import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { createTwoFilesPatch } from 'diff';
import type { OpenLeafModule } from '../../core/modules.js';
import type { Queryable } from '../../core/db.js';
import { badRequest, notFound } from '../../core/errors.js';
import { currentUser, ProjectParams, secured, sendFile, Uuid } from '../../core/http.js';
import { basename, mimeFor, normalizePath } from '../../core/paths.js';
import { slugify } from '../../core/util.js';
import { buildZip } from '../files/zip.js';
import { getProject, sourceFingerprint, touchProject, type FileKind } from '../projects/store.js';

const TAG = 'History';
const VersionParams = Type.Object({ projectId: Uuid, versionId: Uuid });

type VersionKind = 'manual' | 'auto' | 'restore';

interface VersionRow {
  id: string;
  project_id: string;
  user_id: string | null;
  kind: VersionKind;
  label: string;
  source_hash: string;
  main_file: string;
  engine: string;
  file_count: number;
  total_size: number;
  created_at: Date;
}

interface VersionFile {
  path: string;
  kind: FileKind;
  sha256: string;
  size: number;
}

function versionJson(v: VersionRow) {
  return {
    id: v.id,
    kind: v.kind,
    label: v.label,
    mainFile: v.main_file,
    engine: v.engine,
    fileCount: v.file_count,
    totalSize: v.total_size,
    createdAt: v.created_at,
  };
}

/**
 * Record the project exactly as it is now. File contents are stored once per
 * distinct content (`history_blobs`), so unchanged files cost nothing extra.
 */
export async function createVersion(
  q: Queryable,
  projectId: string,
  userId: string | null,
  kind: VersionKind,
  label: string,
): Promise<VersionRow> {
  const hash = await sourceFingerprint(q, projectId);
  const inserted = await q.query<VersionRow>(
    `INSERT INTO versions (project_id, user_id, kind, label, source_hash, main_file, engine, file_count, total_size)
     SELECT p.id, $2, $3, $4, $5, p.main_file, p.engine,
            (SELECT count(*) FROM project_files f WHERE f.project_id = p.id AND f.kind <> 'folder'),
            (SELECT COALESCE(sum(size), 0) FROM project_files f WHERE f.project_id = p.id)
       FROM projects p WHERE p.id = $1
     RETURNING *`,
    [projectId, userId, kind, label.trim().slice(0, 200), hash],
  );
  const version = inserted.rows[0]!;
  await q.query(
    `INSERT INTO history_blobs (project_id, sha256, kind, content, data, size)
     SELECT project_id, sha256, kind, content, data, size
       FROM project_files WHERE project_id = $1 AND kind <> 'folder'
     ON CONFLICT DO NOTHING`,
    [projectId],
  );
  await q.query(
    `INSERT INTO version_files (version_id, path, kind, sha256, size)
     SELECT $2, path, kind, sha256, size FROM project_files WHERE project_id = $1`,
    [projectId, version.id],
  );
  return version;
}

/** Drop stored contents that no remaining version refers to. */
async function collectGarbage(q: Queryable, projectId: string): Promise<void> {
  await q.query(
    `DELETE FROM history_blobs b
      WHERE b.project_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM version_files vf JOIN versions v ON v.id = vf.version_id
           WHERE v.project_id = $1 AND vf.sha256 = b.sha256 AND vf.kind = b.kind)`,
    [projectId],
  );
}

async function getVersion(q: Queryable, projectId: string, versionId: string): Promise<VersionRow> {
  const res = await q.query<VersionRow>('SELECT * FROM versions WHERE id = $1 AND project_id = $2', [
    versionId,
    projectId,
  ]);
  if (!res.rows[0]) throw notFound('No such version.', 'version_not_found');
  return res.rows[0];
}

async function versionFiles(q: Queryable, versionId: string): Promise<VersionFile[]> {
  const res = await q.query<VersionFile>(
    'SELECT path, kind, sha256, size FROM version_files WHERE version_id = $1 ORDER BY path COLLATE "C"',
    [versionId],
  );
  return res.rows;
}

async function currentFiles(q: Queryable, projectId: string): Promise<VersionFile[]> {
  const res = await q.query<VersionFile>(
    'SELECT path, kind, sha256, size FROM project_files WHERE project_id = $1 ORDER BY path COLLATE "C"',
    [projectId],
  );
  return res.rows;
}

async function blobText(
  q: Queryable,
  projectId: string,
  file: VersionFile | undefined,
): Promise<string | null> {
  if (!file || file.kind !== 'text') return null;
  const res = await q.query<{ content: string | null }>(
    `SELECT content FROM history_blobs WHERE project_id = $1 AND sha256 = $2 AND kind = 'text'`,
    [projectId, file.sha256],
  );
  return res.rows[0]?.content ?? '';
}

