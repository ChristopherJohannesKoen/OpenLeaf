import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { redactUrl } from '../src/app.js';
import { createTestApp, newProject, signUp, TINY_PNG, type TestApp } from './helpers.js';

describe('accounts', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp({ REGISTRATION: 'first-user' });
  });
  after(() => t.destroy());

  let token = '';

  it('reports that registration is open until the owner exists', async () => {
    const res = await t.api.get('/api/auth/registration');
    assert.deepEqual(res.body, { mode: 'first-user', open: true, requiresInviteCode: false, hasUsers: false, provider: 'local' });
  });

  it('rejects weak passwords and bad emails', async () => {
    assert.equal((await t.api.post('/api/auth/register', { email: 'me@example.com', password: 'short' })).status, 400);
    assert.equal((await t.api.post('/api/auth/register', { email: 'not-an-email', password: 'long enough pw' })).status, 400);
  });

  it('makes the first account the owner and then closes registration', async () => {
    const res = await t.api.post('/api/auth/register', {
      email: 'Owner@Example.com',
      password: 'correct horse battery',
      displayName: 'Owner',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'owner');
    assert.equal(res.body.user.email, 'owner@example.com');
    assert.equal(res.body.user.password_hash, undefined);
    token = res.body.token;

    const second = await t.api.post('/api/auth/register', { email: 'x@example.com', password: 'correct horse battery' });
    assert.equal(second.status, 403);
    assert.equal(second.body.error.code, 'registration_closed');
  });

  it('requires a valid token', async () => {
    assert.equal((await t.api.get('/api/auth/me')).status, 401);
    assert.equal((await t.api.get('/api/auth/me', 'olf_wrong')).status, 401);
    const me = await t.api.get('/api/auth/me', token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.displayName, 'Owner');
  });

  it('signs in with the right password only', async () => {
    const bad = await t.api.post('/api/auth/login', { email: 'owner@example.com', password: 'wrong password' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'invalid_credentials');
    const unknown = await t.api.post('/api/auth/login', { email: 'nobody@example.com', password: 'whatever pw' });
    assert.equal(unknown.status, 401);
    const good = await t.api.post('/api/auth/login', { email: 'OWNER@example.com', password: 'correct horse battery' });
    assert.equal(good.status, 200);
    assert.ok(good.body.token.startsWith('olf_'));
    assert.notEqual(good.body.token, token);
  });

  it('creates, uses and revokes API tokens', async () => {
    const created = await t.api.post('/api/auth/tokens', { name: 'notebook' }, token);
    assert.equal(created.status, 201);
    assert.ok(created.body.token.startsWith('olp_'));
    assert.equal((await t.api.get('/api/projects', created.body.token)).status, 200);

    const list = await t.api.get('/api/auth/tokens', token);
    assert.equal(list.body.tokens.length, 1);
    assert.equal(list.body.tokens[0].token, undefined);

    assert.equal((await t.api.del(`/api/auth/tokens/${created.body.id}`, token)).status, 204);
    assert.equal((await t.api.get('/api/projects', created.body.token)).status, 401);
  });

  it('changes the password and signs out other sessions', async () => {
    const other = await t.api.post('/api/auth/login', { email: 'owner@example.com', password: 'correct horse battery' });
    const wrong = await t.api.post('/api/auth/password', { currentPassword: 'nope nope nope', newPassword: 'another long password' }, token);
    assert.equal(wrong.status, 401);
    const ok = await t.api.post(
      '/api/auth/password',
      { currentPassword: 'correct horse battery', newPassword: 'another long password' },
      token,
    );
    assert.equal(ok.status, 204);
    assert.equal((await t.api.get('/api/auth/me', other.body.token)).status, 401);
    assert.equal((await t.api.get('/api/auth/me', token)).status, 200);
    assert.equal(
      (await t.api.post('/api/auth/login', { email: 'owner@example.com', password: 'another long password' })).status,
      200,
    );
  });

  it('ends a session on logout', async () => {
    const s = await t.api.post('/api/auth/login', { email: 'owner@example.com', password: 'another long password' });
    assert.equal((await t.api.post('/api/auth/logout', undefined, s.body.token)).status, 204);
    assert.equal((await t.api.get('/api/auth/me', s.body.token)).status, 401);
  });
});

