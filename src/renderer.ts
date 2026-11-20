import type { Browser, BrowserContext, LaunchOptions } from 'playwright';
import {
  BrowserDisconnectedError,
  BrowserLaunchError,
  RendererClosedError,
  RenderTimeoutError,
  SafeHtmlPdfError,
} from './errors.ts';
import { inspectPage } from './inspect-page.ts';
import type { InspectResult } from './inspect-page.ts';
import { Limiter } from './limiter.ts';
import { resolveFormat, resolveMargin } from './page-size.ts';
import type { ResolvedFormat } from './page-size.ts';
import { createRouteHandler } from './route-handler.ts';
import type { RequestReport } from './route-handler.ts';
import type { AssetResolveError } from './errors.ts';
import type { AssetResolver, RenderOptions, RenderResult, Renderer, RendererOptions } from './types.ts';
import { buildWarnings } from './warnings.ts';

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TOLERANCE_PX = 1;
const DEFAULT_SNIPPET_LENGTH = 40;
const DEFAULT_MAX_SOURCE_LENGTH = 100;
const DEFAULT_BASE_URL = 'http://document.invalid/';
// The longest time setTimeout keeps; it turns anything above into 1 ms.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// What Playwright says when the browser, or the context a render was using, is gone.
const TARGET_CLOSED = /Target (?:page, context or browser|closed)|has been closed|Connection closed/i;
const MISSING_BROWSER = /Executable doesn't exist|playwright install/i;

// Everything one render needs, checked and in the units it uses.
interface Settings {
  format: ResolvedFormat;
  margin: { top: number; right: number; bottom: number; left: number };
  /** The printable area: the paper without its margins. */
  width: number;
  height: number;
  selector: string | null;
  printBackground: boolean;
  preferCSSPageSize: boolean;
  finishAnimations: boolean;
  lint: false | { tolerancePx: number; snippetLength: number; maxSourceLength: number };
  timeoutMs: number;
  resolveAsset: AssetResolver;
  baseUrl: URL;
}

// A later source wins, but an option set to undefined does not wipe out an earlier one.
function merge(...sources: (RenderOptions | undefined)[]): RenderOptions {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) if (value !== undefined) merged[key] = value;
  }
  return merged as RenderOptions;
}

function positiveInteger(name: string, value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a whole number of at least ${minimum}.`);
  }
  return value;
}

function nonNegativeNumber(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a number of 0 or more.`);
  }
  return value;
}

function readBaseUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`baseUrl must be an absolute http or https URL, not ${String(value)}.`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new TypeError('baseUrl must be an http or https URL without a user name or password.');
  }
  url.search = '';
  url.hash = '';
  return url;
}

