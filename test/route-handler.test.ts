import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Route } from 'playwright';
import { AssetResolveError } from '../src/errors.ts';
import { createRouteHandler } from '../src/route-handler.ts';
import type { RequestReport } from '../src/route-handler.ts';
import { PNG } from './helpers/fixtures.ts';

const BASE = new URL('http://document.invalid/');
const asset = { body: PNG, contentType: 'image/png' };

// The part of a Playwright route the handler uses, recording what it was told to do.
function fakeRoute(url: string, { navigation = false, subframe = false, method = 'GET', type = 'image' } = {}) {
  const calls: Record<string, unknown>[] = [];
  const route = {
    calls,
    request: () => ({
      url: () => url,
      method: () => method,
      resourceType: () => type,
      isNavigationRequest: () => navigation,
      frame: () => ({ parentFrame: () => (subframe ? {} : null) }),
    }),
    abort: async (code: string) => {
      calls.push({ method: 'abort', code });
    },
    fulfill: async (options: object) => {
      calls.push({ method: 'fulfill', ...options });
    },
  };
  return route;
}

function setup(resolveAsset = async () => asset as typeof asset | null) {
  const reports: RequestReport[] = [];
  const failures: AssetResolveError[] = [];
  const asked: string[] = [];
  const handler = createRouteHandler({
    html: '<p>é</p>',
    baseUrl: BASE,
    resolveAsset: async (url) => (asked.push(url.href), resolveAsset()),
    report: (entry) => reports.push(entry),
    fail: (error) => failures.push(error),
  });
  const run = (route: ReturnType<typeof fakeRoute>) => handler(route as unknown as Route);
  return { run, reports, failures, asked };
}

describe('route handler', () => {
  it('answers the page itself with the HTML, and only to the browser opening it', async () => {
    const { run, asked, reports } = setup();
    const page = fakeRoute('http://document.invalid/', { navigation: true, type: 'document' });
    await run(page);
    assert.deepEqual(page.calls, [
      { method: 'fulfill', status: 200, contentType: 'text/html; charset=utf-8', body: '<p>é</p>' },
    ]);
    assert.deepEqual(asked, []);

    // An image or a frame asking for the page's own address gets a 404.
    for (const route of [
      fakeRoute('http://document.invalid/'),
      fakeRoute('http://document.invalid/', { navigation: true, subframe: true }),
    ]) {
      await run(route);
      assert.equal(route.calls[0].status, 404);
      assert.doesNotMatch(String(route.calls[0].body), /<p>/);
    }
    assert.equal(reports.length, 2);
  });

  it('answers other paths through resolveAsset, with the URL as the browser sent it', async () => {
    const { run, asked } = setup();
    const found = fakeRoute('http://document.invalid/fonts/my%20font.ttf?v=2');
    await run(found);
    assert.deepEqual(asked, ['http://document.invalid/fonts/my%20font.ttf?v=2']);
    assert.deepEqual(found.calls, [{ method: 'fulfill', status: 200, contentType: 'image/png', body: PNG }]);
  });

  it('answers 404 and reports a file that is not there', async () => {
    const { run, reports } = setup(async () => null);
    const missing = fakeRoute('http://document.invalid/missing.png');
    await run(missing);
    assert.equal(missing.calls[0].status, 404);
    assert.deepEqual(reports, [{ kind: 'missing', url: 'http://document.invalid/missing.png', via: 'image' }]);
  });

  it('sends a file whose type the resolver did not name as plain bytes, and a string as text', async () => {
    const bytes = setup(async () => ({ body: PNG }) as never);
    const route = fakeRoute('http://document.invalid/logo.png');
    await bytes.run(route);
    assert.deepEqual(route.calls, [
      { method: 'fulfill', status: 200, contentType: 'application/octet-stream', body: PNG },
    ]);

    const text = setup(async () => ({ body: 'a { color: red }', contentType: 'text/css' }) as never);
    const css = fakeRoute('http://document.invalid/a.css', { type: 'stylesheet' });
    await text.run(css);
    assert.equal(css.calls[0].body, 'a { color: red }');
  });

  it('aborts every request to another host, port, scheme or method without asking resolveAsset', async () => {
    const { run, asked, reports } = setup();
    const refused = [
      'https://assets.example.com/logo.png',
      'http://assets.example.com/logo.png',
      'https://document.invalid/logo.png',
      'http://document.invalid:8080/logo.png',
      'http://document.invalid.example.com/logo.png',
      'http://document.invalid@example.com/logo.png',
      'http://example.com/?http://document.invalid/logo.png',
      'http://127.0.0.1/logo.png',
      'http://localhost:3000/api',
      'http://169.254.169.254/latest/meta-data',
      'ftp://document.invalid/logo.png',
      'ws://document.invalid/socket',
      'file:///etc/passwd',
      'chrome://version',
      'not a url',
      '',
    ];
    for (const url of refused) {
      const route = fakeRoute(url, { navigation: true });
      await run(route);
      assert.deepEqual(route.calls, [{ method: 'abort', code: 'blockedbyclient' }], url);
    }
    const post = fakeRoute('http://document.invalid/form', { method: 'POST' });
    await run(post);
    assert.deepEqual(post.calls, [{ method: 'abort', code: 'blockedbyclient' }]);

    assert.deepEqual(asked, []);
    assert.equal(reports.length, refused.length + 1);
    assert.ok(reports.every((report) => report.kind === 'blocked'));
  });

  it('names what asked for a blocked request', async () => {
    const { run, reports } = setup();
    await run(fakeRoute('https://a.example/x.css', { type: 'stylesheet' }));
    await run(fakeRoute('https://a.example/f.woff2', { type: 'font' }));
    await run(fakeRoute('https://a.example/frame', { navigation: true, subframe: true, type: 'document' }));
    await run(fakeRoute('https://a.example/other', { type: 'other' }));
    assert.deepEqual(
      reports.map((report) => report.via),
      ['stylesheet', 'font', 'iframe', 'resource'],
    );
  });

  it('answers 500 when the file cannot be read, and hands the error on for the render', async () => {
    const failure = new Error('disk unplugged');
    const { run, failures } = setup(async () => {
      throw failure;
    });
    const route = fakeRoute('http://document.invalid/fonts/a.ttf');
    await run(route);
    assert.equal(route.calls[0].status, 500);
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof AssetResolveError);
    assert.equal(failures[0].cause, failure);
    assert.equal(failures[0].url, 'http://document.invalid/fonts/a.ttf');
  });

  it('does not throw when the page closes while it answers', async () => {
    const { run } = setup();
    const route = fakeRoute('http://document.invalid/logo.png');
    route.fulfill = async () => {
      throw new Error('Target page, context or browser has been closed');
    };
    await run(route);
    const refused = fakeRoute('https://example.com/');
    refused.abort = async () => {
      throw new Error('Route is already handled!');
    };
    await run(refused);
  });

  it('serves the page at a base URL that has a path', async () => {
    const handler = createRouteHandler({
      html: '<p>x</p>',
      baseUrl: new URL('http://docs.invalid/reports/q1/'),
      resolveAsset: async () => asset,
      report: () => {},
      fail: () => {},
    });
    const page = fakeRoute('http://docs.invalid/reports/q1/', { navigation: true });
    await handler(page as unknown as Route);
    assert.equal(page.calls[0].status, 200);
    const image = fakeRoute('http://docs.invalid/reports/q1/logo.png');
    await handler(image as unknown as Route);
    assert.equal(image.calls[0].contentType, 'image/png');
  });
});
