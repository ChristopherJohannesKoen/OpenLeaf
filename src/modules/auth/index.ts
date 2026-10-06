import type { FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { OpenLeafModule } from '../../core/modules.js';
import type { Queryable } from '../../core/db.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../core/errors.js';
import { currentUser, secured, Uuid, type AuthUser } from '../../core/http.js';
import { firebaseVerifier } from './firebase.js';
import { hashPassword, hashToken, newToken, safeEqual, verifyPassword } from './passwords.js';

const TAG = 'Accounts';

interface UserRow {
  id: string;
  email: string;
  /** Null for an account that signs in through Firebase: OpenLeaf holds no password for it. */
  password_hash: string | null;
  firebase_uid: string | null;
  display_name: string;
  role: 'owner' | 'member';
  created_at: Date;
}

function publicUser(u: Pick<UserRow, 'id' | 'email' | 'display_name' | 'role' | 'created_at'>) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    createdAt: u.created_at,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254) throw badRequest('That email address is not valid.', 'invalid_email');
  return e;
}

function checkPassword(password: string): void {
  if (password.length < 8) throw badRequest('Use a password of at least 8 characters.', 'weak_password');
  if (password.length > 256) throw badRequest('That password is too long.', 'weak_password');
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1]! : null;
}

/**
 * A session lasts `ttlDays` from its last use, and never longer than `maxDays` from when it
 * was made (0 = no such limit), so a token that leaks does not stay good for ever.
 */
async function issueSession(q: Queryable, userId: string, ttlDays: number, maxDays: number) {
  const token = newToken('olf');
  // Tidy as we go: tokens past their date are of no use to anyone.
  await q.query('DELETE FROM auth_tokens WHERE user_id = $1 AND expires_at < now()', [userId]);
  const res = await q.query<{ id: string; expires_at: Date }>(
    `INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at)
     VALUES ($1, 'session', $2, now() + make_interval(days => $3))
     RETURNING id, expires_at`,
    [userId, hashToken(token), maxDays > 0 ? Math.min(ttlDays, maxDays) : ttlDays],
  );
  return { token, expiresAt: res.rows[0]!.expires_at };
}

