import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { OpenLeafModule } from '../../core/modules.js';
import { badRequest, notFound } from '../../core/errors.js';
import { currentUser, ProjectParams, secured, sendFile, Uuid } from '../../core/http.js';
import { normalizePath } from '../../core/paths.js';
import { slugify } from '../../core/util.js';
import { getProject } from '../projects/store.js';
import { engineStatuses } from './engines.js';
import { CompileService, type CompileRow } from './service.js';
import { forwardSearch, inverseSearch } from './synctex.js';
import { removeWorkspace, workspaceFor } from './workspace.js';

const TAG = 'Compile';

function compileJson(c: CompileRow, opts: { detail?: boolean; cached?: boolean } = {}) {
  const base = `/api/projects/${c.project_id}`;
  return {
    id: c.id,
    status: c.status,
    engine: c.engine,
    mainFile: c.main_file,
    options: c.options,
    message: c.message,
    errorCount: c.error_count,
    warningCount: c.warning_count,
    hasPdf: c.pdf_size !== null,
    pdfSize: c.pdf_size,
    hasSynctex: c.has_synctex,
    createdAt: c.created_at,
    startedAt: c.started_at,
    finishedAt: c.finished_at,
    durationMs: c.duration_ms,
    ...(opts.cached !== undefined ? { cached: opts.cached } : {}),
    ...(opts.detail ? { diagnostics: c.diagnostics } : {}),
    links: {
      self: `${base}/compiles/${c.id}`,
      pdf: c.pdf_size !== null ? `${base}/output.pdf?compile=${c.id}` : null,
      log: `${base}/output.log?compile=${c.id}`,
    },
  };
}

// Created in register(), used by onReady(); keyed by app so several apps can live in one process.
const services = new WeakMap<FastifyInstance, CompileService>();

