// The sample back end: the same interface as the service, held in memory in this tab.
// It cannot run LaTeX. "Compile" re-reads the source (missing pictures, undefined keys) and
// shows the proof that was made when the sample was written. Everything resets on reload.
import { unifiedPatch } from '../lib/diff';
import { indexProject, readingNotes } from '../lib/latex';
import { BLANK_DOCUMENT, SAMPLE_PROJECTS, SAMPLE_TEMPLATES, type SampleProject } from './sample-data';
import {
  ApiError,
  type Api, type Change, type Compile, type CompileOptions, type Diagnostic, type FileDiff, type FileKind, type FileMeta,
  type PdfPosition, type Project, type Registration, type Session, type Settings, type SourcePosition, type SystemInfo,
  type Template, type TextFile, type User, type Version,
} from './types';

interface StoredFile {
  meta: FileMeta;
  content?: string;
  asset?: string;
}

interface Snapshot {
  version: Version;
  files: Map<string, { kind: FileKind; content?: string; asset?: string }>;
}

interface Stored {
  project: Project;
  files: Map<string, StoredFile>;
  versions: Snapshot[];
  compile: Compile | null;
  pdf: string | null;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
let counter = 100;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const USER: User = { id: '00000000-0000-4000-8000-0000000000aa', email: 'sample@openleaf.local', displayName: 'Sample reader', role: 'owner', createdAt: hoursAgo(2000) };

function meta(path: string, kind: FileKind, size: number, at: string): FileMeta {
  return { id: newId(), path, kind, size, sha256: '', version: 1, createdAt: at, updatedAt: at };
}

function lineOf(text: string | undefined, needle: string | undefined): number | null {
  if (!text || !needle) return null;
  const at = text.indexOf(needle);
  return at < 0 ? null : text.slice(0, at).split('\n').length;
}

function seed(sample: SampleProject): Stored {
  const at = hoursAgo(sample.hoursAgo);
  const files = new Map<string, StoredFile>();
  for (const f of sample.files) {
    const kind: FileKind = f.content !== undefined ? 'text' : f.asset ? 'binary' : 'folder';
    files.set(f.path, { meta: meta(f.path, kind, f.content?.length ?? (f.asset ? 18_000 : 0), at), content: f.content, asset: f.asset });
  }
  const current = (): Snapshot['files'] => new Map([...files].map(([p, f]) => [p, { kind: f.meta.kind, content: f.content, asset: f.asset }]));
  const versions: Snapshot[] = sample.versions.map((v) => {
    const snapshot = current();
    for (const [path, content] of Object.entries(v.files)) {
      if (content === null) snapshot.delete(path);
      else snapshot.set(path, { kind: 'text', content });
    }
    return {
      version: {
        id: newId(), kind: v.kind, label: v.label, mainFile: sample.mainFile, engine: sample.engine,
        fileCount: [...snapshot.values()].filter((f) => f.kind !== 'folder').length, totalSize: 0, createdAt: hoursAgo(v.hoursAgo),
      },
      files: snapshot,
    };
  });
  const compile: Compile | null = sample.compile && (() => {
    const diagnostics: Diagnostic[] = sample.compile.diagnostics.map((d) => ({
      level: d.level, message: d.message, file: d.file, source: 'latex' as const,
      line: d.file ? lineOf(files.get(d.file)?.content, d.at) : null,
      ...(d.context ? { context: d.context } : {}),
    }));
    const finished = hoursAgo(sample.compile.hoursAgo);
    return {
      id: newId(), status: sample.compile.status, engine: sample.engine, mainFile: sample.mainFile, message: null,
      errorCount: diagnostics.filter((d) => d.level === 'error').length,
      warningCount: diagnostics.filter((d) => d.level === 'warning').length,
      hasPdf: sample.pdf !== null, pdfSize: sample.pdf ? 90_000 : null, hasSynctex: false,
      createdAt: finished, startedAt: finished, finishedAt: finished, durationMs: sample.compile.durationMs, diagnostics,
    };
  })();
  return {
    project: {
      id: sample.id, name: sample.name, description: sample.description, mainFile: sample.mainFile, engine: sample.engine,
      tags: [], settings: sample.pages ? { openleaf: { pages: sample.pages } } : {}, archived: false, trashed: false,
      archivedAt: null, trashedAt: null, createdAt: hoursAgo(sample.hoursAgo + 400), updatedAt: at,
    },
    files, versions, compile, pdf: sample.pdf,
  };
}

function mergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = typeof target === 'object' && target !== null && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

export class SampleApi implements Api {
  readonly kind = 'sample' as const;
  readonly address = 'sample data, in this tab';
  private store = new Map<string, Stored>(SAMPLE_PROJECTS.map((p) => [p.id, seed(p)]));
  private settings: Settings = {
    editor: { theme: 'light', fontSize: 15, lineWrapping: true },
    compile: { autoCompile: false, autoCompileDelayMs: 2000, stopOnFirstError: false },
  };