export const authModule: OpenLeafModule = {
  name: 'auth',
  description: 'Accounts, sign-in sessions and personal API tokens.',
  core: true,
  migrations: [
    {
      id: '001_init',
      sql: `
        CREATE TABLE users (
          id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email         text NOT NULL UNIQUE,
          password_hash text NOT NULL,
          display_name  text NOT NULL DEFAULT '',
          role          text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
          created_at    timestamptz NOT NULL DEFAULT now(),
          updated_at    timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE auth_tokens (
          id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind          text NOT NULL CHECK (kind IN ('session', 'api')),
          name          text NOT NULL DEFAULT '',
          token_hash    text NOT NULL UNIQUE,
          created_at    timestamptz NOT NULL DEFAULT now(),
          last_used_at  timestamptz,
          expires_at    timestamptz
        );
        CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id);
      `,
    },
    {
      // Accounts that sign in through Firebase Authentication have no password here at all.
      id: '002_firebase_identity',
      sql: `
        ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
        ALTER TABLE users ADD COLUMN firebase_uid text UNIQUE;
      `,
    },
  ],

  register(root, { db, config, events }) {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const authLimit = {
      rateLimit: { max: config.authRateLimitPerMinute, timeWindow: '1 minute' },
    };

    root.decorateRequest('user', null);

    root.decorate('authenticate', async (req: FastifyRequest) => {
      const token = bearerToken(req);
      if (!token) throw unauthorized('Send your token as "Authorization: Bearer <token>".');
      const res = await db.query<{
        token_id: string;
        kind: 'session' | 'api';
        expires_at: Date | null;
        last_used_at: Date | null;
        token_created_at: Date;
        id: string;
        email: string;
        display_name: string;
        role: 'owner' | 'member';
      }>(
        `SELECT t.id AS token_id, t.kind, t.expires_at, t.last_used_at, t.created_at AS token_created_at,
                u.id, u.email, u.display_name, u.role
           FROM auth_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1`,
        [hashToken(token)],
      );
      const row = res.rows[0];
      if (!row) throw unauthorized('That token is not valid.', 'invalid_token');
      const DAY = 24 * 60 * 60 * 1000;
      const tooOld =
        row.kind === 'session' &&
        config.sessionMaxDays > 0 &&
        Date.now() - row.token_created_at.getTime() > config.sessionMaxDays * DAY;
      if (tooOld || (row.expires_at && row.expires_at.getTime() < Date.now())) {
        await db.query('DELETE FROM auth_tokens WHERE id = $1', [row.token_id]);
        throw unauthorized('Your session has expired. Sign in again.', 'session_expired');
      }
      // Touch at most every few minutes; sessions slide forward as they are used.
      const stale = !row.last_used_at || Date.now() - row.last_used_at.getTime() > 5 * 60_000;
      if (stale) {
        await db.query(
          `UPDATE auth_tokens
              SET last_used_at = now(),
                  expires_at = CASE WHEN kind <> 'session' THEN expires_at
                                    WHEN $3::int > 0
                                    THEN LEAST(now() + make_interval(days => $2), created_at + make_interval(days => $3::int))
                                    ELSE now() + make_interval(days => $2) END
            WHERE id = $1`,
          [row.token_id, config.sessionTtlDays, config.sessionMaxDays],
        );
      }
      const user: AuthUser = {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        tokenId: row.token_id,
        tokenKind: row.kind,
      };
      req.user = user;
    });

    const auth = { onRequest: [root.authenticate] };

    async function registrationState() {
      const res = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
      const hasUsers = res.rows[0]!.n > 0;
      const mode = config.registration;
      const open =
        mode === 'open' || mode === 'invite' || (mode === 'first-user' && !hasUsers);
      return {
        mode,
        open,
        requiresInviteCode: mode === 'invite',
        hasUsers,
        // How people prove who they are here, and what the front end needs to start that.
        provider: config.authProvider,
        ...(config.firebase
          ? {
              firebase: {
                apiKey: config.firebase.apiKey,
                authDomain: config.firebase.authDomain,
                projectId: config.firebase.projectId,
                signInProviders: config.firebase.signInProviders,
              },
            }
          : {}),
      };
    }

    const verifyIdToken = config.firebase ? firebaseVerifier(config.firebase) : null;
    const passwordsOff = () =>
      forbidden('This OpenLeaf instance signs people in with Google, not with a password.', 'password_sign_in_disabled');

    /**
     * Refuses unless a new account may be made right now. Call inside the registration lock.
     * A missing invite code (`invite_required`) is told apart from a wrong one, so that a
     * front end can ask for the code only once it knows the account is new.
     */
    function admit(hasUsers: boolean, inviteCode: string | undefined): void {
      switch (config.registration) {
        case 'closed':
          throw forbidden('Registration is closed on this OpenLeaf instance.', 'registration_closed');
        case 'first-user':
          if (hasUsers) {
            throw forbidden(
              'This OpenLeaf instance already has its owner; registration is closed.',
              'registration_closed',
            );
          }
          break;
        case 'invite':
          if (!inviteCode) {
            throw forbidden('A new account needs the invite code.', 'invite_required');
          }
          if (!safeEqual(inviteCode, config.inviteCode!)) {
            throw forbidden('That invite code is not valid.', 'invalid_invite_code');
          }
          break;
        case 'open':
          break;
      }
    }

    app.get(
      '/api/auth/registration',
      {
        schema: {
          tags: [TAG],
          summary: 'Whether new accounts can be created right now',
        },
      },
      async () => registrationState(),
    );

    app.post(
      '/api/auth/register',
      {
        config: authLimit,
        schema: {
          tags: [TAG],
          summary: 'Create an account (the first account becomes the owner)',
          body: Type.Object({
            email: Type.String(),
            password: Type.String(),
            displayName: Type.Optional(Type.String({ maxLength: 120 })),
            inviteCode: Type.Optional(Type.String()),
          }),
        },
      },
      async (req, reply) => {
        if (config.authProvider !== 'local') throw passwordsOff();
        const email = cleanEmail(req.body.email);
        checkPassword(req.body.password);
        const passwordHash = await hashPassword(req.body.password);

        const result = await db.tx(async (q) => {
          // Serialise registrations so "first user becomes owner" cannot race.
          await q.query('SELECT pg_advisory_xact_lock(7302412)');
          const count = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
          const hasUsers = count.rows[0]!.n > 0;

          try {
            admit(hasUsers, req.body.inviteCode);
          } catch (err) {
            // With a password there is one form, so a missing code is simply a wrong one.
            if ((err as { code?: string }).code === 'invite_required') {
              throw forbidden('That invite code is not valid.', 'invalid_invite_code');
            }
            throw err;
          }

          const existing = await q.query('SELECT 1 FROM users WHERE email = $1', [email]);
          if (existing.rowCount) throw conflict('An account with that email already exists.', 'email_taken');

          const inserted = await q.query<UserRow>(
            `INSERT INTO users (email, password_hash, display_name, role)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [email, passwordHash, (req.body.displayName ?? '').trim(), hasUsers ? 'member' : 'owner'],
          );
          const user = inserted.rows[0]!;
          const session = await issueSession(q, user.id, config.sessionTtlDays, config.sessionMaxDays);
          return { user, session };
        });

        events.emit('user.registered', {
          userId: result.user.id,
          email: result.user.email,
          role: result.user.role,
        });
        reply.code(201);
        return { user: publicUser(result.user), ...result.session };
      },
    );

    app.post(
      '/api/auth/login',
      {
        config: authLimit,
        schema: {
          tags: [TAG],
          summary: 'Sign in and receive a session token',
          body: Type.Object({ email: Type.String(), password: Type.String() }),
        },
      },
      async (req) => {
        if (config.authProvider !== 'local') throw passwordsOff();
        const email = req.body.email.trim().toLowerCase();
        const res = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
        const user = res.rows[0];
        // Always do the hashing work, so response time does not reveal whether the email exists.
        const ok = user?.password_hash
          ? await verifyPassword(req.body.password, user.password_hash)
          : (await hashPassword(req.body.password), false);
        if (!user || !ok) throw unauthorized('Wrong email or password.', 'invalid_credentials');
        const session = await issueSession(db, user.id, config.sessionTtlDays, config.sessionMaxDays);
        return { user: publicUser(user), ...session };
      },
    );

    app.post(
      '/api/auth/firebase',
      {
        config: authLimit,
        schema: {
          tags: [TAG],
          summary: 'Sign in with a Firebase ID token (for example after "Continue with Google")',
          description:
            'Only on an instance with `AUTH_PROVIDER=firebase`. The first time an account signs in it is ' +
            'created, subject to the same rules as registration: on an invite-only instance send `inviteCode` ' +
            '(a 403 `invite_required` asks for it). Returns an OpenLeaf session token, as `login` does.',
          body: Type.Object({
            idToken: Type.String({ minLength: 1, maxLength: 8192 }),
            inviteCode: Type.Optional(Type.String({ maxLength: 512 })),
          }),
        },
      },
      async (req, reply) => {
        if (!verifyIdToken) {
          throw forbidden('This OpenLeaf instance does not sign people in through Firebase.', 'firebase_sign_in_disabled');
        }
        const identity = await verifyIdToken(req.body.idToken);

        const result = await db.tx(async (q) => {
          await q.query('SELECT pg_advisory_xact_lock(7302412)');

          const known = await q.query<UserRow>('SELECT * FROM users WHERE firebase_uid = $1', [identity.uid]);
          if (known.rows[0]) {
            return { user: known.rows[0], created: false, session: await issueSession(q, known.rows[0].id, config.sessionTtlDays, config.sessionMaxDays) };
          }

          // An account made earlier with a password, now signing in with the same (verified) address.
          const byEmail = await q.query<UserRow>('SELECT * FROM users WHERE email = $1', [identity.email]);
          if (byEmail.rows[0]) {
            if (byEmail.rows[0].firebase_uid) {
              throw conflict('Another account already uses that email address.', 'email_taken');
            }
            const linked = await q.query<UserRow>(
              'UPDATE users SET firebase_uid = $2, password_hash = NULL, updated_at = now() WHERE id = $1 RETURNING *',
              [byEmail.rows[0].id, identity.uid],
            );
            return { user: linked.rows[0]!, created: false, session: await issueSession(q, linked.rows[0]!.id, config.sessionTtlDays, config.sessionMaxDays) };
          }

          const count = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
          const hasUsers = count.rows[0]!.n > 0;
          admit(hasUsers, req.body.inviteCode?.trim() || undefined);

          const inserted = await q.query<UserRow>(
            `INSERT INTO users (email, firebase_uid, display_name, role)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [identity.email, identity.uid, identity.name, hasUsers ? 'member' : 'owner'],
          );
          const user = inserted.rows[0]!;
          return { user, created: true, session: await issueSession(q, user.id, config.sessionTtlDays, config.sessionMaxDays) };
        });

        if (result.created) {
          events.emit('user.registered', {
            userId: result.user.id,
            email: result.user.email,
            role: result.user.role,
          });
          reply.code(201);
        }
        return { user: publicUser(result.user), ...result.session };
      },
    );

    app.post(
      '/api/auth/logout',
      { ...auth, schema: { tags: [TAG], summary: 'End the current session', security: secured } },
      async (req, reply) => {
        const user = currentUser(req);
        if (user.tokenKind === 'session') {
          await db.query('DELETE FROM auth_tokens WHERE id = $1', [user.tokenId]);
        }
        reply.code(204);
      },
    );

    app.get(
      '/api/auth/sessions',
      { ...auth, schema: { tags: [TAG], summary: 'Where you are signed in: your sessions', security: secured } },
      async (req) => {
        const user = currentUser(req);
        const res = await db.query<{ id: string; created_at: Date; last_used_at: Date | null; expires_at: Date | null }>(
          `SELECT id, created_at, last_used_at, expires_at FROM auth_tokens
            WHERE user_id = $1 AND kind = 'session' AND (expires_at IS NULL OR expires_at > now())
            ORDER BY created_at DESC`,
          [user.id],
        );
        return {
          sessions: res.rows.map((t) => ({
            id: t.id,
            createdAt: t.created_at,
            lastUsedAt: t.last_used_at,
            expiresAt: t.expires_at,
            current: t.id === user.tokenId,
          })),
        };
      },
    );

    app.post(
      '/api/auth/logout-all',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Sign out everywhere: end every session of this account',
          description:
            'Ends all sessions, this one included, on every browser and device. Personal API tokens are ' +
            'left alone unless `?apiTokens=true`.',
          security: secured,
          querystring: Type.Object({ apiTokens: Type.Optional(Type.Boolean()) }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        await db.query(
          `DELETE FROM auth_tokens WHERE user_id = $1 AND (kind = 'session' OR $2::boolean)`,
          [user.id, Boolean(req.query.apiTokens)],
        );
        reply.code(204);
      },
    );

    app.get(
      '/api/auth/me',
      { ...auth, schema: { tags: [TAG], summary: 'The signed-in account', security: secured } },
      async (req) => {
        const res = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [currentUser(req).id]);
        return { user: publicUser(res.rows[0]!) };
      },
    );

    app.patch(
      '/api/auth/me',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Update your display name or email',
          security: secured,
          body: Type.Object({
            displayName: Type.Optional(Type.String({ maxLength: 120 })),
            email: Type.Optional(Type.String()),
          }),
        },
      },
      async (req) => {
        const user = currentUser(req);
        if (req.body.email !== undefined && config.authProvider !== 'local') {
          throw forbidden('The email address comes from the account you sign in with, so it is changed there.', 'email_from_provider');
        }
        const email = req.body.email !== undefined ? cleanEmail(req.body.email) : null;
        if (email) {
          const clash = await db.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [email, user.id]);
          if (clash.rowCount) throw conflict('An account with that email already exists.', 'email_taken');
        }
        const res = await db.query<UserRow>(
          `UPDATE users
              SET display_name = COALESCE($2, display_name),
                  email = COALESCE($3, email),
                  updated_at = now()
            WHERE id = $1 RETURNING *`,
          [user.id, req.body.displayName?.trim() ?? null, email],
        );
        return { user: publicUser(res.rows[0]!) };
      },
    );

    app.post(
      '/api/auth/password',
      {
        ...auth,
        config: authLimit,
        schema: {
          tags: [TAG],
          summary: 'Change your password (signs out your other sessions)',
          security: secured,
          body: Type.Object({ currentPassword: Type.String(), newPassword: Type.String() }),
        },
      },
      async (req, reply) => {
        if (config.authProvider !== 'local') throw passwordsOff();
        const user = currentUser(req);
        const res = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [user.id]);
        const stored = res.rows[0]!.password_hash;
        if (!stored || !(await verifyPassword(req.body.currentPassword, stored))) {
          throw unauthorized('Your current password is not correct.', 'invalid_credentials');
        }
        checkPassword(req.body.newPassword);
        const passwordHash = await hashPassword(req.body.newPassword);
        await db.tx(async (q) => {
          await q.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
            user.id,
            passwordHash,
          ]);
          await q.query(`DELETE FROM auth_tokens WHERE user_id = $1 AND kind = 'session' AND id <> $2`, [
            user.id,
            user.tokenId,
          ]);
        });
        reply.code(204);
      },
    );

    // ---- personal API tokens (for scripts, e.g. pushing figures from a notebook) ----

    app.get(
      '/api/auth/tokens',
      { ...auth, schema: { tags: [TAG], summary: 'List your API tokens', security: secured } },
      async (req) => {
        const res = await db.query<{
          id: string;
          name: string;
          created_at: Date;
          last_used_at: Date | null;
          expires_at: Date | null;
        }>(
          `SELECT id, name, created_at, last_used_at, expires_at
             FROM auth_tokens WHERE user_id = $1 AND kind = 'api' ORDER BY created_at DESC`,
          [currentUser(req).id],
        );
        return {
          tokens: res.rows.map((t) => ({
            id: t.id,
            name: t.name,
            createdAt: t.created_at,
            lastUsedAt: t.last_used_at,
            expiresAt: t.expires_at,
          })),
        };
      },
    );

    app.post(
      '/api/auth/tokens',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Create an API token (shown only once)',
          security: secured,
          body: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 120 }),
            expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
          }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const token = newToken('olp');
        const res = await db.query<{ id: string; created_at: Date; expires_at: Date | null }>(
          `INSERT INTO auth_tokens (user_id, kind, name, token_hash, expires_at)
           VALUES ($1, 'api', $2, $3,
                   CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END)
           RETURNING id, created_at, expires_at`,
          [user.id, req.body.name.trim(), hashToken(token), req.body.expiresInDays ?? null],
        );
        const row = res.rows[0]!;
        reply.code(201);
        return {
          id: row.id,
          name: req.body.name.trim(),
          token,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        };
      },
    );

    app.delete(
      '/api/auth/tokens/:tokenId',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Revoke an API token',
          security: secured,
          params: Type.Object({ tokenId: Uuid }),
        },
      },
      async (req, reply) => {
        const res = await db.query(
          `DELETE FROM auth_tokens WHERE id = $1 AND user_id = $2 AND kind = 'api'`,
          [req.params.tokenId, currentUser(req).id],
        );
        if (!res.rowCount) throw notFound('No such API token.');
        reply.code(204);
      },
    );
  },

  async onReady(root, { db }) {
    const gone = await db.query('DELETE FROM auth_tokens WHERE expires_at < now()');
    if (gone.rowCount) root.log.info({ removed: gone.rowCount }, 'removed expired sessions and tokens');
  },
};
