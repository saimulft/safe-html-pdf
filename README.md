# safe-html-pdf

Render untrusted or AI-written HTML to PDF with Playwright: no JavaScript, no network, hard limits, and a layout lint.

[![npm version](https://img.shields.io/npm/v/safe-html-pdf)](https://www.npmjs.com/package/safe-html-pdf)
[![license](https://img.shields.io/npm/l/safe-html-pdf)](https://www.npmjs.com/package/safe-html-pdf)
[![node version](https://img.shields.io/node/v/safe-html-pdf)](https://www.npmjs.com/package/safe-html-pdf)

It renders the quotation PDFs in the [Bundlewise CRM](https://crm.bundlewise.app).

safe-html-pdf prints HTML to a PDF in headless Chromium with JavaScript turned off and every network request refused. The page can only load files you hand it through a `resolveAsset` callback. While the page is open it also checks the layout, per page or per slide, and tells you about overflow, text drawn outside the page and images that failed to load, so a bad document is caught before anyone opens it.

`html-pdf-node` and `puppeteer-html-pdf` also print HTML to PDF, but they leave JavaScript and the network on and say nothing about the layout. That is fine for HTML you wrote yourself. It is the wrong default for HTML written by a model or a user.

## Install

```sh
npm install safe-html-pdf playwright
npx playwright install chromium
```

`playwright` is a peer dependency (version 1.40 or newer; the tests run against 1.63). Node 20 or newer.

## CLI

```
safe-html-pdf <input.html> [-o out.pdf] [options]

  -o, --output <file>         PDF to write (default: the input name with .pdf)
      --format <format>       A4 (default), Letter, slides (1280x720) or WIDTHxHEIGHT
                              in pixels or with units, for example 1280x720 or 210mmx297mm
      --page-selector <css>   Elements that are the pages of a deck, for example section.slide
      --assets <dir>          Serve the page's images, fonts and styles from this folder
      --strict                Exit 1 when there are any warnings
      --json                  Print the result as JSON
      --timeout <ms>          Stop a render that takes longer (default 30000)
  -h, --help                  Show this help
  -v, --version               Show the version
```

Exit codes: `0` done, `1` failed (a render error, or warnings with `--strict`), `2` wrong usage. The PDF is written even when `--strict` fails the run.

A three-slide deck with a logo, one slide whose cards run off the bottom, and one slide with a missing and an external image:

```sh
$ safe-html-pdf proposal.html -o proposal.pdf --format slides --page-selector section.slide --assets assets
Wrote proposal.pdf (3 pages, 15.1 KB)

5 warnings
  page 2  overflow          Page 2 overflows its 1280 x 720 area: div.card
  page 3  broken-image      Page 3: image failed to load: /team.png
  page 3  broken-image      Page 3: image failed to load: https://cdn.example.com/photo.jpg
  -       missing-asset     No file was served for the image request to http://document.invalid/team.png
  -       blocked-request   Blocked image request to https://cdn.example.com/photo.jpg
```

With `--json` the same result is printed as `{ "output", "pages", "bytes", "warnings": [...] }`, and errors go to stderr as `{ "error": { "code", "message" } }`.

`--assets` serves files from one folder: `/img/logo.png` in the page is `<dir>/img/logo.png`. A path that goes up a folder (`..`, a backslash or an encoded form of either) or that leaves the folder through a symbolic link is refused and counts as a missing file.

## API

```ts
import { writeFile } from 'node:fs/promises';
import { createRenderer } from 'safe-html-pdf';

const renderer = createRenderer({ concurrency: 4 });

const { pdf, pages, warnings } = await renderer.render(html, {
  format: 'slides',
  pageSelector: 'section.slide',
});
await writeFile('deck.pdf', pdf);

for (const warning of warnings) console.warn(warning.message);
await renderer.close();
```

### `createRenderer(options?)`

Starts a renderer: one shared Chromium that starts on first use and starts again after it closes or crashes, a fresh browser context for every render, a cap on how many renders run at once, and a queue in front of it. Returns `{ render, close }`. Close it when you are done, or the process will not exit.

`renderer.render(html, options?)` resolves with `{ pdf, pages, warnings }`. `renderer.close()` rejects the renders that are waiting and closes the browser (unless you passed one in).

| Option              | Default                      | Meaning                                                                                              |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `concurrency`       | `2`                          | Renders running at once.                                                                             |
| `queueLimit`        | `20`                         | Renders that may wait for a place. The next one rejects with `QueueFullError`.                       |
| `launch`            | `{}`                         | Playwright launch options, or an existing Playwright `Browser` to reuse (never closed).              |
| `timeoutMs`         | `30000`                      | Time one render may take once it starts, browser start included. Waiting does not count.             |
| `format`            | `'A4'`                       | `'A4'`, `'Letter'`, `'slides'` (1280 x 720 px) or `{ width, height }` in pixels or `'210mm'`.        |
| `pageSelector`      | none                         | CSS selector of the pages of a deck, such as `'section.slide'`. None means one flowing document.     |
| `margin`            | none                         | A length for all sides, or `{ top, right, bottom, left }`. Numbers are pixels.                       |
| `printBackground`   | `true`                       | Print background colours and images.                                                                 |
| `preferCSSPageSize` | `true`                       | Let a CSS `@page` rule in the HTML set the size and margins.                                         |
| `finishAnimations`  | `true`                       | Fast-forward finite CSS animations to their last frame before measuring and printing.                |
| `lint`              | on                           | `false` turns the layout lint off, or `{ tolerancePx: 1, snippetLength: 40, maxSourceLength: 100 }`. |
| `resolveAsset`      | serves nothing               | `(url: URL) => { body, contentType } \| null`, sync or async. See below.                             |
| `baseUrl`           | `'http://document.invalid/'` | The virtual address of the page. Relative URLs in the HTML resolve against it.                       |

Everything except `concurrency`, `queueLimit` and `launch` is a default that each `render()` call can override.

### `renderPdf(html, options?)`

A one-shot `createRenderer` + `render` + `close`. Takes the same options.

```ts
import { renderPdf } from 'safe-html-pdf';

const { pdf } = await renderPdf('<h1>Invoice</h1>', { format: 'Letter', margin: '15mm' });
```

### `resolveAsset` and `createDirectoryAssetResolver(dir)`

The page lives at `baseUrl` and every file it asks for is answered by `resolveAsset(url)`. It gets the absolute `URL` on that origin, percent-encoded as the browser sent it, and returns `{ body: Uint8Array | string, contentType?: string }`, or `null` for a file that does not exist (a 404 that is reported as `missing-asset`). A throw fails the render with an `AssetResolveError`.

```ts
const renderer = createRenderer({
  resolveAsset: (url) => (url.pathname === '/logo.png' ? { body: logoBytes, contentType: 'image/png' } : null),
});
```

`createDirectoryAssetResolver(dir)` is the resolver the CLI's `--assets` uses: it serves a folder and refuses paths that escape it.

### Result

| Field      | Type              | Meaning                                                                        |
| ---------- | ----------------- | ------------------------------------------------------------------------------ |
| `pdf`      | `Uint8Array`      | The PDF file.                                                                  |
| `pages`    | `number`          | Pages in the PDF.                                                              |
| `warnings` | `RenderWarning[]` | Findings, per page in page order, then the request-level ones. Never an error. |

A warning is `{ code, page, locator, message }`. `page` is the 1-based position of the matched element, or `null` when the finding belongs to the whole document.

| `code`              | `page` | `locator`                             | Meaning                                                                              |
| ------------------- | ------ | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `overflow`          | page   | selector of the element past the edge | Content is bigger than the page, or a page element is taller or wider than the page. |
| `text-outside`      | page   | the first text, cut short             | Text is drawn outside the page. The message adds "and N more".                       |
| `broken-image`      | page   | the image source, or its selector     | An `<img>` that is shown failed to load.                                             |
| `blocked-request`   | `null` | the URL                               | The page asked for something outside the base origin and it was refused.             |
| `missing-asset`     | `null` | the URL                               | `resolveAsset` had no file for a request.                                            |
| `selector-no-match` | `null` | the selector                          | `pageSelector` matched nothing, so the whole document was printed.                   |

### Errors

Every error this package throws on purpose extends `SafeHtmlPdfError` and has a `code`.

| Class                      | `code`                                                                       | When                                                                     |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `QueueFullError`           | `QUEUE_FULL`                                                                 | `concurrency` renders are running and `queueLimit` are already waiting.  |
| `RenderTimeoutError`       | `RENDER_TIMEOUT`                                                             | A render ran longer than `timeoutMs`. Its browser context was closed.    |
| `BrowserLaunchError`       | `PLAYWRIGHT_NOT_INSTALLED`, `BROWSER_NOT_INSTALLED`, `BROWSER_LAUNCH_FAILED` | Chromium could not be started. The next render tries again.              |
| `BrowserDisconnectedError` | `BROWSER_DISCONNECTED`                                                       | Chromium closed or crashed mid-render. The next render starts a new one. |
| `AssetResolveError`        | `ASSET_RESOLVE_FAILED`                                                       | `resolveAsset` threw.                                                    |
| `RendererClosedError`      | `RENDERER_CLOSED`                                                            | `render()` after `close()`, or a render still waiting when it closed.    |

A page that navigates away (a `<meta http-equiv="refresh">` to another address, for example) fails with a plain `SafeHtmlPdfError` with the code `PAGE_NAVIGATED`. Bad options throw `TypeError` or `RangeError`.

In a container, or as root, Chromium may refuse to start with its sandbox on. Pass `launch: { chromiumSandbox: false }` and isolate the container yourself; the package does not turn the sandbox off for you.

## What the lockdown does

- JavaScript is disabled for the whole browser context: inline scripts, event handlers and `javascript:` URLs do not run, and `<noscript>` content is shown.
- Only the page itself and the files `resolveAsset` returns are served. Every other request, whatever its type (image, stylesheet, font, iframe, media, navigation) and whatever its scheme or port, is aborted and reported as `blocked-request`. Requests with a method other than GET and HEAD are aborted too.
- `file://` is not served: a page on an `http` origin cannot load local files, and those requests are reported as broken images or not at all.
- A page that tries to navigate away fails the render instead of printing an error page.
- Service workers are blocked and downloads are off. Every render gets a new browser context, so cookies, cache and storage never carry over.
- A render that passes `timeoutMs` is stopped and its context is closed.
- At most `concurrency` renders run at once, and at most `queueLimit` wait. Beyond that, `render()` rejects at once.

## What the lint checks

The check runs inside the page, after fonts and images have loaded, with print styles applied.

- **Overflow.** The content of a page is bigger than the page and something that counts as content is past the edge: drawn text, or a box of the page flow. An absolutely positioned shape with no text is decoration (a circle bleeding off a corner) and is ignored. A page element that is itself taller or wider than the page is reported too.
- **Text outside the page.** Pieces of text that are drawn outside the page. Text that is hidden, fully transparent or cut off by a box with `overflow: hidden` (an ellipsis) is not counted.
- **Broken images.** Visible `<img>` elements that failed to load, once per image per page. Hidden images and images with no `src` are skipped.
- **Lazy images.** `loading="lazy"` is overridden so images far down the page are loaded and printed.

With `pageSelector`, each match is a page, matches inside another match are ignored, and every match but the last starts a new PDF page. Without it the document is one flowing document: it may be as tall as it likes, and only content wider than the page is reported.

## Limits

- It is not an operating-system sandbox. Switching off JavaScript and the network removes the usual attack surface, but a Chromium bug is still a Chromium bug. For untrusted input, run it as an unprivileged user in a container.
- Time is the only per-render resource limit. A hostile page can use CPU and memory until `timeoutMs`, and there is no cap on the size of the HTML, the number of pages or memory. Put those in front of it if you need them.
- The queue and the concurrency limit belong to one renderer. Two renderers (or two processes) each have their own.
- Pages that need JavaScript to show their content (charts, client-side frameworks) print empty. That is the point, and also the limit.
- Web fonts from the network are never loaded. Text uses the fonts on the machine plus the ones you serve through `resolveAsset`.
- The lint measures a viewport the size of the page with print styles applied, not the print layout itself. A CSS `@page` rule that changes the size or margins (with `preferCSSPageSize`, the default) is not what the lint measures against.
- In a flowing document the lint cannot tell which PDF page a finding is on, so `page` is `null`.
- With `pageSelector`, `page` is the position of the matched element. A page that is taller than the paper (and not clipped) spills onto extra PDF sheets, so `pages` can be larger than the number of matches.
- Background images and fonts that fail to load are only visible as `missing-asset` or `blocked-request`; the lint can only look inside `<img>` elements. An SVG image without a size can be reported as broken.
- A browser you pass as `launch` is never replaced if it dies; renders then fail with `BrowserDisconnectedError`.
- Developed and tested with Playwright 1.63 and its Chromium. Older versions in the peer range have not been run.

## License

MIT © Saimul Islam
