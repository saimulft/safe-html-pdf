import type { Request, Route } from 'playwright';
import { AssetResolveError } from './errors.ts';
import type { AssetResolver } from './types.ts';

/** What the lockdown refused or could not serve while a page rendered. */
export interface RequestReport {
  kind: 'blocked' | 'missing';
  url: string;
  /** What asked for it: `image`, `stylesheet`, `font`, `iframe`, `navigation` and so on. */
  via: string;
}

export interface RouteHandlerOptions {
  /** The page itself. */
  html: string;
  /** The virtual address of the page. Its origin is the only one that is served. */
  baseUrl: URL;
  resolveAsset: AssetResolver;
  /** Gets every refused or missing request. */
  report: (entry: RequestReport) => void;
  /** Gets the error when `resolveAsset` throws, so the render can fail with it. */
  fail: (error: AssetResolveError) => void;
}

// Playwright's answer to a request. One that fails because the page has closed is of no interest.
async function answer(route: Pick<Route, 'abort' | 'fulfill'>, kind: 'abort' | 'fulfill', argument?: object) {
  try {
    if (kind === 'abort') await route.abort('blockedbyclient');
    else await route.fulfill(argument);
  } catch {
    // The page closed, or the request ended, while the answer was on its way.
  }
}

function describeRequest(request: Request): string {
  if (request.isNavigationRequest()) return request.frame().parentFrame() ? 'iframe' : 'navigation';
  const type = request.resourceType();
  return type === 'other' ? 'resource' : type;
}

/**
 * The handler for every request the page makes (give it to `context.route` with the pattern `**\/*`). The page itself
 * is answered with `html`. Any other path of the base origin is answered with what `resolveAsset` returns, or 404 when
 * it returns nothing. A request to any other address, port or scheme, or with a method other than GET and HEAD, is
 * aborted. When `resolveAsset` throws, the request answers 500 and the error goes to `fail`.
 */
export function createRouteHandler(options: RouteHandlerOptions) {
  const { html, baseUrl, resolveAsset, report, fail } = options;

  return async (route: Route): Promise<void> => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      report({ kind: 'blocked', url: request.url(), via: describeRequest(request) });
      return answer(route, 'abort');
    }
    const method = request.method();
    if (url.origin !== baseUrl.origin || (method !== 'GET' && method !== 'HEAD')) {
      report({ kind: 'blocked', url: request.url(), via: describeRequest(request) });
      return answer(route, 'abort');
    }

    const notFound = () => {
      report({ kind: 'missing', url: url.href, via: describeRequest(request) });
      return answer(route, 'fulfill', { status: 404, contentType: 'text/plain', body: 'Not found' });
    };

    if (url.pathname === baseUrl.pathname) {
      // Only the browser opening the page gets it: not an image, nor a frame inside the page.
      const mainPage = request.isNavigationRequest() && !request.frame().parentFrame();
      if (!mainPage) return notFound();
      return answer(route, 'fulfill', { status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }

    let asset;
    try {
      asset = await resolveAsset(url);
    } catch (error) {
      fail(new AssetResolveError(url.href, error));
      return answer(route, 'fulfill', { status: 500, contentType: 'text/plain', body: 'The file could not be read' });
    }
    if (!asset) return notFound();
    const body = typeof asset.body === 'string' ? asset.body : Buffer.from(asset.body);
    return answer(route, 'fulfill', {
      status: 200,
      contentType: asset.contentType ?? 'application/octet-stream',
      body,
    });
  };
}