interface Change {
  path: string;
  kind: FileKind;
  status: 'added' | 'removed' | 'modified';
}

function compare(older: VersionFile[], newer: VersionFile[]): Change[] {
  const a = new Map(older.filter((f) => f.kind !== 'folder').map((f) => [f.path, f]));
  const b = new Map(newer.filter((f) => f.kind !== 'folder').map((f) => [f.path, f]));
  const changes: Change[] = [];
  for (const [path, file] of a) {
    const other = b.get(path);
    if (!other) changes.push({ path, kind: file.kind, status: 'removed' });
    else if (other.sha256 !== file.sha256 || other.kind !== file.kind) {
      changes.push({ path, kind: other.kind, status: 'modified' });
    }
  }
  for (const [path, file] of b) {
    if (!a.has(path)) changes.push({ path, kind: file.kind, status: 'added' });
  }
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

export const historyModule: OpenLeafModule = {
  name: 'history',
  description: 'Named and automatic versions of a project, with diffs and restore.',
  dependsOn: ['projects'],
  migrations: [
    {
      id: '001_init',
      sql: `
        CREATE TABLE versions (
          id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
          kind         text NOT NULL CHECK (kind IN ('manual', 'auto', 'restore')),
          label        text NOT NULL DEFAULT '',
          source_hash  text NOT NULL,
          main_file    text NOT NULL,
          engine       text NOT NULL,
          file_count   integer NOT NULL DEFAULT 0,
          total_size   bigint NOT NULL DEFAULT 0,
          created_at   timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX versions_project_idx ON versions (project_id, created_at DESC);

        CREATE TABLE version_files (
          version_id  uuid NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
          path        text NOT NULL,
          kind        text NOT NULL CHECK (kind IN ('text', 'binary', 'folder')),
          sha256      text NOT NULL DEFAULT '',
          size        integer NOT NULL DEFAULT 0,
          PRIMARY KEY (version_id, path)
        );

        CREATE TABLE history_blobs (
          project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          sha256      text NOT NULL,
          kind        text NOT NULL CHECK (kind IN ('text', 'binary')),
          content     text,
          data        bytea,
          size        integer NOT NULL DEFAULT 0,
          PRIMARY KEY (project_id, sha256, kind)
        );
      `,
    },
  ],

  register(root, { db, config, events }) {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const auth = { onRequest: [root.authenticate] };

    // Automatic versions: after a successful compile, if the files changed and
    // the last automatic version is old enough.
    events.on('project.compiled', async ({ projectId, userId, status }) => {
      if (status !== 'success') return;
      await db.tx(async (q) => {
        const exists = await q.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
        if (!exists.rowCount) return;
        const hash = await sourceFingerprint(q, projectId);
        const last = await q.query<{ source_hash: string }>(
          'SELECT source_hash FROM versions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
          [projectId],
        );
        if (last.rows[0]?.source_hash === hash) return;
        const recent = await q.query(
          `SELECT 1 FROM versions
            WHERE project_id = $1 AND kind = 'auto'
              AND created_at > now() - make_interval(mins => $2) LIMIT 1`,
          [projectId, config.history.autoIntervalMinutes],
        );
        if (recent.rowCount) return;
        await createVersion(q, projectId, userId, 'auto', '');
        const pruned = await q.query(
          `DELETE FROM versions
            WHERE project_id = $1 AND kind = 'auto'
              AND id NOT IN (SELECT id FROM versions WHERE project_id = $1 AND kind = 'auto'
                              ORDER BY created_at DESC LIMIT $2)`,
          [projectId, config.history.autoKeep],
        );
        if (pruned.rowCount) await collectGarbage(q, projectId);
      });
    });

    app.get(
      '/api/projects/:projectId/versions',
      {
        ...auth,
        schema: { tags: [TAG], summary: 'List saved versions, newest first', security: secured, params: ProjectParams },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const res = await db.query<VersionRow>(
          'SELECT * FROM versions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 500',
          [project.id],
        );
        return { versions: res.rows.map(versionJson) };
      },
    );

    app.post(
      '/api/projects/:projectId/versions',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Save the current state as a version',
          security: secured,
          params: ProjectParams,
          body: Type.Optional(Type.Object({ label: Type.Optional(Type.String({ maxLength: 200 })) })),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const version = await db.tx(async (q) => {
          const project = await getProject(q, req.params.projectId, user.id);
          return createVersion(q, project.id, user.id, 'manual', req.body?.label ?? '');
        });
        reply.code(201);
        return { version: versionJson(version) };
      },
    );

    app.get(
      '/api/projects/:projectId/versions/:versionId',
      {
        ...auth,
        schema: { tags: [TAG], summary: 'A version and the files it contains', security: secured, params: VersionParams },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const version = await getVersion(db, project.id, req.params.versionId);
        return { version: versionJson(version), files: await versionFiles(db, version.id) };
      },
    );

    app.patch(
      '/api/projects/:projectId/versions/:versionId',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Label a version (labelled versions are never pruned automatically)',
          security: secured,
          params: VersionParams,
          body: Type.Object({ label: Type.String({ maxLength: 200 }) }),
        },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        await getVersion(db, project.id, req.params.versionId);
        const label = req.body.label.trim();
        // Naming an automatic version promotes it, so pruning leaves it alone.
        const res = await db.query<VersionRow>(
          `UPDATE versions
              SET label = $2, kind = CASE WHEN kind = 'auto' AND $2 <> '' THEN 'manual' ELSE kind END
            WHERE id = $1 RETURNING *`,
          [req.params.versionId, label],
        );
        return { version: versionJson(res.rows[0]!) };
      },
    );

    app.delete(
      '/api/projects/:projectId/versions/:versionId',
      {
        ...auth,
        schema: { tags: [TAG], summary: 'Delete a version', security: secured, params: VersionParams },
      },
      async (req, reply) => {
        const user = currentUser(req);
        await db.tx(async (q) => {
          const project = await getProject(q, req.params.projectId, user.id);
          await getVersion(q, project.id, req.params.versionId);
          await q.query('DELETE FROM versions WHERE id = $1', [req.params.versionId]);
          await collectGarbage(q, project.id);
        });
        reply.code(204);
      },
    );

    app.get(
      '/api/projects/:projectId/versions/:versionId/file',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'A file as it was in a version',
          description: 'Text files are returned as JSON; binary files (or `raw=true`) as raw bytes.',
          security: secured,
          params: VersionParams,
          querystring: Type.Object({ path: Type.String(), raw: Type.Optional(Type.Boolean()) }),
        },
      },
      async (req, reply) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const version = await getVersion(db, project.id, req.params.versionId);
        const path = normalizePath(req.query.path);
        const res = await db.query<VersionFile & { content: string | null; data: Buffer | null }>(
          `SELECT vf.path, vf.kind, vf.sha256, vf.size, b.content, b.data
             FROM version_files vf
             LEFT JOIN history_blobs b ON b.project_id = $1 AND b.sha256 = vf.sha256 AND b.kind = vf.kind
            WHERE vf.version_id = $2 AND vf.path = $3`,
          [project.id, version.id, path],
        );
        const file = res.rows[0];
        if (!file || file.kind === 'folder') throw notFound(`No file at "${path}" in that version.`, 'file_not_found');
        if (file.kind === 'text' && !req.query.raw) {
          return { file: { path: file.path, kind: file.kind, size: file.size, sha256: file.sha256, content: file.content ?? '' } };
        }
        return sendFile(reply, {
          filename: basename(file.path),
          contentType: mimeFor(file.path, file.kind === 'text'),
          body: file.kind === 'text' ? Buffer.from(file.content ?? '', 'utf8') : (file.data ?? Buffer.alloc(0)),
          etag: file.sha256,
        });
      },
    );

    app.get(
      '/api/projects/:projectId/versions/:versionId/diff',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'What changed between a version and now (or another version)',
          description:
            'Without `path`: the list of added, removed and modified files going from this version to `against` ' +
            '(default `current`). With `path`: a unified diff of that one text file, plus both contents.',
          security: secured,
          params: VersionParams,
          querystring: Type.Object({
            against: Type.Optional(Type.String({ description: '"current" (default) or another version id' })),
            path: Type.Optional(Type.String()),
          }),
        },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const version = await getVersion(db, project.id, req.params.versionId);
        const against = req.query.against ?? 'current';
        const older = await versionFiles(db, version.id);

        let newer: VersionFile[];
        let readNewer: (file: VersionFile | undefined) => Promise<string | null>;
        if (against === 'current') {
          newer = await currentFiles(db, project.id);
          readNewer = async (file) => {
            if (!file || file.kind !== 'text') return null;
            const res = await db.query<{ content: string | null }>(
              'SELECT content FROM project_files WHERE project_id = $1 AND path = $2',
              [project.id, file.path],
            );
            return res.rows[0]?.content ?? '';
          };
        } else {
          if (!/^[0-9a-f-]{36}$/i.test(against)) throw badRequest('"against" must be "current" or a version id.');
          const other = await getVersion(db, project.id, against);
          newer = await versionFiles(db, other.id);
          readNewer = (file) => blobText(db, project.id, file);
        }

        if (req.query.path === undefined) {
          return { from: version.id, to: against, changes: compare(older, newer) };
        }

        const path = normalizePath(req.query.path);
        const before = older.find((f) => f.path === path && f.kind !== 'folder');
        const after = newer.find((f) => f.path === path && f.kind !== 'folder');
        if (!before && !after) throw notFound(`"${path}" exists in neither side of the comparison.`, 'file_not_found');
        const status = !before ? 'added' : !after ? 'removed' : before.sha256 === after.sha256 ? 'unchanged' : 'modified';
        const binary = before?.kind === 'binary' || after?.kind === 'binary';
        if (binary) return { path, status, binary: true, patch: null, before: null, after: null };

        const [oldText, newText] = await Promise.all([blobText(db, project.id, before), readNewer(after)]);
        return {
          path,
          status,
          binary: false,
          patch: createTwoFilesPatch(`a/${path}`, `b/${path}`, oldText ?? '', newText ?? '', undefined, undefined, {
            context: 3,
          }),
          before: oldText,
          after: newText,
        };
      },
    );

    app.post(
      '/api/projects/:projectId/versions/:versionId/restore',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Put the project back to how it was in a version',
          description: 'The current state is saved as a version first, so a restore can always be undone.',
          security: secured,
          params: VersionParams,
        },
      },
      async (req) => {
        const user = currentUser(req);
        const result = await db.tx(async (q) => {
          const project = await getProject(q, req.params.projectId, user.id);
          const version = await getVersion(q, project.id, req.params.versionId);

          // Safety net: keep what is about to be replaced (unless it is already saved).
          const hash = await sourceFingerprint(q, project.id);
          const saved = await q.query('SELECT 1 FROM versions WHERE project_id = $1 AND source_hash = $2 LIMIT 1', [
            project.id,
            hash,
          ]);
          let backup: VersionRow | null = null;
          if (!saved.rowCount) {
            backup = await createVersion(q, project.id, user.id, 'restore', 'Before restoring an earlier version');
          }

          await q.query(
            `DELETE FROM project_files pf
              WHERE pf.project_id = $1
                AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.version_id = $2 AND vf.path = pf.path)`,
            [project.id, version.id],
          );
          // Unchanged files are left alone; changed ones get a higher version number so
          // an editor holding the old copy is told about the change when it next saves.
          await q.query(
            `INSERT INTO project_files (project_id, path, kind, content, data, size, sha256)
             SELECT $1, vf.path, vf.kind, b.content, b.data, vf.size, vf.sha256
               FROM version_files vf
               LEFT JOIN history_blobs b ON b.project_id = $1 AND b.sha256 = vf.sha256 AND b.kind = vf.kind
              WHERE vf.version_id = $2
             ON CONFLICT (project_id, path) DO UPDATE
               SET kind = EXCLUDED.kind, content = EXCLUDED.content, data = EXCLUDED.data,
                   size = EXCLUDED.size, sha256 = EXCLUDED.sha256,
                   version = project_files.version + 1, updated_at = now()
             WHERE project_files.sha256 IS DISTINCT FROM EXCLUDED.sha256
                OR project_files.kind IS DISTINCT FROM EXCLUDED.kind`,
            [project.id, version.id],
          );
          await q.query(
            `UPDATE projects SET main_file = $2, engine = $3
              WHERE id = $1 AND EXISTS (
                SELECT 1 FROM project_files WHERE project_id = $1 AND path = $2 AND kind = 'text')`,
            [project.id, version.main_file, version.engine],
          );
          await touchProject(q, project.id);
          return { restored: version, backup };
        });
        events.emit('project.files-changed', { projectId: req.params.projectId, userId: user.id });
        return {
          restored: versionJson(result.restored),
          backup: result.backup ? versionJson(result.backup) : null,
        };
      },
    );

    app.get(
      '/api/projects/:projectId/versions/:versionId/export.zip',
      {
        ...auth,
        schema: { tags: [TAG], summary: 'Download a version as a zip archive', security: secured, params: VersionParams },
      },
      async (req, reply) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const version = await getVersion(db, project.id, req.params.versionId);
        const res = await db.query<{ path: string; kind: FileKind; content: string | null; data: Buffer | null }>(
          `SELECT vf.path, vf.kind, b.content, b.data
             FROM version_files vf
             LEFT JOIN history_blobs b ON b.project_id = $1 AND b.sha256 = vf.sha256 AND b.kind = vf.kind
            WHERE vf.version_id = $2 ORDER BY vf.path COLLATE "C"`,
          [project.id, version.id],
        );
        const stamp = version.created_at.toISOString().slice(0, 16).replace(/[:T]/g, '-');
        return sendFile(reply, {
          filename: `${slugify(project.name)}-${stamp}.zip`,
          contentType: 'application/zip',
          body: buildZip(res.rows),
          download: true,
        });
      },
    );
  },
};
