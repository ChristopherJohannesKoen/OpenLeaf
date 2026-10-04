import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { OpenLeafModule } from '../../core/modules.js';
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import { currentUser, secured, Uuid } from '../../core/http.js';
import { latexEscape } from '../../core/util.js';
import {
  cleanName,
  getProject,
  insertEntries,
  insertProject,
  projectJson,
  type FileEntry,
  type FileKind,
} from '../projects/store.js';
import { BUILTIN_TEMPLATES, type BuiltinTemplate } from './builtin.js';

const TAG = 'Templates';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TemplateParams = Type.Object({ templateId: Type.String({ minLength: 1, maxLength: 64 }) });

interface TemplateRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  engine: string;
  main_file: string;
  created_at: Date;
}

function builtinJson(t: BuiltinTemplate) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    engine: t.engine,
    mainFile: t.mainFile,
    builtin: true,
    fileCount: Object.keys(t.files).length,
    createdAt: null,
  };
}

function customJson(t: TemplateRow & { file_count?: number }) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    engine: t.engine,
    mainFile: t.main_file,
    builtin: false,
    fileCount: t.file_count ?? 0,
    createdAt: t.created_at,
  };
}

function fill(text: string, values: { title: string; author: string }): string {
  return text
    .replaceAll('{{TITLE}}', latexEscape(values.title))
    .replaceAll('{{AUTHOR}}', latexEscape(values.author));
}

