import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { seal, unseal } from '../src/core/secrets.js';
import { gitBlobSha } from '../src/modules/github/index.js';
import { createTestApp, newProject, signUp, TINY_PNG, TEST_DATABASE_URL, type TestApp } from './helpers.js';

/**
 * A stand-in for GitHub: the device flow, one account ("ada"), and enough of the git data API to
 * hold real commits, so the tests can read back exactly what OpenLeaf saved.
 */
class FakeGithub {
  server!: Server;
  url = '';
  token = 'gho_' + randomBytes(12).toString('hex');
  approved: 'no' | 'yes' | 'denied' = 'no';
  revoked = false;
  calls: string[] = [];
  blobs = new Map<string, Buffer>();
  trees = new Map<string, { path: string; sha: string; type: string }[]>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  repos = new Map<string, { id: number; private: boolean; description: string; head: string }>();

  private sha(kind: string, value: unknown): string {
    return createHash('sha1').update(kind).update(JSON.stringify(value)).digest('hex');
  }

  commit(tree: string, parents: string[], message: string): string {
    const sha = this.sha('commit', { tree, parents, message, n: this.commits.size });
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }

  putTree(entries: { path: string; sha: string }[]): string {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path)).map((e) => ({ ...e, type: 'blob' }));
    const sha = this.sha('tree', sorted);
    this.trees.set(sha, sorted);
    return sha;
  }

  putBlob(data: Buffer): string {
    const sha = gitBlobSha(data);
    this.blobs.set(sha, data);
    return sha;
  }

  /** The files at the tip of a repository, as path -> contents. */
  files(fullName: string): Record<string, Buffer> {
    const repo = this.repos.get(fullName)!;
    const tree = this.trees.get(this.commits.get(repo.head)!.tree)!;
    return Object.fromEntries(tree.map((e) => [e.path, this.blobs.get(e.sha)!]));
  }

  /** Messages from the tip back to the first commit. */
  log(fullName: string): string[] {
    const out: string[] = [];
    for (let sha: string | undefined = this.repos.get(fullName)!.head; sha; sha = this.commits.get(sha)!.parents[0]) {
      out.push(this.commits.get(sha)!.message);
    }
    return out;
  }

  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    return String(req.headers['content-type']).includes('json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const url = new URL(req.url!, 'http://x');
      const path = url.pathname;
      this.calls.push(`${req.method} ${path}`);
      const body = req.method === 'GET' ? {} : await this.body(req);

      if (path === '/login/device/code') {
        return send(200, { device_code: 'device-1', user_code: 'WDJB-MJHT', verification_uri: `${this.url}/login/device`, expires_in: 900, interval: 1 });
      }
      if (path === '/login/oauth/access_token') {
        if (this.approved === 'no') return send(200, { error: 'authorization_pending' });
        if (this.approved === 'denied') return send(200, { error: 'access_denied' });
        return send(200, { access_token: this.token, token_type: 'bearer', scope: 'repo' });
      }
      if (this.revoked || req.headers.authorization !== `Bearer ${this.token}`) return send(401, { message: 'Bad credentials' });
      if (path === '/user' && req.method === 'GET') return send(200, { id: 42, login: 'ada', name: 'Ada Lovelace' });

      if (path === '/user/repos' && req.method === 'POST') {
        const fullName = `ada/${body.name}`;
        if (this.repos.has(fullName)) return send(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
        // auto_init: GitHub starts the repository with a README.
        const readme = this.putBlob(Buffer.from(`# ${body.name}\n`));
        const head = this.commit(this.putTree([{ path: 'README.md', sha: readme }]), [], 'Initial commit');
        this.repos.set(fullName, { id: 1000 + this.repos.size, private: Boolean(body.private), description: body.description ?? '', head });
        return send(201, { id: this.repos.get(fullName)!.id, name: body.name, full_name: fullName, html_url: `${this.url}/${fullName}`, private: Boolean(body.private), default_branch: 'main' });
      }

      const m = /^\/repos\/(ada\/[^/]+)\/git\/(.+)$/.exec(path);
      const repo = m ? this.repos.get(m[1]!) : undefined;
      if (!m || !repo) return send(404, { message: 'Not Found' });
      const rest = m[2]!;
      if (rest === 'ref/heads/main' && req.method === 'GET') return send(200, { object: { sha: repo.head } });
      if (rest.startsWith('commits/') && req.method === 'GET') return send(200, { tree: { sha: this.commits.get(rest.slice(8))!.tree } });
      if (rest.startsWith('trees/') && req.method === 'GET') return send(200, { truncated: false, tree: this.trees.get(rest.slice(6)) ?? [] });
      if (rest === 'blobs' && req.method === 'POST') return send(201, { sha: this.putBlob(Buffer.from(body.content, 'base64')) });
      if (rest === 'trees' && req.method === 'POST') return send(201, { sha: this.putTree(body.tree) });
      if (rest === 'commits' && req.method === 'POST') return send(201, { sha: this.commit(body.tree, body.parents, body.message) });
      if (rest === 'refs/heads/main' && req.method === 'PATCH') {
        if (!this.commits.get(body.sha)?.parents.includes(repo.head)) return send(422, { message: 'Update is not a fast forward' });
        repo.head = body.sha;
        return send(200, { object: { sha: repo.head } });
      }
      return send(404, { message: 'Not Found' });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const KEY = randomBytes(32).toString('base64');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('secrets and settings', () => {
  it('seals a value so that only the same key and owner open it', () => {
    const key = randomBytes(32);
    const sealed = seal(key, 'gho_secret', 'user-1');
    assert.ok(!sealed.includes('gho_secret'));
    assert.notEqual(seal(key, 'gho_secret', 'user-1'), sealed);
    assert.equal(unseal(key, sealed, 'user-1'), 'gho_secret');
    assert.equal(unseal(randomBytes(32), sealed, 'user-1'), null);
    assert.equal(unseal(key, sealed, 'user-2'), null);
    assert.equal(unseal(key, sealed.slice(0, -3) + 'AAA', 'user-1'), null);
    assert.equal(unseal(key, 'not sealed', 'user-1'), null);
  });

  it('refuses to hold GitHub tokens without a key to encrypt them', () => {
    assert.throws(() => loadConfig({ DATABASE_URL: TEST_DATABASE_URL, GITHUB_CLIENT_ID: 'abc' }), /SECRETS_KEY/);
    assert.throws(() => loadConfig({ DATABASE_URL: TEST_DATABASE_URL, SECRETS_KEY: 'too-short' }), /32 random bytes/);
    const c = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, GITHUB_CLIENT_ID: 'abc', SECRETS_KEY: KEY });
    assert.equal(c.github?.scope, 'repo');
    assert.equal(c.github?.apiUrl, 'https://api.github.com');
  });
});