describe('sign-in through Firebase', () => {
  const PROJECT = 'openleaf-test';
  let t: TestApp;
  let jwks: Server;
  let key: CryptoKey;
  let strangerKey: CryptoKey;

  /** An ID token as Firebase would issue it after "Continue with Google", with any claim overridden. */
  const idToken = (claims: Record<string, unknown> = {}, opts: { signWith?: CryptoKey; expiresIn?: string } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      email_verified: true,
      auth_time: now - 5,
      firebase: { identities: { 'google.com': ['1234'] }, sign_in_provider: 'google.com' },
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer((claims.iss as string) ?? `https://securetoken.google.com/${PROJECT}`)
      .setAudience((claims.aud as string) ?? PROJECT)
      .setSubject((claims.sub as string) ?? 'uid-ada')
      .setIssuedAt(now - 5)
      .setExpirationTime(opts.expiresIn ?? '1h')
      .sign(opts.signWith ?? key);
  };

  before(async () => {
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey;
    strangerKey = (await generateKeyPair('RS256')).privateKey;
    const published = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
    jwks = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(published));
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
    const { port } = jwks.address() as AddressInfo;
    t = await createTestApp({
      AUTH_PROVIDER: 'firebase',
      FIREBASE_PROJECT_ID: PROJECT,
      FIREBASE_API_KEY: 'web-api-key',
      FIREBASE_JWKS_URL: `http://127.0.0.1:${port}/jwks`,
      REGISTRATION: 'invite',
      INVITE_CODE: 'letmein',
    });
  });
  after(async () => {
    await t.destroy();
    await new Promise((resolve) => jwks.close(resolve));
  });

  it('tells the front end how to start the sign-in', async () => {
    const res = await t.api.get('/api/auth/registration');
    assert.equal(res.body.provider, 'firebase');
    assert.deepEqual(res.body.firebase, {
      apiKey: 'web-api-key',
      authDomain: `${PROJECT}.firebaseapp.com`,
      projectId: PROJECT,
      signInProviders: ['google.com'],
    });
  });

  it('keeps no passwords: register, login and change-password are refused', async () => {
    const register = await t.api.post('/api/auth/register', { email: 'a@example.com', password: 'correct horse battery', inviteCode: 'letmein' });
    assert.equal(register.status, 403);
    assert.equal(register.body.error.code, 'password_sign_in_disabled');
    const login = await t.api.post('/api/auth/login', { email: 'a@example.com', password: 'correct horse battery' });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'password_sign_in_disabled');
  });

  it('refuses tokens that Firebase did not issue for this project', async () => {
    const bad = async (token: string, status = 401, code = 'invalid_id_token') => {
      const res = await t.api.post('/api/auth/firebase', { idToken: token, inviteCode: 'letmein' });
      assert.equal(res.status, status);
      assert.equal(res.body.error.code, code);
    };
    await bad('not-a-token');
    await bad(await idToken({}, { signWith: strangerKey }));
    await bad(await idToken({ aud: 'someone-elses-project' }));
    await bad(await idToken({ iss: 'https://securetoken.google.com/someone-elses-project' }));
    await bad(await idToken({}, { expiresIn: '-10m' }));
    await bad(await idToken({ auth_time: Math.floor(Date.now() / 1000) + 3600 }));
    // signed with "none", or with the public key as an HMAC secret, must not pass either
    const [, body] = (await idToken()).split('.');
    await bad(`${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${body}.`);
    // right project, but not an address the provider vouches for, or not Google at all
    await bad(await idToken({ email_verified: false }), 403, 'email_not_verified');
    await bad(await idToken({ firebase: { sign_in_provider: 'password' } }), 403, 'sign_in_method_not_allowed');
    assert.equal((await t.api.get('/api/auth/registration')).body.hasUsers, false);
  });

  let ownerId = '';
  let session = '';

  it('asks a new account for the invite code, then makes it the owner', async () => {
    const missing = await t.api.post('/api/auth/firebase', { idToken: await idToken() });
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error.code, 'invite_required');
    const wrong = await t.api.post('/api/auth/firebase', { idToken: await idToken(), inviteCode: 'guess' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, 'invalid_invite_code');

    const res = await t.api.post('/api/auth/firebase', { idToken: await idToken({ email: 'Ada@Example.com' }), inviteCode: 'letmein' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'owner');
    assert.equal(res.body.user.email, 'ada@example.com');
    assert.equal(res.body.user.displayName, 'Ada Lovelace');
    assert.ok(res.body.token.startsWith('olf_'));
    ownerId = res.body.user.id;
    session = res.body.token;

    const stored = await t.db.query<{ password_hash: string | null; firebase_uid: string }>('SELECT password_hash, firebase_uid FROM users');
    assert.deepEqual(stored.rows, [{ password_hash: null, firebase_uid: 'uid-ada' }]);
  });

  it('signs the same account in again without the code, and the session works', async () => {
    const again = await t.api.post('/api/auth/firebase', { idToken: await idToken() });
    assert.equal(again.status, 200);
    assert.equal(again.body.user.id, ownerId);
    assert.notEqual(again.body.token, session);
    const me = await t.api.get('/api/auth/me', session);
    assert.equal(me.body.user.email, 'ada@example.com');
    assert.equal((await t.api.post('/api/projects', { name: 'Notes' }, session)).status, 201);
  });

  it('makes later accounts members, each with their own id', async () => {
    const other = await idToken({ sub: 'uid-grace', email: 'grace@example.com', name: 'Grace Hopper' });
    assert.equal((await t.api.post('/api/auth/firebase', { idToken: other })).body.error.code, 'invite_required');
    const res = await t.api.post('/api/auth/firebase', { idToken: other, inviteCode: 'letmein' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'member');
    assert.notEqual(res.body.user.id, ownerId);
    assert.equal((await t.api.get('/api/projects', res.body.token)).body.projects.length, 0);
  });

  it('does not let one account take an address that belongs to another', async () => {
    const clash = await t.api.post('/api/auth/firebase', {
      idToken: await idToken({ sub: 'uid-impostor', email: 'ada@example.com' }),
      inviteCode: 'letmein',
    });
    assert.equal(clash.status, 409);
    const change = await t.api.patch('/api/auth/me', { email: 'someone@example.com' }, session);
    assert.equal(change.status, 403);
    assert.equal(change.body.error.code, 'email_from_provider');
    assert.equal((await t.api.patch('/api/auth/me', { displayName: 'Ada L.' }, session)).body.user.displayName, 'Ada L.');
  });
});

