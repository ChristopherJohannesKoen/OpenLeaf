import { Unzip, UnzipInflate, zipSync, type Zippable } from 'fflate';
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

/** Thrown from inside the unpacking callbacks to stop at once. */
class Stop extends Error {}

/**
 * Unpack an archive while counting the bytes that actually come out, and stop the moment they
 * pass the limit. The sizes an archive declares are not believed: a small file can claim to be
 * small and still unpack to gigabytes. The archive is fed in small slices so that no single
 * step can produce more than a few megabytes before the count is checked.
 */
function unpack(archive: Uint8Array, limits: Limits): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  let count = 0;
  let total = 0;
  // The first reason to stop is the one reported, however the library passes the error on.
  let reason: Error | null = null;
  const stop = (why: Error): never => {
    reason ??= why;
    throw new Stop();
  };
  const unreadable = () => badRequest('That file is not a readable zip archive.', 'invalid_zip');

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    if (file.name.endsWith('/')) {
      out[file.name] = new Uint8Array(0);
      return;
    }
    if (IGNORED.some((re) => re.test(file.name))) return; // never started, so never unpacked
    count += 1;
    if (count > MAX_ZIP_ENTRIES) {
      stop(tooLarge(`Zip archives are limited to ${MAX_ZIP_ENTRIES} files.`, 'zip_too_many_files'));
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (err) stop(unreadable());
      if (chunk.byteLength) {
        size += chunk.byteLength;
        total += chunk.byteLength;
        if (total > limits.maxProjectBytes) {
          stop(
            tooLarge(
              `The archive unpacks to more than the ${Math.round(limits.maxProjectBytes / (1024 * 1024))} MB project limit.`,
              'project_too_large',
            ),
          );
        }
        parts.push(chunk);
      }
      if (final) {
        const whole = new Uint8Array(size);
        let at = 0;
        for (const part of parts) {
          whole.set(part, at);
          at += part.byteLength;
        }
        out[file.name] = whole;
      }
    };
    file.start();
  };

  const SLICE = 16 * 1024;
  try {
    for (let at = 0; at < archive.byteLength; at += SLICE) {
      const last = at + SLICE >= archive.byteLength;
      unzipper.push(archive.subarray(at, Math.min(at + SLICE, archive.byteLength)), last);
    }
    if (archive.byteLength === 0) unzipper.push(new Uint8Array(0), true);
  } catch {
    throw reason ?? unreadable();
  }
  if (reason) throw reason;
  return out;
}

/** Read a zip archive into project file entries, enforcing size and count limits. */
export function readZip(archive: Uint8Array, limits: Limits): ZipImport {
  // "PK\x03\x04" (a file) or "PK\x05\x06" (an empty archive): anything else is not a zip.
  const magic = archive.byteLength >= 4 && archive[0] === 0x50 && archive[1] === 0x4b;
  if (!magic) throw badRequest('That file is not a readable zip archive.', 'invalid_zip');
  const unzipped = unpack(archive, limits);

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