export const compileModule: OpenLeafModule = {
  name: 'compile',
  description: 'Turn a project into a PDF with pdfLaTeX, XeLaTeX or LuaLaTeX; logs, diagnostics and SyncTeX.',
  dependsOn: ['projects'],
  migrations: [
    {
      id: '001_init',
      sql: `
        CREATE TABLE compiles (
          id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
          status         text NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failure', 'timeout', 'error')),
          engine         text NOT NULL,
          main_file      text NOT NULL,
          job_name       text NOT NULL DEFAULT 'output',
          options        jsonb NOT NULL DEFAULT '{}',
          source_hash    text NOT NULL DEFAULT '',
          diagnostics    jsonb NOT NULL DEFAULT '[]',
          error_count    integer NOT NULL DEFAULT 0,
          warning_count  integer NOT NULL DEFAULT 0,
          message        text,
          log            text,
          console        text,
          pdf            bytea,
          pdf_size       integer,
          synctex        bytea,
          created_at     timestamptz NOT NULL DEFAULT now(),
          started_at     timestamptz,
          finished_at    timestamptz,
          duration_ms    integer
        );
        CREATE INDEX compiles_project_idx ON compiles (project_id, created_at DESC);
      `,
    },
  ],

  register(root, { db, config, events, info }) {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const auth = { onRequest: [root.authenticate] };
    const compiler = new CompileService(db, config, events, root.log);
    services.set(root, compiler);

    events.on('project.deleted', async ({ projectId }) => {
      await removeWorkspace(workspaceFor(config.compile.dir, projectId));
    });

    info.set('compile', async () => ({
      defaultEngine: config.compile.defaultEngine,
      timeoutSeconds: Math.round(config.compile.timeoutMs / 1000),
      engines: await engineStatuses(),
      selfTests: compiler.selfTests,
    }));

    app.get(
      '/api/compile/engines',
      { ...auth, schema: { tags: [TAG], summary: 'The LaTeX engines this server can run', security: secured } },
      async () => ({ defaultEngine: config.compile.defaultEngine, engines: await engineStatuses() }),
    );

    app.post(
      '/api/projects/:projectId/compile',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Compile the project to PDF',
          description:
            'By default the request waits for the compile to finish and returns the result with its diagnostics. ' +
            'Pass `wait=false` to get a 202 straight away and poll `links.self`. ' +
            'If nothing changed since the last successful compile, that result is returned (`cached: true`) unless `force` is set.',
          security: secured,
          params: ProjectParams,
          querystring: Type.Object({ wait: Type.Optional(Type.Boolean()) }),
          body: Type.Optional(
            Type.Object({
              engine: Type.Optional(Type.String()),
              mainFile: Type.Optional(Type.String()),
              stopOnFirstError: Type.Optional(Type.Boolean()),
              clean: Type.Optional(Type.Boolean({ description: 'Discard cached auxiliary files first' })),
              force: Type.Optional(Type.Boolean({ description: 'Compile even if nothing changed' })),
            }),
          ),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const project = await getProject(db, req.params.projectId, user.id);
        const ticket = await compiler.request(project, user.id, req.body ?? {});
        if (req.query.wait === false) {
          const row = await compiler.get(project.id, ticket.compileId);
          const finished = !['queued', 'running'].includes(row.status);
          reply.code(finished ? 200 : 202);
          return { compile: compileJson(row, { detail: finished, cached: ticket.cached }) };
        }
        await ticket.done;
        const row = await compiler.get(project.id, ticket.compileId);
        return { compile: compileJson(row, { detail: true, cached: ticket.cached }) };
      },
    );

    app.get(
      '/api/projects/:projectId/compiles',
      {
        ...auth,
        schema: { tags: [TAG], summary: 'Recent compiles of a project', security: secured, params: ProjectParams },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        return { compiles: (await compiler.list(project.id)).map((c) => compileJson(c)) };
      },
    );

    app.get(
      '/api/projects/:projectId/compiles/latest',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'The most recent compile, with diagnostics',
          security: secured,
          params: ProjectParams,
        },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const row = await compiler.latest(project.id);
        return { compile: row ? compileJson(row, { detail: true }) : null };
      },
    );

    app.get(
      '/api/projects/:projectId/compiles/:compileId',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'One compile, with diagnostics',
          security: secured,
          params: Type.Object({ projectId: Uuid, compileId: Uuid }),
        },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        return { compile: compileJson(await compiler.get(project.id, req.params.compileId), { detail: true }) };
      },
    );

    const OutputQuery = Type.Object({
      compile: Type.Optional(Uuid),
      download: Type.Optional(Type.Boolean()),
    });

    app.get(
      '/api/projects/:projectId/output.pdf',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'The compiled PDF (latest, or of a specific compile)',
          security: secured,
          params: ProjectParams,
          querystring: OutputQuery,
        },
      },
      async (req, reply) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const row = req.query.compile
          ? await compiler.get(project.id, req.query.compile)
          : await compiler.latest(project.id, { withPdf: true });
        if (!row || row.pdf_size === null) {
          throw notFound('There is no PDF yet. Compile the project first.', 'no_pdf');
        }
        if (req.headers['if-none-match'] === `"${row.id}"`) return reply.code(304).send();
        const res = await db.query<{ pdf: Buffer }>('SELECT pdf FROM compiles WHERE id = $1', [row.id]);
        return sendFile(reply, {
          filename: `${slugify(project.name)}.pdf`,
          contentType: 'application/pdf',
          body: res.rows[0]!.pdf,
          download: req.query.download,
          etag: row.id,
        });
      },
    );

    app.get(
      '/api/projects/:projectId/output.log',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'The raw LaTeX log (latest, or of a specific compile)',
          description: 'Pass `console=true` for the latexmk console output instead of the TeX log.',
          security: secured,
          params: ProjectParams,
          querystring: Type.Intersect([OutputQuery, Type.Object({ console: Type.Optional(Type.Boolean()) })]),
        },
      },
      async (req, reply) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const row = req.query.compile ? await compiler.get(project.id, req.query.compile) : await compiler.latest(project.id);
        if (!row) throw notFound('There is no compile log yet. Compile the project first.', 'no_log');
        const res = await db.query<{ log: string | null; console: string | null }>(
          'SELECT log, console FROM compiles WHERE id = $1',
          [row.id],
        );
        const text = (req.query.console ? res.rows[0]!.console : res.rows[0]!.log || res.rows[0]!.console) ?? '';
        return sendFile(reply, {
          filename: `${slugify(project.name)}.log`,
          contentType: 'text/plain; charset=utf-8',
          body: Buffer.from(text, 'utf8'),
          download: req.query.download,
        });
      },
    );

    app.post(
      '/api/projects/:projectId/synctex/forward',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Source to PDF: where does this line appear in the PDF?',
          description:
            'Returns boxes in PDF points measured from the top-left corner of the page (`h` right, `v` down to the top of the box).',
          security: secured,
          params: ProjectParams,
          body: Type.Object({
            file: Type.String(),
            line: Type.Integer({ minimum: 1 }),
            column: Type.Optional(Type.Integer({ minimum: 0 })),
          }),
        },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const row = await compiler.latest(project.id, { withSynctex: true });
        if (!row) throw notFound('Compile the project first to enable source/PDF sync.', 'no_synctex');
        const dir = await compiler.synctexDir(row);
        const positions = await forwardSearch(
          dir,
          compiler.workspace(project.id).src,
          row.job_name,
          normalizePath(req.body.file, 'file'),
          req.body.line,
          req.body.column ?? 0,
        );
        return { compileId: row.id, positions };
      },
    );

    app.post(
      '/api/projects/:projectId/synctex/inverse',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'PDF to source: which line produced this spot on the page?',
          description: 'Coordinates are PDF points measured from the top-left corner of the page.',
          security: secured,
          params: ProjectParams,
          body: Type.Object({
            page: Type.Integer({ minimum: 1 }),
            h: Type.Number(),
            v: Type.Number(),
          }),
        },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const row = await compiler.latest(project.id, { withSynctex: true });
        if (!row) throw notFound('Compile the project first to enable source/PDF sync.', 'no_synctex');
        const dir = await compiler.synctexDir(row);
        const position = await inverseSearch(
          dir,
          compiler.workspace(project.id).src,
          row.job_name,
          req.body.page,
          req.body.h,
          req.body.v,
        );
        if (!position) throw badRequest('Nothing in the project corresponds to that position.', 'no_match');
        return { compileId: row.id, position };
      },
    );

    app.delete(
      '/api/projects/:projectId/compile-cache',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Delete cached auxiliary files so the next compile starts from scratch',
          security: secured,
          params: ProjectParams,
        },
      },
      async (req, reply) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        await compiler.clearCache(project.id);
        reply.code(204);
      },
    );
  },

  async onReady(root, { config }) {
    const compiler = services.get(root);
    if (!compiler) return;
    const recovered = await compiler.recoverInterrupted();
    if (recovered) root.log.info({ recovered }, 'closed out compiles interrupted by a restart');

    const engines = await engineStatuses(true);
    root.log.info(
      { engines: engines.map((e) => ({ id: e.id, available: e.available, version: e.version })) },
      'LaTeX engines detected',
    );
    if (config.compile.startupSelfTest !== 'off') {
      const which =
        config.compile.startupSelfTest === 'all'
          ? engines.filter((e) => e.available).map((e) => e.id)
          : [config.compile.defaultEngine];
      // Runs in the background so the server starts accepting requests immediately.
      void compiler.runSelfTest(which).then((results) => {
        for (const r of results) {
          if (r.ok) root.log.info(r, `compile self-test passed (${r.engine})`);
          else root.log.error(r, `compile self-test FAILED (${r.engine})`);
        }
      });
    }
  },
};
