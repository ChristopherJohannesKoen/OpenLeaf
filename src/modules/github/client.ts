import type { GithubConfig } from '../../config.js';
import { VERSION } from '../../version.js';

/** A failed call to GitHub: its HTTP status and what it said. */
export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

const TIMEOUT_MS = 30_000;

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The handful of GitHub calls OpenLeaf makes, with a person's token. Nothing here logs the token. */
export class Github {
  constructor(
    private readonly config: GithubConfig,
    private readonly token: string | null = null,
  ) {}

  private async call<T>(method: string, url: string, body?: unknown, form = false): Promise<T> {
    const headers: Record<string, string> = {
      Accept: form ? 'application/json' : 'application/vnd.github+json',
      'User-Agent': `OpenLeaf/${VERSION}`,
    };
    if (!form) headers['X-GitHub-Api-Version'] = '2022-11-28';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
      payload = form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    } catch (err) {
      throw new GithubError(0, `GitHub could not be reached (${(err as Error).name}).`);
    }
    const data = await parse(res);
    if (!res.ok) {
      const said = (data as { message?: string } | null)?.message;
      throw new GithubError(res.status, said ? `GitHub said: ${said}` : `GitHub answered ${res.status}.`, data);
    }
    return data as T;
  }

  private api<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.call<T>(method, `${this.config.apiUrl}${path}`, body);
  }

  // ---- linking an account (the "device flow": a one-time code typed in at github.com) ----

  startDeviceFlow() {
    return this.call<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>(
      'POST',
      `${this.config.webUrl}/login/device/code`,
      { client_id: this.config.clientId, scope: this.config.scope },
      true,
    );
  }

  pollDeviceFlow(deviceCode: string) {
    return this.call<{ access_token?: string; scope?: string; error?: string; error_description?: string; interval?: number }>(
      'POST',
      `${this.config.webUrl}/login/oauth/access_token`,
      { client_id: this.config.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
      true,
    );
  }

  me() {
    return this.api<{ id: number; login: string; name: string | null }>('GET', '/user');
  }

  // ---- repositories ----

  createRepo(input: { name: string; description: string; private: boolean }) {
    return this.api<Repo>('POST', '/user/repos', { ...input, auto_init: true, has_wiki: false, has_projects: false });
  }

  repo(fullName: string) {
    return this.api<Repo>('GET', `/repos/${fullName}`);
  }

  // ---- git data: a commit is built from blobs and one tree, then the branch is moved to it ----

  async head(fullName: string, branch: string): Promise<string> {
    const ref = await this.api<{ object: { sha: string } }>('GET', `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`);
    return ref.object.sha;
  }

  async commitTree(fullName: string, commitSha: string): Promise<string> {
    return (await this.api<{ tree: { sha: string } }>('GET', `/repos/${fullName}/git/commits/${commitSha}`)).tree.sha;
  }

  tree(fullName: string, treeSha: string) {
    return this.api<{ truncated: boolean; tree: { path: string; type: string; sha: string }[] }>(
      'GET',
      `/repos/${fullName}/git/trees/${treeSha}?recursive=1`,
    );
  }

  async createBlob(fullName: string, data: Buffer): Promise<string> {
    return (await this.api<{ sha: string }>('POST', `/repos/${fullName}/git/blobs`, { content: data.toString('base64'), encoding: 'base64' })).sha;
  }

  async createTree(fullName: string, entries: { path: string; sha: string }[]): Promise<string> {
    const tree = entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha }));
    return (await this.api<{ sha: string }>('POST', `/repos/${fullName}/git/trees`, { tree })).sha;
  }

  async createCommit(fullName: string, input: { message: string; tree: string; parents: string[] }): Promise<string> {
    return (await this.api<{ sha: string }>('POST', `/repos/${fullName}/git/commits`, input)).sha;
  }

  async moveBranch(fullName: string, branch: string, sha: string): Promise<void> {
    await this.api('PATCH', `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
  }
}

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch: string;
}