  private get(id: string): Stored {
    const found = this.store.get(id);
    if (!found) throw new ApiError(404, 'project_not_found', 'Project not found.');
    return found;
  }

  private touch(s: Stored): void {
    s.project = { ...s.project, updatedAt: new Date().toISOString() };
  }

  private withCounts(s: Stored): Project {
    const files = [...s.files.values()].filter((f) => f.meta.kind !== 'folder');
    return { ...s.project, fileCount: files.length, totalSize: files.reduce((n, f) => n + f.meta.size, 0) };
  }

  // accounts
  async registration(): Promise<Registration> { return { mode: 'open', open: true, requiresInviteCode: false, hasUsers: true }; }
  async register(): Promise<Session> { return { user: USER, token: 'sample', expiresAt: null }; }
  async login(): Promise<Session> { return { user: USER, token: 'sample', expiresAt: null }; }
  async logout(): Promise<void> {}
  async me(): Promise<User> { return USER; }

  async info(): Promise<SystemInfo> {
    return {
      name: 'OpenLeaf', version: 'sample', uptimeSeconds: 0,
      modules: ['auth', 'projects', 'system', 'files', 'compile', 'history', 'templates', 'settings'].map((name) => ({ name, description: '', core: false })),
      registration: { mode: 'open', hasOwner: true },
      limits: { maxUploadBytes: 25 * 1024 * 1024, maxProjectBytes: 150 * 1024 * 1024, maxTextFileBytes: 2 * 1024 * 1024 },
      compile: { defaultEngine: 'pdflatex', timeoutSeconds: 0, engines: [] },
    };
  }

