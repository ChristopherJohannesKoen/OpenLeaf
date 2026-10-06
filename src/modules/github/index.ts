import { createHash, randomBytes } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { Queryable } from '../../core/db.js';
import { badRequest, conflict, HttpError, notFound, unavailable } from '../../core/errors.js';
import { currentUser, ProjectParams, secured } from '../../core/http.js';
import type { OpenLeafModule } from '../../core/modules.js';
import { seal, unseal } from '../../core/secrets.js';
import { slugify } from '../../core/util.js';
import { getProject, readAllFiles, sourceFingerprint } from '../projects/store.js';
import { Github, GithubError, type Repo, type TokenAnswer } from './client.js';

const TAG = 'GitHub';

interface AccountRow {
  user_id: string;
  github_id: string;
  login: string;
  name: string;
  token_enc: string;
  scopes: string;
  linked_at: Date;
  /** When the token stops working; null for a token that does not expire. */
  token_expires_at: Date | null;
  /** The token that buys the next one, encrypted like the first; null when tokens do not expire. */
  refresh_enc: string | null;
  refresh_expires_at: Date | null;
}

interface RepoRow {
  project_id: string;
  repo_id: string;
  full_name: string;
  html_url: string;
  private: boolean;
  branch: string;
  last_commit_sha: string | null;
  last_source_hash: string | null;
  last_saved_at: Date | null;
}

