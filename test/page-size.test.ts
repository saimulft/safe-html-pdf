import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lengthToPx, parseFormatArgument, resolveFormat, resolveMargin } from '../src/page-size.ts';

describe('lengthToPx', () => {
  it('reads numbers and CSS lengths', () => {
    assert.equal(lengthToPx(12), 12);
    assert.equal(lengthToPx('12'), 12);
    assert.equal(lengthToPx('1in'), 96);
    assert.equal(lengthToPx('72pt'), 96);
    assert.equal(lengthToPx('1pc'), 16);
    assert.equal(Math.round(lengthToPx('210mm') as number), 794);
    assert.equal(Math.round(lengthToPx(' 2.54 CM ') as number), 96);
  });

  it('rejects everything else', () => {
    for (const value of [-1, Number.NaN, Infinity, '', 'abc', '12em', '12%', '1 2', null, undefined, {}]) {
      assert.equal(lengthToPx(value), null, String(value));
    }
  });
});

describe('resolveFormat', () => {
  it('knows the named formats', () => {
    assert.deepEqual(resolveFormat('A4'), { width: 794, height: 1123, pdf: { format: 'A4' } });
    assert.deepEqual(resolveFormat('letter' as never), { width: 816, height: 1056, pdf: { format: 'Letter' } });
    assert.deepEqual(resolveFormat('slides'), { width: 1280, height: 720, pdf: { width: '1280px', height: '720px' } });
  });

  it('takes a custom size with or without units', () => {
    const custom = resolveFormat({ width: 600, height: '4in' });
    assert.equal(custom.width, 600);
    assert.equal(custom.height, 384);
  });

  it('refuses what is not a format', () => {
    assert.throws(() => resolveFormat('A5' as never), TypeError);
    assert.throws(() => resolveFormat({ width: 0, height: 100 }), TypeError);
    assert.throws(() => resolveFormat({ width: 100 } as never), TypeError);
    assert.throws(() => resolveFormat(null as never), TypeError);
  });
});

describe('resolveMargin', () => {
  it('spreads one value over the four sides', () => {
    assert.deepEqual(resolveMargin('1in'), { top: 96, right: 96, bottom: 96, left: 96 });
    assert.deepEqual(resolveMargin(undefined), { top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('takes each side on its own', () => {
    assert.deepEqual(resolveMargin({ top: 10, left: '1in' }), { top: 10, right: 0, bottom: 0, left: 96 });
  });

  it('refuses a margin that is not a length', () => {
    assert.throws(() => resolveMargin('wide'), TypeError);
    assert.throws(() => resolveMargin({ top: -4 }), TypeError);
  });
});

describe('parseFormatArgument', () => {
  it('reads the names and WIDTHxHEIGHT', () => {
    assert.equal(parseFormatArgument('a4'), 'A4');
    assert.equal(parseFormatArgument('Letter'), 'Letter');
    assert.equal(parseFormatArgument('SLIDES'), 'slides');
    assert.deepEqual(parseFormatArgument('1280x720'), { width: '1280', height: '720' });
    assert.deepEqual(parseFormatArgument('210mmx297mm'), { width: '210mm', height: '297mm' });
    assert.deepEqual(parseFormatArgument('8.5in x 11in'), { width: '8.5in', height: '11in' });
  });

  it('returns null for anything else', () => {
    for (const value of ['', 'A5', '1280', '1280x', 'x720', '0x0', 'axb', '10emx20em']) {
      assert.equal(parseFormatArgument(value), null, value);
    }
  });
});
