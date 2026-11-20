import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Asset, AssetResolver } from './types.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.css': 'text/css; charset=utf-8',
};

// A path that names no file, or a folder, is a miss and not a failure.
const NOT_A_FILE = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'ENAMETOOLONG']);

// The path a browser asked for, decoded once, or null when it cannot be one of ours: not valid percent-encoding, a
// backslash or NUL in it, or a ".." segment.
function decodedPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  // A trailing slash names a folder, never a file.
  if (decoded.endsWith('/') || decoded.split('/').includes('..')) return null;
  return decoded;
}

/**
 * An `resolveAsset` that serves the files of one folder: `/img/logo.png` is `<dir>/img/logo.png`. The request path
 * is decoded once; one that goes up a folder (`..` or a backslash, however written) or that leaves the folder
 * through a symbolic link answers `null`, and so does a path that is not a file. The content type comes from the
 * file extension (images, fonts and CSS; anything else is sent as `application/octet-stream`).
 *
 * ```ts
 * const renderer = createRenderer({ resolveAsset: createDirectoryAssetResolver('./assets') });
 * ```
 */
export function createDirectoryAssetResolver(directory: string): AssetResolver {
  const rootPromise = realpath(path.resolve(directory));
  // A folder that does not exist is a mistake to hear about, but not before the first file is asked for.
  rootPromise.catch(() => {});

  return async (url: URL): Promise<Asset | null> => {
    const decoded = decodedPath(url.pathname);
    if (!decoded) return null;
    const root = await rootPromise;
    try {
      const file = await realpath(path.join(root, decoded));
      if (!file.startsWith(root + path.sep)) return null;
      const body = await readFile(file);
      return { body, contentType: CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
    } catch (error) {
      if (NOT_A_FILE.has((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
  };
}
