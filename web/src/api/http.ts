// The real back end: the OpenLeaf HTTP API. Every request carries the session token as a bearer header.
import {
  ApiError,
  type Api, type Change, type Compile, type CompileOptions, type FileDiff, type FileMeta, type PdfPosition, type Project,
  type GithubKeep, type GithubLinkAnswer, type GithubLinkStart, type GithubState,
  type Registration, type Session, type SessionInfo, type Settings, type SourcePosition, type SystemInfo, type Template, type TextFile,
  type User, type Version,
} from './types';

type Query = Record<string, string | number | boolean | undefined>;

function qs(query?: Query): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export class HttpApi implements Api {
  readonly kind = 'service' as const;
  readonly address: string;
  private readonly base: string;
  private token: string | null;
  /** Called when the service says the session is no longer valid. */
  onSignedOut: (() => void) | null = null;

  /** `shownAs`: the address to show, when calls go through a forwarding dev server. */
  constructor(base: string, token: string | null, shownAs?: string) {
    this.base = base.replace(/\/+$/, '');
    this.address = (shownAs || this.base || window.location.origin).replace(/^https?:\/\//, '');
    this.token = token;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  private async request(method: string, path: string, opts: { query?: Query; json?: unknown; form?: FormData } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}${qs(opts.query)}`, { method, headers, body });
    } catch {
      throw new ApiError(0, 'unreachable', 'The service did not answer. It may be asleep, or this computer may be offline.');
    }
    if (res.ok || res.status === 304) return res;
    let code = 'request_error';
    let message = `The service answered ${res.status}.`;
    let details: unknown;
    try {
      const data = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      if (data.error) {
        code = data.error.code ?? code;
        message = data.error.message ?? message;
        details = data.error.details;
      }
    } catch {
      // Not JSON: a gateway or dev-server page, which is what answers while the service is asleep or away.
      if (res.status >= 500) {
        code = 'unreachable';
        message = 'The service is not answering yet. It may be waking up; try again in a moment.';
      }
    }
    if (res.status === 401 && this.token && code !== 'invalid_credentials') this.onSignedOut?.();
    throw new ApiError(res.status, code, message, details);
  }

  private async json<T>(method: string, path: string, opts: { query?: Query; json?: unknown; form?: FormData } = {}): Promise<T> {
    const res = await this.request(method, path, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // accounts
  registration() { return this.json<Registration>('GET', '/api/auth/registration'); }
  register(input: { email: string; password: string; displayName?: string; inviteCode?: string }) {
    return this.json<Session>('POST', '/api/auth/register', { json: input });
  }
  login(email: string, password: string) { return this.json<Session>('POST', '/api/auth/login', { json: { email, password } }); }
  firebaseSignIn(idToken: string, inviteCode?: string) {
    return this.json<Session>('POST', '/api/auth/firebase', { json: { idToken, inviteCode } });
  }
  async logout() { await this.json<void>('POST', '/api/auth/logout'); }
  async logoutAll() { await this.json<void>('POST', '/api/auth/logout-all'); }
  async sessions() { return (await this.json<{ sessions: SessionInfo[] }>('GET', '/api/auth/sessions')).sessions; }
  async me() { return (await this.json<{ user: User }>('GET', '/api/auth/me')).user; }

  // system
  info() { return this.json<SystemInfo>('GET', '/api/system/info'); }

  // projects
  async listProjects(status: 'active' | 'archived' | 'trashed' = 'active') {
    return (await this.json<{ projects: Project[] }>('GET', '/api/projects', { query: { status } })).projects;
  }
  async getProject(id: string) { return (await this.json<{ project: Project }>('GET', `/api/projects/${id}`)).project; }
  async createProject(input: { name: string }) {
    return (await this.json<{ project: Project }>('POST', '/api/projects', { json: input })).project;
  }
  async createFromTemplate(templateId: string, input: { name: string }) {
    return (await this.json<{ project: Project }>('POST', `/api/templates/${encodeURIComponent(templateId)}/projects`, { json: input })).project;
  }
  async patchProject(id: string, patch: Record<string, unknown>) {
    return (await this.json<{ project: Project }>('PATCH', `/api/projects/${id}`, { json: patch })).project;
  }
  async duplicateProject(id: string) {
    return (await this.json<{ project: Project }>('POST', `/api/projects/${id}/duplicate`, { json: {} })).project;
  }
  async moveProject(id: string, to: 'archive' | 'unarchive' | 'trash' | 'restore') {
    return (await this.json<{ project: Project }>('POST', `/api/projects/${id}/${to}`)).project;
  }
  async deleteProject(id: string) { await this.json<void>('DELETE', `/api/projects/${id}`, { query: { force: true } }); }
  async importZip(file: File, name?: string) {
    const form = new FormData();
    if (name) form.append('name', name);
    form.append('file', file, file.name);
    return (await this.json<{ project: Project }>('POST', '/api/projects/import', { form })).project;
  }
  async exportZip(id: string) { return (await this.request('GET', `/api/projects/${id}/export.zip`)).blob(); }
  async backupAll() { return (await this.request('GET', '/api/export/projects.zip')).blob(); }
  async listTemplates() { return (await this.json<{ templates: Template[] }>('GET', '/api/templates')).templates; }

  // files
  listFiles(id: string) { return this.json<{ mainFile: string; files: FileMeta[] }>('GET', `/api/projects/${id}/files`); }
  async readText(id: string, path: string) {
    return (await this.json<{ file: TextFile }>('GET', `/api/projects/${id}/files/content`, { query: { path } })).file;
  }
  async saveText(id: string, path: string, content: string, opts: { baseVersion?: number; createOnly?: boolean } = {}) {
    return (await this.json<{ file: FileMeta }>('PUT', `/api/projects/${id}/files/content`, { json: { path, content, ...opts } })).file;
  }
  async readRaw(id: string, path: string) { return (await this.request('GET', `/api/projects/${id}/files/raw`, { query: { path } })).blob(); }
  async createFolder(id: string, path: string) { await this.json('POST', `/api/projects/${id}/files/folder`, { json: { path } }); }
  async movePath(id: string, from: string, to: string) { await this.json('POST', `/api/projects/${id}/files/move`, { json: { from, to } }); }
  async deletePath(id: string, path: string) { await this.json('DELETE', `/api/projects/${id}/files`, { query: { path } }); }
  async upload(id: string, files: File[], folder?: string) {
    const form = new FormData();
    if (folder) form.append('folder', folder); // fields must come before the files
    for (const file of files) form.append('file', file, file.name);
    return (await this.json<{ files: FileMeta[] }>('POST', `/api/projects/${id}/files/upload`, { form })).files;
  }

  // compile
  async compile(id: string, options: CompileOptions = {}) {
    return (await this.json<{ compile: Compile }>('POST', `/api/projects/${id}/compile`, { json: options })).compile;
  }
  async latestCompile(id: string) {
    return (await this.json<{ compile: Compile | null }>('GET', `/api/projects/${id}/compiles/latest`)).compile;
  }
  async pdf(id: string, compileId?: string) {
    return (await this.request('GET', `/api/projects/${id}/output.pdf`, { query: { compile: compileId } })).arrayBuffer();
  }
  async log(id: string, compileId?: string) {
    return (await this.request('GET', `/api/projects/${id}/output.log`, { query: { compile: compileId } })).text();
  }
  async synctexForward(id: string, at: { file: string; line: number; column?: number }) {
    return (await this.json<{ positions: PdfPosition[] }>('POST', `/api/projects/${id}/synctex/forward`, { json: at })).positions;
  }
  async synctexInverse(id: string, at: { page: number; h: number; v: number }) {
    try {
      return (await this.json<{ position: SourcePosition }>('POST', `/api/projects/${id}/synctex/inverse`, { json: at })).position;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'no_match') return null;
      throw err;
    }
  }

  // history
  async listVersions(id: string) { return (await this.json<{ versions: Version[] }>('GET', `/api/projects/${id}/versions`)).versions; }
  async createVersion(id: string, label: string) {
    return (await this.json<{ version: Version }>('POST', `/api/projects/${id}/versions`, { json: { label } })).version;
  }
  async versionChanges(id: string, versionId: string) {
    return (await this.json<{ changes: Change[] }>('GET', `/api/projects/${id}/versions/${versionId}/diff`)).changes;
  }
  versionDiff(id: string, versionId: string, path: string) {
    return this.json<FileDiff>('GET', `/api/projects/${id}/versions/${versionId}/diff`, { query: { path } });
  }
  async restoreVersion(id: string, versionId: string) { await this.json('POST', `/api/projects/${id}/versions/${versionId}/restore`); }
  async deleteVersion(id: string, versionId: string) { await this.json('DELETE', `/api/projects/${id}/versions/${versionId}`); }

  // preferences
  async getSettings() { return (await this.json<{ settings: Settings }>('GET', '/api/settings')).settings; }
  async patchSettings(patch: Record<string, unknown>) {
    return (await this.json<{ settings: Settings }>('PATCH', '/api/settings', { json: patch })).settings;
  }

  // GitHub
  github() { return this.json<GithubState>('GET', '/api/github'); }
  githubLinkStart() { return this.json<GithubLinkStart>('POST', '/api/github/link'); }
  githubLinkPoll(linkId: string) { return this.json<GithubLinkAnswer>('POST', `/api/github/link/${encodeURIComponent(linkId)}`); }
  async githubUnlink() { await this.json<void>('DELETE', '/api/github'); }
  githubKeep(id: string) { return this.json<GithubKeep>('GET', `/api/projects/${id}/github`); }
  githubCreate(id: string, input: { name?: string; private?: boolean }) { return this.json<GithubKeep>('POST', `/api/projects/${id}/github`, { json: input }); }
  githubSave(id: string, input: { message?: string; overwrite?: boolean } = {}) { return this.json<GithubKeep>('POST', `/api/projects/${id}/github/save`, { json: input }); }
  async githubForget(id: string) { await this.json<void>('DELETE', `/api/projects/${id}/github`); }
}
