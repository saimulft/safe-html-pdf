import type { Browser, LaunchOptions } from 'playwright';

/** A file served to the page: its bytes and its media type. */
export interface Asset {
  /** The file's content. A string is sent as UTF-8. */
  body: Uint8Array | string;
  /** The media type, for example `image/png`. Defaults to `application/octet-stream`. */
  contentType?: string;
}

/**
 * Answers the page's requests for files (images, fonts, stylesheets). It gets the absolute URL on the virtual base
 * origin, still percent-encoded, for example `http://document.invalid/img/logo.png`. Return `null` for a file that does
 * not exist. A throw fails the render with an {@link AssetResolveError}.
 */
export type AssetResolver = (url: URL) => Asset | null | undefined | Promise<Asset | null | undefined>;

/** A page size in CSS pixels (a number) or with a unit in a string: `px`, `in`, `cm`, `mm`, `pt` or `pc`. */
export interface PageSize {
  width: number | string;
  height: number | string;
}

/**
 * The paper: `'A4'` (210 x 297 mm), `'Letter'` (8.5 x 11 in), `'slides'` (1280 x 720 px, 16:9) or a custom
 * `{ width, height }`.
 */
export type PageFormat = 'A4' | 'Letter' | 'slides' | PageSize;

/** Page margins. A number is in CSS pixels, a string carries its unit (`'15mm'`). */
export type Margin =
  | number
  | string
  | {
      top?: number | string;
      right?: number | string;
      bottom?: number | string;
      left?: number | string;
    };

/** What the layout lint measures and how strictly. */
export interface LintOptions {
  /** Layout is fractional: something has to pass an edge by more than this many pixels to count. Default 1. */
  tolerancePx?: number;
  /** Text quoted in a warning is cut after this many characters. Default 40. */
  snippetLength?: number;
  /** An image source up to this long is used as the locator of a broken image. Longer ones (data URLs) are not. Default 100. */
  maxSourceLength?: number;
}

/** Options that can be set on a renderer and overridden on each `render()` call. */
export interface RenderOptions {
  /** The paper. Default `'A4'`. */
  format?: PageFormat;
  /**
   * A CSS selector for the elements that are the pages of a slide deck, for example `section.slide`. Each match is
   * one lint unit and starts a new PDF page. Matches inside another match are ignored. Without it the whole
   * document is one flowing document and only its width is linted.
   */
  pageSelector?: string;
  /** Page margins. Default none. The lint measures the area inside them. */
  margin?: Margin;
  /** Print background colours and images. Default `true`. */
  printBackground?: boolean;
  /**
   * Let a CSS `@page` rule in the HTML decide the page size and margins over `format` and `margin`. Default `true`.
   * With `false`, Chromium shrinks content that is wider than the page to fit it.
   */
  preferCSSPageSize?: boolean;
  /** Fast-forward finite CSS animations and transitions to their last frame before measuring and printing. Default `true`. */
  finishAnimations?: boolean;
  /** `false` turns the layout lint off. Blocked requests and missing assets are still reported. */
  lint?: false | LintOptions;
  /** How long one render may take once it starts, browser start included. Default 30000. */
  timeoutMs?: number;
  /** Serves the page's files. Without it every file request is answered with a 404 and reported. */
  resolveAsset?: AssetResolver;
  /** The virtual address the page lives at and `resolveAsset` resolves against. Default `http://document.invalid/`. */
  baseUrl?: string | URL;
}

/** Options of {@link createRenderer} and {@link renderPdf}. Everything in {@link RenderOptions} is a default for each render. */
export interface RendererOptions extends RenderOptions {
  /** How many renders run at once. Default 2. */
  concurrency?: number;
  /** How many more may wait for a free place before `render()` rejects with a {@link QueueFullError}. Default 20. */
  queueLimit?: number;
  /**
   * Playwright launch options for the shared Chromium, or an existing Playwright `Browser` to reuse. A browser you
   * pass is never closed by the renderer, and cannot be replaced if it dies.
   */
  launch?: LaunchOptions | Browser;
}

/** The kinds of finding a render can report. */
export type WarningCode =
  'overflow' | 'text-outside' | 'broken-image' | 'blocked-request' | 'missing-asset' | 'selector-no-match';

/** One finding. A warning never fails a render. */
export interface RenderWarning {
  code: WarningCode;
  /** The 1-based page (the position of the matched element), or `null` when it belongs to the whole document. */
  page: number | null;
  /** A short pointer: a CSS selector, a text snippet, an image source or a URL, depending on `code`. */
  locator: string;
  /** A sentence that says what was found, ending with the locator. */
  message: string;
}

/** What `render()` resolves with. */
export interface RenderResult {
  /** The PDF file. */
  pdf: Uint8Array;
  /** The number of pages in the PDF. */
  pages: number;
  /** Layout problems, blocked requests and missing assets, per page in page order, then the request-level ones. */
  warnings: RenderWarning[];
}

/** A shared Chromium with a queue in front of it. */
export interface Renderer {
  /** Prints `html` to a PDF. Options given here override the ones the renderer was created with. */
  render(html: string, options?: RenderOptions): Promise<RenderResult>;
  /** Rejects the renders that are waiting and closes the browser if the renderer started it. Safe to call twice. */
  close(): Promise<void>;
}
