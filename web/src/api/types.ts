// Shapes of the OpenLeaf API, as the back end in ../../src returns them.

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'owner' | 'member';
  createdAt: string;
}

export interface Session {
  user: User;
  token: string;
  expiresAt: string | null;
}

export interface Registration {
  mode: 'first-user' | 'invite' | 'open' | 'closed';
  open: boolean;
  requiresInviteCode: boolean;
  hasUsers: boolean;
  /** Who checks who you are: the service itself (a password), or Firebase (a Google account). */
  provider?: 'local' | 'firebase';
  /** With `provider: 'firebase'`: what the browser needs to open Google's window. None of it is secret. */
  firebase?: { apiKey: string; authDomain: string; projectId: string; signInProviders: string[] };
}

export interface EngineStatus {
  id: string;
  label: string;
  description?: string;
  available: boolean;
  version: string | null;
}

export interface SystemInfo {
  name: string;
  version: string;
  uptimeSeconds: number;
  modules: { name: string; description: string; core: boolean }[];
  registration: { mode: string; hasOwner: boolean };
  limits: { maxUploadBytes: number; maxProjectBytes: number; maxTextFileBytes: number };
  compile?: {
    defaultEngine: string; timeoutSeconds: number; engines: EngineStatus[];
    /** How compiles are kept apart from the service on this host. */
    isolation?: Isolation;
  };
  templates?: { builtin: string[] };
  github?: { available: boolean; scope: string | null };
}

/** What stands between a compile and the service that started it. Older services say only the first four. */
export interface Isolation {
  namespaces: boolean; limits: boolean; noNewPrivileges: boolean; summary: string;
  /** A compile cannot open a network connection of any kind. */
  noNetwork?: boolean;
  /** It cannot look into the service's process or any other. */
  noProcessAccess?: boolean;
  /** It sees only the TeX installation and its own folders. */
  narrowFiles?: boolean;
  /** The service's own memory is closed to the programs it starts. */
  serviceGuarded?: boolean;
  launcher?: boolean;
}

/** A place this account is signed in. */
export interface SessionInfo {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  current: boolean;
}

export interface GithubAccount {
  login: string; name: string; scopes: string[]; linkedAt: string;
  /** The link renews itself as it is used; left unused it lapses on this date. Null: it lasts until unlinked. */
  lapsesAt?: string | null;
}

/** Whether the service can save to GitHub, and the account linked to this OpenLeaf account. */
export interface GithubState { available: boolean; scope: string | null; account: GithubAccount | null }

/** A link being made: the code to type in at GitHub, and where. */
export interface GithubLinkStart { linkId: string; userCode: string; verificationUri: string; expiresAt: string; intervalSeconds: number }

export type GithubLinkAnswer =
  | { status: 'pending'; intervalSeconds?: number }
  | { status: 'linked'; account: GithubAccount }
  | { status: 'expired' | 'denied' };

/** The repository a project is kept in. */
export interface GithubKeep {
  repo: { fullName: string; url: string; private: boolean; branch: string } | null;
  lastSavedAt: string | null;
  lastCommit: { sha: string; url: string } | null;
  /** The project has changed since it was last saved there. */
  changed: boolean;
  /** On a save: whether a commit was made (false when there was nothing new). */
  saved?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  mainFile: string;
  engine: string;
  tags: string[];
  settings: Record<string, unknown>;
  archived: boolean;
  trashed: boolean;
  archivedAt: string | null;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
  fileCount?: number;
  totalSize?: number;
}

export type FileKind = 'text' | 'binary' | 'folder';

export interface FileMeta {
  id: string;
  path: string;
  kind: FileKind;
  size: number;
  sha256: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TextFile extends FileMeta {
  content: string;
}

export type DiagnosticLevel = 'error' | 'warning' | 'typesetting';

export interface Diagnostic {
  level: DiagnosticLevel;
  message: string;
  /** Project-relative path when the problem is in a project file. */
  file: string | null;
  line: number | null;
  source: 'latex' | 'bibtex' | 'biber' | 'latexmk';
  /** The offending source text or extra explanation TeX printed, if any. */
  context?: string;
}

export type CompileStatus = 'queued' | 'running' | 'success' | 'failure' | 'timeout' | 'error';

export interface Compile {
  id: string;
  status: CompileStatus;
  engine: string;
  mainFile: string;
  message: string | null;
  errorCount: number;
  warningCount: number;
  hasPdf: boolean;
  pdfSize: number | null;
  hasSynctex: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  cached?: boolean;
  diagnostics?: Diagnostic[];
}

export interface CompileOptions {
  engine?: string;
  mainFile?: string;
  stopOnFirstError?: boolean;
  clean?: boolean;
  force?: boolean;
}

export interface PdfPosition {
  page: number;
  /** PDF points from the top-left of the page. */
  h: number;
  v: number;
  width: number;
  height: number;
}

export interface SourcePosition {
  file: string;
  line: number;
  column: number;
}

export interface Version {
  id: string;
  kind: 'manual' | 'auto' | 'restore';
  label: string;
  mainFile: string;
  engine: string;
  fileCount: number;
  totalSize: number;
  createdAt: string;
}

export interface Change {
  path: string;
  kind: FileKind;
  status: 'added' | 'removed' | 'modified';
}

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  binary: boolean;
  patch: string | null;
  before: string | null;
  after: string | null;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  engine: string;
  mainFile: string;
  builtin: boolean;
  fileCount: number;
}

