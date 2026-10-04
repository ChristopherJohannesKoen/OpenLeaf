/**
 * Data access for projects and their file trees. Every other module that
 * needs to read or change project files goes through these functions, so the
 * rules (path safety, size limits, folder bookkeeping) live in one place.
 */
import type { Queryable } from '../../core/db.js';
import { badRequest, conflict, notFound, tooLarge } from '../../core/errors.js';
import { likeEscape, normalizePath, parentFolders } from '../../core/paths.js';
import { sha256 } from '../../core/util.js';

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  main_file: string;
  engine: string;
  tags: string[];
  settings: Record<string, unknown>;
  archived_at: Date | null;
  trashed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type FileKind = 'text' | 'binary' | 'folder';

export interface FileMeta {
  id: string;
  path: string;
  kind: FileKind;
  size: number;
  sha256: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface FileRow extends FileMeta {
  content: string | null;
  data: Buffer | null;
}

export interface FileEntry {
  path: string;
  kind: FileKind;
  content?: string | null;
  data?: Buffer | null;
}

export interface Limits {
  maxProjectBytes: number;
  maxTextFileBytes: number;
  maxUploadBytes: number;
}

const META_COLUMNS = 'id, path, kind, size, sha256, version, created_at, updated_at';

export function projectJson(p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    mainFile: p.main_file,
    engine: p.engine,
    tags: p.tags,
    settings: p.settings,
    archived: p.archived_at !== null,
    trashed: p.trashed_at !== null,
    archivedAt: p.archived_at,
    trashedAt: p.trashed_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export function fileJson(f: FileMeta) {
  return {
    id: f.id,
    path: f.path,
    kind: f.kind,
    size: f.size,
    sha256: f.sha256,
    version: f.version,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  };
}

/** Load a project the user owns, or throw 404 (never reveal that someone else's exists). */
export async function getProject(q: Queryable, projectId: string, userId: string): Promise<ProjectRow> {
  const res = await q.query<ProjectRow>('SELECT * FROM projects WHERE id = $1 AND owner_id = $2', [
    projectId,
    userId,
  ]);
  const row = res.rows[0];
  if (!row) throw notFound('Project not found.', 'project_not_found');
  return row;
}

export async function touchProject(q: Queryable, projectId: string): Promise<void> {
  await q.query('UPDATE projects SET updated_at = now() WHERE id = $1', [projectId]);
}

export async function listFiles(q: Queryable, projectId: string): Promise<FileMeta[]> {
  const res = await q.query<FileMeta>(
    `SELECT ${META_COLUMNS} FROM project_files WHERE project_id = $1 ORDER BY path COLLATE "C"`,
    [projectId],
  );
  return res.rows;
}

export async function readFile(q: Queryable, projectId: string, path: string): Promise<FileRow> {
  const res = await q.query<FileRow>(
    `SELECT ${META_COLUMNS}, content, data FROM project_files WHERE project_id = $1 AND path = $2`,
    [projectId, path],
  );
  const row = res.rows[0];
  if (!row) throw notFound(`No file at "${path}".`, 'file_not_found');
  return row;
}

/** All files with their contents (used for export, snapshots, compile sync). */
export async function readAllFiles(q: Queryable, projectId: string, paths?: string[]): Promise<FileRow[]> {
  if (paths && paths.length === 0) return [];
  const res = await q.query<FileRow>(
    `SELECT ${META_COLUMNS}, content, data FROM project_files
      WHERE project_id = $1 ${paths ? 'AND path = ANY($2)' : ''}
      ORDER BY path COLLATE "C"`,
    paths ? [projectId, paths] : [projectId],
  );
  return res.rows;
}

export async function projectSize(q: Queryable, projectId: string): Promise<number> {
  const res = await q.query<{ total: number }>(
    'SELECT COALESCE(sum(size), 0)::bigint AS total FROM project_files WHERE project_id = $1',
    [projectId],
  );
  return res.rows[0]!.total;
}

/** A stable hash of the whole tree: changes whenever any file changes. */
export async function sourceFingerprint(q: Queryable, projectId: string): Promise<string> {
  const files = await listFiles(q, projectId);
  return sha256(files.map((f) => `${f.kind}\0${f.path}\0${f.sha256}`).join('\n'));
}

async function ensureFolders(q: Queryable, projectId: string, folders: string[]): Promise<void> {
  if (!folders.length) return;
  // A parent "folder" must not already exist as a regular file.
  const clash = await q.query<{ path: string }>(
    `SELECT path FROM project_files WHERE project_id = $1 AND path = ANY($2) AND kind <> 'folder'`,
    [projectId, folders],
  );
  if (clash.rowCount) {
    throw conflict(
      `"${clash.rows[0]!.path}" is a file, so nothing can be placed inside it.`,
      'path_conflict',
    );
  }
  await q.query(
    `INSERT INTO project_files (project_id, path, kind)
     SELECT $1, p, 'folder' FROM unnest($2::text[]) AS p
     ON CONFLICT (project_id, path) DO NOTHING`,
    [projectId, folders],
  );
}

export async function createFolder(q: Queryable, projectId: string, rawPath: string): Promise<string> {
  const path = normalizePath(rawPath);
  const existing = await q.query<{ kind: FileKind }>(
    'SELECT kind FROM project_files WHERE project_id = $1 AND path = $2',
    [projectId, path],
  );
  if (existing.rows[0] && existing.rows[0].kind !== 'folder') {
    throw conflict(`A file already exists at "${path}".`, 'path_conflict');
  }
  await ensureFolders(q, projectId, [...parentFolders(path), path]);
  await touchProject(q, projectId);
  return path;
}

export interface WriteOptions {
  /** Reject the write unless the stored version still equals this (optimistic locking). */
  baseVersion?: number;
  /** Fail instead of overwriting an existing file. */
  createOnly?: boolean;
  limits: Limits;
}

/**
 * Create or overwrite a file. Pass `content` for editable text or `data` for
 * binary (images, PDFs…). Parent folders are created as needed.
 */
export async function writeFile(
  q: Queryable,
  projectId: string,
  rawPath: string,
  body: { content: string } | { data: Buffer },
  opts: WriteOptions,
): Promise<FileMeta> {
  const path = normalizePath(rawPath);
  const isText = 'content' in body;
  const bytes = isText ? Buffer.from(body.content, 'utf8') : body.data;
  const size = bytes.byteLength;

  if (isText) {
    if (body.content.includes('\u0000')) {
      throw badRequest('Text files cannot contain NUL characters.', 'invalid_content');
    }
    if (size > opts.limits.maxTextFileBytes) {
      throw tooLarge(
        `Text files are limited to ${Math.round(opts.limits.maxTextFileBytes / 1024)} KB.`,
        'file_too_large',
      );
    }
  } else if (size > opts.limits.maxUploadBytes) {
    throw tooLarge(
      `Files are limited to ${Math.round(opts.limits.maxUploadBytes / (1024 * 1024))} MB.`,
      'file_too_large',
    );
  }

  const existing = await q.query<{ kind: FileKind; version: number; size: number }>(
    'SELECT kind, version, size FROM project_files WHERE project_id = $1 AND path = $2 FOR UPDATE',
    [projectId, path],
  );
  const current = existing.rows[0];
  if (current?.kind === 'folder') {
    throw conflict(`"${path}" is a folder.`, 'path_conflict');
  }
  if (current && opts.createOnly) {
    throw conflict(`A file already exists at "${path}".`, 'file_exists');
  }
  if (current && opts.baseVersion !== undefined && opts.baseVersion !== current.version) {
    throw conflict(
      'This file was changed somewhere else since you loaded it. Reload it before saving.',
      'version_conflict',
      { currentVersion: current.version },
    );
  }
  if (!current) {
    const below = await q.query(
      `SELECT 1 FROM project_files WHERE project_id = $1 AND path LIKE $2 ESCAPE '\\' LIMIT 1`,
      [projectId, `${likeEscape(path)}/%`],
    );
    if (below.rowCount) throw conflict(`"${path}" is a folder.`, 'path_conflict');
  }

  const total = await projectSize(q, projectId);
  if (total - (current?.size ?? 0) + size > opts.limits.maxProjectBytes) {
    throw tooLarge(
      `This would take the project over its ${Math.round(opts.limits.maxProjectBytes / (1024 * 1024))} MB limit.`,
      'project_too_large',
    );
  }

  await ensureFolders(q, projectId, parentFolders(path));
  const res = await q.query<FileMeta>(
    `INSERT INTO project_files (project_id, path, kind, content, data, size, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, path) DO UPDATE
       SET kind = EXCLUDED.kind, content = EXCLUDED.content, data = EXCLUDED.data,
           size = EXCLUDED.size, sha256 = EXCLUDED.sha256,
           version = project_files.version + 1, updated_at = now()
     RETURNING ${META_COLUMNS}`,
    [
      projectId,
      path,
      isText ? 'text' : 'binary',
      isText ? body.content : null,
      isText ? null : body.data,
      size,
      sha256(bytes),
    ],
  );
  await touchProject(q, projectId);
  return res.rows[0]!;
}

/** Rename or move a file or a whole folder. */
export async function movePath(
  q: Queryable,
  projectId: string,
  rawFrom: string,
  rawTo: string,
): Promise<{ from: string; to: string; moved: number }> {
  const from = normalizePath(rawFrom, 'source path');
  const to = normalizePath(rawTo, 'destination path');
  if (from === to) return { from, to, moved: 0 };
  if (to.startsWith(`${from}/`)) {
    throw badRequest('A folder cannot be moved inside itself.', 'invalid_move');
  }

  const source = await q.query<{ kind: FileKind }>(
    'SELECT kind FROM project_files WHERE project_id = $1 AND path = $2 FOR UPDATE',
    [projectId, from],
  );
  if (!source.rows[0]) throw notFound(`Nothing exists at "${from}".`, 'file_not_found');

  const dest = await q.query(
    `SELECT 1 FROM project_files
      WHERE project_id = $1 AND (path = $2 OR path LIKE $3 ESCAPE '\\') LIMIT 1`,
    [projectId, to, `${likeEscape(to)}/%`],
  );
  if (dest.rowCount) throw conflict(`Something already exists at "${to}".`, 'file_exists');

  await ensureFolders(q, projectId, parentFolders(to));
  const res = await q.query(
    `UPDATE project_files
        SET path = $3 || substr(path, char_length($2) + 1), updated_at = now()
      WHERE project_id = $1 AND (path = $2 OR path LIKE $4 ESCAPE '\\')`,
    [projectId, from, to, `${likeEscape(from)}/%`],
  );
  // Keep the project's main file pointing at the same document.
  await q.query(
    `UPDATE projects
        SET main_file = $3 || substr(main_file, char_length($2) + 1)
      WHERE id = $1 AND (main_file = $2 OR main_file LIKE $4 ESCAPE '\\')`,
    [projectId, from, to, `${likeEscape(from)}/%`],
  );
  await touchProject(q, projectId);
  return { from, to, moved: res.rowCount };
}

/** Delete a file, or a folder and everything in it. */
export async function deletePath(q: Queryable, projectId: string, rawPath: string): Promise<number> {
  const path = normalizePath(rawPath);
  const res = await q.query(
    `DELETE FROM project_files
      WHERE project_id = $1 AND (path = $2 OR path LIKE $3 ESCAPE '\\')`,
    [projectId, path, `${likeEscape(path)}/%`],
  );
  if (!res.rowCount) throw notFound(`Nothing exists at "${path}".`, 'file_not_found');
  await touchProject(q, projectId);
  return res.rowCount;
}

/** Insert a batch of entries into an (empty or cleared) project. Paths must already be valid. */
export async function insertEntries(
  q: Queryable,
  projectId: string,
  entries: FileEntry[],
  limits: Limits,
): Promise<void> {
  let total = 0;
  const folders = new Set<string>();
  const seen = new Set<string>();
  const files: { path: string; kind: FileKind; content: string | null; data: Buffer | null; size: number; sha: string }[] = [];

  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (entry.kind === 'folder') {
      folders.add(path);
      for (const parent of parentFolders(path)) folders.add(parent);
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    for (const parent of parentFolders(path)) folders.add(parent);
    const bytes =
      entry.kind === 'text' ? Buffer.from(entry.content ?? '', 'utf8') : (entry.data ?? Buffer.alloc(0));
    total += bytes.byteLength;
    files.push({
      path,
      kind: entry.kind,
      content: entry.kind === 'text' ? (entry.content ?? '') : null,
      data: entry.kind === 'binary' ? bytes : null,
      size: bytes.byteLength,
      sha: sha256(bytes),
    });
  }
  for (const f of files) {
    if (folders.has(f.path)) {
      throw conflict(`"${f.path}" is used both as a file and as a folder.`, 'path_conflict');
    }
  }
  if (total > limits.maxProjectBytes) {
    throw tooLarge(
      `The files add up to more than the ${Math.round(limits.maxProjectBytes / (1024 * 1024))} MB project limit.`,
      'project_too_large',
    );
  }

  if (folders.size) {
    await q.query(
      `INSERT INTO project_files (project_id, path, kind)
       SELECT $1, p, 'folder' FROM unnest($2::text[]) AS p
       ON CONFLICT (project_id, path) DO NOTHING`,
      [projectId, [...folders]],
    );
  }
  for (const f of files) {
    await q.query(
      `INSERT INTO project_files (project_id, path, kind, content, data, size, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, f.path, f.kind, f.content, f.data, f.size, f.sha],
    );
  }
  await touchProject(q, projectId);
}

/** Replace the whole tree (used when restoring an earlier version). */
export async function replaceAllFiles(
  q: Queryable,
  projectId: string,
  entries: FileEntry[],
  limits: Limits,
): Promise<void> {
  await q.query('DELETE FROM project_files WHERE project_id = $1', [projectId]);
  await insertEntries(q, projectId, entries, limits);
}

export async function copyFiles(q: Queryable, fromProjectId: string, toProjectId: string): Promise<void> {
  await q.query(
    `INSERT INTO project_files (project_id, path, kind, content, data, size, sha256)
     SELECT $2, path, kind, content, data, size, sha256 FROM project_files WHERE project_id = $1`,
    [fromProjectId, toProjectId],
  );
}

export interface NewProject {
  ownerId: string;
  name: string;
  description?: string;
  mainFile?: string;
  engine: string;
  tags?: string[];
  settings?: Record<string, unknown>;
}

export function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw badRequest('Give the project a name.', 'invalid_name');
  if (n.length > 200) throw badRequest('That project name is too long.', 'invalid_name');
  return n;
}

export function cleanTags(tags: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of tags ?? []) {
    const tag = t.trim();
    if (!tag) continue;
    if (tag.length > 50) throw badRequest('Tags are limited to 50 characters.', 'invalid_tag');
    out.add(tag);
  }
  if (out.size > 30) throw badRequest('A project can have at most 30 tags.', 'invalid_tag');
  return [...out];
}

export async function insertProject(q: Queryable, p: NewProject): Promise<ProjectRow> {
  const res = await q.query<ProjectRow>(
    `INSERT INTO projects (owner_id, name, description, main_file, engine, tags, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      p.ownerId,
      cleanName(p.name),
      (p.description ?? '').trim(),
      p.mainFile ? normalizePath(p.mainFile, 'main file') : 'main.tex',
      p.engine,
      cleanTags(p.tags),
      JSON.stringify(p.settings ?? {}),
    ],
  );
  return res.rows[0]!;
}

/** Pick the most likely root document of a set of files. */
export function guessMainFile(files: { path: string; content?: string | null }[]): string | null {
  const tex = files.filter((f) => f.path.toLowerCase().endsWith('.tex'));
  const roots = tex.filter((f) => /\\documentclass/.test(f.content ?? ''));
  const pool = roots.length ? roots : tex;
  if (!pool.length) return null;
  const score = (p: string) => {
    const depth = p.split('/').length;
    const base = p.split('/').pop()!.toLowerCase();
    const named = ['main.tex', 'thesis.tex', 'paper.tex', 'report.tex', 'article.tex'].indexOf(base);
    return depth * 10 + (named === -1 ? 5 : named);
  };
  return [...pool].sort((a, b) => score(a.path) - score(b.path) || a.path.localeCompare(b.path))[0]!.path;
}
