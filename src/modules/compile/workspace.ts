import { mkdir, readFile as fsReadFile, rm, writeFile as fsWriteFile } from 'node:fs/promises';
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
  if (opts.clean) await rm(ws.root, { recursive: true, force: true });
  await mkdir(ws.src, { recursive: true });

  const previous = opts.clean ? {} : await loadManifest(ws);
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