/** Preferences as the back end merges them over its defaults; the app keeps its own keys under `openleaf`. */
export type Settings = Record<string, unknown>;

/** An error the API answered with: `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Everything the screens need from a back end. Implemented by HttpApi (the real service) and SampleApi (in memory). */
export interface Api {
  readonly kind: 'service' | 'sample';
  /** Where this back end lives, for display. */
  readonly address: string;

  // accounts
  registration(): Promise<Registration>;
  register(input: { email: string; password: string; displayName?: string; inviteCode?: string }): Promise<Session>;
  login(email: string, password: string): Promise<Session>;
  /** Trade a Firebase ID token for a session. A new account on an invite-only service needs `inviteCode`. */
  firebaseSignIn(idToken: string, inviteCode?: string): Promise<Session>;
  logout(): Promise<void>;
  /** End every session of this account, on every browser. */
  logoutAll(): Promise<void>;
  sessions(): Promise<SessionInfo[]>;
  me(): Promise<User>;

  // system
  info(): Promise<SystemInfo>;

  // projects
  listProjects(status?: 'active' | 'archived' | 'trashed'): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(input: { name: string }): Promise<Project>;
  createFromTemplate(templateId: string, input: { name: string }): Promise<Project>;
  patchProject(id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'mainFile' | 'engine' | 'tags'>> & { settings?: Record<string, unknown> }): Promise<Project>;
  duplicateProject(id: string): Promise<Project>;
  moveProject(id: string, to: 'archive' | 'unarchive' | 'trash' | 'restore'): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  importZip(file: File, name?: string): Promise<Project>;
  exportZip(id: string): Promise<Blob>;
  backupAll(): Promise<Blob>;
  listTemplates(): Promise<Template[]>;

  // files
  listFiles(id: string): Promise<{ mainFile: string; files: FileMeta[] }>;
  readText(id: string, path: string): Promise<TextFile>;
  saveText(id: string, path: string, content: string, opts?: { baseVersion?: number; createOnly?: boolean }): Promise<FileMeta>;
  readRaw(id: string, path: string): Promise<Blob>;
  createFolder(id: string, path: string): Promise<void>;
  movePath(id: string, from: string, to: string): Promise<void>;
  deletePath(id: string, path: string): Promise<void>;
  upload(id: string, files: File[], folder?: string): Promise<FileMeta[]>;

  // compile
  compile(id: string, options?: CompileOptions): Promise<Compile>;
  latestCompile(id: string): Promise<Compile | null>;
  /** The PDF of a compile, or of the latest compile that produced one. */
  pdf(id: string, compileId?: string): Promise<ArrayBuffer>;
  log(id: string, compileId?: string): Promise<string>;
  synctexForward(id: string, at: { file: string; line: number; column?: number }): Promise<PdfPosition[]>;
  synctexInverse(id: string, at: { page: number; h: number; v: number }): Promise<SourcePosition | null>;

  // history
  listVersions(id: string): Promise<Version[]>;
  createVersion(id: string, label: string): Promise<Version>;
  versionChanges(id: string, versionId: string): Promise<Change[]>;
  versionDiff(id: string, versionId: string, path: string): Promise<FileDiff>;
  restoreVersion(id: string, versionId: string): Promise<void>;
  deleteVersion(id: string, versionId: string): Promise<void>;

  // preferences
  getSettings(): Promise<Settings>;
  patchSettings(patch: Record<string, unknown>): Promise<Settings>;

  // GitHub: an account linked by a one-time code, and one repository per project
  github(): Promise<GithubState>;
  githubLinkStart(): Promise<GithubLinkStart>;
  githubLinkPoll(linkId: string): Promise<GithubLinkAnswer>;
  githubUnlink(): Promise<void>;
  githubKeep(id: string): Promise<GithubKeep>;
  githubCreate(id: string, input: { name?: string; private?: boolean }): Promise<GithubKeep>;
  githubSave(id: string, input?: { message?: string; overwrite?: boolean }): Promise<GithubKeep>;
  githubForget(id: string): Promise<void>;
}
