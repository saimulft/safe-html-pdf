import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createRenderer } from '../src/index.ts';
import type { Renderer, RenderOptions, RenderWarning } from '../src/index.ts';
import { deck, PNG, slide } from './helpers/fixtures.ts';
import { hasImage, inflated, mediaBoxes, pageCount } from './helpers/pdf.ts';

const TIMEOUT = { timeout: 90000 };
const slides = { format: 'slides', pageSelector: 'section.slide' } as const satisfies RenderOptions;
const png = { body: PNG, contentType: 'image/png' };

const summary = (warnings: RenderWarning[]) => warnings.map((w) => `${w.code}@${w.page}`);

describe('layout lint of a deck', TIMEOUT, () => {
  let renderer: Renderer;
  before(() => {
    renderer = createRenderer();
  });
  after(() => renderer.close());

  // A three-slide deck with `middle` as the content of slide 2.
  const render = (middle: string, options: RenderOptions = {}) =>
    renderer.render(deck(slide('<h1>Cover</h1>'), slide(middle), slide('<h1>Closing</h1>')), { ...slides, ...options });

  const cases: [name: string, middle: string, expected: string[]][] = [
    ['a block taller than the slide', '<div style="height:2000px"></div>', ['overflow@2']],
    ['a block exactly as tall as the slide', '<div style="height:720px"></div>', []],
    ['a block a little taller than the slide', '<div style="height:740px"></div>', ['overflow@2']],
    ['a block wider than the slide', '<div style="width:1500px;height:50px"></div>', ['overflow@2']],
    [
      'text that flows below the bottom edge',
      '<div style="height:800px"></div><p style="margin:0">Hidden below the slide</p>',
      ['overflow@2', 'text-outside@2'],
    ],
    [
      'text placed past the right edge',
      '<p style="position:absolute;left:1270px;top:100px;margin:0;white-space:nowrap">Runs off the right edge</p>',
      ['overflow@2', 'text-outside@2'],
    ],
    [
      'text placed past the left edge',
      '<p style="position:absolute;left:-300px;top:100px;margin:0;white-space:nowrap">Starts left of the slide</p>',
      ['text-outside@2'],
    ],
    [
      'a decorative shape that bleeds off the slide',
      '<div style="position:absolute;left:1100px;top:-100px;width:400px;height:400px;border-radius:50%;background:#ccc"></div>' +
        '<div style="position:absolute;right:-50px;bottom:-200px;width:600px;height:400px;background:#ddd"><div style="width:100px;height:600px"></div></div>' +
        '<p>Inside</p>',
      [],
    ],
    [
      'text cut off by its own box (an ellipsis) near the right edge',
      '<div style="position:absolute;left:1000px;top:100px;width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A very long line of text that runs well past the right edge of the slide</div>',
      [],
    ],
    [
      'tall content inside a box that clips it',
      '<div style="height:200px;overflow:hidden"><div style="height:2000px"><p style="margin-top:900px">Clipped away</p></div></div>',
      [],
    ],
    [
      'text that is not shown (hidden or fully transparent) outside the slide',
      '<p style="position:absolute;left:1300px;top:10px;visibility:hidden">Hidden</p>' +
        '<p style="position:absolute;left:1300px;top:50px;opacity:0">Transparent</p>' +
        '<div style="opacity:0"><p style="position:absolute;left:1300px;top:90px">Inside a transparent box</p></div>',
      [],
    ],
  ];

  for (const [name, middle, expected] of cases) {
    it(`${expected.length ? 'reports' : 'stays quiet about'} ${name}`, async () => {
      const { warnings } = await render(middle);
      assert.deepEqual(summary(warnings), expected);
    });
  }

  it('gives each warning a code, a page, a locator and a message that ends with it', async () => {
    const { warnings } = await render(
      '<div class="card" style="height:2000px"></div><p style="position:absolute;left:1270px;top:100px;margin:0;white-space:nowrap">Runs off the right edge</p>',
    );
    assert.deepEqual(warnings, [
      {
        code: 'overflow',
        page: 2,
        locator: 'div.card',
        message: 'Page 2 overflows its 1280 x 720 area: div.card',
      },
      {
        code: 'text-outside',
        page: 2,
        locator: 'Runs off the right edge',
        message: 'Page 2 draws text outside its 1280 x 720 area: "Runs off the right edge"',
      },
    ]);
  });

  it('counts the pieces of text outside, and cuts a long line in the warning', async () => {
    const several = await render(
      '<div style="height:800px"></div><p style="margin:0">One</p><p style="margin:0">Two</p><p style="margin:0">Three</p>',
    );
    assert.equal(several.warnings[1].message, 'Page 2 draws text outside its 1280 x 720 area: "One" and 2 more');

    const long = await render(`<div style="height:800px"></div><p style="margin:0">${'Sentence '.repeat(12)}</p>`);
    assert.equal(long.warnings[1].locator, 'Sentence Sentence Sentence Sentence Sent...');
    const wider = await render(`<div style="height:800px"></div><p style="margin:0">${'Sentence '.repeat(12)}</p>`, {
      lint: { snippetLength: 10 },
    });
    assert.equal(wider.warnings[1].locator, 'Sentence S...');
  });

  it('numbers pages by position and prints one PDF page per slide', async () => {
    const html = deck(
      slide('<p>One</p>'),
      slide('<p>Two</p>'),
      slide('<div style="height:900px"></div>'),
      slide('<div style="height:900px"></div>'),
      slide('<p>Five</p>'),
    );
    const { pdf, pages, warnings } = await renderer.render(html, slides);
    assert.deepEqual(summary(warnings), ['overflow@3', 'overflow@4']);
    assert.equal(pages, 5);
    assert.equal(pageCount(pdf), 5);
    // 1280 x 720 CSS pixels are 960 x 540 points.
    assert.deepEqual(new Set(mediaBoxes(pdf).map((box) => box.join(' '))), new Set(['0 0 960 540']));
  });

  it('does not count a slide held inside another slide as a page of its own', async () => {
    const nested = '<div style="height:100px"></div><section class="slide" data-note="inner"><p>Inner</p></section>';
    const { pages, warnings } = await renderer.render(
      deck(slide('<p>Cover</p>'), slide(nested), slide('<p>End</p>')),
      slides,
    );
    assert.equal(pages, 3);
    assert.deepEqual(summary(warnings), []);
  });

  it('flags a slide that grows past the page because it has no fixed height', async () => {
    const grown = `<section class="slide" style="width:1280px;min-height:720px"><div style="height:900px"></div></section>`;
    const { warnings } = await renderer.render(deck(slide('<p>Cover</p>'), grown), slides);
    assert.deepEqual(summary(warnings), ['overflow@2']);
  });

  it('reports a missing or broken image on its page, once however often it appears', async () => {
    const image = '<img src="/gone.png" alt="" style="width:40px">';
    const { warnings } = await render(image + image + '<img src="/other.png" alt="" style="width:40px">', {
      resolveAsset: () => null,
    });
    const broken = warnings.filter((warning) => warning.code === 'broken-image');
    assert.deepEqual(
      broken.map((warning) => [warning.page, warning.locator]),
      [
        [2, '/gone.png'],
        [2, '/other.png'],
      ],
    );
    assert.equal(broken[0].message, 'Page 2: image failed to load: /gone.png');
  });

  it('uses a short locator for an image whose source is long', async () => {
    const source = `data:image/png;base64,${'A'.repeat(300)}`;
    const { warnings } = await render(`<img src="${source}" alt="" style="width:40px">`);
    assert.deepEqual(summary(warnings), ['broken-image@2']);
    assert.match(warnings[0].locator, /^img\b/);
    assert.equal(warnings[0].locator.length < 40, true);
  });

  it('says nothing about images that load, have no source or are not shown', async () => {
    const inner =
      '<img src="/ok.png" alt="" style="width:40px">' +
      `<img src="data:image/png;base64,${PNG.toString('base64')}" alt="" style="width:40px">` +
      '<img alt="">' +
      '<img src="" alt="">' +
      '<img src="/hidden.png" alt="" style="display:none">';
    const { warnings } = await render(inner, { resolveAsset: (url) => (url.pathname === '/ok.png' ? png : null) });
    // Chromium still asks for the hidden image, so its missing file is reported; but no image counts as broken.
    assert.deepEqual(summary(warnings), ['missing-asset@null']);
    assert.match(warnings[0].locator, /hidden\.png$/);
  });

  it('loads images that are far below the fold, even when the page asks for lazy loading', async () => {
    const asked: string[] = [];
    const html = deck(
      slide(
        '<div style="height:600px"></div><img src="/lazy.png" loading="lazy" alt="" style="width:40px;position:absolute;top:650px">',
      ),
    );
    const { pdf, warnings } = await renderer.render(html, {
      ...slides,
      resolveAsset: (url) => (asked.push(url.pathname), png),
    });
    assert.deepEqual(asked, ['/lazy.png']);
    assert.deepEqual(warnings, []);
    assert.ok(hasImage(pdf));
  });

  it('measures an animation at its last frame, and leaves it alone when told to', async () => {
    const css = '@keyframes grow { from { height: 0 } to { height: 2000px } } .grows { animation: grow 5s forwards }';
    const html = `<!doctype html><html><head><style>body{margin:0}${css}</style></head><body>${slide('<div class="grows"></div>')}</body></html>`;
    assert.deepEqual(summary((await renderer.render(html, slides)).warnings), ['overflow@1']);
    assert.deepEqual(summary((await renderer.render(html, { ...slides, finishAnimations: false })).warnings), []);
  });

  it('prints a fade-in at its last frame, not transparent', async () => {
    const css =
      '@keyframes fade { from { opacity: 0 } to { opacity: 1 } } .fade { opacity: 0; animation: fade 5s forwards }';
    const html = `<!doctype html><html><head><style>body{margin:0}${css}</style></head><body>${slide('<p class="fade">Faded in</p>')}</body></html>`;
    const { pdf } = await renderer.render(html, slides);
    assert.doesNotMatch(Buffer.from(pdf).toString('latin1'), /\/ca 0\b/);
  });

  it('honours a tolerance and can be switched off', async () => {
    const tall = '<div style="height:725px"></div>';
    assert.deepEqual(summary((await render(tall)).warnings), ['overflow@2']);
    assert.deepEqual(summary((await render(tall, { lint: { tolerancePx: 10 } })).warnings), []);

    const off = await render('<div style="height:2000px"></div><img src="/gone.png" alt="" style="width:20px">', {
      lint: false,
    });
    assert.deepEqual(summary(off.warnings), ['missing-asset@null']);
  });

  it('warns when the page selector matches nothing, and rejects one that is not CSS', async () => {
    const none = await renderer.render('<p>Hello</p>', { pageSelector: 'section.slide' });
    assert.deepEqual(
      none.warnings.map((warning) => [warning.code, warning.locator]),
      [['selector-no-match', 'section.slide']],
    );
    await assert.rejects(renderer.render('<p>x</p>', { pageSelector: 'section[' }), TypeError);
  });
});