describe('saving projects to GitHub', () => {
  const gh = new FakeGithub();
  let t: TestApp;
  let ada = { token: '', id: '', email: '' };
  let projectId = '';

  before(async () => {
    await gh.start();
    t = await createTestApp({ GITHUB_CLIENT_ID: 'client-id', SECRETS_KEY: KEY, GITHUB_API_URL: gh.url, GITHUB_URL: gh.url });
    ada = await signUp(t, 'ada');
    projectId = await newProject(t, ada.token, 'My Thesis');
    await t.api.put(`/api/projects/${projectId}/files/content`, { path: 'chapters/one.tex', content: 'Chapter one.\n' }, ada.token);
    await t.api.upload(`/api/projects/${projectId}/files/upload`, { fields: { folder: 'figures' }, files: [{ name: 'dot.png', data: TINY_PNG }] }, ada.token);
  });
  after(async () => {
    await t.destroy();
    await gh.stop();
  });

  const p = (suffix = '') => `/api/projects/${projectId}/github${suffix}`;

  it('needs an account to be linked first', async () => {
    const state = await t.api.get('/api/github', ada.token);
    assert.deepEqual(state.body, { available: true, scope: 'repo', account: null });
    const res = await t.api.post(p(), { name: 'thesis' }, ada.token);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'github_not_linked');
    assert.equal((await t.api.get('/api/github')).status, 401);
  });

  it('links with a one-time code, and keeps the token to itself', async () => {
    const start = await t.api.post('/api/github/link', undefined, ada.token);
    assert.equal(start.status, 200);
    assert.equal(start.body.userCode, 'WDJB-MJHT');
    assert.equal(start.body.verificationUri, `${gh.url}/login/device`);
    assert.equal(start.body.deviceCode, undefined);

    // Asking sooner than GitHub allows is answered without troubling GitHub.
    const before = gh.calls.length;
    assert.equal((await t.api.post(`/api/github/link/${start.body.linkId}`, undefined, ada.token)).body.status, 'pending');
    assert.equal(gh.calls.length, before);

    await wait(1100);
    assert.equal((await t.api.post(`/api/github/link/${start.body.linkId}`, undefined, ada.token)).body.status, 'pending');
    // Another account cannot finish someone else's link.
    const eve = await signUp(t, 'eve');
    assert.equal((await t.api.post(`/api/github/link/${start.body.linkId}`, undefined, eve.token)).body.status, 'expired');

    gh.approved = 'yes';
    await wait(1100);
    const done = await t.api.post(`/api/github/link/${start.body.linkId}`, undefined, ada.token);
    assert.equal(done.body.status, 'linked');
    assert.equal(done.body.account.login, 'ada');
    assert.ok(!JSON.stringify(done.body).includes(gh.token));

    const state = await t.api.get('/api/github', ada.token);
    assert.equal(state.body.account.login, 'ada');
    assert.deepEqual(state.body.account.scopes, ['repo']);
    assert.ok(!JSON.stringify(state.body).includes(gh.token));

    const stored = await t.db.query<{ token_enc: string }>('SELECT token_enc FROM github_accounts');
    assert.equal(stored.rowCount, 1);
    assert.ok(!stored.rows[0]!.token_enc.includes(gh.token));
    // The code is used up.
    assert.equal((await t.api.post(`/api/github/link/${start.body.linkId}`, undefined, ada.token)).body.status, 'expired');
  });

  it('creates a private repository holding exactly the project\'s files', async () => {
    const res = await t.api.post(p(), {}, ada.token);
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.repo, { fullName: 'ada/My-Thesis', url: `${gh.url}/ada/My-Thesis`, private: true, branch: 'main' });
    assert.equal(res.body.changed, false);
    assert.ok(res.body.lastCommit.sha);

    const files = gh.files('ada/My-Thesis');
    assert.deepEqual(Object.keys(files).sort(), ['chapters/one.tex', 'figures/dot.png', 'main.tex']);
    assert.equal(files['chapters/one.tex']!.toString(), 'Chapter one.\n');
    assert.ok(files['figures/dot.png']!.equals(TINY_PNG));
    assert.deepEqual(gh.log('ada/My-Thesis'), ['Start My Thesis in OpenLeaf', 'Initial commit']);

    const again = await t.api.post(p(), { name: 'other' }, ada.token);
    assert.equal(again.body.error.code, 'github_already_linked');
  });

  it('saves a change as one commit and uploads only what changed', async () => {
    await t.api.put(`/api/projects/${projectId}/files/content`, { path: 'chapters/one.tex', content: 'Chapter one, revised.\n', baseVersion: 1 }, ada.token);
    assert.equal((await t.api.get(p(), ada.token)).body.changed, true);

    const before = gh.calls.filter((c) => c.endsWith('/git/blobs')).length;
    const res = await t.api.post(p('/save'), { message: 'Revise chapter one' }, ada.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.saved, true);
    assert.equal(res.body.changed, false);
    assert.equal(gh.calls.filter((c) => c.endsWith('/git/blobs')).length - before, 1);
    assert.equal(gh.files('ada/My-Thesis')['chapters/one.tex']!.toString(), 'Chapter one, revised.\n');
    assert.equal(gh.log('ada/My-Thesis')[0], 'Revise chapter one');

    // Nothing new: no commit is made.
    const same = await t.api.post(p('/save'), undefined, ada.token);
    assert.equal(same.body.saved, false);
    assert.equal(gh.log('ada/My-Thesis').length, 3);

    // A deleted file leaves the repository too (and stays in its history).
    await t.api.del(`/api/projects/${projectId}/files?path=figures`, ada.token);
    await t.api.post(p('/save'), {}, ada.token);
    assert.deepEqual(Object.keys(gh.files('ada/My-Thesis')).sort(), ['chapters/one.tex', 'main.tex']);
    assert.equal(gh.log('ada/My-Thesis')[0], 'Save from OpenLeaf');
  });

  it('does not write over changes made on GitHub without being told to', async () => {
    const repo = gh.repos.get('ada/My-Thesis')!;
    const edited = gh.putTree([{ path: 'main.tex', sha: gh.putBlob(Buffer.from('edited on github')) }]);
    const outside = gh.commit(edited, [repo.head], 'Edit on GitHub');
    repo.head = outside;

    await t.api.put(`/api/projects/${projectId}/files/content`, { path: 'notes.tex', content: 'new\n' }, ada.token);
    const refused = await t.api.post(p('/save'), {}, ada.token);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'github_remote_changed');
    assert.equal(repo.head, outside);

    const forced = await t.api.post(p('/save'), { overwrite: true, message: 'Save over the GitHub edit' }, ada.token);
    assert.equal(forced.body.saved, true);
    assert.ok(gh.files('ada/My-Thesis')['notes.tex']);
    // The edit made on GitHub is still in the history.
    assert.deepEqual(gh.log('ada/My-Thesis').slice(0, 2), ['Save over the GitHub edit', 'Edit on GitHub']);
  });

  it('keeps one account\'s repositories away from another\'s', async () => {
    const eve = await signUp(t, 'eve');
    assert.equal((await t.api.get(p(), eve.token)).status, 404);
    assert.equal((await t.api.post(p('/save'), {}, eve.token)).status, 404);
    const hers = await newProject(t, eve.token, 'Hers');
    const res = await t.api.post(`/api/projects/${hers}/github`, {}, eve.token);
    assert.equal(res.body.error.code, 'github_not_linked');
  });

  it('refuses names that are taken or not allowed', async () => {
    const second = await newProject(t, ada.token, 'Second');
    const taken = await t.api.post(`/api/projects/${second}/github`, { name: 'My-Thesis' }, ada.token);
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'github_repo_exists');
    const bad = await t.api.post(`/api/projects/${second}/github`, { name: 'has spaces/and slashes' }, ada.token);
    assert.equal(bad.body.error.code, 'invalid_repo_name');
    const ok = await t.api.post(`/api/projects/${second}/github`, { name: 'second-paper', private: false }, ada.token);
    assert.equal(ok.status, 201);
    assert.equal(gh.repos.get('ada/second-paper')!.private, false);
  });

  it('forgets a project\'s repository without touching it, and unlinks the account', async () => {
    assert.equal((await t.api.del(p(), ada.token)).status, 204);
    assert.equal((await t.api.get(p(), ada.token)).body.repo, null);
    assert.ok(gh.repos.has('ada/My-Thesis'));
    assert.equal((await t.api.post(p('/save'), {}, ada.token)).body.error.code, 'github_no_repo');

    assert.equal((await t.api.del('/api/github', ada.token)).status, 204);
    assert.equal((await t.api.get('/api/github', ada.token)).body.account, null);
    assert.equal((await t.db.query('SELECT 1 FROM github_accounts')).rowCount, 0);
  });

  it('says so when the code is refused at GitHub, and unlinks when GitHub withdraws the token', async () => {
    gh.approved = 'denied';
    const start = await t.api.post('/api/github/link', undefined, ada.token);
    await wait(1100);
    assert.equal((await t.api.post(`/api/github/link/${start.body.linkId}`, undefined, ada.token)).body.status, 'denied');

    gh.approved = 'yes';
    const again = await t.api.post('/api/github/link', undefined, ada.token);
    await wait(1100);
    assert.equal((await t.api.post(`/api/github/link/${again.body.linkId}`, undefined, ada.token)).body.status, 'linked');

    gh.revoked = true;
    const third = await newProject(t, ada.token, 'Third');
    const res = await t.api.post(`/api/projects/${third}/github`, {}, ada.token);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'github_not_linked');
    assert.equal((await t.api.get('/api/github', ada.token)).body.account, null);
    gh.revoked = false;
  });
});

describe('an instance without GitHub set up', () => {
  it('says it is not available and stores nothing', async () => {
    const t = await createTestApp();
    try {
      const user = await signUp(t, 'plain');
      assert.deepEqual((await t.api.get('/api/github', user.token)).body, { available: false, scope: null, account: null });
      const res = await t.api.post('/api/github/link', undefined, user.token);
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'github_not_configured');
    } finally {
      await t.destroy();
    }
  });
});