  // projects
  async listProjects(status: 'active' | 'archived' | 'trashed' = 'active'): Promise<Project[]> {
    return [...this.store.values()]
      .filter((s) => (status === 'trashed' ? s.project.trashed : status === 'archived' ? s.project.archived && !s.project.trashed : !s.project.archived && !s.project.trashed))
      .map((s) => this.withCounts(s))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getProject(id: string): Promise<Project> { return this.withCounts(this.get(id)); }

  private create(name: string, files: { path: string; content: string }[], mainFile: string): Project {
    const now = new Date().toISOString();
    const id = newId();
    const stored: Stored = {
      project: { id, name: name.trim(), description: '', mainFile, engine: 'pdflatex', tags: [], settings: {}, archived: false, trashed: false, archivedAt: null, trashedAt: null, createdAt: now, updatedAt: now },
      files: new Map(files.map((f) => [f.path, { meta: meta(f.path, 'text', f.content.length, now), content: f.content }])),
      versions: [], compile: null, pdf: null,
    };
    this.store.set(id, stored);
    return this.withCounts(stored);
  }
  async createProject(input: { name: string }): Promise<Project> {
    return this.create(input.name, [{ path: 'main.tex', content: BLANK_DOCUMENT(input.name) }], 'main.tex');
  }
  async createFromTemplate(templateId: string, input: { name: string }): Promise<Project> {
    const template = SAMPLE_TEMPLATES.find((t) => t.id === templateId);
    const mainFile = template?.mainFile ?? 'main.tex';
    return this.create(input.name, [{ path: mainFile, content: BLANK_DOCUMENT(input.name) }], mainFile);
  }
  async patchProject(id: string, patch: Record<string, unknown>): Promise<Project> {
    const s = this.get(id);
    const { settings, ...rest } = patch;
    if (typeof rest.mainFile === 'string' && s.files.get(rest.mainFile)?.meta.kind !== 'text') {
      throw new ApiError(400, 'invalid_main_file', `There is no text file at "${rest.mainFile}" to use as the main file.`);
    }
    s.project = { ...s.project, ...(rest as Partial<Project>), settings: settings ? (mergePatch(s.project.settings, settings) as Record<string, unknown>) : s.project.settings };
    this.touch(s);
    return this.withCounts(s);
  }
  async duplicateProject(id: string): Promise<Project> {
    const s = this.get(id);
    const copy = this.create(`${s.project.name} (copy)`, [], s.project.mainFile);
    const stored = this.get(copy.id);
    for (const [path, f] of s.files) stored.files.set(path, { ...f, meta: { ...f.meta, id: newId() } });
    return this.withCounts(stored);
  }
  async moveProject(id: string, to: 'archive' | 'unarchive' | 'trash' | 'restore'): Promise<Project> {
    const s = this.get(id);
    const now = new Date().toISOString();
    if (to === 'archive') s.project = { ...s.project, archived: true, archivedAt: now };
    if (to === 'unarchive') s.project = { ...s.project, archived: false, archivedAt: null };
    if (to === 'trash') s.project = { ...s.project, trashed: true, trashedAt: now };
    if (to === 'restore') s.project = { ...s.project, trashed: false, trashedAt: null };
    return this.withCounts(s);
  }
  async deleteProject(id: string): Promise<void> { this.get(id); this.store.delete(id); }
  async importZip(): Promise<Project> { throw new ApiError(400, 'sample_only', 'The sample library cannot read a zip. Link the service to import one.'); }
  async exportZip(): Promise<Blob> { throw new ApiError(400, 'sample_only', 'The sample library has nothing to export. Link the service first.'); }
  async backupAll(): Promise<Blob> { throw new ApiError(400, 'sample_only', 'The sample library has nothing to back up. Link the service first.'); }
  async listTemplates(): Promise<Template[]> { return SAMPLE_TEMPLATES; }

  // files
  async listFiles(id: string): Promise<{ mainFile: string; files: FileMeta[] }> {
    const s = this.get(id);
    return { mainFile: s.project.mainFile, files: [...s.files.values()].map((f) => f.meta).sort((a, b) => (a.path < b.path ? -1 : 1)) };
  }
  async readText(id: string, path: string): Promise<TextFile> {
    const f = this.get(id).files.get(path);
    if (!f) throw new ApiError(404, 'file_not_found', `No file at "${path}".`);
    if (f.meta.kind !== 'text') throw new ApiError(400, 'not_text', `"${path}" is not a text file.`);
    return { ...f.meta, content: f.content ?? '' };
  }
  async saveText(id: string, path: string, content: string, opts: { baseVersion?: number; createOnly?: boolean } = {}): Promise<FileMeta> {
    const s = this.get(id);
    const existing = s.files.get(path);
    const now = new Date().toISOString();
    if (existing) {
      if (opts.createOnly) throw new ApiError(409, 'file_exists', `A file already exists at "${path}".`);
      if (existing.meta.kind === 'folder') throw new ApiError(409, 'path_conflict', `"${path}" is a folder.`);
      if (opts.baseVersion !== undefined && opts.baseVersion !== existing.meta.version) {
        throw new ApiError(409, 'version_conflict', `"${path}" was changed elsewhere.`);
      }
      existing.content = content;
      existing.meta = { ...existing.meta, kind: 'text', size: content.length, version: existing.meta.version + 1, updatedAt: now };
      this.touch(s);
      return existing.meta;
    }
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      if (!s.files.has(folder)) s.files.set(folder, { meta: meta(folder, 'folder', 0, now) });
    }
    const created: StoredFile = { meta: meta(path, 'text', content.length, now), content };
    s.files.set(path, created);
    this.touch(s);
    return created.meta;
  }
  async readRaw(id: string, path: string): Promise<Blob> {
    const f = this.get(id).files.get(path);
    if (!f || f.meta.kind === 'folder') throw new ApiError(404, 'file_not_found', `No file at "${path}".`);
    if (f.asset) return (await fetch(f.asset)).blob();
    return new Blob([f.content ?? ''], { type: 'text/plain' });
  }
  async createFolder(id: string, path: string): Promise<void> {
    const s = this.get(id);
    if (s.files.has(path)) throw new ApiError(409, 'file_exists', `Something already exists at "${path}".`);
    s.files.set(path, { meta: meta(path, 'folder', 0, new Date().toISOString()) });
  }
  async movePath(id: string, from: string, to: string): Promise<void> {
    const s = this.get(id);
    if (!s.files.has(from)) throw new ApiError(404, 'file_not_found', `Nothing exists at "${from}".`);
    if (s.files.has(to)) throw new ApiError(409, 'file_exists', `Something already exists at "${to}".`);
    for (const [path, f] of [...s.files]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      const next = to + path.slice(from.length);
      s.files.delete(path);
      s.files.set(next, { ...f, meta: { ...f.meta, path: next } });
    }
    if (s.project.mainFile === from || s.project.mainFile.startsWith(`${from}/`)) {
      s.project = { ...s.project, mainFile: to + s.project.mainFile.slice(from.length) };
    }
    this.touch(s);
  }
  async deletePath(id: string, path: string): Promise<void> {
    const s = this.get(id);
    if (!s.files.has(path)) throw new ApiError(404, 'file_not_found', `Nothing exists at "${path}".`);
    for (const p of [...s.files.keys()]) if (p === path || p.startsWith(`${path}/`)) s.files.delete(p);
    this.touch(s);
  }
  async upload(id: string, files: File[], folder?: string): Promise<FileMeta[]> {
    const s = this.get(id);
    const now = new Date().toISOString();
    const out: FileMeta[] = [];
    for (const file of files) {
      const path = folder ? `${folder}/${file.name}` : file.name;
      const isText = /\.(tex|bib|sty|cls|txt|md|bst|tikz|csv)$/i.test(file.name);
      const stored: StoredFile = isText
        ? { meta: meta(path, 'text', file.size, now), content: await file.text() }
        : { meta: meta(path, 'binary', file.size, now), asset: URL.createObjectURL(file) };
      s.files.set(path, stored);
      out.push(stored.meta);
    }
    this.touch(s);
    return out;
  }

