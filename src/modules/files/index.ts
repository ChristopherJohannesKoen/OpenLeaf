import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { OpenLeafModule } from '../../core/modules.js';
import { badRequest } from '../../core/errors.js';
import { currentUser, ProjectParams, secured, sendFile } from '../../core/http.js';
import { basename, looksLikeText, mimeFor, normalizePath } from '../../core/paths.js';
import { slugify } from '../../core/util.js';
import {
  createFolder,
  deletePath,
  fileJson,
  getProject,
  guessMainFile,
  insertEntries,
  insertProject,
  listFiles,
  movePath,
  projectJson,
  readAllFiles,
  readFile,
  writeFile,
  type FileMeta,
  type ProjectRow,
} from '../projects/store.js';
import { zipSync, type Zippable } from 'fflate';
import { buildZip, readZip, zipEntries } from './zip.js';

const TAG = 'Files';
const PathQuery = Type.Object({ path: Type.String({ description: 'Path inside the project, e.g. chapters/intro.tex' }) });

interface TreeNode {
  name: string;
  path: string;
  kind: string;
  size?: number;
  version?: number;
  updatedAt?: Date;
  children?: TreeNode[];
}

function buildTree(files: FileMeta[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] };
  const folders = new Map<string, TreeNode>([['', root]]);
  const folderFor = (path: string): TreeNode => {
    const found = folders.get(path);
    if (found) return found;
    const i = path.lastIndexOf('/');
    const parent = folderFor(i === -1 ? '' : path.slice(0, i));
    const node: TreeNode = { name: basename(path), path, kind: 'folder', children: [] };
    parent.children!.push(node);
    folders.set(path, node);
    return node;
  };
  for (const f of files) {
    if (f.kind === 'folder') {
      folderFor(f.path);
      continue;
    }
    const i = f.path.lastIndexOf('/');
    folderFor(i === -1 ? '' : f.path.slice(0, i)).children!.push({
      name: basename(f.path),
      path: f.path,
      kind: f.kind,
      size: f.size,
      version: f.version,
      updatedAt: f.updated_at,
    });
  }
  const sort = (node: TreeNode) => {
    node.children?.sort(
      (a, b) =>
        Number(b.kind === 'folder') - Number(a.kind === 'folder') ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
    node.children?.forEach(sort);
  };
  sort(root);
  return root.children!;
}

