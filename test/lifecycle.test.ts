import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import {
  BrowserDisconnectedError,
  BrowserLaunchError,
  createRenderer,
  QueueFullError,
  RendererClosedError,
  renderPdf,
  RenderTimeoutError,
  SafeHtmlPdfError,
} from '../src/index.ts';
import type { AssetResolver } from '../src/index.ts';
import { deck, gate, PNG, sleep, slide } from './helpers/fixtures.ts';
import { startsLikePdf } from './helpers/pdf.ts';

const run = promisify(execFile);
const TIMEOUT = { timeout: 90000 };
const png = { body: PNG, contentType: 'image/png' };

// A page that stays open until the resolver lets its image go.
const held = (name: string) => deck(slide(`<img src="/hold-${name}.png" alt="" style="width:10px">`));
const quick = '<!doctype html><p>quick</p>';

async function until(condition: () => boolean, what: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(10);
  }
}

describe('queue and concurrency', TIMEOUT, () => {
  it('rejects with QueueFullError when the queue is full, and serves the others in order', async () => {
    const renderer = createRenderer({ concurrency: 1, queueLimit: 1 });
    const release = gate();
    const started: string[] = [];
    const resolveAsset: AssetResolver = async (url) => {
      started.push(url.pathname);
      await release.promise;
      return png;
    };

    const first = renderer.render(held('a'), { resolveAsset });
    const second = renderer.render(held('b'), { resolveAsset });
    const third = renderer.render(held('c'), { resolveAsset });
    await assert.rejects(third, (error: QueueFullError) => {
      assert.ok(error instanceof QueueFullError);
      assert.ok(error instanceof SafeHtmlPdfError);
      assert.equal(error.code, 'QUEUE_FULL');
      assert.equal(error.queueLimit, 1);
      return true;
    });

    await until(() => started.length === 1, 'the first render to start');
    await sleep(150);
    // The second is waiting for the one place: it has not asked for anything yet.
    assert.deepEqual(started, ['/hold-a.png']);
    release.open();
    await Promise.all([first, second]);
    assert.deepEqual(started, ['/hold-a.png', '/hold-b.png']);

    // The queue has room again.
    assert.ok(startsLikePdf((await renderer.render(quick)).pdf));
    await renderer.close();
  });

  it('runs at most `concurrency` renders at once', async () => {
    const renderer = createRenderer({ concurrency: 2, queueLimit: 10 });
    const release = gate();
    const active = new Set<string>();
    const seen = new Set<string>();
    let peak = 0;
    const resolveAsset: AssetResolver = async (url) => {
      active.add(url.pathname);
      peak = Math.max(peak, active.size);
      seen.add(url.pathname);
      await release.promise;
      active.delete(url.pathname);
      return png;
    };
    const renders = ['a', 'b', 'c', 'd'].map((name) => renderer.render(held(name), { resolveAsset }));
    await until(() => active.size === 2, 'two renders to be running');
    await sleep(250);
    assert.equal(active.size, 2, 'a third render started');
    release.open();
    await Promise.all(renders);
    assert.equal(peak, 2);
    assert.equal(seen.size, 4);
    await renderer.close();
  });

  it('does not count the wait in the queue against a render time limit', async () => {
    const renderer = createRenderer({ concurrency: 1, queueLimit: 5, timeoutMs: 5000 });
    const release = gate();
    const first = renderer.render(held('a'), {
      resolveAsset: async () => {
        await release.promise;
        return png;
      },
    });
    const second = renderer.render(quick, { timeoutMs: 1500 });
    await sleep(2000);
    release.open();
    await first;
    assert.ok(startsLikePdf((await second).pdf));
    await renderer.close();
  });
});

