import type { Margin, PageFormat } from './types.ts';

const PX_PER_UNIT: Record<string, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16 };
const LENGTH = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(px|in|cm|mm|pt|pc)?\s*$/i;

/** A CSS length ("12", "210mm", "8.5in") in pixels, or `null` when it is not one. A bare number is pixels. */
export function lengthToPx(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = LENGTH.exec(value);
  if (!match) return null;
  return Number(match[1]) * PX_PER_UNIT[(match[2] ?? 'px').toLowerCase()];
}

export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ResolvedFormat {
  /** The paper in pixels (rounded, so it can be a viewport). */
  width: number;
  height: number;
  /** What to give Playwright's `page.pdf()`. */
  pdf: { format: 'A4' | 'Letter' } | { width: string; height: string };
}

/** The pixel size and `page.pdf()` arguments of a format. Throws a TypeError for one that is not valid. */
export function resolveFormat(format: PageFormat): ResolvedFormat {
  if (typeof format === 'string') {
    switch (format.toLowerCase()) {
      case 'a4':
        return { width: 794, height: 1123, pdf: { format: 'A4' } };
      case 'letter':
        return { width: 816, height: 1056, pdf: { format: 'Letter' } };
      case 'slides':
        return { width: 1280, height: 720, pdf: { width: '1280px', height: '720px' } };
      default:
        throw new TypeError(`Unknown format "${format}": use "A4", "Letter", "slides" or { width, height }.`);
    }
  }
  if (format && typeof format === 'object') {
    const width = lengthToPx(format.width);
    const height = lengthToPx(format.height);
    if (width && height) {
      return {
        width: Math.round(width),
        height: Math.round(height),
        pdf: { width: `${width}px`, height: `${height}px` },
      };
    }
  }
  throw new TypeError(
    'format { width, height } needs two lengths above 0, for example { width: 1280, height: "720px" }.',
  );
}

/** The four margins in pixels. Throws a TypeError for one that is not valid. */
export function resolveMargin(margin: Margin | undefined): Box {
  const parts: Record<keyof Box, unknown> =
    margin !== null && typeof margin === 'object'
      ? { top: margin.top ?? 0, right: margin.right ?? 0, bottom: margin.bottom ?? 0, left: margin.left ?? 0 }
      : { top: margin ?? 0, right: margin ?? 0, bottom: margin ?? 0, left: margin ?? 0 };
  const box = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const side of Object.keys(box) as (keyof Box)[]) {
    const px = lengthToPx(parts[side]);
    if (px === null)
      throw new TypeError(`margin ${side} must be a length such as 12 or "15mm", not ${String(parts[side])}.`);
    box[side] = px;
  }
  return box;
}

/**
 * Reads the CLI's `--format` value: `A4`, `Letter`, `slides` or `WIDTHxHEIGHT` (pixels, or with units:
 * `1280x720`, `210mmx297mm`). Returns `null` for anything else.
 */
export function parseFormatArgument(value: string): PageFormat | null {
  const named = value.trim().toLowerCase();
  if (named === 'a4') return 'A4';
  if (named === 'letter') return 'Letter';
  if (named === 'slides') return 'slides';
  const match = /^\s*([\d.]+\s*[a-z]*?)\s*x\s*([\d.]+\s*[a-z]*)\s*$/i.exec(value);
  if (!match) return null;
  const [, width, height] = match;
  return lengthToPx(width) && lengthToPx(height) ? { width: width.trim(), height: height.trim() } : null;
}