describe('invite-only registration', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp({ REGISTRATION: 'invite', INVITE_CODE: 'let-me-in' });
  });
  after(() => t.destroy());

  it('needs the right invite code', async () => {
    const body = { email: 'a@example.com', password: 'correct horse battery' };
    assert.equal((await t.api.post('/api/auth/register', body)).status, 403);
    assert.equal((await t.api.post('/api/auth/register', { ...body, inviteCode: 'wrong' })).status, 403);
    const ok = await t.api.post('/api/auth/register', { ...body, inviteCode: 'let-me-in' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.user.role, 'owner');
    const second = await t.api.post('/api/auth/register', {
      email: 'b@example.com',
      password: 'correct horse battery',
      inviteCode: 'let-me-in',
    });
    assert.equal(second.body.user.role, 'member');
    const dup = await t.api.post('/api/auth/register', { ...body, inviteCode: 'let-me-in' });
    assert.equal(dup.status, 409);
  });

  it('has no Firebase sign-in unless it is switched on', async () => {
    const res = await t.api.post('/api/auth/firebase', { idToken: 'anything' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'firebase_sign_in_disabled');
  });
});

describe('projects and files', () => {
  let t: TestApp;
  let alice = '';
  let bob = '';
  let projectId = '';
  before(async () => {
    t = await createTestApp();
    alice = (await signUp(t, 'alice')).token;
    bob = (await signUp(t, 'bob')).token;
  });
  after(() => t.destroy());

  const files = (id = projectId) => `/api/projects/${id}/files`;

  it('creates a project with a starter document', async () => {
    const res = await t.api.post('/api/projects', { name: '  Beam  theory & R_1 ', tags: ['thesis', 'thesis', ' fem '] }, alice);
    assert.equal(res.status, 201);
    projectId = res.body.project.id;
    assert.equal(res.body.project.name, 'Beam theory & R_1');
    assert.deepEqual(res.body.project.tags, ['thesis', 'fem']);
    assert.equal(res.body.project.mainFile, 'main.tex');

    const main = await t.api.get(`${files()}/content?path=main.tex`, alice);
    assert.equal(main.status, 200);
    assert.match(main.body.file.content, /\\title\{Beam theory \\& R\\_1\}/);
    assert.equal(main.body.file.version, 1);
  });

  it("keeps one user's projects invisible to another", async () => {
    assert.equal((await t.api.get(`/api/projects/${projectId}`, bob)).status, 404);
    assert.equal((await t.api.get(`${files()}/content?path=main.tex`, bob)).status, 404);
    assert.equal((await t.api.put(`${files()}/content`, { path: 'x.tex', content: 'x' }, bob)).status, 404);
    assert.equal((await t.api.del(`/api/projects/${projectId}?force=true`, bob)).status, 404);
    assert.equal((await t.api.get('/api/projects', bob)).body.projects.length, 0);
    assert.equal((await t.api.get('/api/projects', alice)).body.projects.length, 1);
  });

  it('saves text files with version checks', async () => {
    const created = await t.api.put(`${files()}/content`, { path: 'chapters/intro.tex', content: 'Hello' }, alice);
    assert.equal(created.status, 200);
    assert.equal(created.body.file.version, 1);
    assert.equal(created.body.file.size, 5);

    const saved = await t.api.put(`${files()}/content`, { path: 'chapters/intro.tex', content: 'Hello again', baseVersion: 1 }, alice);
    assert.equal(saved.body.file.version, 2);

    const stale = await t.api.put(`${files()}/content`, { path: 'chapters/intro.tex', content: 'Old tab', baseVersion: 1 }, alice);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'version_conflict');
    assert.equal(stale.body.error.details.currentVersion, 2);

    const exists = await t.api.put(`${files()}/content`, { path: 'chapters/intro.tex', content: 'x', createOnly: true }, alice);
    assert.equal(exists.body.error.code, 'file_exists');
  });

  it('refuses unsafe paths and file/folder clashes', async () => {
    for (const path of ['../outside.tex', '/etc/passwd', 'a/../../b.tex']) {
      const res = await t.api.put(`${files()}/content`, { path, content: 'x' }, alice);
      assert.equal(res.status, 400, path);
      assert.equal(res.body.error.code, 'invalid_path');
    }
    const inFile = await t.api.put(`${files()}/content`, { path: 'main.tex/child.tex', content: 'x' }, alice);
    assert.equal(inFile.status, 409);
    const onFolder = await t.api.put(`${files()}/content`, { path: 'chapters', content: 'x' }, alice);
    assert.equal(onFolder.status, 409);
  });

  it('uploads binary and text files and serves them back', async () => {
    const res = await t.api.upload(
      `${files()}/upload`,
      { fields: { folder: 'figures' }, files: [{ name: 'dot.png', data: TINY_PNG }, { name: 'data.csv', data: 'a,b\n1,2\n' }] },
      alice,
    );
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.files.map((f: any) => [f.path, f.kind]), [
      ['figures/dot.png', 'binary'],
      ['figures/data.csv', 'text'],
    ]);

    const raw = await t.api.get(`${files()}/raw?path=figures/dot.png`, alice);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers['content-type'], 'image/png');
    assert.ok(raw.raw.equals(TINY_PNG));
    assert.match(String(raw.headers['content-security-policy']), /sandbox/);

    const etag = String(raw.headers.etag);
    const cached = await t.api.get(`${files()}/raw?path=figures/dot.png`, alice, { 'if-none-match': etag });
    assert.equal(cached.status, 304);

    const asText = await t.api.get(`${files()}/content?path=figures/dot.png`, alice);
    assert.equal(asText.body.error.code, 'not_text');
  });

  it('lists files as a flat list and as a tree', async () => {
    const res = await t.api.get(`${files()}?tree=true`, alice);
    assert.deepEqual(
      res.body.files.map((f: any) => f.path),
      ['chapters', 'chapters/intro.tex', 'figures', 'figures/data.csv', 'figures/dot.png', 'main.tex'],
    );
    assert.deepEqual(res.body.tree.map((n: any) => n.name), ['chapters', 'figures', 'main.tex']);
    assert.deepEqual(res.body.tree[1].children.map((n: any) => n.name), ['data.csv', 'dot.png']);
  });

  it('creates folders, moves and renames', async () => {
    assert.equal((await t.api.post(`${files()}/folder`, { path: 'appendix/raw' }, alice)).status, 201);

    const rename = await t.api.post(`${files()}/move`, { from: 'chapters/intro.tex', to: 'chapters/introduction.tex' }, alice);
    assert.equal(rename.body.moved, 1);

    const folder = await t.api.post(`${files()}/move`, { from: 'chapters', to: 'sections/part1' }, alice);
    assert.equal(folder.body.moved, 2);
    assert.equal((await t.api.get(`${files()}/content?path=sections/part1/introduction.tex`, alice)).status, 200);

    const clash = await t.api.post(`${files()}/move`, { from: 'main.tex', to: 'figures/dot.png' }, alice);
    assert.equal(clash.status, 409);
    const inside = await t.api.post(`${files()}/move`, { from: 'sections', to: 'sections/part1/deeper' }, alice);
    assert.equal(inside.status, 400);
    const missing = await t.api.post(`${files()}/move`, { from: 'nope.tex', to: 'x.tex' }, alice);
    assert.equal(missing.status, 404);
  });

  it('keeps the main file pointing at the document when it is moved', async () => {
    await t.api.post(`${files()}/move`, { from: 'main.tex', to: 'paper/main.tex' }, alice);
    assert.equal((await t.api.get(`/api/projects/${projectId}`, alice)).body.project.mainFile, 'paper/main.tex');
    await t.api.post(`${files()}/move`, { from: 'paper', to: 'doc' }, alice);
    assert.equal((await t.api.get(`/api/projects/${projectId}`, alice)).body.project.mainFile, 'doc/main.tex');
    await t.api.post(`${files()}/move`, { from: 'doc/main.tex', to: 'main.tex' }, alice);
    assert.equal((await t.api.get(`/api/projects/${projectId}`, alice)).body.project.mainFile, 'main.tex');
  });

  it('deletes files and whole folders', async () => {
    const res = await t.api.del(`${files()}?path=sections`, alice);
    assert.equal(res.body.deleted, 3);
    assert.equal((await t.api.del(`${files()}?path=sections`, alice)).status, 404);
  });

  it('updates project details and merges settings', async () => {
    const bad = await t.api.patch(`/api/projects/${projectId}`, { mainFile: 'missing.tex' }, alice);
    assert.equal(bad.body.error.code, 'invalid_main_file');

    await t.api.patch(`/api/projects/${projectId}`, { settings: { autoCompile: true, spell: { lang: 'en' } } }, alice);
    const res = await t.api.patch(
      `/api/projects/${projectId}`,
      { name: 'Renamed', engine: 'xelatex', settings: { spell: { lang: 'af' }, autoCompile: null } },
      alice,
    );
    assert.equal(res.body.project.name, 'Renamed');
    assert.equal(res.body.project.engine, 'xelatex');
    assert.deepEqual(res.body.project.settings, { spell: { lang: 'af' } });
  });

  it('exports a zip and imports it again as a new project', async () => {
    const zip = await t.api.get(`/api/projects/${projectId}/export.zip`, alice);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers['content-type'], 'application/zip');
    const names = Object.keys(unzipSync(zip.raw)).sort();
    assert.deepEqual(names, ['appendix/', 'appendix/raw/', 'doc/', 'figures/', 'figures/data.csv', 'figures/dot.png', 'main.tex']);

    const imported = await t.api.upload('/api/projects/import', { fields: { name: 'Round trip' }, files: [{ name: 'export.zip', data: zip.raw }] }, alice);
    assert.equal(imported.status, 201);
    assert.equal(imported.body.project.name, 'Round trip');
    assert.equal(imported.body.project.mainFile, 'main.tex');
    assert.equal(imported.body.imported, 3);

    const png = await t.api.get(`/api/projects/${imported.body.project.id}/files/raw?path=figures/dot.png`, alice);
    assert.ok(png.raw.equals(TINY_PNG));
  });

  it('unwraps a top-level folder and finds the main document in an imported zip', async () => {
    const archive = Buffer.from(
      zipSync({
        'my-paper/sections/a.tex': Buffer.from('\\section{A}'),
        'my-paper/thesis.tex': Buffer.from('\\documentclass{book}\\begin{document}x\\end{document}'),
        'my-paper/.DS_Store': Buffer.from('junk'),
        '__MACOSX/my-paper/._thesis.tex': Buffer.from('junk'),
      }),
    );
    const res = await t.api.upload('/api/projects/import', { files: [{ name: 'my-paper.zip', data: archive }] }, alice);
    assert.equal(res.status, 201);
    assert.equal(res.body.project.name, 'my-paper');
    assert.equal(res.body.project.mainFile, 'thesis.tex');
    const list = await t.api.get(`/api/projects/${res.body.project.id}/files`, alice);
    assert.deepEqual(list.body.files.map((f: any) => f.path), ['sections', 'sections/a.tex', 'thesis.tex']);

    const notZip = await t.api.upload('/api/projects/import', { files: [{ name: 'x.zip', data: 'not a zip' }] }, alice);
    assert.equal(notZip.status, 400);
    assert.equal(notZip.body.error.code, 'invalid_zip');
  });

  it('duplicates, archives, trashes and deletes projects', async () => {
    const copy = await t.api.post(`/api/projects/${projectId}/duplicate`, {}, alice);
    assert.equal(copy.status, 201);
    assert.equal(copy.body.project.name, 'Renamed (copy)');
    const copyId = copy.body.project.id;
    assert.equal((await t.api.get(`/api/projects/${copyId}/files/content?path=main.tex`, alice)).status, 200);

    await t.api.post(`/api/projects/${copyId}/archive`, undefined, alice);
    const active = (await t.api.get('/api/projects', alice)).body.projects.map((p: any) => p.id);
    assert.ok(!active.includes(copyId));
    assert.deepEqual((await t.api.get('/api/projects?status=archived', alice)).body.projects.map((p: any) => p.id), [copyId]);

    const early = await t.api.del(`/api/projects/${copyId}`, alice);
    assert.equal(early.status, 409);
    await t.api.post(`/api/projects/${copyId}/trash`, undefined, alice);
    assert.equal((await t.api.get('/api/projects?status=trashed', alice)).body.projects.length, 1);
    assert.equal((await t.api.del(`/api/projects/${copyId}`, alice)).status, 204);
    assert.equal((await t.api.get(`/api/projects/${copyId}`, alice)).status, 404);
  });

  it('backs up every project in one archive', async () => {
    const zip = await t.api.get('/api/export/projects.zip', alice);
    assert.equal(zip.status, 200);
    const entries = unzipSync(zip.raw);
    const manifest = JSON.parse(Buffer.from(entries['openleaf-projects.json']!).toString());
    assert.deepEqual(manifest.projects.map((p: any) => p.folder), ['Renamed', 'Round-trip', 'my-paper']);
    assert.ok(entries['Renamed/main.tex']);
    assert.ok(Buffer.from(entries['Round-trip/figures/dot.png']!).equals(TINY_PNG));
    assert.ok(entries['my-paper/sections/a.tex']);
  });

  it('searches by name and tag', async () => {
    assert.equal((await t.api.get('/api/projects?q=round', alice)).body.projects.length, 1);
    assert.equal((await t.api.get('/api/projects?tag=fem', alice)).body.projects.length, 1);
    assert.equal((await t.api.get('/api/projects?q=100%25', alice)).body.projects.length, 0);
  });

  it('enforces the project size limit', async () => {
    const small = await createTestApp({ MAX_PROJECT_BYTES: '2000' }, false);
    try {
      const user = (await signUp(small, 'carol')).token;
      const id = await newProject(small, user);
      const res = await small.api.put(`/api/projects/${id}/files/content`, { path: 'big.tex', content: 'x'.repeat(3000) }, user);
      assert.equal(res.status, 413);
      assert.equal(res.body.error.code, 'project_too_large');
    } finally {
      await small.destroy();
    }
  });
});