export const filesModule: OpenLeafModule = {
  name: 'files',
  description: 'Read, edit, upload, move and delete project files; zip import and export.',
  dependsOn: ['projects'],

  register(root, { db, config, events }) {
    const app = root.withTypeProvider<TypeBoxTypeProvider>();
    const auth = { onRequest: [root.authenticate] };
    const limits = config;

    app.get(
      '/api/projects/:projectId/files',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'List the files in a project',
          security: secured,
          params: ProjectParams,
          querystring: Type.Object({
            tree: Type.Optional(Type.Boolean({ description: 'Also return the files as a nested tree' })),
          }),
        },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const files = await listFiles(db, project.id);
        return {
          mainFile: project.main_file,
          files: files.map(fileJson),
          ...(req.query.tree ? { tree: buildTree(files) } : {}),
        };
      },
    );

    app.get(
      '/api/projects/:projectId/files/content',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Read a text file (JSON, with its version number)',
          security: secured,
          params: ProjectParams,
          querystring: PathQuery,
        },
      },
      async (req) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const file = await readFile(db, project.id, normalizePath(req.query.path));
        if (file.kind !== 'text') {
          throw badRequest(
            `"${file.path}" is a ${file.kind === 'folder' ? 'folder' : 'binary file'}; use /files/raw to download binary files.`,
            'not_text',
          );
        }
        return { file: { ...fileJson(file), content: file.content ?? '' } };
      },
    );

    app.get(
      '/api/projects/:projectId/files/raw',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Download a file as raw bytes (images, PDFs, or text)',
          security: secured,
          params: ProjectParams,
          querystring: Type.Intersect([PathQuery, Type.Object({ download: Type.Optional(Type.Boolean()) })]),
        },
      },
      async (req, reply) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const file = await readFile(db, project.id, normalizePath(req.query.path));
        if (file.kind === 'folder') throw badRequest(`"${file.path}" is a folder.`, 'not_a_file');
        const body = file.kind === 'text' ? Buffer.from(file.content ?? '', 'utf8') : (file.data ?? Buffer.alloc(0));
        if (req.headers['if-none-match'] === `"${file.sha256}"`) return reply.code(304).send();
        return sendFile(reply, {
          filename: basename(file.path),
          contentType: mimeFor(file.path, file.kind === 'text'),
          body,
          download: req.query.download,
          etag: file.sha256,
        });
      },
    );

    app.put(
      '/api/projects/:projectId/files/content',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Create or save a text file',
          description:
            'Send `baseVersion` (the version you loaded) to be told with a 409 if the file changed in the meantime.',
          security: secured,
          params: ProjectParams,
          body: Type.Object({
            path: Type.String(),
            content: Type.String(),
            baseVersion: Type.Optional(Type.Integer({ minimum: 1 })),
            createOnly: Type.Optional(Type.Boolean()),
          }),
        },
      },
      async (req) => {
        const user = currentUser(req);
        const file = await db.tx(async (q) => {
          const project = await getProject(q, req.params.projectId, user.id);
          return writeFile(q, project.id, req.body.path, { content: req.body.content }, {
            baseVersion: req.body.baseVersion,
            createOnly: req.body.createOnly,
            limits,
          });
        });
        events.emit('project.files-changed', { projectId: req.params.projectId, userId: user.id });
        return { file: fileJson(file) };
      },
    );

    app.post(
      '/api/projects/:projectId/files/upload',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Upload one or more files (multipart/form-data)',
          description:
            'Send files as multipart parts. Optional text fields, sent *before* the files: `folder` (target folder) and `overwrite` (`false` to refuse replacing existing files).',
          security: secured,
          consumes: ['multipart/form-data'],
          params: ProjectParams,
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const project = await getProject(db, req.params.projectId, user.id);
        if (!req.isMultipart()) throw badRequest('Send the files as multipart/form-data.', 'not_multipart');

        let folder = '';
        let overwrite = true;
        const uploads: { path: string; data: Buffer }[] = [];
        for await (const part of req.parts()) {
          if (part.type === 'field') {
            if (part.fieldname === 'folder' && typeof part.value === 'string' && part.value.trim()) {
              folder = normalizePath(part.value, 'folder');
            }
            if (part.fieldname === 'overwrite') overwrite = String(part.value) !== 'false';
            continue;
          }
          const data = await part.toBuffer();
          const name = normalizePath(part.filename || part.fieldname, 'file name');
          uploads.push({ path: folder ? `${folder}/${name}` : name, data });
        }
        if (!uploads.length) throw badRequest('No files were included in the upload.', 'no_files');

        const saved = await db.tx(async (q) => {
          const out: FileMeta[] = [];
          for (const upload of uploads) {
            const body = looksLikeText(upload.path, upload.data, limits.maxTextFileBytes)
              ? { content: upload.data.toString('utf8') }
              : { data: upload.data };
            out.push(await writeFile(q, project.id, upload.path, body, { createOnly: !overwrite, limits }));
          }
          return out;
        });
        events.emit('project.files-changed', { projectId: project.id, userId: user.id });
        reply.code(201);
        return { files: saved.map(fileJson) };
      },
    );

    app.post(
      '/api/projects/:projectId/files/folder',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Create a folder',
          security: secured,
          params: ProjectParams,
          body: Type.Object({ path: Type.String() }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const path = await db.tx(async (q) => {
          const project = await getProject(q, req.params.projectId, user.id);
          return createFolder(q, project.id, req.body.path);
        });
        reply.code(201);
        return { path };
      },
    );

    app.post(
      '/api/projects/:projectId/files/move',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Rename or move a file or folder',
          security: secured,
          params: ProjectParams,
          body: Type.Object({ from: Type.String(), to: Type.String() }),
        },
      },
      async (req) => {
        const user = currentUser(req);
        const result = await db.tx(async (q) => {
          const project = await getProject(q, req.params.projectId, user.id);
          return movePath(q, project.id, req.body.from, req.body.to);
        });
        events.emit('project.files-changed', { projectId: req.params.projectId, userId: user.id });
        return result;
      },
    );

    app.delete(
      '/api/projects/:projectId/files',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Delete a file, or a folder and everything inside it',
          security: secured,
          params: ProjectParams,
          querystring: PathQuery,
        },
      },
      async (req) => {
        const user = currentUser(req);
        const deleted = await db.tx(async (q) => {
          const project = await getProject(q, req.params.projectId, user.id);
          return deletePath(q, project.id, req.query.path);
        });
        events.emit('project.files-changed', { projectId: req.params.projectId, userId: user.id });
        return { deleted };
      },
    );

    app.get(
      '/api/projects/:projectId/export.zip',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Download the whole project as a zip archive',
          security: secured,
          params: ProjectParams,
        },
      },
      async (req, reply) => {
        const project = await getProject(db, req.params.projectId, currentUser(req).id);
        const files = await readAllFiles(db, project.id);
        return sendFile(reply, {
          filename: `${slugify(project.name)}.zip`,
          contentType: 'application/zip',
          body: buildZip(files),
          download: true,
        });
      },
    );

    app.get(
      '/api/export/projects.zip',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Back up all of your projects as one zip archive',
          description:
            'One folder per project, plus `openleaf-projects.json` describing them (name, main file, engine, tags). ' +
            'Each folder can be re-imported with `POST /api/projects/import`. Trashed projects are left out unless `includeTrashed=true`.',
          security: secured,
          querystring: Type.Object({ includeTrashed: Type.Optional(Type.Boolean()) }),
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        const projects = await db.query<ProjectRow>(
          `SELECT * FROM projects WHERE owner_id = $1 ${req.query.includeTrashed ? '' : 'AND trashed_at IS NULL'}
            ORDER BY created_at`,
          [user.id],
        );
        const tree: Zippable = {};
        const manifest: Record<string, unknown>[] = [];
        const used = new Set<string>();
        for (const project of projects.rows) {
          let folder = slugify(project.name);
          for (let n = 2; used.has(folder.toLowerCase()); n++) folder = `${slugify(project.name)}-${n}`;
          used.add(folder.toLowerCase());
          manifest.push({ folder, ...projectJson(project) });
          tree[`${folder}/`] = new Uint8Array(0);
          Object.assign(tree, zipEntries(await readAllFiles(db, project.id), folder));
        }
        tree['openleaf-projects.json'] = Buffer.from(
          JSON.stringify({ exportedAt: new Date().toISOString(), projects: manifest }, null, 2),
          'utf8',
        );
        return sendFile(reply, {
          filename: `openleaf-backup-${new Date().toISOString().slice(0, 10)}.zip`,
          contentType: 'application/zip',
          body: Buffer.from(zipSync(tree)),
          download: true,
        });
      },
    );

    app.post(
      '/api/projects/import',
      {
        ...auth,
        schema: {
          tags: [TAG],
          summary: 'Create a project from a zip archive (multipart/form-data)',
          description:
            'Send the archive as a file part. Optional text fields, sent *before* the file: `name`, `engine`. The main document is detected automatically.',
          security: secured,
          consumes: ['multipart/form-data'],
        },
      },
      async (req, reply) => {
        const user = currentUser(req);
        if (!req.isMultipart()) throw badRequest('Send the archive as multipart/form-data.', 'not_multipart');

        let name: string | null = null;
        let engine: string | null = null;
        let archive: Buffer | null = null;
        let archiveName = 'Imported project';
        for await (const part of req.parts()) {
          if (part.type === 'field') {
            if (part.fieldname === 'name' && typeof part.value === 'string') name = part.value;
            if (part.fieldname === 'engine' && typeof part.value === 'string') engine = part.value;
            continue;
          }
          if (!archive) {
            archive = await part.toBuffer();
            archiveName = (part.filename || archiveName).replace(/\.zip$/i, '');
          } else {
            await part.toBuffer(); // drain extra parts
          }
        }
        if (!archive) throw badRequest('No zip archive was included.', 'no_files');
        if (engine && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(engine)) {
          throw badRequest('That engine name is not valid.', 'invalid_engine');
        }

        const { entries, skipped } = readZip(archive, limits);
        if (!entries.some((e) => e.kind !== 'folder')) {
          throw badRequest('The archive contains no files.', 'empty_zip');
        }
        const mainFile = guessMainFile(entries.filter((e) => e.kind === 'text'));

        const project = await db.tx(async (q) => {
          const created = await insertProject(q, {
            ownerId: user.id,
            name: name?.trim() || archiveName,
            mainFile: mainFile ?? 'main.tex',
            engine: engine ?? config.compile.defaultEngine,
          });
          await insertEntries(q, created.id, entries, limits);
          return created;
        });
        events.emit('project.created', { projectId: project.id, userId: user.id });
        reply.code(201);
        return {
          project: projectJson(project),
          imported: entries.filter((e) => e.kind !== 'folder').length,
          skipped,
        };
      },
    );
  },
};
