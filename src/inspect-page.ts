/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

// The code in this file runs inside the page, in Chromium, not in Node. Playwright sends the source text of
// `inspectPage`, so the function has to be self-contained: nothing from this file or from an import can be used
// inside it, and it must not use syntax that the TypeScript compiler turns into a helper call.

/** What `inspectPage` is told. */
export interface InspectArgs {
  /** The elements that are the pages, or `null` for a flowing document. */
  selector: string | null;
  /** The printable area in pixels. */
  width: number;
  height: number;
  tolerance: number;
  /** `false` skips the measuring. The page is still prepared for printing. */
  lint: boolean;
  finishAnimations: boolean;
  maxSourceLength: number;
}

/** What `inspectPage` finds for one page (or for the whole document). */
export interface UnitFindings {
  /** Content past the edge, with a short locator of what is past it; or `null`. */
  overflow: { locator: string } | null;
  /** How many pieces of drawn text are outside, and the first of them (cut at 200 characters). */
  outside: { count: number; first: string };
  /** The images that failed to load. `source` is empty when it is too long to be a locator. */
  images: { source: string; locator: string }[];
}

export interface InspectResult {
  invalidSelector: boolean;
  units: UnitFindings[];
}

/**
 * Prepares the page for printing and measures it. It waits for the fonts and images, fast-forwards finished
 * animations, starts every page of a deck on a new sheet, and then looks at each page, that is, each match of
 * `selector` that is not inside another match, or at the document as a whole. A page is
 * - overflowing when its content is bigger than the printable area (it scrolls) and something that counts as
 *   content is out of it: drawn text, or a box of the page flow. A shape with position absolute or fixed that holds
 *   no text is decoration, such as a circle in a corner, and may run off the page on purpose, so it is not content;
 * - drawing text outside when pieces of text are drawn outside the area. Only what is drawn counts: text that is
 *   hidden, fully transparent or cut away by a box with hidden overflow (an ellipsis) is not outside.
 * A flowing document is only measured sideways: it may be as tall as it likes.
 */
