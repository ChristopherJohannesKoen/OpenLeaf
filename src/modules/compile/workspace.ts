import { lstat, mkdir, readdir, readFile as fsReadFile, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import type { Queryable } from '../../core/db.js';
import { sha256 } from '../../core/util.js';
import { listFiles, readAllFiles } from '../projects/store.js';

/**
 * Each project gets a directory on local disk that mirrors its files. It is
 * kept between compiles so latexmk can reuse its auxiliary files (much faster
 * second compiles). The disk is only a cache: the database is the source of
 * truth and the directory is rebuilt whenever it is missing.
 */
export interface Workspace {
  /** `<compileDir>/projects/<id>` */
  root: string;
  /** `<root>/src` — where the project files and build outputs live. */
  src: string;
  manifestPath: string;
}

export function workspaceFor(compileDir: string, projectId: string): Workspace {
  const root = path.join(compileDir, 'projects', projectId);
  return { root, src: path.join(root, 'src'), manifestPath: path.join(root, 'manifest.json') };
}

type Manifest = Record<string, string>; // path -> "kind:sha256"

async function loadManifest(ws: Workspace): Promise<Manifest> {
  try {
    return JSON.parse(await fsReadFile(ws.manifestPath, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

function resolveInside(base: string, relative: string): string {
  const full = path.resolve(base, relative);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Refusing to touch a path outside the compile directory: ${relative}`);
  }
  return full;
}

/**
 * A compile wrote in this folder. Before the service writes into it again, take out anything
 * that is not a plain file or a folder, so that no write can be led somewhere else through a
 * link. TeX has no need to leave links, devices or pipes behind.
 */
async function removeOddEntries(dir: string): Promise<number> {
  let removed = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removed += await removeOddEntries(full);
    else if (!entry.isFile()) {
      await rm(full, { force: true });
      removed++;
    }
  }
  return removed;
}

/** True when the path exists and is something other than a real folder (a link, a file). */
async function notAFolder(dir: string): Promise<boolean> {
  const info = await lstat(dir).catch(() => null);
  return info !== null && !info.isDirectory();
}

/**
 * Bring the on-disk copy in line with the database: write new/changed files,
 * remove files that were deleted from the project, leave build artefacts alone.
 * Returns a hash that identifies this exact set of sources.
 */
export async function syncWorkspace(
  q: Queryable,
  projectId: string,
  ws: Workspace,
  opts: { clean?: boolean } = {},
): Promise<{ sourceHash: string; written: number; removed: number }> {
  // If the folder itself was swapped for something else, start again from nothing.
  const replaced = (await notAFolder(ws.root)) || (await notAFolder(ws.src));
  const clean = Boolean(opts.clean) || replaced;
  if (clean) await rm(ws.root, { recursive: true, force: true });
  await mkdir(ws.src, { recursive: true });
  if (!clean) await removeOddEntries(ws.src);

  const previous = clean ? {} : await loadManifest(ws);
  const files = await listFiles(q, projectId);
  const next: Manifest = {};
  for (const f of files) next[f.path] = `${f.kind}:${f.sha256}`;

  // Remove what no longer exists in the project (deepest paths first).
  let removed = 0;
  const gone = Object.keys(previous)
    .filter((p) => !(p in next))
    .sort((a, b) => b.length - a.length);
  for (const p of gone) {
    await rm(resolveInside(ws.src, p), { recursive: true, force: true });
    removed++;
  }

  const changed = files.filter((f) => previous[f.path] !== next[f.path]);
  for (const f of changed.filter((c) => c.kind === 'folder')) {
    const target = resolveInside(ws.src, f.path);
    // A path that used to be a file may now be a folder.
    if (previous[f.path] && !previous[f.path]!.startsWith('folder:')) await rm(target, { force: true });
    await mkdir(target, { recursive: true });
  }

  const toWrite = changed.filter((c) => c.kind !== 'folder').map((c) => c.path);
  let written = 0;
  // Fetch contents in batches to keep memory use flat for large projects.
  for (let i = 0; i < toWrite.length; i += 50) {
    const batch = await readAllFiles(q, projectId, toWrite.slice(i, i + 50));
    for (const f of batch) {
      const target = resolveInside(ws.src, f.path);
      if (previous[f.path]?.startsWith('folder:')) await rm(target, { recursive: true, force: true });
      await mkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, f.kind === 'text' ? (f.content ?? '') : (f.data ?? Buffer.alloc(0)));
      written++;
    }
  }

  await fsWriteFile(ws.manifestPath, JSON.stringify(next));
  const sourceHash = sha256(
    files.map((f) => `${f.kind}\0${f.path}\0${f.sha256}`).join('\n'),
  );
  return { sourceHash, written, removed };
}

export async function removeWorkspace(ws: Workspace): Promise<void> {
  await rm(ws.root, { recursive: true, force: true });
}
