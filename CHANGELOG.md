# Changelog

## 0.1.0

Initial release.

- `createRenderer()` and `renderPdf()`: HTML to PDF in a shared Chromium that recovers from crashes, with a fresh context per render, a concurrency cap (default 2), a wait-queue cap (default 20) and a hard time limit that closes the context.
- Lockdown: JavaScript off, only the page and the files `resolveAsset` returns are served, every other request is aborted and reported.
- Layout lint per page or slide: overflow, text drawn outside the page and broken images, each as a warning with a code, a page number and a locator.
- A4, Letter, 16:9 slides or a custom size, a `pageSelector` for decks, margins and `printBackground`.
- Typed errors for a full queue, a timeout, a browser that cannot launch or has gone away, and a failing asset resolver.
- `safe-html-pdf` command line with `--assets`, `--strict` and `--json`.