/** A link being made: the one-time code has been shown, GitHub has not said yes yet. */
interface Pending {
  userId: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  notBefore: number;
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The id git gives a file's contents: sha1 of "blob <length>\0" followed by the bytes. */
export function gitBlobSha(data: Buffer): string {
  return createHash('sha1').update(`blob ${data.byteLength}\0`).update(data).digest('hex');
}

function accountJson(a: AccountRow) {
  return {
    login: a.login,
    name: a.name,
    scopes: a.scopes.split(/[ ,]+/).filter(Boolean),
    linkedAt: a.linked_at,
    // With tokens that expire: the link renews itself whenever it is used, and lapses for good
    // on this date if it is not used before then. Null: the link lasts until it is unlinked.
    lapsesAt: a.refresh_expires_at,
  };
}

/** Renew a token this long before it runs out, so that a save never starts with a dying one. */
const RENEW_MARGIN_MS = 5 * 60_000;

const inSeconds = (seconds: number | undefined): Date | null =>
  typeof seconds === 'number' && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;

export const githubModule: OpenLeafModule = {
  name: 'github',
  description: 'Keep each project in a GitHub repository of its own: link an account, then save commits to it.',
  dependsOn: ['projects'],
  migrations: [
    {
      id: '001_init',
      sql: `
        CREATE TABLE github_accounts (
          user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          github_id  bigint NOT NULL,
          login      text NOT NULL,
          name       text NOT NULL DEFAULT '',
          -- The person's GitHub token, encrypted with SECRETS_KEY. Never sent to anyone.
          token_enc  text NOT NULL,
          scopes     text NOT NULL DEFAULT '',
          linked_at  timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE github_repos (
          project_id        uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          repo_id           bigint NOT NULL,
          full_name         text NOT NULL,
          html_url          text NOT NULL,
          private           boolean NOT NULL,
          branch            text NOT NULL,
          last_commit_sha   text,
          last_source_hash  text,
          last_saved_at     timestamptz
        );
      `,
    },
    {
      id: '002_token_renewal',
      sql: `
        ALTER TABLE github_accounts
          ADD COLUMN token_expires_at   timestamptz,
          ADD COLUMN refresh_enc        text,
          ADD COLUMN refresh_expires_at timestamptz;
      `,
    },
  ],

  register(root, { db, config, info }) {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const auth = { onRequest: [root.authenticate] };
    const linkLimit = { rateLimit: { max: config.authRateLimitPerMinute * 3, timeWindow: '1 minute' } };
    const pending = new Map<string, Pending>();

    info.set('github', () => ({ available: Boolean(config.github), scope: config.github?.scope ?? null }));

    function settings() {
      if (!config.github || !config.secretsKey) {
        throw unavailable(
          'Saving to GitHub is not set up on this OpenLeaf instance (GITHUB_CLIENT_ID and SECRETS_KEY).',
          'github_not_configured',
        );
      }
      return { github: config.github, key: config.secretsKey };
    }

    async function account(q: Queryable, userId: string): Promise<AccountRow | null> {
      return (await q.query<AccountRow>('SELECT * FROM github_accounts WHERE user_id = $1', [userId])).rows[0] ?? null;
    }

    /** What is stored for a token answer: both tokens sealed, each bound to its owner and its role. */
    function sealed(key: Buffer, userId: string, answer: TokenAnswer) {
      return {
        token: seal(key, answer.access_token!, userId),
        tokenExpiresAt: inSeconds(answer.expires_in),
        refresh: answer.refresh_token ? seal(key, answer.refresh_token, `${userId}/refresh`) : null,
        refreshExpiresAt: answer.refresh_token ? inSeconds(answer.refresh_token_expires_in) : null,
      };
    }

    async function forget(userId: string): Promise<void> {
      await db.query('DELETE FROM github_accounts WHERE user_id = $1', [userId]);
    }

    const lapsed = () =>
      conflict('The link to GitHub has run out. Link the account again (Modules, Connections).', 'github_not_linked');

    // One renewal at a time per person: a refresh token can be used once, so two requests
    // arriving together must share the answer rather than race for it.
    const renewing = new Map<string, Promise<string>>();

    async function renew(row: AccountRow): Promise<string> {
      const { github, key } = settings();
      const refresh = row.refresh_enc ? unseal(key, row.refresh_enc, `${row.user_id}/refresh`) : null;
      if (!refresh || (row.refresh_expires_at && row.refresh_expires_at.getTime() <= Date.now())) {
        await forget(row.user_id);
        throw lapsed();
      }
      let answer: TokenAnswer;
      try {
        answer = await new Github(github).renew(refresh);
      } catch (err) {
        // GitHub could not be reached or is refusing for now: the link itself is not at fault.
        return explain(err, row.user_id, 'renew the link');
      }
      if (answer.error && answer.error !== 'bad_refresh_token') {
        // Not a verdict on this link (the app's settings, a grant GitHub does not offer): keep
        // the link and say what GitHub said.
        const said = answer.error_description ? `${answer.error}: ${answer.error_description}` : answer.error;
        throw new HttpError(502, 'github_renewal_refused', `GitHub would not renew the link (${said}).`);
      }
      if (answer.error || !answer.access_token) {
        // GitHub will not renew it: it was revoked there, or it ran out.
        await forget(row.user_id);
        throw lapsed();
      }
      const next = sealed(key, row.user_id, answer);
      await db.query(
        `UPDATE github_accounts
            SET token_enc = $2, token_expires_at = $3, refresh_enc = $4, refresh_expires_at = $5
          WHERE user_id = $1`,
        [row.user_id, next.token, next.tokenExpiresAt, next.refresh, next.refreshExpiresAt],
      );
      return answer.access_token;
    }

    /** A client that acts as this person on GitHub, or a 409 saying the account must be linked. */
    async function clientFor(userId: string): Promise<Github> {
      const { github, key } = settings();
      const row = await account(db, userId);
      let token = row ? unseal(key, row.token_enc, userId) : null;
      if (!row || !token) {
        // A stored token that no longer opens (the key was changed) is of no use; forget it.
        if (row) await forget(userId);
        throw conflict('Link a GitHub account first (Modules, Connections).', 'github_not_linked');
      }
      if (row.token_expires_at && row.token_expires_at.getTime() - Date.now() < RENEW_MARGIN_MS) {
        token = await renewOnce(row);
      }
      return new Github(github, token);
    }

    function renewOnce(row: AccountRow): Promise<string> {
      let running = renewing.get(row.user_id);
      if (!running) {
        running = renew(row).finally(() => renewing.delete(row.user_id));
        renewing.set(row.user_id, running);
      }
      return running;
    }

    /** Turn what GitHub said into something to show; a refused token unlinks the account. */
    async function explain(err: unknown, userId: string, doing: string): Promise<never> {
      if (!(err instanceof GithubError)) throw err;
      if (err.status === 401) {
        await db.query('DELETE FROM github_accounts WHERE user_id = $1', [userId]);
        throw conflict('GitHub no longer accepts this link. Link the account again.', 'github_not_linked');
      }
      if (err.status === 0) throw unavailable(err.message, 'github_unreachable');
      if (err.status === 403 || err.status === 429) {
        throw new HttpError(429, 'github_refused', `GitHub refused to ${doing} for now. ${err.message}`);
      }
      throw new HttpError(502, 'github_error', `Could not ${doing}. ${err.message}`);
    }

    async function repoRow(q: Queryable, projectId: string): Promise<RepoRow | null> {
      return (await q.query<RepoRow>('SELECT * FROM github_repos WHERE project_id = $1', [projectId])).rows[0] ?? null;
    }

    async function status(projectId: string) {
      const row = await repoRow(db, projectId);
      if (!row) return { repo: null, lastSavedAt: null, lastCommit: null, changed: false };
      const now = await sourceFingerprint(db, projectId);
      return {
        repo: { fullName: row.full_name, url: row.html_url, private: row.private, branch: row.branch },
        lastSavedAt: row.last_saved_at,
        lastCommit: row.last_commit_sha ? { sha: row.last_commit_sha, url: `${row.html_url}/commit/${row.last_commit_sha}` } : null,
        changed: row.last_source_hash !== now,
      };
    }

    /**
     * Make one commit on the repository's branch whose files are exactly the project's files.
     * Only contents GitHub does not already have are uploaded. The branch is moved forward, never
     * forced, so nothing that is in the repository's history is lost.
     */
    async function save(
      gh: Github,
      projectId: string,
      row: RepoRow,
      opts: { message: string; overwrite: boolean },
    ): Promise<{ saved: boolean }> {
      const head = await gh.head(row.full_name, row.branch);
      if (row.last_commit_sha && head !== row.last_commit_sha && !opts.overwrite) {
        throw conflict(
          'The repository has changes that did not come from OpenLeaf. Saving puts this project\'s files on top; what is there stays in the history.',
          'github_remote_changed',
        );
      }
      const headTree = await gh.commitTree(row.full_name, head);
      const existing = await gh.tree(row.full_name, headTree);
      const have = new Set(existing.truncated ? [] : existing.tree.filter((e) => e.type === 'blob').map((e) => e.sha));

      const fingerprint = await sourceFingerprint(db, projectId);
      const files = (await readAllFiles(db, projectId)).filter(
        (f) => f.kind !== 'folder' && !f.path.split('/').includes('.git'),
      );
      if (files.length === 0) throw badRequest('This project has no files to save yet.', 'nothing_to_save');

      const entries: { path: string; sha: string }[] = [];
      const uploads: { sha: string; data: Buffer }[] = [];
      for (const f of files) {
        const data = f.kind === 'text' ? Buffer.from(f.content ?? '', 'utf8') : (f.data ?? Buffer.alloc(0));
        const sha = gitBlobSha(data);
        entries.push({ path: f.path, sha });
        if (!have.has(sha)) {
          have.add(sha);
          uploads.push({ sha, data });
        }
      }
      // A few at a time: quick for a normal project, gentle on GitHub's limits.
      for (let i = 0; i < uploads.length; i += 4) {
        await Promise.all(
          uploads.slice(i, i + 4).map(async (u) => {
            const made = await gh.createBlob(row.full_name, u.data);
            if (made !== u.sha) throw new GithubError(502, 'GitHub stored a file under an unexpected id.');
          }),
        );
      }

      const tree = await gh.createTree(row.full_name, entries);
      let commit = head;
      const nothingNew = tree === headTree;
      if (!nothingNew) {
        commit = await gh.createCommit(row.full_name, { message: opts.message, tree, parents: [head] });
        try {
          await gh.moveBranch(row.full_name, row.branch, commit);
        } catch (err) {
          if (err instanceof GithubError && err.status === 422) {
            throw conflict('The repository changed while this was being saved. Try again.', 'github_remote_changed');
          }
          throw err;
        }
      }
      await db.query(
        `UPDATE github_repos SET last_commit_sha = $2, last_source_hash = $3, last_saved_at = now() WHERE project_id = $1`,
        [projectId, commit, fingerprint],
      );
      return { saved: !nothingNew };
    }

    // ------------------------------------------------------------------ the account

    app.get(
      '/api/github',
      { ...auth, schema: { tags: [TAG], summary: 'Whether saving to GitHub is set up, and which account is linked', security: secured } },
      async (req) => {
        if (!config.github) return { available: false, scope: null, account: null };
        const row = await account(db, currentUser(req).id);
        return { available: true, scope: config.github.scope, account: row ? accountJson(row) : null };
      },
    );

    app.post(
      '/api/github/link',
      {
        ...auth,
        config: linkLimit,
        schema: {
          tags: [TAG],
          summary: 'Start linking a GitHub account: get a one-time code to type in at GitHub',
          description:
            'Returns a short code and the address to enter it at. Nothing is linked until the person approves ' +
            'it there; ask `/api/github/link/{linkId}` to find out. OpenLeaf never sees the GitHub password.',
          security: secured,
        },
      },
      async (req) => {
        const { github } = settings();
        const user = currentUser(req);
        let flow;
        try {
          flow = await new Github(github).startDeviceFlow();
        } catch (err) {
          return explain(err, user.id, 'start linking');
        }
        if (!flow.device_code || !flow.user_code) {
          throw new HttpError(502, 'github_error', 'GitHub did not give a code. Check that device flow is switched on for the OAuth app.');
        }
        // One link at a time per person; old attempts are dropped.
        for (const [id, p] of pending) if (p.userId === user.id || p.expiresAt < Date.now()) pending.delete(id);
        const linkId = randomBytes(18).toString('base64url');
        const intervalMs = Math.max(1, flow.interval || 5) * 1000;
        pending.set(linkId, {
          userId: user.id,
          deviceCode: flow.device_code,
          intervalMs,
          expiresAt: Date.now() + Math.max(60, flow.expires_in || 900) * 1000,
          notBefore: Date.now() + intervalMs,
        });
        return {
          linkId,
          userCode: flow.user_code,
          verificationUri: flow.verification_uri,
          expiresAt: new Date(pending.get(linkId)!.expiresAt).toISOString(),
          intervalSeconds: intervalMs / 1000,
        };
      },
    );

    app.post(
      '/api/github/link/:linkId',
      {
        ...auth,
        config: linkLimit,
        schema: {
          tags: [TAG],
          summary: 'Ask whether the one-time code has been approved yet',
          security: secured,
          params: Type.Object({ linkId: Type.String({ minLength: 10, maxLength: 64 }) }),
        },
      },
      async (req) => {
        const { github, key } = settings();
        const user = currentUser(req);
        const p = pending.get(req.params.linkId);
        if (!p || p.userId !== user.id) return { status: 'expired' as const };
        if (p.expiresAt < Date.now()) {
          pending.delete(req.params.linkId);
          return { status: 'expired' as const };
        }
        // GitHub asks not to be polled faster than it said; answering "pending" early costs nothing.
        if (Date.now() < p.notBefore) return { status: 'pending' as const, intervalSeconds: p.intervalMs / 1000 };
        p.notBefore = Date.now() + p.intervalMs;

        let answer;
        try {
          answer = await new Github(github).pollDeviceFlow(p.deviceCode);
        } catch (err) {
          return explain(err, user.id, 'finish linking');
        }
        if (answer.error === 'authorization_pending') return { status: 'pending' as const, intervalSeconds: p.intervalMs / 1000 };
        if (answer.error === 'slow_down') {
          p.intervalMs += 5000;
          p.notBefore = Date.now() + p.intervalMs;
          return { status: 'pending' as const, intervalSeconds: p.intervalMs / 1000 };
        }
        if (answer.error || !answer.access_token) {
          pending.delete(req.params.linkId);
          return { status: answer.error === 'access_denied' ? ('denied' as const) : ('expired' as const) };
        }
        pending.delete(req.params.linkId);

        let me;
        try {
          me = await new Github(github, answer.access_token).me();
        } catch (err) {
          return explain(err, user.id, 'read the GitHub account');
        }
        // What was granted: as the token answer says, or failing that as GitHub reports for the token.
        const granted = answer.scope ? answer.scope.split(/[ ,]+/).filter(Boolean) : (me.scopes ?? []);
        if (!granted.includes(github.scope) && !(github.scope === 'public_repo' && granted.includes('repo'))) {
          throw conflict(`GitHub did not grant the "${github.scope}" permission, so nothing was linked.`, 'github_scope_missing');
        }
        const kept = sealed(key, user.id, answer);
        const row = await db.query<AccountRow>(
          `INSERT INTO github_accounts
             (user_id, github_id, login, name, token_enc, scopes, token_expires_at, refresh_enc, refresh_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (user_id) DO UPDATE
             SET github_id = EXCLUDED.github_id, login = EXCLUDED.login, name = EXCLUDED.name,
                 token_enc = EXCLUDED.token_enc, scopes = EXCLUDED.scopes, linked_at = now(),
                 token_expires_at = EXCLUDED.token_expires_at, refresh_enc = EXCLUDED.refresh_enc,
                 refresh_expires_at = EXCLUDED.refresh_expires_at
           RETURNING *`,
          [user.id, me.id, me.login, me.name ?? '', kept.token, granted.join(' '), kept.tokenExpiresAt, kept.refresh, kept.refreshExpiresAt],
        );
        return { status: 'linked' as const, account: accountJson(row.rows[0]!) };
      },
    );

    app.post(
      '/api/github/renew',
      {
        ...auth,
        config: linkLimit,
        schema: {
          tags: [TAG],
          summary: 'Renew the link to GitHub now',
          description:
            'A link whose token expires renews itself whenever it is used, so this is never needed; it is here ' +
            'to check that renewal works on an instance, and to push the date the link would lapse further out. ' +
            'A link whose token does not expire is left as it is (`renewed: false`).',
          security: secured,
        },
      },
      async (req) => {
        settings();
        const user = currentUser(req);
        const row = await account(db, user.id);
        if (!row) throw conflict('Link a GitHub account first (Modules, Connections).', 'github_not_linked');
        if (!row.refresh_enc) return { renewed: false, account: accountJson(row) };
        await renewOnce(row);
        return { renewed: true, account: accountJson((await account(db, user.id))!) };
      },
    );

    app.delete(
      '/api/github',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Unlink the GitHub account',
          description:
            'Forgets the stored token. Repositories and their history are untouched. To withdraw the permission ' +
            'on GitHub\'s side as well, revoke OpenLeaf under Settings, Applications, Authorized OAuth Apps.',
          security: secured,
        },
      },
      async (req, reply) => {
        await db.query('DELETE FROM github_accounts WHERE user_id = $1', [currentUser(req).id]);
        reply.code(204);
      },
    );

