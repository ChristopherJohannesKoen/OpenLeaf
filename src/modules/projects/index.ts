import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { OpenLeafModule } from '../../core/modules.js';
import { badRequest, conflict } from '../../core/errors.js';
import { currentUser, ProjectParams, secured } from '../../core/http.js';
import { likeEscape, normalizePath } from '../../core/paths.js';
import { jsonSize, latexEscape, mergePatch } from '../../core/util.js';
import {
  cleanName,
  cleanTags,
  copyFiles,
  getProject,
  insertEntries,
  insertProject,
  projectJson,
  type ProjectRow,
} from './store.js';

const TAG = 'Projects';
const EngineId = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,31}$' });

export function blankDocument(title: string): string {
  return `\\documentclass[11pt]{article}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{${latexEscape(title)}}
\\author{}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}

Start writing here.

\\end{document}
`;
}

export const projectsModule: OpenLeafModule = {
  name: 'projects',
  description: 'Projects and the tables that hold their file trees.',
  core: true,
  dependsOn: ['auth'],
  migrations: [
    {
      id: '001_init',
      sql: `
        CREATE TABLE projects (
          id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name         text NOT NULL,
          description  text NOT NULL DEFAULT '',
          main_file    text NOT NULL DEFAULT 'main.tex',
          engine       text NOT NULL DEFAULT 'pdflatex',
          tags         text[] NOT NULL DEFAULT '{}',
          settings     jsonb NOT NULL DEFAULT '{}',
          archived_at  timestamptz,
          trashed_at   timestamptz,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX projects_owner_idx ON projects (owner_id, updated_at DESC);

        CREATE TABLE project_files (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          path        text NOT NULL,
          kind        text NOT NULL CHECK (kind IN ('text', 'binary', 'folder')),
          content     text,
          data        bytea,
          size        integer NOT NULL DEFAULT 0,
          sha256      text NOT NULL DEFAULT '',
          version     integer NOT NULL DEFAULT 1,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz NOT NULL DEFAULT now(),
          UNIQUE (project_id, path)
        );
      `,
    },
  ],

  register(root, { db, config, events }) {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const auth = { onRequest: [root.authenticate] };
    const limits = config;

    app.get(
      '/api/projects',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'List your projects',
          security: secured,
          querystring: Type.Object({
            status: Type.Optional(
              Type.Union([
                Type.Literal('active'),
                Type.Literal('archived'),
                Type.Literal('trashed'),
                Type.Literal('all'),
              ]),
            ),
            q: Type.Optional(Type.String({ maxLength: 200, description: 'Search in name and description' })),
            tag: Type.Optional(Type.String({ maxLength: 50 })),
          }),
        },
      },
      async (req) => {
        const user = currentUser(req);
        const status = req.query.status ?? 'active';
        const where = ['p.owner_id = $1'];
        const params: unknown[] = [user.id];
        if (status === 'active') where.push('p.archived_at IS NULL AND p.trashed_at IS NULL');
        if (status === 'archived') where.push('p.archived_at IS NOT NULL AND p.trashed_at IS NULL');
        if (status === 'trashed') where.push('p.trashed_at IS NOT NULL');
        if (req.query.q?.trim()) {
          params.push(`%${likeEscape(req.query.q.trim())}%`);
          where.push(`(p.name ILIKE $${params.length} ESCAPE '\\' OR p.description ILIKE $${params.length} ESCAPE '\\')`);
        }
        if (req.query.tag) {
          params.push(req.query.tag);
          where.push(`$${params.length} = ANY(p.tags)`);
        }
        const res = await db.query<ProjectRow & { file_count: number; total_size: number }>(
          `SELECT p.*,
                  COALESCE(f.file_count, 0)::int AS file_count,
                  COALESCE(f.total_size, 0)::bigint AS total_size
             FROM projects p
             LEFT JOIN LATERAL (
               SELECT count(*) FILTER (WHERE kind <> 'folder') AS file_count, sum(size) AS total_size
                 FROM project_files WHERE project_id = p.id
             ) f ON true
            WHERE ${where.join(' AND ')}
            ORDER BY p.updated_at DESC`,
          params,
        );
        return {
          projects: res.rows.map((p) => ({
            ...projectJson(p),
            fileCount: p.file_count,
            totalSize: p.total_size,
          })),
        };
      },
    );

    app.post(
      '/api/projects',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Create a project with a starter main.tex',
          security: secured,
          body: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 200 }),
            description: Type.Optional(Type.String({ maxLength: 2000 })),
            engine: Type.Optional(EngineId),
            tags: Type.Optional(Type.Array(Type.String())),
            empty: Type.Optional(Type.Boolean({ description: 'Create no starter file at all' })),
          }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const project = await db.tx(async (q) => {
          const created = await insertProject(q, {
            ownerId: user.id,
            name: req.body.name,
            description: req.body.description,
            engine: req.body.engine ?? config.compile.defaultEngine,
            tags: req.body.tags,
          });
          if (!req.body.empty) {
            await insertEntries(
              q,
              created.id,
              [{ path: 'main.tex', kind: 'text', content: blankDocument(created.name) }],
              limits,
            );
          }
          return created;
        });
        events.emit('project.created', { projectId: project.id, userId: user.id });
        reply.code(201);
        return { project: projectJson(project) };
      },
    );

    app.get(
      '/api/projects/:projectId',
      {
        ...auth,
        schema: { tags: [TAG], summary: 'Get one project', security: secured, params: ProjectParams },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const stats = await db.query<{ file_count: number; total_size: number }>(
          `SELECT count(*) FILTER (WHERE kind <> 'folder')::int AS file_count,
                  COALESCE(sum(size), 0)::bigint AS total_size
             FROM project_files WHERE project_id = $1`,
          [project.id],
        );
        return {
          project: {
            ...projectJson(project),
            fileCount: stats.rows[0]!.file_count,
            totalSize: stats.rows[0]!.total_size,
          },
        };
      },
    );

    app.patch(
      '/api/projects/:projectId',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Rename a project or change its main file, engine, tags or settings',
          description:
            '`settings` is merged into the existing settings (JSON Merge Patch: send `null` to remove a key).',
          security: secured,
          params: ProjectParams,
          body: Type.Object({
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            description: Type.Optional(Type.String({ maxLength: 2000 })),
            mainFile: Type.Optional(Type.String()),
            engine: Type.Optional(EngineId),
            tags: Type.Optional(Type.Array(Type.String())),
            settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          }),
        },
      },
      async (req) => {
        const user = currentUser(req);
        const project = await db.tx(async (q) => {
          const current = await getProject(q, req.params.projectId, user.id);
          let mainFile: string | null = null;
          if (req.body.mainFile !== undefined) {
            mainFile = normalizePath(req.body.mainFile, 'main file');
            const exists = await q.query(
              `SELECT 1 FROM project_files WHERE project_id = $1 AND path = $2 AND kind = 'text'`,
              [current.id, mainFile],
            );
            if (!exists.rowCount) {
              throw badRequest(`There is no text file at "${mainFile}" to use as the main file.`, 'invalid_main_file');
            }
          }
          let settings: unknown = null;
          if (req.body.settings !== undefined) {
            settings = mergePatch(current.settings, req.body.settings);
            if (jsonSize(settings) > 64 * 1024) {
              throw badRequest('Project settings are limited to 64 KB.', 'settings_too_large');
            }
          }
          const res = await q.query<ProjectRow>(
            `UPDATE projects
                SET name = COALESCE($2, name),
                    description = COALESCE($3, description),
                    main_file = COALESCE($4, main_file),
                    engine = COALESCE($5, engine),
                    tags = COALESCE($6, tags),
                    settings = COALESCE($7::jsonb, settings),
                    updated_at = now()
              WHERE id = $1 RETURNING *`,
            [
              current.id,
              req.body.name !== undefined ? cleanName(req.body.name) : null,
              req.body.description !== undefined ? req.body.description.trim() : null,
              mainFile,
              req.body.engine ?? null,
              req.body.tags !== undefined ? cleanTags(req.body.tags) : null,
              settings !== null ? JSON.stringify(settings) : null,
            ],
          );
          return res.rows[0]!;
        });
        return { project: projectJson(project) };
      },
    );

    app.post(
      '/api/projects/:projectId/duplicate',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Copy a project and all of its files',
          security: secured,
          params: ProjectParams,
          body: Type.Optional(Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) })),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const copy = await db.tx(async (q) => {
          const source = await getProject(q, req.params.projectId, user.id);
          const created = await insertProject(q, {
            ownerId: user.id,
            name: req.body?.name ?? `${source.name} (copy)`.slice(0, 200),
            description: source.description,
            mainFile: source.main_file,
            engine: source.engine,
            tags: source.tags,
            settings: source.settings,
          });
          await copyFiles(q, source.id, created.id);
          return created;
        });
        events.emit('project.created', { projectId: copy.id, userId: user.id });
        reply.code(201);
        return { project: projectJson(copy) };
      },
    );

    const transitions = {
      archive: { summary: 'Archive a project', sql: 'archived_at = now()' },
      unarchive: { summary: 'Move a project out of the archive', sql: 'archived_at = NULL' },
      trash: { summary: 'Move a project to the trash', sql: 'trashed_at = now()' },
      restore: { summary: 'Take a project out of the trash', sql: 'trashed_at = NULL' },
    } as const;

    for (const [action, def] of Object.entries(transitions)) {
      app.post(
        `/api/projects/:projectId/${action}`,
        {
          ...auth,
          schema: { tags: [TAG], summary: def.summary, security: secured, params: ProjectParams },
        },
        async (req) => {
          const current = await getProject(db, req.params.projectId, currentUser(req).id);
          const res = await db.query<ProjectRow>(
            `UPDATE projects SET ${def.sql} WHERE id = $1 RETURNING *`,
            [current.id],
          );
          return { project: projectJson(res.rows[0]!) };
        },
      );
    }

    app.delete(
      '/api/projects/:projectId',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Permanently delete a project',
          description:
            'The project must be in the trash first, unless `force=true` is passed. This cannot be undone.',
          security: secured,
          params: ProjectParams,
          querystring: Type.Object({ force: Type.Optional(Type.Boolean()) }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const current = await getProject(db, req.params.projectId, user.id);
        if (!current.trashed_at && !req.query.force) {
          throw conflict(
            'Move the project to the trash first, or pass force=true to delete it immediately.',
            'not_in_trash',
          );
        }
        await db.query('DELETE FROM projects WHERE id = $1', [current.id]);
        events.emit('project.deleted', { projectId: current.id, userId: user.id });
        reply.code(204);
      },
    );
  },
};
