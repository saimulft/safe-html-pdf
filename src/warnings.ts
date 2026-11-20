import type { InspectResult } from './inspect-page.ts';
import type { RequestReport } from './route-handler.ts';
import type { RenderWarning } from './types.ts';

export interface WarningContext {
  /** The printable area, in pixels. */
  width: number;
  height: number;
  /** The pageSelector, or `null` for a flowing document. */
  selector: string | null;
  snippetLength: number;
}

// The first characters of a text, by whole characters.
export function snippet(text: string, length: number): string {
  const characters = Array.from(text);
  return characters.length > length ? `${characters.slice(0, length).join('').trimEnd()}...` : text;
}

const MAX_URL_LENGTH = 200;

/** The warnings of one render: each page in order, then what the lockdown refused or could not find. */
export function buildWarnings(
  inspected: InspectResult,
  reports: Iterable<RequestReport>,
  context: WarningContext,
): RenderWarning[] {
  const { width, height, selector } = context;
  const area = selector === null ? `${width} px wide page` : `${width} x ${height} area`;
  const warnings: RenderWarning[] = [];

  inspected.units.forEach((unit, index) => {
    const page = selector === null ? null : index + 1;
    const name = page === null ? 'The document' : `Page ${page}`;
    if (unit.overflow) {
      const locator = unit.overflow.locator;
      warnings.push({
        code: 'overflow',
        page,
        locator,
        message:
          selector === null
            ? `The document is wider than the ${width} px page: ${locator}`
            : `${name} overflows its ${area}: ${locator}`,
      });
    }
    if (unit.outside.count > 0) {
      const locator = snippet(unit.outside.first, context.snippetLength);
      const more = unit.outside.count > 1 ? ` and ${unit.outside.count - 1} more` : '';
      warnings.push({
        code: 'text-outside',
        page,
        locator,
        message: `${name} draws text outside its ${area}: "${locator}"${more}`,
      });
    }
    // Each broken image is named once per page, however often it appears.
    const seen = new Set<string>();
    for (const image of unit.images) {
      const key = image.source || image.locator;
      if (seen.has(key)) continue;
      seen.add(key);
      const locator = image.source || image.locator;
      warnings.push({
        code: 'broken-image',
        page,
        locator,
        message: `${name}: image failed to load: ${locator}`,
      });
    }
  });

  if (selector !== null && inspected.units.length === 0) {
    warnings.push({
      code: 'selector-no-match',
      page: null,
      locator: selector,
      message: `pageSelector matched nothing, so the whole document was printed and no page was checked: ${selector}`,
    });
  }

  for (const report of reports) {
    const locator = snippet(report.url, MAX_URL_LENGTH);
    warnings.push(
      report.kind === 'blocked'
        ? {
            code: 'blocked-request',
            page: null,
            locator,
            message: `Blocked ${report.via} request to ${locator}`,
          }
        : {
            code: 'missing-asset',
            page: null,
            locator,
            message: `No file was served for the ${report.via} request to ${locator}`,
          },
    );
  }
  return warnings;
}