describe('settings and templates', () => {
  let t: TestApp;
  let token = '';
  before(async () => {
    t = await createTestApp();
    token = (await signUp(t, 'dana')).token;
  });
  after(() => t.destroy());

  it('returns defaults and merges overrides', async () => {
    const initial = await t.api.get('/api/settings', token);
    assert.equal(initial.body.settings.editor.theme, 'light');
    assert.deepEqual(initial.body.overrides, {});

    const patched = await t.api.patch('/api/settings', { editor: { theme: 'dark', keybindings: 'vim' }, myPlugin: { on: true } }, token);
    assert.equal(patched.body.settings.editor.theme, 'dark');
    assert.equal(patched.body.settings.editor.fontSize, 14);
    assert.deepEqual(patched.body.settings.myPlugin, { on: true });

    const reset = await t.api.patch('/api/settings', { editor: { theme: null } }, token);
    assert.equal(reset.body.settings.editor.theme, 'light');
    assert.equal(reset.body.settings.editor.keybindings, 'vim');

    assert.deepEqual((await t.api.del('/api/settings', token)).body.overrides, {});
  });

  it('lists the built-in templates and creates projects from them', async () => {
    const list = await t.api.get('/api/templates', token);
    assert.deepEqual(
      list.body.templates.map((x: any) => x.id),
      ['article', 'report', 'beamer', 'notes', 'assignment'],
    );
    const created = await t.api.post('/api/templates/report/projects', { name: 'My 100% thesis', author: 'D. Ana' }, token);
    assert.equal(created.status, 201);
    const id = created.body.project.id;
    const main = await t.api.get(`/api/projects/${id}/files/content?path=main.tex`, token);
    assert.match(main.body.file.content, /\\title\{My 100\\% thesis\}/);
    assert.match(main.body.file.content, /\\author\{D\. Ana\}/);
    const files = await t.api.get(`/api/projects/${id}/files`, token);
    assert.ok(files.body.files.some((f: any) => f.path === 'chapters/methodology.tex'));
    assert.equal((await t.api.post('/api/templates/nope/projects', { name: 'x' }, token)).status, 404);
  });

  it('saves a project as a personal template and reuses it', async () => {
    const source = await newProject(t, token, 'House style');
    await t.api.put(`/api/projects/${source}/files/content`, { path: 'style/house.sty', content: '% house style' }, token);
    await t.api.upload(`/api/projects/${source}/files/upload`, { files: [{ name: 'logo.png', data: TINY_PNG }] }, token);

    const saved = await t.api.post('/api/templates', { projectId: source, name: 'House template' }, token);
    assert.equal(saved.status, 201);
    assert.equal(saved.body.template.builtin, false);
    const templateId = saved.body.template.id;

    const detail = await t.api.get(`/api/templates/${templateId}`, token);
    assert.equal(detail.body.template.fileCount, 3);

    const created = await t.api.post(`/api/templates/${templateId}/projects`, { name: 'From my template' }, token);
    assert.equal(created.status, 201);
    const logo = await t.api.get(`/api/projects/${created.body.project.id}/files/raw?path=logo.png`, token);
    assert.ok(logo.raw.equals(TINY_PNG));

    const stranger = (await signUp(t, 'eve')).token;
    assert.equal((await t.api.get(`/api/templates/${templateId}`, stranger)).status, 404);
    assert.equal((await t.api.del('/api/templates/article', token)).status, 403);
    assert.equal((await t.api.del(`/api/templates/${templateId}`, token)).status, 204);
  });
});

