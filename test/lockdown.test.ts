import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createRenderer } from '../src/index.ts';
import type { Renderer, RenderWarning } from '../src/index.ts';
import { deck, PNG, slide } from './helpers/fixtures.ts';
import { hasImage, startsLikePdf } from './helpers/pdf.ts';
import { startProbeServer } from './helpers/probe-server.ts';

const TIMEOUT = { timeout: 60000 };
const codes = (warnings: RenderWarning[]) => warnings.map((warning) => warning.code);
const slides = { format: 'slides', pageSelector: 'section.slide' } as const;

describe('lockdown', TIMEOUT, () => {
  let renderer: Renderer;
  let probe: Awaited<ReturnType<typeof startProbeServer>>;

  before(async () => {
    renderer = createRenderer();
    probe = await startProbeServer();
  });

  after(async () => {
    await renderer.close();
    await probe.close();
  });

  it('blocks and reports an external image, stylesheet, font, background and iframe, and reaches nothing', async () => {
    const origin = probe.origin;
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="${origin}/style.css">
      <style>
        @font-face { font-family: Probe; src: url(${origin}/font.woff2); }
        body { margin: 0; font-family: Probe, serif; background: url(${origin}/background.png); }
      </style>
      <script src="${origin}/script.js"></script>
    </head><body>
      <section class="slide" style="width:1280px;height:720px">
        <img src="${origin}/image.png" alt="">
        <iframe src="${origin}/frame.html"></iframe>
        <object data="${origin}/object.bin"></object>
        <video poster="${origin}/poster.png"></video>
      </section>
      <script>fetch('${origin}/fetch'); new Image().src = '${origin}/beacon.png';</script>
    </body></html>`;

    const { pdf, warnings } = await renderer.render(html, slides);

    assert.ok(startsLikePdf(pdf));
    assert.deepEqual(probe.hits, [], 'the page reached the network');
    const blocked = warnings.filter((warning) => warning.code === 'blocked-request');
    const byUrl = new Map(blocked.map((warning) => [warning.locator, warning.message]));
    assert.match(byUrl.get(`${origin}/image.png`) ?? '', /^Blocked image request/);
    assert.match(byUrl.get(`${origin}/style.css`) ?? '', /^Blocked stylesheet request/);
    assert.match(byUrl.get(`${origin}/font.woff2`) ?? '', /^Blocked font request/);
    assert.match(byUrl.get(`${origin}/background.png`) ?? '', /^Blocked image request/);
    assert.match(byUrl.get(`${origin}/frame.html`) ?? '', /^Blocked iframe request/);
    assert.ok(byUrl.has(`${origin}/poster.png`));
    // JavaScript is off, so a script and a fetch are never even attempted: they cannot be in the warnings.
    assert.equal(byUrl.has(`${origin}/script.js`), false);
    assert.equal(byUrl.has(`${origin}/fetch`), false);
    assert.equal(byUrl.has(`${origin}/beacon.png`), false);
    for (const warning of blocked) assert.equal(warning.page, null);
  });

  it('does not run inline JavaScript, event handlers or javascript: URLs', async () => {
    const html = deck(
      slide(
        `<div id="grow" style="height:10px"></div>
         <img src="data:image/x-nope;base64,AAAA" alt="" style="width:10px"
              onerror="document.getElementById('grow').style.height='2000px'">
         <a href="javascript:document.getElementById('grow').style.height='2000px'">link</a>
         <script>document.getElementById('grow').style.height = '2000px';</script>`,
      ),
    ).replace('<body>', `<body onload="document.getElementById('grow').style.height='2000px'">`);
    const { warnings } = await renderer.render(html, slides);
    assert.equal(codes(warnings).includes('overflow'), false, JSON.stringify(warnings));
  });

  it('really has JavaScript off: <noscript> content is rendered', async () => {
    // Only a browser with scripting disabled lays out a <noscript> block.
    const html = deck(slide('<noscript><div style="height:2000px" class="from-noscript"></div></noscript>'));
    const { warnings } = await renderer.render(html, slides);
    assert.deepEqual(
      warnings.map((warning) => [warning.code, warning.page]),
      [['overflow', 1]],
    );
  });

  it('stops a page that tries to navigate away, and reaches nothing', async () => {
    const html = `<!doctype html><meta http-equiv="refresh" content="0;url=${probe.origin}/away"><p>Stay</p>`;
    await assert.rejects(renderer.render(html), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'PAGE_NAVIGATED');
      assert.match(error.message, /\/away/);
      return true;
    });
    assert.deepEqual(probe.hits, []);
  });

  it('gives no access to local files', async () => {
    const html = `<!doctype html><body style="background:url(file:///etc/hosts)">
      <img src="file:///etc/hosts" alt="" style="width:20px"><link rel="stylesheet" href="file:///etc/hosts"></body>`;
    const { warnings } = await renderer.render(html);
    assert.deepEqual(codes(warnings), ['broken-image']);
    assert.equal(warnings[0].locator, 'file:///etc/hosts');
  });

  it('asks resolveAsset only for files of the base origin, with the URL as the browser sent it', async () => {
    const asked: string[] = [];
    const html = deck(
      slide(
        `<img src="/logo%20one.png" alt=""><img src="${probe.origin}/x.png" alt=""><img src="//other.invalid/y.png" alt="">`,
      ),
    );
    await renderer.render(html, {
      ...slides,
      resolveAsset: (url) => {
        asked.push(url.href);
        return null;
      },
    });
    assert.deepEqual(asked, ['http://document.invalid/logo%20one.png']);
    assert.deepEqual(probe.hits, []);
  });

  it('serves an image that resolveAsset returns, and puts it in the PDF', async () => {
    const html = deck(slide('<img src="/logo.png" alt="" style="width:80px">'));
    const asked: string[] = [];
    const { pdf, warnings } = await renderer.render(html, {
      ...slides,
      resolveAsset: (url) => {
        asked.push(url.pathname);
        return url.pathname === '/logo.png' ? { body: PNG, contentType: 'image/png' } : null;
      },
    });
    assert.deepEqual(asked, ['/logo.png']);
    assert.deepEqual(warnings, []);
    assert.ok(hasImage(pdf));
  });

  it('serves a stylesheet and a font from resolveAsset too, and accepts a string body', async () => {
    const html = `<!doctype html><link rel="stylesheet" href="/theme.css"><div class="tall"></div>`;
    const { warnings } = await renderer.render(html, {
      resolveAsset: (url) =>
        url.pathname === '/theme.css'
          ? { body: '.tall { width: 2000px; height: 10px }', contentType: 'text/css' }
          : null,
    });
    // The stylesheet came through: its rule made the block wider than the page.
    assert.deepEqual(codes(warnings), ['overflow']);
  });

  it('resolves against a base URL you choose', async () => {
    const asked: string[] = [];
    const html = deck(slide('<img src="logo.png" alt="" style="width:40px">'));
    const { warnings } = await renderer.render(html, {
      ...slides,
      baseUrl: 'https://assets.example/reports/q1/',
      resolveAsset: (url) => {
        asked.push(url.href);
        return { body: PNG, contentType: 'image/png' };
      },
    });
    assert.deepEqual(asked, ['https://assets.example/reports/q1/logo.png']);
    assert.deepEqual(warnings, []);
  });

  it('reports a file that resolveAsset does not have, as well as the image that failed', async () => {
    const html = deck(slide('<img src="/gone.png" alt="" style="width:40px">'));
    const { warnings } = await renderer.render(html, slides);
    assert.deepEqual(
      warnings.map((warning) => [warning.code, warning.page, warning.locator]),
      [
        ['broken-image', 1, '/gone.png'],
        ['missing-asset', null, 'http://document.invalid/gone.png'],
      ],
    );
  });

  it('fails the render, with the cause, when resolveAsset throws', async () => {
    const failure = new Error('disk unplugged');
    const html = deck(slide('<img src="/logo.png" alt="">'));
    await assert.rejects(
      renderer.render(html, {
        ...slides,
        resolveAsset: () => {
          throw failure;
        },
      }),
      (error: Error & { code?: string; cause?: unknown }) => {
        assert.equal(error.name, 'AssetResolveError');
        assert.equal(error.code, 'ASSET_RESOLVE_FAILED');
        assert.equal(error.cause, failure);
        return true;
      },
    );
  });

  it('keeps nothing between two renders: every render has a context of its own', async () => {
    const html = `<!doctype html><p>x</p>`;
    const first = await renderer.render(html);
    const second = await renderer.render(html);
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(second.warnings, []);
  });
});