export const templatesModule: OpenLeafModule = {
  name: 'templates',
  description: 'Built-in starter documents, plus saving your own projects as reusable templates.',
  dependsOn: ['projects'],
  migrations: [
    {
      id: '001_init',
      sql: `
        CREATE TABLE templates (
          id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name         text NOT NULL,
          description  text NOT NULL DEFAULT '',
          engine       text NOT NULL,
          main_file    text NOT NULL,
          created_at   timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE template_files (
          template_id  uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
          path         text NOT NULL,
          kind         text NOT NULL CHECK (kind IN ('text', 'binary', 'folder')),
          content      text,
          data         bytea,
          size         integer NOT NULL DEFAULT 0,
          PRIMARY KEY (template_id, path)
        );
      `,
    },
  ],

  register(root, { db, config, events, info }) {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const auth = { onRequest: [root.authenticate] };

    info.set('templates', () => ({ builtin: BUILTIN_TEMPLATES.map((t) => t.id) }));

    async function customTemplate(id: string, userId: string): Promise<TemplateRow> {
      if (!UUID_RE.test(id)) throw notFound('No such template.', 'template_not_found');
      const res = await db.query<TemplateRow>('SELECT * FROM templates WHERE id = $1 AND owner_id = $2', [id, userId]);
      if (!res.rows[0]) throw notFound('No such template.', 'template_not_found');
      return res.rows[0];
    }

    app.get(
      '/api/templates',
      { ...auth, schema: { tags: [TAG], summary: 'Built-in templates and your own', security: secured } },
      async (req) => {
        const res = await db.query<TemplateRow & { file_count: number }>(
          `SELECT t.*, (SELECT count(*)::int FROM template_files f
                         WHERE f.template_id = t.id AND f.kind <> 'folder') AS file_count
             FROM templates t WHERE t.owner_id = $1 ORDER BY t.name`,
          [currentUser(req).id],
        );
        return { templates: [...BUILTIN_TEMPLATES.map(builtinJson), ...res.rows.map(customJson)] };
      },
    );

    app.get(
      '/api/templates/:templateId',
      {
        ...auth,
        schema: { tags: [TAG], summary: 'A template and its file list', security: secured, params: TemplateParams },
      },
      async (req) => {
        const builtin = BUILTIN_TEMPLATES.find((t) => t.id === req.params.templateId);
        if (builtin) {
          return {
            template: builtinJson(builtin),
            files: Object.entries(builtin.files).map(([path, content]) => ({
              path,
              kind: 'text',
              size: Buffer.byteLength(content, 'utf8'),
            })),
          };
        }
        const template = await customTemplate(req.params.templateId, currentUser(req).id);
        const files = await db.query<{ path: string; kind: FileKind; size: number }>(
          'SELECT path, kind, size FROM template_files WHERE template_id = $1 ORDER BY path COLLATE "C"',
          [template.id],
        );
        return {
          template: customJson({ ...template, file_count: files.rows.filter((f) => f.kind !== 'folder').length }),
          files: files.rows,
        };
      },
    );

    app.post(
      '/api/templates',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Save one of your projects as a personal template',
          security: secured,
          body: Type.Object({
            projectId: Uuid,
            name: Type.String({ minLength: 1, maxLength: 200 }),
            description: Type.Optional(Type.String({ maxLength: 2000 })),
          }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const template = await db.tx(async (q) => {
          const project = await getProject(q, req.body.projectId, user.id);
          const inserted = await q.query<TemplateRow>(
            `INSERT INTO templates (owner_id, name, description, engine, main_file)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [user.id, cleanName(req.body.name), (req.body.description ?? '').trim(), project.engine, project.main_file],
          );
          const row = inserted.rows[0]!;
          const copied = await q.query(
            `INSERT INTO template_files (template_id, path, kind, content, data, size)
             SELECT $2, path, kind, content, data, size FROM project_files WHERE project_id = $1`,
            [project.id, row.id],
          );
          return { ...row, file_count: copied.rowCount };
        });
        reply.code(201);
        return { template: customJson(template) };
      },
    );

    app.delete(
      '/api/templates/:templateId',
      {
        ...auth,
        schema: { tags: [TAG], summary: 'Delete a personal template', security: secured, params: TemplateParams },
      },
      async (req, reply) => {
        if (BUILTIN_TEMPLATES.some((t) => t.id === req.params.templateId)) {
          throw forbidden('Built-in templates cannot be deleted.', 'builtin_template');
        }
        const template = await customTemplate(req.params.templateId, currentUser(req).id);
        await db.query('DELETE FROM templates WHERE id = $1', [template.id]);
        reply.code(204);
      },
    );

    app.post(
      '/api/templates/:templateId/projects',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Create a new project from a template',
          security: secured,
          params: TemplateParams,
          body: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 200 }),
            description: Type.Optional(Type.String({ maxLength: 2000 })),
            author: Type.Optional(Type.String({ maxLength: 200, description: 'Defaults to your display name' })),
            tags: Type.Optional(Type.Array(Type.String())),
          }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const name = cleanName(req.body.name);
        const builtin = BUILTIN_TEMPLATES.find((t) => t.id === req.params.templateId);

        let engine: string;
        let mainFile: string;
        let entries: FileEntry[];
        if (builtin) {
          const values = { title: name, author: req.body.author ?? user.displayName ?? '' };
          engine = builtin.engine;
          mainFile = builtin.mainFile;
          entries = Object.entries(builtin.files).map(([path, content]) => ({
            path,
            kind: 'text' as const,
            content: fill(content, values),
          }));
        } else {
          const template = await customTemplate(req.params.templateId, user.id);
          const files = await db.query<{ path: string; kind: FileKind; content: string | null; data: Buffer | null }>(
            'SELECT path, kind, content, data FROM template_files WHERE template_id = $1',
            [template.id],
          );
          engine = template.engine;
          mainFile = template.main_file;
          entries = files.rows;
        }
        if (!entries.length) throw badRequest('That template has no files.', 'empty_template');

        const project = await db.tx(async (q) => {
          const created = await insertProject(q, {
            ownerId: user.id,
            name,
            description: req.body.description,
            mainFile,
            engine,
            tags: req.body.tags,
          });
          await insertEntries(q, created.id, entries, config);
          return created;
        });
        events.emit('project.created', { projectId: project.id, userId: user.id });
        reply.code(201);
        return { project: projectJson(project) };
      },
    );
  },
};