describe('hardening', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp({ SESSION_MAX_DAYS: '10', MAX_PROJECT_BYTES: String(2 * 1024 * 1024) });
  });
  after(() => t.destroy());

  const login = (email: string) => t.api.post('/api/auth/login', { email, password: 'correct horse battery' });

  it('lists sessions and signs out everywhere', async () => {
    const owner = await signUp(t, 'owner');
    const second = (await login(owner.email)).body.token as string;
    const apiToken = (await t.api.post('/api/auth/tokens', { name: 'script' }, owner.token)).body.token as string;

    const sessions = await t.api.get('/api/auth/sessions', second);
    assert.equal(sessions.body.sessions.length, 2);
    assert.equal(sessions.body.sessions.filter((s: any) => s.current).length, 1);
    assert.equal(sessions.body.sessions[0].token, undefined);

    assert.equal((await t.api.post('/api/auth/logout-all', undefined, second)).status, 204);
    assert.equal((await t.api.get('/api/auth/me', second)).status, 401);
    assert.equal((await t.api.get('/api/auth/me', owner.token)).status, 401);
    // API tokens are for scripts and are kept unless asked for too.
    assert.equal((await t.api.get('/api/auth/me', apiToken)).status, 200);
    assert.equal((await t.api.post('/api/auth/logout-all?apiTokens=true', undefined, apiToken)).status, 204);
    assert.equal((await t.api.get('/api/auth/me', apiToken)).status, 401);
  });

  it('ends a session after its absolute lifetime, however recently it was used', async () => {
    const user = await signUp(t, 'aged');
    assert.equal((await t.api.get('/api/auth/me', user.token)).status, 200);
    await t.db.query(
      `UPDATE auth_tokens SET created_at = now() - interval '11 days', last_used_at = now() WHERE user_id = $1`,
      [user.id],
    );
    const res = await t.api.get('/api/auth/me', user.token);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'session_expired');
  });

  it('never lets use push a session past its absolute lifetime, and clears out dead ones', async () => {
    const user = await signUp(t, 'slider');
    await t.db.query(
      `UPDATE auth_tokens SET created_at = now() - interval '9 days', last_used_at = NULL WHERE user_id = $1`,
      [user.id],
    );
    assert.equal((await t.api.get('/api/auth/me', user.token)).status, 200);
    const row = await t.db.query<{ days: number }>(
      `SELECT extract(epoch FROM (expires_at - now())) / 86400 AS days FROM auth_tokens WHERE user_id = $1`,
      [user.id],
    );
    assert.ok(Number(row.rows[0]!.days) <= 1.01, `expected at most a day left, got ${row.rows[0]!.days}`);

    await t.db.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 hour' WHERE user_id = $1`, [user.id]);
    await login(user.email);
    const left = await t.db.query('SELECT 1 FROM auth_tokens WHERE user_id = $1', [user.id]);
    assert.equal(left.rowCount, 1);
  });

  it('gives share links an expiry unless told otherwise, and keeps their tokens out of the log', async () => {
    const user = await signUp(t, 'sharer');
    const projectId = await newProject(t, user.token);
    const link = await t.api.post(`/api/projects/${projectId}/share-links`, {}, user.token);
    assert.equal(link.status, 201);
    const days = (new Date(link.body.link.expiresAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days < 31, `expected about 30 days, got ${days}`);
    const long = await t.api.post(`/api/projects/${projectId}/share-links`, { expiresInDays: 400 }, user.token);
    assert.ok(new Date(long.body.link.expiresAt).getTime() - Date.now() > 399 * 86_400_000);

    assert.equal(redactUrl(`/api/shared/${link.body.token}/output.pdf?download=true`), '/api/shared/[redacted]/output.pdf?download=true');
    assert.equal(redactUrl('/api/projects/123/files?path=a.tex'), '/api/projects/123/files?path=a.tex');
  });

  it('counts what an archive really unpacks to, not what it claims', async () => {
    const user = await signUp(t, 'zipper');
    // 6 MB of zeros squeezes into a few kilobytes; every size the archive declares is then set to 10 bytes.
    const archive = Buffer.from(zipSync({ 'main.tex': strToU8('ok'), 'data.txt': [new Uint8Array(6 * 1024 * 1024), { level: 9 }] }));
    for (const [magic, offset] of [['PK\x03\x04', 22], ['PK\x01\x02', 24]] as const) {
      for (let at = archive.indexOf(magic, 0, 'latin1'); at >= 0; at = archive.indexOf(magic, at + 4, 'latin1')) {
        archive.writeUInt32LE(10, at + offset);
      }
    }
    assert.ok(archive.byteLength < 20_000);
    const res = await t.api.upload('/api/projects/import', { files: [{ name: 'small.zip', data: archive }] }, user.token);
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'project_too_large');
    assert.equal((await t.api.get('/api/projects', user.token)).body.projects.length, 0);
  });

  it('takes the caller\'s address only from proxies it has reason to believe', async () => {
    const owner = (await login((await t.db.query<{ email: string }>(`SELECT email FROM users WHERE role = 'owner'`)).rows[0]!.email)).body.token as string;
    const seen = async (remoteAddress: string, forwardedFor?: string) => {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/system/request',
        remoteAddress,
        headers: { authorization: `Bearer ${owner}`, ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
      });
      return res.json().address as string;
    };
    // Someone connecting directly cannot say they are someone else.
    assert.equal(await seen('203.0.113.9', '1.2.3.4'), '203.0.113.9');
    // Behind a proxy on a private network, the caller is the first public address from the proxy outwards,
    // whatever was written to the left of it.
    assert.equal(await seen('10.0.0.5', '198.51.100.7'), '198.51.100.7');
    assert.equal(await seen('10.0.0.5', '1.2.3.4, 198.51.100.7'), '198.51.100.7');

    const member = await signUp(t, 'member');
    assert.equal((await t.api.get('/api/system/request', member.token)).status, 403);
  });

  it('believes a set number of proxy hops when told to', async () => {
    const hops = await createTestApp({ TRUST_PROXY: '2' }, false);
    try {
      const owner = (await hops.api.post('/api/auth/login', {
        email: (await hops.db.query<{ email: string }>(`SELECT email FROM users WHERE role = 'owner'`)).rows[0]!.email,
        password: 'correct horse battery',
      })).body.token as string;
      const res = await hops.app.inject({
        method: 'GET',
        url: '/api/system/request',
        remoteAddress: '10.0.0.5',
        headers: { authorization: `Bearer ${owner}`, 'x-forwarded-for': '1.2.3.4, 198.51.100.7, 172.70.1.1' },
      });
      assert.equal(res.json().address, '198.51.100.7');
    } finally {
      await hops.destroy();
    }
  });
});

