import { inflateSync } from 'node:zlib';

const latin1 = (pdf: Uint8Array) => Buffer.from(pdf).toString('latin1');

export const startsLikePdf = (pdf: Uint8Array) => latin1(pdf).startsWith('%PDF-');

export const pageCount = (pdf: Uint8Array) => (latin1(pdf).match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;

/** The [x0, y0, x1, y1] media box of every page, in points. */
export const mediaBoxes = (pdf: Uint8Array) =>
  [...latin1(pdf).matchAll(/\/MediaBox\s*\[([^\]]*)\]/g)].map(([, box]) => box.trim().split(/\s+/).map(Number));

export const hasImage = (pdf: Uint8Array) => /\/Subtype\s*\/Image/.test(latin1(pdf));

/** The PDF with its compressed content streams inflated, as latin1 text, so drawing operators can be searched. */
export function inflated(pdf: Uint8Array): string {
  const source = latin1(pdf);
  let text = source;
  for (const [, body] of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      text += `\n${inflateSync(Buffer.from(body, 'latin1')).toString('latin1')}`;
    } catch {
      // Not a Flate stream (an image, a font): nothing to search in it.
    }
  }
  return text;
}