  // compile
  async compile(id: string, _options: CompileOptions = {}): Promise<Compile> {
    const s = this.get(id);
    await pause(900);
    const sources = new Map<string, string>();
    for (const [path, f] of s.files) if (f.meta.kind === 'text') sources.set(path, f.content ?? '');
    const index = indexProject(sources);
    const paths = new Set(s.files.keys());
    const diagnostics: Diagnostic[] = [];
    for (const [file, text] of sources) {
      for (const note of readingNotes(file, text, index, paths)) {
        const isCite = note.text.includes('bibliography');
        diagnostics.push(
          note.tone === 'broken'
            ? { level: 'error', message: `File \`${note.lemma}' not found.`, file, line: note.line, source: 'latex' }
            : { level: 'warning', message: `${isCite ? 'Citation' : 'Reference'} \`${note.lemma}' undefined.`, file, line: note.line, source: 'latex' },
        );
      }
    }
    if (!sources.has(s.project.mainFile)) {
      diagnostics.unshift({ level: 'error', message: `The main file ${s.project.mainFile} is missing.`, file: null, line: null, source: 'latexmk' });
    }
    const errors = diagnostics.filter((d) => d.level === 'error').length;
    const now = new Date().toISOString();
    s.compile = {
      id: newId(), status: errors ? 'failure' : 'success', engine: s.project.engine, mainFile: s.project.mainFile,
      message: s.pdf ? null : 'The sample library cannot run LaTeX, so there is no proof for this project.',
      errorCount: errors, warningCount: diagnostics.length - errors, hasPdf: s.pdf !== null, pdfSize: s.pdf ? 90_000 : null,
      hasSynctex: false, createdAt: now, startedAt: now, finishedAt: now, durationMs: 900, cached: false, diagnostics,
    };
    return s.compile;
  }
  async latestCompile(id: string): Promise<Compile | null> { return this.get(id).compile; }
  async pdf(id: string): Promise<ArrayBuffer> {
    const s = this.get(id);
    if (!s.pdf) throw new ApiError(404, 'no_pdf', 'There is no proof yet.');
    const res = await fetch(s.pdf);
    if (!res.ok) throw new ApiError(404, 'no_pdf', 'The sample proof is missing.');
    return res.arrayBuffer();
  }
  async log(id: string): Promise<string> {
    const c = this.get(id).compile;
    if (!c) throw new ApiError(404, 'no_log', 'There is no compile log yet.');
    return ['This is the sample library. It does not run LaTeX, so there is no TeX log.', '', ...(c.diagnostics ?? []).map((d) => `${d.file ?? ''}:${d.line ?? ''}: ${d.message}`)].join('\n');
  }
  async synctexForward(): Promise<PdfPosition[]> { return []; }
  async synctexInverse(): Promise<SourcePosition | null> { return null; }

