/** Base class of every error this package throws on purpose. Check `error.code` to tell them apart. */
export class SafeHtmlPdfError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Thrown by `render()` when `concurrency` renders are running and `queueLimit` more are already waiting. */
export class QueueFullError extends SafeHtmlPdfError {
  declare readonly code: 'QUEUE_FULL';
  readonly queueLimit: number;

  constructor(queueLimit: number) {
    super('QUEUE_FULL', `The render queue is full: ${queueLimit} renders are already waiting.`);
    this.queueLimit = queueLimit;
  }
}

/**
 * Thrown when a render runs longer than `timeoutMs`. The render's browser context has been closed by then, so
 * nothing from it keeps running. The time spent waiting in the queue does not count.
 */
export class RenderTimeoutError extends SafeHtmlPdfError {
  declare readonly code: 'RENDER_TIMEOUT';
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super('RENDER_TIMEOUT', `The PDF was not finished within ${timeoutMs} ms, so the render was stopped.`);
    this.timeoutMs = timeoutMs;
  }
}

/** The reasons a browser could not be started (or reached). */
export type BrowserLaunchErrorCode = 'PLAYWRIGHT_NOT_INSTALLED' | 'BROWSER_NOT_INSTALLED' | 'BROWSER_LAUNCH_FAILED';

/**
 * Thrown when Chromium cannot be started: Playwright is not installed (`PLAYWRIGHT_NOT_INSTALLED`), its Chromium
 * download is missing (`BROWSER_NOT_INSTALLED`), or the launch failed for another reason (`BROWSER_LAUNCH_FAILED`).
 * The original error is in `cause`. A failed launch is not remembered: the next render tries again.
 */
export class BrowserLaunchError extends SafeHtmlPdfError {
  declare readonly code: BrowserLaunchErrorCode;

  constructor(code: BrowserLaunchErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

/**
 * Thrown when the browser closed or crashed during a render, or when the browser you passed in as `launch` is no
 * longer connected. A browser the renderer started itself is replaced on the next render.
 */
export class BrowserDisconnectedError extends SafeHtmlPdfError {
  declare readonly code: 'BROWSER_DISCONNECTED';

  constructor(message: string, options?: ErrorOptions) {
    super('BROWSER_DISCONNECTED', message, options);
  }
}

/**
 * Thrown when `resolveAsset` throws. A PDF with a font or a logo missing because the disk failed would be wrong, so
 * the render fails instead. Returning `null` from `resolveAsset` is not an error: that is a missing file.
 */
export class AssetResolveError extends SafeHtmlPdfError {
  declare readonly code: 'ASSET_RESOLVE_FAILED';
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      'ASSET_RESOLVE_FAILED',
      `resolveAsset failed for ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
    this.url = url;
  }
}

/** Thrown by `render()` when the renderer has been closed, and to renders that were still waiting when it closed. */
export class RendererClosedError extends SafeHtmlPdfError {
  declare readonly code: 'RENDERER_CLOSED';

  constructor() {
    super('RENDERER_CLOSED', 'The renderer has been closed.');
  }
}