describe('time limit', TIMEOUT, () => {
  it('stops a slow render with RenderTimeoutError and stays usable', async () => {
    const renderer = createRenderer();
    const release = gate();
    const began = Date.now();
    await assert.rejects(
      renderer.render(held('slow'), {
        timeoutMs: 1000,
        resolveAsset: async () => {
          await release.promise;
          return png;
        },
      }),
      (error: RenderTimeoutError) => {
        assert.ok(error instanceof RenderTimeoutError);
        assert.equal(error.code, 'RENDER_TIMEOUT');
        assert.equal(error.timeoutMs, 1000);
        return true;
      },
    );
    assert.ok(Date.now() - began < 8000, 'the timeout came late');
    release.open();

    // The place was given back and the browser is fine.
    assert.ok(startsLikePdf((await renderer.render(quick)).pdf));
    await renderer.close();
  });

  it('uses the renderer default and lets a render override it', async () => {
    const renderer = createRenderer({ timeoutMs: 800 });
    const release = gate();
    const slow: AssetResolver = async () => {
      await release.promise;
      return png;
    };
    await assert.rejects(renderer.render(held('d'), { resolveAsset: slow }), RenderTimeoutError);
    await assert.rejects(
      renderer.render(held('e'), { resolveAsset: slow, timeoutMs: 600 }),
      (error: RenderTimeoutError) => {
        assert.equal(error.timeoutMs, 600);
        return true;
      },
    );
    release.open();
    await renderer.close();
  });
});

