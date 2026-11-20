#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createDirectoryAssetResolver } from './directory-assets.ts';
import { SafeHtmlPdfError } from './errors.ts';
import { parseFormatArgument } from './page-size.ts';
import { renderPdf } from './renderer.ts';
import type { RenderWarning } from './types.ts';

const USAGE = `Usage: safe-html-pdf <input.html> [-o out.pdf] [options]

Prints an HTML file to a PDF with JavaScript and the network switched off, and
reports layout problems: overflow, text outside the page and broken images.

Options:
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

Exit codes: 0 done, 1 failed (or warnings with --strict), 2 wrong usage.
`;

class UsageError extends Error {}

function readVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function formatWarning(warning: RenderWarning): string {
  const page = warning.page === null ? '-' : `page ${warning.page}`;
  return `  ${page.padEnd(8)}${warning.code.padEnd(18)}${warning.message}`;
}

function parseCommandLine(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        format: { type: 'string' },
        'page-selector': { type: 'string' },
        assets: { type: 'string' },
        strict: { type: 'boolean' },
        json: { type: 'boolean' },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help || values.version) return { values, input: '', timeoutMs: undefined, format: undefined };
  if (positionals.length !== 1) {
    throw new UsageError(positionals.length === 0 ? 'Missing the input file.' : 'Give exactly one input file.');
  }

  let format;
  if (values.format !== undefined) {
    format = parseFormatArgument(values.format) ?? undefined;
    if (!format) throw new UsageError(`Unknown --format "${values.format}": use A4, Letter, slides or WIDTHxHEIGHT.`);
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = /^\d+$/.test(values.timeout) ? Number(values.timeout) : Number.NaN;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) {
      throw new UsageError('--timeout needs a number of milliseconds above 0.');
    }
  }
  if (values['page-selector'] !== undefined && !values['page-selector'].trim()) {
    throw new UsageError('--page-selector needs a CSS selector.');
  }
  return { values, input: positionals[0], timeoutMs, format };
}

/** Runs the command line and returns the exit code. */
async function main(argv: string[]): Promise<number> {
  let command;
  try {
    command = parseCommandLine(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`safe-html-pdf: ${error.message}\nRun safe-html-pdf --help for usage.\n`);
    return 2;
  }
  const { values, input, timeoutMs, format } = command;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const output = values.output ?? path.join(path.dirname(input), `${path.basename(input, path.extname(input))}.pdf`);
  try {
    let html: string;
    try {
      html = await readFile(input, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read ${input}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, {
        cause: error,
      });
    }
    const { pdf, pages, warnings } = await renderPdf(html, {
      format,
      pageSelector: values['page-selector'],
      timeoutMs,
      resolveAsset: values.assets === undefined ? undefined : createDirectoryAssetResolver(values.assets),
    });
    await writeFile(output, pdf);

    if (values.json) {
      process.stdout.write(`${JSON.stringify({ output, pages, bytes: pdf.byteLength, warnings }, null, 2)}\n`);
    } else {
      let text = `Wrote ${output} (${plural(pages, 'page')}, ${formatBytes(pdf.byteLength)})\n`;
      if (warnings.length > 0)
        text += `\n${plural(warnings.length, 'warning')}\n${warnings.map(formatWarning).join('\n')}\n`;
      else text += 'No warnings.\n';
      process.stdout.write(text);
    }
    return values.strict && warnings.length > 0 ? 1 : 0;
  } catch (error) {
    const code = error instanceof SafeHtmlPdfError ? error.code : 'ERROR';
    const message = error instanceof Error ? error.message : String(error);
    if (values.json) process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    else process.stderr.write(`safe-html-pdf: ${message}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