function resolveSettings(options: RenderOptions): Settings {
  const format = resolveFormat(options.format ?? 'A4');
  const margin = resolveMargin(options.margin);
  const width = Math.round(format.width - margin.left - margin.right);
  const height = Math.round(format.height - margin.top - margin.bottom);
  if (width < 1 || height < 1) throw new RangeError('margin leaves no room on the page.');

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be a number of milliseconds above 0 and up to ${MAX_TIMEOUT_MS}.`);
  }
  const resolveAsset = options.resolveAsset ?? (() => null);
  if (typeof resolveAsset !== 'function') throw new TypeError('resolveAsset must be a function.');
  const selector = options.pageSelector ?? null;
  if (selector !== null && (typeof selector !== 'string' || !selector.trim())) {
    throw new TypeError('pageSelector must be a CSS selector string.');
  }

  let lint: Settings['lint'] = false;
  if (options.lint !== false) {
    const given = options.lint ?? {};
    lint = {
      tolerancePx: nonNegativeNumber('lint.tolerancePx', given.tolerancePx ?? DEFAULT_TOLERANCE_PX),
      snippetLength: positiveInteger('lint.snippetLength', given.snippetLength ?? DEFAULT_SNIPPET_LENGTH, 1),
      maxSourceLength: positiveInteger('lint.maxSourceLength', given.maxSourceLength ?? DEFAULT_MAX_SOURCE_LENGTH, 1),
    };
  }

  return {
    format,
    margin,
    width,
    height,
    selector,
    printBackground: options.printBackground ?? true,
    preferCSSPageSize: options.preferCSSPageSize ?? true,
    finishAnimations: options.finishAnimations ?? true,
    lint,
    timeoutMs,
    resolveAsset,
    baseUrl: readBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
  };
}

// Playwright is loaded on first use, so importing this package does not pay for it.
let playwrightLoad: Promise<typeof import('playwright')> | null = null;
function loadPlaywright(): Promise<typeof import('playwright')> {
  playwrightLoad ??= import('playwright').catch((error: unknown) => {
    playwrightLoad = null;
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new BrowserLaunchError(
        'PLAYWRIGHT_NOT_INSTALLED',
        'Playwright is not installed. Run `npm install playwright` and `npx playwright install chromium`.',
        { cause: error },
      );
    }
    throw error;
  });
  return playwrightLoad;
}

function launchError(error: unknown): BrowserLaunchError {
  if (error instanceof BrowserLaunchError) return error;
  const text = error instanceof Error ? error.message : String(error);
  if (MISSING_BROWSER.test(text)) {
    return new BrowserLaunchError(
      'BROWSER_NOT_INSTALLED',
      "Playwright's Chromium is not installed. Run `npx playwright install chromium` (add `--with-deps` on Linux).",
      { cause: error },
    );
  }
  const hint = /sandbox/i.test(text)
    ? ' If you run as root or in a container, pass launch: { chromiumSandbox: false } and isolate the container yourself.'
    : '';
  return new BrowserLaunchError(
    'BROWSER_LAUNCH_FAILED',
    `Chromium could not be started: ${text.split('\n')[0]}${hint}`,
    { cause: error },
  );
}

function isBrowser(value: unknown): value is Browser {
  return typeof value === 'object' && value !== null && typeof (value as Browser).newContext === 'function';
}

// A PDF's pages are its /Type /Page objects (not /Pages, the tree that holds them).
function countPdfPages(pdf: Uint8Array): number {
  return (
    Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength)
      .toString('latin1')
      .match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []
  ).length;
}

// What a render shares with the deadline that watches it.
interface Run {
  browser: Browser | null;
  context: BrowserContext | null;
  expired: boolean;
}

/**
 * Starts a renderer: one Chromium that starts on first use, starts again after it closes or crashes, and prints
 * `concurrency` PDFs at a time while up to `queueLimit` more wait their turn. Close it when you are done.
 *
 * ```ts
 * const renderer = createRenderer({ concurrency: 4 });
 * const { pdf, warnings } = await renderer.render('<h1>Hello</h1>');
 * await renderer.close();
 * ```
 */
export function createRenderer(options: RendererOptions = {}): Renderer {
  const { concurrency, queueLimit, launch, ...defaults } = options;
  const limiter = new Limiter(
    positiveInteger('concurrency', concurrency ?? DEFAULT_CONCURRENCY, 1),
    positiveInteger('queueLimit', queueLimit ?? DEFAULT_QUEUE_LIMIT, 0),
  );
  // Bad defaults are the caller's mistake at start, not at the first render.
  resolveSettings(merge(defaults));

  const provided = isBrowser(launch) ? launch : null;
  const launchOptions: LaunchOptions = provided ? {} : ((launch as LaunchOptions | undefined) ?? {});
  let launching: Promise<Browser> | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;

  function startBrowser(): Promise<Browser> {
    const starting: Promise<Browser> = loadPlaywright()
      .then(({ chromium }) =>
        chromium.launch({
          headless: true,
          ...launchOptions,
          args: ['--disable-dev-shm-usage', ...(launchOptions.args ?? [])],
        }),
      )
      .then((browser) => {
        // A browser that closes or crashes is forgotten; the next render starts a new one.
        browser.on('disconnected', () => {
          if (launching === starting) launching = null;
        });
        return browser;
      })
      .catch((error: unknown) => {
        // A failed start is not kept either, so a browser installed later is found without a restart.
        if (launching === starting) launching = null;
        throw launchError(error);
      });
    return starting;
  }

  async function getBrowser(): Promise<Browser> {
    if (provided) {
      if (!provided.isConnected())
        throw new BrowserDisconnectedError('The browser passed as `launch` is no longer connected.');
      return provided;
    }
    for (let attempt = 0; ; attempt += 1) {
      if (closed) throw new RendererClosedError();
      const starting = (launching ??= startBrowser());
      const browser = await starting;
      if (browser.isConnected()) return browser;
      if (launching === starting) launching = null;
      if (attempt > 0) throw new BrowserDisconnectedError('Chromium closed right after it was started.');
    }
  }

  // A context of its own for one render: no cookies, cache or storage carry over between renders.
  async function openContext(settings: Settings, run: Run): Promise<BrowserContext> {
    for (let attempt = 0; ; attempt += 1) {
      const browser = await getBrowser();
      run.browser = browser;
      try {
        return await browser.newContext({
          viewport: { width: settings.width, height: settings.height },
          javaScriptEnabled: false,
          serviceWorkers: 'block',
          acceptDownloads: false,
        });
      } catch (error) {
        // The browser may have crashed since it was last used: the next getBrowser() starts a new one, once.
        if (browser.isConnected() || attempt > 0) throw error;
      }
    }
  }

  async function print(html: string, settings: Settings, run: Run): Promise<RenderResult> {
    const context = await openContext(settings, run);
    run.context = context;
    // The caller gave up while the browser was starting: nothing to print for.
    if (run.expired) throw new RenderTimeoutError(settings.timeoutMs);

    const reports = new Map<string, RequestReport>();
    let assetError: AssetResolveError | undefined;
    await context.route(
      '**/*',
      createRouteHandler({
        html,
        baseUrl: settings.baseUrl,
        resolveAsset: settings.resolveAsset,
        report: (entry) => {
          const key = `${entry.kind} ${entry.via} ${entry.url}`;
          if (!reports.has(key)) reports.set(key, entry);
        },
        fail: (error) => {
          assetError ??= error;
        },
      }),
    );
    const page = await context.newPage();
    const lint = settings.lint;
    const { margin } = settings;

    // A page that sends the browser somewhere else (a meta refresh, say) is stopped by the lockdown, but what is left
    // to print is an error page. That is a failure, not a PDF.
    const wentAway = () => {
      const away = [...reports.values()].find((entry) => entry.kind === 'blocked' && entry.via === 'navigation');
      return away
        ? new SafeHtmlPdfError(
            'PAGE_NAVIGATED',
            `The page tried to navigate to ${away.url}, which is blocked, so it was not printed.`,
          )
        : undefined;
    };

    let inspected: InspectResult;
    let pdf: Uint8Array;
    try {
      // The same styles the PDF is printed with, so the checks measure what is printed.
      await page.emulateMedia({ media: 'print' });
      await page.goto(settings.baseUrl.href, { waitUntil: 'load', timeout: settings.timeoutMs });
      inspected = await page.evaluate(inspectPage, {
        selector: settings.selector,
        width: settings.width,
        height: settings.height,
        tolerance: lint ? lint.tolerancePx : 0,
        lint: lint !== false,
        finishAnimations: settings.finishAnimations,
        maxSourceLength: lint ? lint.maxSourceLength : 0,
      });
      if (inspected.invalidSelector)
        throw new TypeError(`pageSelector is not a valid CSS selector: ${settings.selector}`);
      pdf = await page.pdf({
        ...settings.format.pdf,
        margin: {
          top: `${margin.top}px`,
          right: `${margin.right}px`,
          bottom: `${margin.bottom}px`,
          left: `${margin.left}px`,
        },
        printBackground: settings.printBackground,
        preferCSSPageSize: settings.preferCSSPageSize,
      });
    } catch (error) {
      throw wentAway() ?? error;
    }
    const away = wentAway();
    if (away) throw away;
    if (assetError) throw assetError;

    const warnings = buildWarnings(inspected, reports.values(), {
      width: settings.width,
      height: settings.height,
      selector: settings.selector,
      snippetLength: lint ? lint.snippetLength : DEFAULT_SNIPPET_LENGTH,
    });
    return { pdf, pages: countPdfPages(pdf), warnings };
  }

  // Runs a render within `ms`. At the deadline the caller gets a RenderTimeoutError at once, and the context is
  // closed, which ends whatever the render was waiting for.
  async function withinDeadline(settings: Settings, html: string): Promise<RenderResult> {
    const ms = settings.timeoutMs;
    const run: Run = { browser: null, context: null, expired: false };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        run.expired = true;
        run.context?.close().catch(() => {});
        reject(new RenderTimeoutError(ms));
      }, ms);
    });
    const rendering = print(html, settings, run)
      .catch((error: unknown) => {
        if (run.expired || (error as { name?: string } | null)?.name === 'TimeoutError')
          throw new RenderTimeoutError(ms);
        if (error instanceof SafeHtmlPdfError || error instanceof TypeError || error instanceof RangeError) throw error;
        if (closed) throw new RendererClosedError();
        if (run.browser && (!run.browser.isConnected() || TARGET_CLOSED.test(String((error as Error)?.message)))) {
          throw new BrowserDisconnectedError('The browser closed or crashed while the PDF was being printed.', {
            cause: error,
          });
        }
        throw error;
      })
      .finally(() => run.context?.close().catch(() => {}));
    // After the deadline has answered, what the render ends with is of no interest.
    rendering.catch(() => {});
    try {
      return await Promise.race([rendering, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async render(html, renderOptions) {
      if (closed) throw new RendererClosedError();
      if (typeof html !== 'string') throw new TypeError('render() needs the page as a string of HTML.');
      const settings = resolveSettings(merge(defaults, renderOptions));

      // The place in the queue is taken before anything is awaited, so renders are served in the order of the calls.
      await limiter.acquire();
      try {
        if (closed) throw new RendererClosedError();
        return await withinDeadline(settings, html);
      } finally {
        limiter.release();
      }
    },

    close() {
      closing ??= (async () => {
        closed = true;
        limiter.closeQueue();
        const starting = launching;
        launching = null;
        if (!starting || provided) return;
        try {
          await (await starting).close();
        } catch {
          // It never started, or it is gone already.
        }
      })();
      return closing;
    },
  };
}

/**
 * Prints one document: starts a renderer, renders `html` once and closes it again. Use {@link createRenderer} when you
 * print more than one, so the browser is started once.
 *
 * ```ts
 * const { pdf, pages, warnings } = await renderPdf('<h1>Invoice</h1>', { format: 'Letter' });
 * ```
 */
export async function renderPdf(html: string, options: RendererOptions = {}): Promise<RenderResult> {
  const renderer = createRenderer(options);
  try {
    return await renderer.render(html);
  } finally {
    await renderer.close();
  }
}
