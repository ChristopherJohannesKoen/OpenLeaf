import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { OpenLeafModule } from '../../core/modules.js';
import { notFound } from '../../core/errors.js';
import { currentUser, ProjectParams, secured, sendFile, Uuid } from '../../core/http.js';
import { slugify } from '../../core/util.js';
import { hashToken, newToken } from '../auth/passwords.js';
import { getProject } from '../projects/store.js';

const TAG = 'Sharing';

interface LinkRow {
  id: string;
  project_id: string;
  label: string;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
}

function linkJson(l: LinkRow) {
  return {
    id: l.id,
    label: l.label,
    createdAt: l.created_at,
    expiresAt: l.expires_at,
    lastUsedAt: l.last_used_at,
    expired: l.expires_at !== null && l.expires_at.getTime() < Date.now(),
  };
}

export const shareModule: OpenLeafModule = {
  name: 'share',
  description: 'Read-only links to a project\'s latest PDF, for people without an account (e.g. a supervisor).',
  dependsOn: ['projects', 'compile'],
  migrations: [
    {
      id: '001_init',
      sql: `
        CREATE TABLE share_links (
          id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
          label         text NOT NULL DEFAULT '',
          token_hash    text NOT NULL UNIQUE,
          created_at    timestamptz NOT NULL DEFAULT now(),
          expires_at    timestamptz,
          last_used_at  timestamptz
        );
        CREATE INDEX share_links_project_idx ON share_links (project_id);
      `,
    },
  ],

  register(root, { db, config }) {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const auth = { onRequest: [root.authenticate] };
    const publicLimit = { rateLimit: { max: 120, timeWindow: '1 minute' } };
    const absolute = (path: string) => (config.publicUrl ? `${config.publicUrl.replace(/\/+$/, '')}${path}` : path);

    app.get(
      '/api/projects/:projectId/share-links',
      {
        ...auth,
        schema: { tags: [TAG], summary: 'List the share links of a project', security: secured, params: ProjectParams },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const res = await db.query<LinkRow>(
          'SELECT * FROM share_links WHERE project_id = $1 ORDER BY created_at DESC',
          [project.id],
        );
        return { links: res.rows.map(linkJson) };
      },
    );

    app.post(
      '/api/projects/:projectId/share-links',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Create a read-only link to the latest PDF',
          description:
            'The link is shown only once. Anyone who has it can view the PDF until it expires or is revoked. ' +
            'Without `expiresInDays` the link gets the instance default (30 days unless configured otherwise).',
          security: secured,
          params: ProjectParams,
          body: Type.Optional(
            Type.Object({
              label: Type.Optional(Type.String({ maxLength: 120 })),
              expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
            }),
          ),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const project = await getProject(db, req.params.projectId, user.id);
        const token = newToken('ols');
        const res = await db.query<LinkRow>(
          `INSERT INTO share_links (project_id, created_by, label, token_hash, expires_at)
           VALUES ($1, $2, $3, $4,
                   CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)
           RETURNING *`,
          [
            project.id,
            user.id,
            (req.body?.label ?? '').trim(),
            hashToken(token),
            req.body?.expiresInDays ?? (config.shareLinkDefaultDays > 0 ? config.shareLinkDefaultDays : null),
          ],
        );
        reply.code(201);
        return {
          link: linkJson(res.rows[0]!),
          token,
          infoUrl: absolute(`/api/shared/${token}`),
          pdfUrl: absolute(`/api/shared/${token}/output.pdf`),
        };
      },
    );

    app.delete(
      '/api/projects/:projectId/share-links/:linkId',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Revoke a share link',
          security: secured,
          params: Type.Object({ projectId: Uuid, linkId: Uuid }),
        },
      },
      async (req, reply) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const res = await db.query('DELETE FROM share_links WHERE id = $1 AND project_id = $2', [
          req.params.linkId,
          project.id,
        ]);
        if (!res.rowCount) throw notFound('No such share link.');
        reply.code(204);
      },
    );

    // ---- public endpoints (no account needed; the token is the credential) ----

    async function resolve(token: string) {
      const res = await db.query<{ link_id: string; project_id: string; name: string }>(
        `SELECT l.id AS link_id, p.id AS project_id, p.name
           FROM share_links l JOIN projects p ON p.id = l.project_id
          WHERE l.token_hash = $1
            AND (l.expires_at IS NULL OR l.expires_at > now())
            AND p.trashed_at IS NULL`,
        [hashToken(token)],
      );
      if (!res.rows[0]) throw notFound('This link is not valid or has expired.', 'invalid_share_link');
      await db.query('UPDATE share_links SET last_used_at = now() WHERE id = $1', [res.rows[0].link_id]);
      return res.rows[0];
    }

    const TokenParams = Type.Object({ token: Type.String({ minLength: 10, maxLength: 100 }) });

    app.get(
      '/api/shared/:token',
      {
        config: publicLimit,
        schema: { tags: [TAG], summary: 'Public: what a share link points to', params: TokenParams },
      },
      async (req) => {
        const shared = await resolve(req.params.token);
        const latest = await db.query<{ finished_at: Date | null; pdf_size: number | null }>(
          `SELECT finished_at, pdf_size FROM compiles
            WHERE project_id = $1 AND pdf IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
          [shared.project_id],
        );
        return {
          project: { name: shared.name },
          hasPdf: Boolean(latest.rows[0]),
          compiledAt: latest.rows[0]?.finished_at ?? null,
          pdfSize: latest.rows[0]?.pdf_size ?? null,
          pdfUrl: absolute(`/api/shared/${req.params.token}/output.pdf`),
        };
      },
    );

    app.get(
      '/api/shared/:token/output.pdf',
      {
        config: publicLimit,
        schema: {
          tags: [TAG],
          summary: 'Public: the latest PDF behind a share link',
          params: TokenParams,
          querystring: Type.Object({ download: Type.Optional(Type.Boolean()) }),
        },
      },
      async (req, reply) => {
        const shared = await resolve(req.params.token);
        const res = await db.query<{ id: string; pdf: Buffer }>(
          `SELECT id, pdf FROM compiles
            WHERE project_id = $1 AND pdf IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
          [shared.project_id],
        );
        if (!res.rows[0]) throw notFound('This project has not been compiled yet.', 'no_pdf');
        return sendFile(reply, {
          filename: `${slugify(shared.name)}.pdf`,
          contentType: 'application/pdf',
          body: res.rows[0].pdf,
          download: req.query.download,
          etag: res.rows[0].id,
        });
      },
    );
  },
};