describe('layout lint of a flowing document', TIMEOUT, () => {
  let renderer: Renderer;
  before(() => {
    renderer = createRenderer();
  });
  after(() => renderer.close());

  it('prints a document taller than a page on several pages without a warning', async () => {
    const html = `<!doctype html><body>${'<p style="height:400px">Paragraph</p>'.repeat(6)}</body>`;
    const { pdf, pages, warnings } = await renderer.render(html);
    assert.ok(pages > 1);
    assert.equal(pageCount(pdf), pages);
    assert.deepEqual(warnings, []);
  });

  it('reports content that is wider than the page', async () => {
    const html =
      '<!doctype html><body><p>Fine</p><div class="wide" style="width:1200px;height:20px;background:#eee"></div></body>';
    const { warnings } = await renderer.render(html);
    assert.deepEqual(warnings, [
      {
        code: 'overflow',
        page: null,
        locator: 'div.wide',
        message: 'The document is wider than the 794 px page: div.wide',
      },
    ]);
  });

  it('reports text drawn outside the page and a broken image', async () => {
    const html =
      '<!doctype html><body><p style="position:absolute;left:-200px;top:20px;white-space:nowrap">Off to the left</p><img src="/gone.png" alt="" style="width:30px"></body>';
    const { warnings } = await renderer.render(html);
    assert.deepEqual(
      warnings.map((warning) => [warning.code, warning.page, warning.locator]),
      [
        ['text-outside', null, 'Off to the left'],
        ['broken-image', null, '/gone.png'],
        ['missing-asset', null, 'http://document.invalid/gone.png'],
      ],
    );
  });

  it('prints A4, Letter and custom sizes', async () => {
    const html = '<!doctype html><p>Page</p>';
    const [a4] = mediaBoxes((await renderer.render(html, { format: 'A4' })).pdf);
    const [letter] = mediaBoxes((await renderer.render(html, { format: 'Letter' })).pdf);
    const [custom] = mediaBoxes((await renderer.render(html, { format: { width: 600, height: '4in' } })).pdf);
    assert.ok(Math.abs(a4[2] - 595.3) < 1 && Math.abs(a4[3] - 841.9) < 1, a4.join(' '));
    assert.deepEqual(letter, [0, 0, 612, 792]);
    assert.deepEqual(custom, [0, 0, 450, 288]);
  });

  it('measures inside the margins', async () => {
    const html =
      '<!doctype html><body style="margin:0"><div style="width:700px;height:20px;background:#eee"></div></body>';
    assert.deepEqual((await renderer.render(html)).warnings, []);
    const { warnings } = await renderer.render(html, { margin: '20mm' });
    assert.deepEqual(
      warnings.map((warning) => warning.code),
      ['overflow'],
    );
    assert.match(warnings[0].message, /wider than the 643 px page/);
  });

  it('lets a CSS @page rule decide the size by default, and not when told so', async () => {
    const html = '<!doctype html><style>@page { size: 400px 300px; margin: 0 }</style><p>x</p>';
    assert.deepEqual((await renderer.render(html)).pages, 1);
    const [css] = mediaBoxes((await renderer.render(html)).pdf);
    assert.ok(Math.abs(css[2] - 300) < 1 && Math.abs(css[3] - 225) < 1, css.join(' '));
    const [paper] = mediaBoxes((await renderer.render(html, { preferCSSPageSize: false })).pdf);
    // The paper is A4 again (turned sideways, as the @page rule asks), not 300 x 225 points.
    assert.ok(Math.abs(Math.max(paper[2], paper[3]) - 841.9) < 1.5, paper.join(' '));
  });

  it('prints backgrounds unless told not to', async () => {
    const html = '<!doctype html><body style="margin:0"><div style="height:100px;background:#ff0000"></div></body>';
    const withBackground = inflated((await renderer.render(html)).pdf);
    const without = inflated((await renderer.render(html, { printBackground: false })).pdf);
    assert.match(withBackground, /1 0 0 rg/);
    assert.doesNotMatch(without, /1 0 0 rg/);
  });
});