    // ------------------------------------------------------------------ a project's repository

    app.get(
      '/api/projects/:projectId/github',
      { ...auth, schema: { tags: [TAG], summary: 'The repository this project is kept in, and whether it is up to date', security: secured, params: ProjectParams } },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        return status(project.id);
      },
    );

    app.post(
      '/api/projects/:projectId/github',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Create a repository for this project and save the project to it',
          description: 'The repository is new, belongs to the linked account, and is private unless `private` is false.',
          security: secured,
          params: ProjectParams,
          body: Type.Object({
            name: Type.Optional(Type.String({ maxLength: 100 })),
            private: Type.Optional(Type.Boolean()),
            description: Type.Optional(Type.String({ maxLength: 300 })),
          }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const project = await getProject(db, req.params.projectId, user.id);
        if (await repoRow(db, project.id)) throw conflict('This project already has a repository.', 'github_already_linked');
        const name = (req.body.name ?? '').trim() || slugify(project.name);
        if (!REPO_NAME.test(name) || name === '.' || name === '..') {
          throw badRequest('A repository name may use letters, digits, hyphens, dots and underscores.', 'invalid_repo_name');
        }
        const gh = await clientFor(user.id);
        let repo: Repo;
        try {
          repo = await gh.createRepo({
            name,
            description: (req.body.description ?? project.description ?? '').slice(0, 300),
            private: req.body.private ?? true,
          });
        } catch (err) {
          if (err instanceof GithubError && err.status === 422) {
            throw conflict(`You already have a repository called "${name}", or GitHub does not allow that name. Choose another.`, 'github_repo_exists');
          }
          return explain(err, user.id, 'create the repository');
        }
        const inserted = await db.query<RepoRow>(
          `INSERT INTO github_repos (project_id, repo_id, full_name, html_url, private, branch)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [project.id, repo.id, repo.full_name, repo.html_url, repo.private, repo.default_branch || 'main'],
        );
        try {
          await save(gh, project.id, inserted.rows[0]!, { message: `Start ${project.name} in OpenLeaf`, overwrite: true });
        } catch (err) {
          // The repository exists and is linked; only the first save failed. Say so, and let Save retry it.
          if (err instanceof HttpError && err.code === 'nothing_to_save') {
            reply.code(201);
            return status(project.id);
          }
          return explain(err, user.id, 'save to the new repository');
        }
        reply.code(201);
        return status(project.id);
      },
    );

    app.post(
      '/api/projects/:projectId/github/save',
      {
        ...auth,
        // Every setting has a default, so a request with no body at all is a plain "save".
        preValidation: (req, _reply, done) => {
          req.body ??= {};
          done();
        },
        schema: {
          tags: [TAG],
          summary: 'Save the project to its repository as one commit',
          description:
            'The commit holds exactly the project\'s files. If the repository has commits that did not come from ' +
            'OpenLeaf the answer is 409 `github_remote_changed`; send `overwrite: true` to save on top of them ' +
            '(they stay in the history).',
          security: secured,
          params: ProjectParams,
          body: Type.Optional(
            Type.Object({
              message: Type.Optional(Type.String({ maxLength: 2000 })),
              overwrite: Type.Optional(Type.Boolean()),
            }),
          ),
        },
      },
      async (req) => {
        const user = currentUser(req);
        const project = await getProject(db, req.params.projectId, user.id);
        const row = await repoRow(db, project.id);
        if (!row) throw notFound('This project has no repository yet.', 'github_no_repo');
        const gh = await clientFor(user.id);
        const message = (req.body?.message ?? '').trim() || 'Save from OpenLeaf';
        let result;
        try {
          result = await save(gh, project.id, row, { message, overwrite: Boolean(req.body?.overwrite) });
        } catch (err) {
          if (err instanceof GithubError && err.status === 404) {
            throw conflict(
              'GitHub cannot find the repository with this account. It may have been deleted or renamed; unlink it here and create it again.',
              'github_repo_missing',
            );
          }
          return explain(err, user.id, 'save to GitHub');
        }
        return { ...(await status(project.id)), saved: result.saved };
      },
    );

    app.delete(
      '/api/projects/:projectId/github',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Stop keeping this project in its repository (the repository itself is left as it is)',
          security: secured,
          params: ProjectParams,
        },
      },
      async (req, reply) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        await db.query('DELETE FROM github_repos WHERE project_id = $1', [project.id]);
        reply.code(204);
      },
    );
  },
};
