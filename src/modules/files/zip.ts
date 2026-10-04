import { unzipSync, zipSync, type Zippable } from 'fflate';
import { badRequest, tooLarge } from '../../core/errors.js';
import { looksLikeText, normalizePath } from '../../core/paths.js';
import type { FileEntry, FileRow, Limits } from '../projects/store.js';

const MAX_ZIP_ENTRIES = 5000;
const IGNORED = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)\.git\//];

/** Zip entries for a set of project files, optionally under a folder prefix. */
export function zipEntries(files: Pick<FileRow, 'path' | 'kind' | 'content' | 'data'>[], prefix = ''): Zippable {
  const tree: Zippable = {};
  for (const f of files) {
    const name = prefix ? `${prefix}/${f.path}` : f.path;
    if (f.kind === 'folder') {
      tree[`${name}/`] = new Uint8Array(0);
    } else if (f.kind === 'text') {
      tree[name] = [Buffer.from(f.content ?? '', 'utf8'), { level: 6 }];
    } else {
      // Images and PDFs are already compressed; storing them is faster and just as small.
      tree[name] = [f.data ?? new Uint8Array(0), { level: 0 }];
    }
  }
  return tree;
}

/** Build a zip archive of a project's files (folders included, even empty ones). */
export function buildZip(files: Pick<FileRow, 'path' | 'kind' | 'content' | 'data'>[], prefix = ''): Buffer {
  return Buffer.from(zipSync(zipEntries(files, prefix)));
}

export interface ZipImport {
  entries: FileEntry[];
  skipped: { path: string; reason: string }[];
}

/** Read a zip archive into project file entries, enforcing size and count limits. */
export function readZip(archive: Uint8Array, limits: Limits): ZipImport {
  let count = 0;
  let declared = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(archive, {
      filter(file) {
        if (file.name.endsWith('/')) return true;
        if (IGNORED.some((re) => re.test(file.name))) return false;
        count += 1;
        declared += file.originalSize;
        if (count > MAX_ZIP_ENTRIES) {
          throw tooLarge(`Zip archives are limited to ${MAX_ZIP_ENTRIES} files.`, 'zip_too_many_files');
        }
        if (declared > limits.maxProjectBytes) {
          throw tooLarge(
            `The archive unpacks to more than the ${Math.round(limits.maxProjectBytes / (1024 * 1024))} MB project limit.`,
            'project_too_large',
          );
        }
        return true;
      },
    });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err;
    throw badRequest('That file is not a readable zip archive.', 'invalid_zip');
  }

  let names = Object.keys(unzipped).filter((n) => !IGNORED.some((re) => re.test(n)));

  // Archives are often wrapped in one top-level folder ("my-paper/main.tex"); unwrap it.
  const tops = new Set(names.map((n) => n.split('/')[0]!));
  const wrapped = tops.size === 1 && names.every((n) => n.includes('/'));
  const strip = wrapped ? `${[...tops][0]}/` : '';
  names = names.filter((n) => n !== strip);

  const entries: FileEntry[] = [];
  const skipped: ZipImport['skipped'] = [];
  let actual = 0;

  for (const name of names) {
    const relative = name.slice(strip.length);
    const bytes = unzipped[name]!;
    const isFolder = name.endsWith('/');
    let path: string;
    try {
      path = normalizePath(relative);
    } catch (err) {
      skipped.push({ path: relative, reason: (err as Error).message });
      continue;
    }
    if (isFolder) {
      entries.push({ path, kind: 'folder' });
      continue;
    }
    actual += bytes.byteLength;
    if (actual > limits.maxProjectBytes) {
      throw tooLarge('The archive unpacks to more than the project size limit.', 'project_too_large');
    }
    if (bytes.byteLength > limits.maxUploadBytes) {
      skipped.push({ path, reason: 'Larger than the per-file upload limit.' });
      continue;
    }
    if (looksLikeText(path, bytes, limits.maxTextFileBytes)) {
      entries.push({ path, kind: 'text', content: Buffer.from(bytes).toString('utf8') });
    } else {
      entries.push({ path, kind: 'binary', data: Buffer.from(bytes) });
    }
  }
  return { entries, skipped };
}