describe('browser lifecycle', TIMEOUT, () => {
  // Remember every Chromium the renderer starts, so a test can pull the rug from under it.
  const launched: Browser[] = [];
  const launch = chromium.launch.bind(chromium);
  chromium.launch = (async (options) => {
    const browser = await launch(options);
    launched.push(browser);
    return browser;
  }) as typeof chromium.launch;
  after(async () => {
    chromium.launch = launch;
    await Promise.all(launched.map((browser) => browser.close().catch(() => {})));
  });

  it('starts a new Chromium after the old one closes', async () => {
    const renderer = createRenderer();
    const before = launched.length;
    assert.ok(startsLikePdf((await renderer.render(quick)).pdf));
    assert.equal(launched.length, before + 1);
    // Reuses the browser while it is alive.
    await renderer.render(quick);
    assert.equal(launched.length, before + 1);

    await launched[before].close();
    assert.ok(startsLikePdf((await renderer.render(quick)).pdf));
    assert.equal(launched.length, before + 2);
    await renderer.close();
  });

  it('fails the render that was running when Chromium went away, and recovers for the next', async () => {
    const renderer = createRenderer();
    await renderer.render(quick);
    const browser = launched.at(-1) as Browser;
    const asked = gate();
    const release = gate();
    const rendering = renderer.render(held('crash'), {
      resolveAsset: async () => {
        asked.open();
        await release.promise;
        return png;
      },
    });
    // Listen from the start: the render fails while the browser is still closing.
    const outcome = rendering.then(
      () => null,
      (error: unknown) => error,
    );
    await asked.promise;
    await browser.close();
    const error = (await outcome) as BrowserDisconnectedError;
    assert.ok(error instanceof BrowserDisconnectedError, String(error));
    assert.equal(error.code, 'BROWSER_DISCONNECTED');
    release.open();
    assert.ok(startsLikePdf((await renderer.render(quick)).pdf));
    await renderer.close();
  });

  it('reuses a browser you pass in, and never closes it', async () => {
    const browser = await chromium.launch({ headless: true });
    const renderer = createRenderer({ launch: browser });
    const before = launched.length;
    assert.ok(startsLikePdf((await renderer.render(quick)).pdf));
    await renderer.close();
    assert.equal(browser.isConnected(), true);
    assert.equal(launched.length, before, 'the renderer started no browser of its own');

    await browser.close();
    const again = createRenderer({ launch: browser });
    await assert.rejects(again.render(quick), BrowserDisconnectedError);
  });

  it('passes launch options on to Chromium', async () => {
    const renderer = createRenderer({ launch: { args: ['--window-size=800,600'] } });
    await renderer.render(quick);
    await renderer.close();
  });

  it('rejects waiting renders and later ones after close()', async () => {
    const renderer = createRenderer({ concurrency: 1, queueLimit: 5 });
    const release = gate();
    const first = renderer.render(held('a'), {
      resolveAsset: async () => {
        await release.promise;
        return png;
      },
    });
    const waiting = renderer.render(quick);
    await sleep(100);
    const closing = renderer.close();
    await assert.rejects(waiting, RendererClosedError);
    await assert.rejects(first, RendererClosedError);
    await closing;
    await renderer.close();
    await assert.rejects(renderer.render(quick), (error: RendererClosedError) => error.code === 'RENDERER_CLOSED');
    release.open();
  });

  it('renders once with renderPdf and cleans up after itself', async () => {
    const before = launched.length;
    const { pdf, pages, warnings } = await renderPdf('<h1>One shot</h1>', { format: 'Letter' });
    assert.ok(startsLikePdf(pdf));
    assert.equal(pages, 1);
    assert.deepEqual(warnings, []);
    assert.equal(launched.length, before + 1);
    assert.equal(launched.at(-1)?.isConnected(), false);
  });

  it('throws a BrowserLaunchError when Chromium cannot be started, and tries again next time', async () => {
    const renderer = createRenderer({ launch: { executablePath: '/nonexistent/chromium' } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(renderer.render(quick), (error: BrowserLaunchError) => {
        assert.ok(error instanceof BrowserLaunchError);
        assert.match(error.code, /^BROWSER_(NOT_INSTALLED|LAUNCH_FAILED)$/);
        assert.ok(error.cause);
        return true;
      });
    }
    await renderer.close();
  });
});

describe('no Chromium installed', TIMEOUT, () => {
  it('rejects with BROWSER_NOT_INSTALLED and the command that fixes it, every time', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'safe-html-pdf-no-browsers-'));
    try {
      const { stdout } = await run(process.execPath, ['test/helpers/missing-browser.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
        timeout: 60000,
      });
      const attempts = JSON.parse(stdout.trim().split('\n').at(-1) as string);
      assert.equal(attempts.length, 2);
      for (const attempt of attempts) {
        assert.equal(attempt.name, 'BrowserLaunchError');
        assert.equal(attempt.code, 'BROWSER_NOT_INSTALLED');
        assert.match(attempt.message, /npx playwright install chromium/);
      }
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('arguments', () => {
  // These are refused before any browser is started.
  it('rejects bad options when the renderer is created', () => {
    assert.throws(() => createRenderer({ concurrency: 0 }), RangeError);
    assert.throws(() => createRenderer({ concurrency: 1.5 }), RangeError);
    assert.throws(() => createRenderer({ queueLimit: -1 }), RangeError);
    assert.throws(() => createRenderer({ timeoutMs: 0 }), RangeError);
    assert.throws(() => createRenderer({ format: 'A5' as never }), TypeError);
    assert.throws(() => createRenderer({ baseUrl: 'file:///tmp/' }), TypeError);
    assert.throws(() => createRenderer({ baseUrl: 'http://user:pass@host.invalid/' }), TypeError);
    assert.throws(() => createRenderer({ baseUrl: 'not a url' }), TypeError);
    assert.throws(() => createRenderer({ margin: { top: 'wide' } }), TypeError);
    assert.throws(() => createRenderer({ margin: '500mm' }), RangeError);
    assert.throws(() => createRenderer({ lint: { tolerancePx: -1 } }), RangeError);
    assert.throws(() => createRenderer({ pageSelector: ' ' }), TypeError);
    assert.throws(() => createRenderer({ resolveAsset: '/assets' as never }), TypeError);
  });

  it('rejects HTML that is not a string, and time limits that a timer cannot hold', async () => {
    const renderer = createRenderer();
    await assert.rejects(renderer.render(undefined as never), TypeError);
    await assert.rejects(renderer.render(Buffer.from('<p>x</p>') as never), TypeError);
    for (const timeoutMs of [0, -5, Number.NaN, Infinity, '30000' as never, 2 ** 31]) {
      await assert.rejects(renderer.render(quick, { timeoutMs }), RangeError, String(timeoutMs));
    }
    await renderer.close();
  });

  it('lets an option set to undefined fall back to the default', async () => {
    const renderer = createRenderer({ format: 'Letter' });
    await assert.doesNotReject(renderer.render(quick, { format: undefined, timeoutMs: undefined }));
    await renderer.close();
  });
});
