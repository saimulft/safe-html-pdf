import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { deck, PNG, slide } from './helpers/fixtures.ts';
import { hasImage, mediaBoxes, pageCount, startsLikePdf } from './helpers/pdf.ts';

const TIMEOUT = { timeout: 120000 };
const ROOT = process.cwd();
const DECK = ['--format', 'slides', '--page-selector', 'section.slide'];

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs `node src/cli.ts` the way a user runs the installed command, and reports how it ended.
function cli(args: string[], cwd = ROOT): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'src/cli.ts'), ...args],
      { cwd, timeout: 90000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('command line', TIMEOUT, () => {
  let dir: string;
  const file = (name: string) => path.join(dir, name);

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'safe-html-pdf-cli-'));
    await writeFile(file('page.html'), '<!doctype html><h1>Hello</h1><p>A page.</p>');
    await writeFile(
      file('deck.html'),
      deck(slide('<h1>One</h1>'), slide('<h1>Two</h1>'), slide('<div style="height:900px"></div>')),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders a file and prints a short summary', async () => {
    const result = await cli([file('page.html'), '-o', file('out.pdf')]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `Wrote ${file('out.pdf')} (1 page, ${(await size('out.pdf')).label})\nNo warnings.\n`);
    assert.ok(startsLikePdf(await readFile(file('out.pdf'))));
  });

  async function size(name: string) {
    const { size: bytes } = await stat(file(name));
    return { bytes, label: `${(bytes / 1024).toFixed(1)} KB` };
  }

  it('names the PDF after the input when there is no -o', async () => {
    const result = await cli([file('page.html')]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(startsLikePdf(await readFile(file('page.pdf'))));
  });

  it('lists warnings and still exits 0, unless --strict', async () => {
    const args = [file('deck.html'), '-o', file('deck.pdf'), '--format', 'slides', '--page-selector', 'section.slide'];
    const lenient = await cli(args);
    assert.equal(lenient.code, 0, lenient.stderr);
    assert.match(lenient.stdout, /\(3 pages, /);
    assert.match(lenient.stdout, /\n1 warning\n/);
    assert.match(lenient.stdout, /page 3\s+overflow\s+Page 3 overflows its 1280 x 720 area: div\n$/);

    const strict = await cli([...args, '--strict']);
    assert.equal(strict.code, 1);
    assert.match(strict.stdout, /1 warning/);
    // The PDF is written either way.
    assert.equal(pageCount(await readFile(file('deck.pdf'))), 3);
    assert.deepEqual(
      new Set(mediaBoxes(await readFile(file('deck.pdf'))).map((box) => box.join(' '))),
      new Set(['0 0 960 540']),
    );
  });

  it('exits 0 with --strict when there is nothing to report', async () => {
    const result = await cli([file('page.html'), '-o', file('strict.pdf'), '--strict']);
    assert.equal(result.code, 0, result.stderr);
  });

  it('prints JSON with --json', async () => {
    const result = await cli([
      file('deck.html'),
      '-o',
      file('json.pdf'),
      '--format',
      'slides',
      '--page-selector',
      'section.slide',
      '--json',
    ]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.output, file('json.pdf'));
    assert.equal(report.pages, 3);
    assert.equal(report.bytes, (await stat(file('json.pdf'))).size);
    assert.deepEqual(
      report.warnings.map((warning: { code: string; page: number }) => [warning.code, warning.page]),
      [['overflow', 3]],
    );
    assert.deepEqual(Object.keys(report.warnings[0]).sort(), ['code', 'locator', 'message', 'page']);
  });

  it('takes WIDTHxHEIGHT, with or without units, as the format', async () => {
    const pixels = await cli([file('page.html'), '-o', file('pixels.pdf'), '--format', '600x400']);
    assert.equal(pixels.code, 0, pixels.stderr);
    assert.deepEqual(mediaBoxes(await readFile(file('pixels.pdf')))[0], [0, 0, 450, 300]);

    const letter = await cli([file('page.html'), '-o', file('letter.pdf'), '--format', 'Letter']);
    assert.equal(letter.code, 0, letter.stderr);
    assert.deepEqual(mediaBoxes(await readFile(file('letter.pdf')))[0], [0, 0, 612, 792]);
  });

  describe('--assets', () => {
    before(async () => {
      await mkdir(file('assets/img'), { recursive: true });
      await writeFile(file('assets/img/logo.png'), PNG);
      // A real image outside the folder: if the render ever reaches it, the PDF contains an image.
      await writeFile(file('secret.png'), PNG);
      await symlink(file('secret.png'), file('assets/leak.png'));
      await writeFile(file('logo.html'), deck(slide('<img src="img/logo.png" alt="" style="width:40px">')));
      await writeFile(
        file('escape.html'),
        deck(
          slide(
            '<img src="/..%2Fsecret.png" alt="" style="width:40px">' +
              '<img src="/img/..%2F..%2Fsecret.png" alt="" style="width:40px">' +
              '<img src="/%252e%252e%252fsecret.png" alt="" style="width:40px">' +
              '<img src="/leak.png" alt="" style="width:40px">',
          ),
        ),
      );
    });

    it('serves the page its files from the folder', async () => {
      const result = await cli([
        file('logo.html'),
        '-o',
        file('logo.pdf'),
        '--assets',
        file('assets'),
        '--strict',
        ...DECK,
      ]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.ok(hasImage(await readFile(file('logo.pdf'))));
    });

    it('has no files to serve without --assets', async () => {
      const result = await cli([file('logo.html'), '-o', file('none.pdf'), '--json', ...DECK]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(
        JSON.parse(result.stdout).warnings.map((warning: { code: string }) => warning.code),
        ['broken-image', 'missing-asset'],
      );
      assert.equal(hasImage(await readFile(file('none.pdf'))), false);
    });

    it('refuses every path that leaves the folder, links included', async () => {
      const result = await cli([
        file('escape.html'),
        '-o',
        file('escape.pdf'),
        '--assets',
        file('assets'),
        '--json',
        ...DECK,
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hasImage(await readFile(file('escape.pdf'))), false, 'a file outside the folder was served');
      const warnings = JSON.parse(result.stdout).warnings as { code: string }[];
      assert.equal(warnings.filter((warning) => warning.code === 'broken-image').length, 4);
    });

    it('fails when the folder does not exist', async () => {
      const result = await cli([file('logo.html'), '-o', file('nofolder.pdf'), '--assets', file('no-such-folder')]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /ENOENT/);
    });
  });

  describe('usage errors exit 2', () => {
    const cases: [name: string, args: string[], message: RegExp][] = [
      ['no input', [], /Missing the input file/],
      ['two inputs', ['a.html', 'b.html'], /exactly one input/],
      ['an unknown option', ['page.html', '--nope'], /--nope/],
      ['a bad format', ['page.html', '--format', 'A5'], /Unknown --format "A5"/],
      ['a bad format size', ['page.html', '--format', '0x0'], /Unknown --format/],
      ['a timeout that is not a number', ['page.html', '--timeout', 'soon'], /--timeout needs a number/],
      ['a timeout of 0', ['page.html', '--timeout', '0'], /--timeout needs a number/],
      ['an option without its value', ['page.html', '-o'], /-o/],
      ['an empty page selector', ['page.html', '--page-selector', ' '], /--page-selector needs/],
    ];
    for (const [name, args, message] of cases) {
      it(`for ${name}`, async () => {
        const result = await cli(args);
        assert.equal(result.code, 2, result.stdout);
        assert.match(result.stderr, message);
        assert.match(result.stderr, /safe-html-pdf --help/);
        assert.equal(result.stdout, '');
      });
    }
  });

  it('exits 1 with a message when the input cannot be read', async () => {
    const result = await cli([file('missing.html'), '-o', file('missing.pdf')]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Cannot read .*missing\.html: ENOENT/);
  });

  it('exits 1 when the render runs out of time, in JSON too', async () => {
    const plain = await cli([file('page.html'), '-o', file('late.pdf'), '--timeout', '1']);
    assert.equal(plain.code, 1);
    assert.match(plain.stderr, /not finished within 1 ms/);

    const json = await cli([file('page.html'), '-o', file('late.pdf'), '--timeout', '1', '--json']);
    assert.equal(json.code, 1);
    assert.equal(JSON.parse(json.stderr).error.code, 'RENDER_TIMEOUT');
    assert.equal(json.stdout, '');
  });

  it('shows help and the version', async () => {
    const help = await cli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: safe-html-pdf <input\.html>/);
    for (const option of ['--output', '--format', '--page-selector', '--assets', '--strict', '--json', '--timeout']) {
      assert.ok(help.stdout.includes(option), option);
    }

    const version = await cli(['--version']);
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(version.code, 0);
    assert.equal(version.stdout, `${manifest.version}\n`);
  });
});
