// A real 1 x 1 PNG, so an <img> that loads has something to decode.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A 1280 x 720 slide, the size of the "slides" format. */
export const slide = (inner = '', style = '') =>
  `<section class="slide" style="position:relative;width:1280px;height:720px;overflow:hidden;${style}">${inner}</section>`;

/** A deck of slides in a page with no margin. */
export const deck = (...slides: string[]) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${slides.join('')}</body></html>`;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise you settle from outside, to hold a render at a chosen point. */
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
