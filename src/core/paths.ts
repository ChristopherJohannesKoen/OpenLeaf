import { badRequest } from './errors.js';

const MAX_PATH_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\:*?"<>|]/;

/**
 * Validate and normalise a project-relative path such as `chapters/intro.tex`.
 * Rejects anything that could escape the project folder or confuse a
 * filesystem: absolute paths, `..`, backslashes, control characters.
 */
export function normalizePath(input: unknown, what = 'path'): string {
  if (typeof input !== 'string') throw badRequest(`Missing ${what}.`, 'invalid_path');
  let p = input.trim().normalize('NFC');
  p = p.replace(/^\.\//, '');
  p = p.replace(/\/+$/, '');
  if (p === '') throw badRequest(`The ${what} is empty.`, 'invalid_path');
  if (p.length > MAX_PATH_LENGTH) throw badRequest(`The ${what} is too long.`, 'invalid_path');
  if (p.startsWith('/')) throw badRequest(`The ${what} must be relative.`, 'invalid_path');

  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw badRequest(`The ${what} "${input}" contains an invalid segment.`, 'invalid_path');
    }
    if (seg.length > MAX_SEGMENT_LENGTH) {
      throw badRequest(`A name in the ${what} is too long.`, 'invalid_path');
    }
    if (FORBIDDEN_CHARS.test(seg)) {
      throw badRequest(
        `The ${what} "${input}" contains characters that are not allowed (\\ : * ? " < > | or control characters).`,
        'invalid_path',
      );
    }
    if (seg !== seg.trim()) {
      throw badRequest(`Names in the ${what} cannot start or end with a space.`, 'invalid_path');
    }
  }
  return segments.join('/');
}

/** `a/b/c.tex` -> [`a`, `a/b`] */
export function parentFolders(p: string): string[] {
  const parts = p.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

/** Escape a string for use inside a SQL LIKE pattern. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const BINARY_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'ico',
  'eps', 'ps', 'dvi', 'zip', 'gz', 'tar', '7z', 'xz', 'bz2',
  'ttf', 'otf', 'woff', 'woff2', 'pfb', 'tfm', 'vf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
  'mp3', 'mp4', 'wav', 'mov', 'avi', 'bin', 'exe', 'dll', 'so', 'npy', 'mat',
]);

/** Decide whether bytes should be stored as editable text or as a binary blob. */
export function looksLikeText(pathName: string, data: Uint8Array, maxTextBytes: number): boolean {
  if (BINARY_EXTENSIONS.has(extname(pathName))) return false;
  if (data.byteLength > maxTextBytes) return false;
  if (data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  eps: 'application/postscript',
  ps: 'application/postscript',
  zip: 'application/zip',
  json: 'application/json',
  csv: 'text/csv',
};

export function mimeFor(pathName: string, isText: boolean): string {
  const ext = extname(pathName);
  if (MIME[ext]) return MIME[ext]!;
  return isText ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}