export async function inspectPage(args: InspectArgs): Promise<InspectResult> {
  const { selector, width, height, tolerance, maxSourceLength } = args;

  let matches: Element[] = [];
  if (selector !== null) {
    try {
      matches = [...document.querySelectorAll(selector)];
    } catch {
      return { invalidSelector: true, units: [] };
    }
  }
  const units =
    selector === null ? [document.documentElement] : matches.filter((unit) => !unit.parentElement?.closest(selector));

  // Images far below the fold are not loaded unless the page says to; the printout needs all of them.
  for (const image of document.images) image.loading = 'eager';
  await document.fonts.ready;
  await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
  if (args.finishAnimations) {
    for (const animation of document.getAnimations()) {
      try {
        animation.finish();
      } catch {
        // An endless animation has no last frame.
      }
    }
  }
  // Every page but the last ends the sheet. Set on the element, so a page's own style rules cannot block it.
  if (selector !== null) {
    for (const unit of units.slice(0, -1)) (unit as HTMLElement).style?.setProperty('break-after', 'page');
  }
  if (!args.lint)
    return {
      invalidSelector: false,
      units: units.map(() => ({ overflow: null, outside: { count: 0, first: '' }, images: [] })),
    };

  // A short name for an element: tag, id or the first two classes, and its place among same-named siblings.
  function describe(element: Element): string {
    let name = element.localName;
    if (element.id) return `${name}#${CSS.escape(element.id)}`;
    name += [...element.classList]
      .slice(0, 2)
      .map((className) => `.${CSS.escape(className)}`)
      .join('');
    const siblings = element.parentElement
      ? [...element.parentElement.children].filter((n) => n.localName === element.localName)
      : [];
    if (!element.classList.length && siblings.length > 1) name += `:nth-of-type(${siblings.indexOf(element) + 1})`;
    return name;
  }

  return {
    invalidSelector: false,
    units: units.map((unit): UnitFindings => {
      const box = unit.getBoundingClientRect();
      // The printable area, anchored where the page starts. A flowing document has no bottom edge.
      const area =
        selector === null
          ? { left: 0, top: -Infinity, right: width, bottom: Infinity }
          : { left: box.left, top: box.top, right: box.left + width, bottom: box.top + height };
      const outsideArea = (rect: { left: number; top: number; right: number; bottom: number }) =>
        rect.left < area.left - tolerance ||
        rect.top < area.top - tolerance ||
        rect.right > area.right + tolerance ||
        rect.bottom > area.bottom + tolerance;

      // Hidden, or inside something fully transparent: not drawn.
      function hidden(element: Element): boolean {
        if (['hidden', 'collapse'].includes(getComputedStyle(element).visibility)) return true;
        for (let node: Element | null = element; node; node = node === unit ? null : node.parentElement) {
          if (Number(getComputedStyle(node).opacity) === 0) return true;
        }
        return false;
      }

      // The part of `rect` that is drawn: what an ancestor with hidden overflow (below the page) cuts away is not.
      // null when none of it is.
      function drawn(rect: { left: number; top: number; right: number; bottom: number }, from: Element | null) {
        let { left, top, right, bottom } = rect;
        for (let node = from; node && node !== unit; node = node.parentElement) {
          const style = getComputedStyle(node);
          // An inline box does not clip, but an inline svg does.
          if (node.localName !== 'svg' && (style.display === 'inline' || style.display === 'contents')) continue;
          const clipsX = style.overflowX !== 'visible';
          const clipsY = style.overflowY !== 'visible';
          if (!clipsX && !clipsY) continue;
          const clip = node.getBoundingClientRect();
          if (clipsX) {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
          if (clipsY) {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
          if (left >= right || top >= bottom) return null;
        }
        return { left, top, right, bottom };
      }

      const decorations = new Map<Element, boolean>();
      function isDecoration(element: Element | null): boolean {
        if (!element || element === unit) return false;
        let known = decorations.get(element);
        if (known === undefined) {
          const placed = ['absolute', 'fixed'].includes(getComputedStyle(element).position);
          known = (placed && !element.textContent?.trim()) || isDecoration(element.parentElement);
          decorations.set(element, known);
        }
        return known;
      }

      const outside: string[] = [];
      let firstOutsideParent: Element | null = null;
      const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const text = node.data.replace(/\s+/g, ' ').trim();
        const parent = node.parentElement;
        if (!text || !parent) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (!outsideArea(range.getBoundingClientRect()) || hidden(parent)) continue;
        const seen = [...range.getClientRects()].some((rect) => {
          if (rect.width <= 0 || rect.height <= 0) return false;
          const visible = drawn(rect, parent);
          return visible !== null && outsideArea(visible);
        });
        if (seen) {
          outside.push(text);
          firstOutsideParent ??= parent;
        }
      }

      // A box of the page flow that is drawn, at least in part, outside the area.
      function boxEscapes(element: Element): boolean {
        if ((element as SVGElement).ownerSVGElement) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || !outsideArea(rect)) return false;
        if (isDecoration(element) || hidden(element)) return false;
        const visible = drawn(rect, element.parentElement);
        return visible !== null && outsideArea(visible);
      }

      // A page that is itself bigger than the printable area spills onto the next sheet.
      const tooBig = selector !== null && (box.width > width + tolerance || box.height > height + tolerance);
      const scrolls =
        unit.scrollWidth > width + tolerance || (selector !== null && unit.scrollHeight > height + tolerance);
      let escaping: Element | null = null;
      if (scrolls) {
        for (const element of unit.querySelectorAll('*')) {
          if (boxEscapes(element)) {
            escaping = element;
            break;
          }
        }
      }
      let overflow: UnitFindings['overflow'] = null;
      if (tooBig) overflow = { locator: describe(unit) };
      else if (scrolls && (escaping || outside.length > 0)) {
        overflow = { locator: describe((escaping ?? firstOutsideParent) as Element) };
      }

      const images: UnitFindings['images'] = [];
      for (const image of unit.querySelectorAll('img')) {
        const source = (image.getAttribute('src') || image.currentSrc || '').replace(/\s+/g, ' ').trim();
        if (!source || image.getClientRects().length === 0 || hidden(image)) continue;
        if (image.complete && image.naturalWidth === 0) {
          images.push({ source: source.length <= maxSourceLength ? source : '', locator: describe(image) });
        }
      }

      return { overflow, outside: { count: outside.length, first: (outside[0] ?? '').slice(0, 200) }, images };
    }),
  };
}