describe('instance', () => {
  it('serves health, info and API documentation', async () => {
    const t = await createTestApp();
    try {
      // The health check is public and says only whether the service is up.
      const health = await t.api.get('/healthz');
      assert.equal(health.status, 200);
      assert.deepEqual(health.body, { status: 'ok' });

      // What the instance runs is for people who are signed in.
      assert.equal((await t.api.get('/api/system/info')).status, 401);
      const token = (await signUp(t, 'ivy')).token;
      const info = await t.api.get('/api/system/info', token);
      assert.ok(info.body.modules.some((m: any) => m.name === 'compile'));
      assert.ok(info.body.compile.engines.some((e: any) => e.id === 'pdflatex' && e.available));
      assert.equal(typeof info.body.compile.isolation.namespaces, 'boolean');
      assert.equal(typeof info.body.compile.isolation.summary, 'string');

      const openapi = await t.api.get('/docs/json');
      assert.equal(openapi.status, 200);
      assert.ok(openapi.body.paths['/api/projects/{projectId}/compile']);
      assert.equal((await t.api.get('/docs')).status, 200);

      const missing = await t.api.get('/api/nope');
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, 'not_found');

      const invalid = await t.api.post('/api/auth/login', { email: 'only-email@example.com' });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, 'validation_error');
    } finally {
      await t.destroy();
    }
  });

  it('drops the routes of a disabled module', async () => {
    const t = await createTestApp({ OPENLEAF_DISABLED_MODULES: 'share,templates,history' });
    try {
      const token = (await signUp(t, 'frank')).token;
      assert.equal((await t.api.get('/api/templates', token)).status, 404);
      assert.equal((await t.api.get('/api/projects', token)).status, 200);
      const info = await t.api.get('/api/system/info', token);
      assert.deepEqual(
        info.body.modules.map((m: any) => m.name),
        ['auth', 'system', 'projects', 'files', 'compile', 'settings', 'github'],
      );
    } finally {
      await t.destroy();
    }
  });

  it('rate-limits sign-in attempts', async () => {
    const t = await createTestApp({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await t.api.post('/api/auth/login', { email: 'a@example.com', password: 'wrong password' })).status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    } finally {
      await t.destroy();
    }
  });
});
