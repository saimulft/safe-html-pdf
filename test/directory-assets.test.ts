import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDirectoryAssetResolver } from '../src/directory-assets.ts';
import { PNG } from './helpers/fixtures.ts';

const get = (resolve: ReturnType<typeof createDirectoryAssetResolver>, pathname: string) =>
  resolve(new URL(`http://document.invalid${pathname}`));

describe('createDirectoryAssetResolver', () => {
  let root: string;
  let assets: string;
  let resolve: ReturnType<typeof createDirectoryAssetResolver>;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'safe-html-pdf-assets-'));
    assets = path.join(root, 'assets');
    await mkdir(path.join(assets, 'img'), { recursive: true });
    await writeFile(path.join(assets, 'img', 'logo.png'), PNG);
    await writeFile(path.join(assets, 'style.css'), 'p { color: red }');
    await writeFile(path.join(assets, 'data.bin'), 'bytes');
    await writeFile(path.join(assets, 'my file (1).png'), PNG);
    await writeFile(path.join(root, 'secret.txt'), 'outside the folder');
    await symlink(path.join(root, 'secret.txt'), path.join(assets, 'leak.txt'));
    await symlink(root, path.join(assets, 'up'));
    resolve = createDirectoryAssetResolver(assets);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serves a file with the type of its extension', async () => {
    const png = await get(resolve, '/img/logo.png');
    assert.deepEqual(png?.body, PNG);
    assert.equal(png?.contentType, 'image/png');
    assert.equal((await get(resolve, '/style.css'))?.contentType, 'text/css; charset=utf-8');
    assert.equal((await get(resolve, '/data.bin'))?.contentType, 'application/octet-stream');
  });

  it('decodes the path once', async () => {
    assert.ok(await get(resolve, '/my%20file%20(1).png'));
    assert.equal(await get(resolve, '/my%2520file%2520(1).png'), null);
  });

  it('answers null for a file that is not there, a folder and the root', async () => {
    for (const pathname of ['/nothing.png', '/img', '/img/', '/', '/img/logo.png/', '/style.css%00.png']) {
      assert.equal(await get(resolve, pathname), null, pathname);
    }
  });

  it('refuses every way out of the folder', async () => {
    const attempts = [
      '/../secret.txt',
      '/img/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/secret.txt',
      '/..%2Fsecret.txt',
      '/img/..%2f..%2fsecret.txt',
      '/..%5Csecret.txt',
      '/img\\..\\..\\secret.txt',
      '/%252e%252e/secret.txt',
      '/%E0%A4%A',
      '/leak.txt',
      '/up/secret.txt',
    ];
    for (const pathname of attempts) assert.equal(await get(resolve, pathname), null, pathname);
  });

  it('does not mistake a sibling folder with the same prefix for the folder', async () => {
    await mkdir(path.join(root, 'assets-private'), { recursive: true });
    await writeFile(path.join(root, 'assets-private', 'key.txt'), 'private');
    await symlink(path.join(root, 'assets-private'), path.join(assets, 'sibling'));
    assert.equal(await get(resolve, '/sibling/key.txt'), null);
  });

  it('fails loudly when the folder itself is missing', async () => {
    const missing = createDirectoryAssetResolver(path.join(root, 'no-such-folder'));
    await assert.rejects(async () => get(missing, '/a.png'), { code: 'ENOENT' });
  });
});