  // history
  async listVersions(id: string): Promise<Version[]> {
    return this.get(id).versions.map((v) => v.version).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async createVersion(id: string, label: string): Promise<Version> {
    const s = this.get(id);
    const snapshot: Snapshot = {
      version: {
        id: newId(), kind: 'manual', label: label.trim(), mainFile: s.project.mainFile, engine: s.project.engine,
        fileCount: [...s.files.values()].filter((f) => f.meta.kind !== 'folder').length, totalSize: 0, createdAt: new Date().toISOString(),
      },
      files: new Map([...s.files].map(([p, f]) => [p, { kind: f.meta.kind, content: f.content, asset: f.asset }])),
    };
    s.versions.push(snapshot);
    return snapshot.version;
  }
  private snapshot(id: string, versionId: string): Snapshot {
    const found = this.get(id).versions.find((v) => v.version.id === versionId);
    if (!found) throw new ApiError(404, 'version_not_found', 'No such version.');
    return found;
  }
  async versionChanges(id: string, versionId: string): Promise<Change[]> {
    const s = this.get(id);
    const old = this.snapshot(id, versionId).files;
    const changes: Change[] = [];
    for (const [path, f] of old) {
      if (f.kind === 'folder') continue;
      const now = s.files.get(path);
      if (!now) changes.push({ path, kind: f.kind, status: 'removed' });
      else if ((now.content ?? now.asset) !== (f.content ?? f.asset)) changes.push({ path, kind: f.kind, status: 'modified' });
    }
    for (const [path, f] of s.files) if (f.meta.kind !== 'folder' && !old.has(path)) changes.push({ path, kind: f.meta.kind, status: 'added' });
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
  async versionDiff(id: string, versionId: string, path: string): Promise<FileDiff> {
    const before = this.snapshot(id, versionId).files.get(path);
    const after = this.get(id).files.get(path);
    const status = !before ? 'added' : !after ? 'removed' : (before.content ?? before.asset) === (after.content ?? after.asset) ? 'unchanged' : 'modified';
    if (before?.kind === 'binary' || after?.meta.kind === 'binary') return { path, status, binary: true, patch: null, before: null, after: null };
    const a = before?.content ?? '';
    const b = after?.content ?? '';
    return { path, status, binary: false, patch: unifiedPatch(path, a, b), before: before ? a : null, after: after ? b : null };
  }
  async restoreVersion(id: string, versionId: string): Promise<void> {
    const s = this.get(id);
    const snap = this.snapshot(id, versionId);
    await this.createVersion(id, 'Before restoring an earlier version');
    const now = new Date().toISOString();
    const next = new Map<string, StoredFile>();
    for (const [path, f] of snap.files) {
      const prior = s.files.get(path);
      next.set(path, { meta: { ...(prior?.meta ?? meta(path, f.kind, f.content?.length ?? 0, now)), kind: f.kind, version: (prior?.meta.version ?? 0) + 1, updatedAt: now }, content: f.content, asset: f.asset });
    }
    s.files = next;
    this.touch(s);
  }
  async deleteVersion(id: string, versionId: string): Promise<void> {
    const s = this.get(id);
    s.versions = s.versions.filter((v) => v.version.id !== versionId);
  }

  // preferences
  async getSettings(): Promise<Settings> { return this.settings; }
  async patchSettings(patch: Record<string, unknown>): Promise<Settings> {
    this.settings = mergePatch(this.settings, patch) as Settings;
    return this.settings;
  }
}
