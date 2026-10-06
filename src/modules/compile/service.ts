import { constants } from 'node:fs';
import { mkdir, open, readFile as fsReadFile, readdir, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../config.js';
import type { Db } from '../../core/db.js';
import type { EventBus } from '../../core/events.js';
import { badRequest, notFound, unavailable } from '../../core/errors.js';
import { normalizePath } from '../../core/paths.js';
import { sha256 } from '../../core/util.js';
import { sourceFingerprint, type ProjectRow } from '../projects/store.js';
import { engineStatuses, getEngine, listEngines, type Engine } from './engines.js';
import { parseBibLog, parseLatexLog, summarize, type Diagnostic } from './log-parser.js';
import { run } from './runner.js';
import {
  describeIsolation,
  detectIsolation,
  isolate,
  NO_ISOLATION,
  noNetwork,
  serviceGuarded,
  type Isolation,
} from './sandbox.js';
import { removeWorkspace, syncWorkspace, workspaceFor, type Workspace } from './workspace.js';

export type CompileStatus = 'queued' | 'running' | 'success' | 'failure' | 'timeout' | 'error';

export interface CompileRow {
  id: string;
  project_id: string;
  user_id: string | null;
  status: CompileStatus;
  engine: string;
  main_file: string;
  job_name: string;
  options: Record<string, unknown>;
  source_hash: string;
  diagnostics: Diagnostic[];
  error_count: number;
  warning_count: number;
  message: string | null;
  pdf_size: number | null;
  has_synctex: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
}

/** Everything except the large columns (log, pdf, synctex). */
export const COMPILE_COLUMNS = `id, project_id, user_id, status, engine, main_file, job_name, options, source_hash,
  diagnostics, error_count, warning_count, message, pdf_size, (synctex IS NOT NULL) AS has_synctex,
  created_at, started_at, finished_at, duration_ms`;

export interface CompileOptions {
  engine?: string;
  mainFile?: string;
  stopOnFirstError?: boolean;
  /** Throw away cached auxiliary files and build from scratch. */
  clean?: boolean;
  /** Compile even if nothing changed since the last successful compile. */
  force?: boolean;
}

export interface CompileTicket {
  compileId: string;
  /** True when an identical earlier compile was reused instead of running LaTeX again. */
  cached: boolean;
  /** Resolves when the compile has finished (never rejects). */
  done: Promise<void>;
}

class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

const SAFE_JOBNAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function jobNameFor(mainFile: string): string {
  const base = mainFile.split('/').pop()!.replace(/\.[^.]+$/, '');
  return SAFE_JOBNAME.test(base) ? base : 'output';
}

function clip(text: string, max = MAX_LOG_BYTES): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[… log truncated …]\n\n${text.slice(-half)}`;
}

/**
 * Read a file the compile left behind. The compile wrote this folder, so nothing in it is
 * taken on trust: only a plain file is read, and a link is never followed (a link could
 * point at a file that the service can read and the compile could not).
 */
export async function readIfFresh(file: string, since: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.mtimeMs < since) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The lines that say why a run failed: TeX's own complaints from its log (or, failing that,
 * from what the tools printed), not latexmk's closing advice.
 */
async function whatWentWrong(dir: string, jobName: string, output: string): Promise<string> {
  const log = (await readIfFresh(path.join(dir, `${jobName}.log`), 0))?.toString('utf8') ?? '';
  const telling = /^!|error|fatal|cannot|can't|could not|unable|denied|not found|not loadable|unrecognized|no such|failed/i;
  const pick = (text: string) => {
    const all = text.split('\n').map((line) => line.trimEnd());
    const kept: string[] = [];
    all.forEach((line, i) => {
      if (!line || !telling.test(line) || /^Latexmk:|rerun latexmk|force complete|error summary/.test(line)) return;
      kept.push(line);
      // What follows "Error message:" is the message.
      if (/error message:?\s*$/i.test(line)) kept.push(...all.slice(i + 1, i + 5).filter(Boolean));
    });
    return kept;
  };
  const lines = [...new Set([...pick(log), ...pick(output)])].slice(0, 14);
  const said = lines.length ? lines : output.trim().split('\n').slice(-8);
  return said.join(' | ').slice(0, 1600);
}

export interface SelfTestResult {
  ok: boolean;
  engine: string;
  durationMs: number;
  pdfBytes: number;
  message: string;
  at: string;
}

export class CompileService {
  private readonly slots: Semaphore;
  private readonly projectLocks = new KeyedMutex();
  private readonly inflight = new Map<string, { key: string; compileId: string; promise: Promise<void> }>();
  selfTests: SelfTestResult[] = [];
  /** How compiles are kept apart from the service on this host; set by `prepareIsolation`. */
  isolation: Isolation = NO_ISOLATION;
  /** Whether the service's own memory is closed to the programs it starts (see `serviceGuarded`). */
  guarded = false;
  /** Engines that have compiled the test document under the isolation now in force. */
  private readonly verified = new Set<string>();
  private readonly selfTestLock = new KeyedMutex();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly events: EventBus,
    private readonly log: { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void },
  ) {
    this.slots = new Semaphore(config.compile.concurrency);
  }

  workspace(projectId: string): Workspace {
    return workspaceFor(this.config.compile.dir, projectId);
  }

  /** Find out what isolation this host allows. Called once, before the first compile. */
  async prepareIsolation(): Promise<Isolation> {
    // Programs a compile starts by name; where they live has to be readable to it.
    const binaries = [
      ...new Set(['latexmk', 'perl', 'kpsewhich', 'bibtex', 'biber', 'makeindex', 'gs', ...listEngines().flatMap((e) => e.binaries)]),
    ];
    this.isolation = await detectIsolation(this.config.compile.isolation, {
      env: await this.texEnv(),
      binaries,
      launcher: this.config.compile.sandbox ?? undefined,
      extraReadPaths: this.config.compile.readPaths,
      skip: this.config.compile.isolationSkip,
    });
    this.guarded = await serviceGuarded();
    this.verified.clear();
    return this.isolation;
  }

  describeIsolation(): string {
    return describeIsolation(this.isolation, this.guarded);
  }

  /** The folders every compile shares: a home, TeX's caches, temporary files. */
  private texDirs(): { home: string; texmfVar: string; tmp: string } {
    const base = this.config.compile.dir;
    return { home: path.join(base, 'home'), texmfVar: path.join(base, 'texmf-var'), tmp: path.join(base, 'tmp') };
  }

  /** Wrap a command for a run in `cwd`: the only folders it may write are that one and the shared three. */
  private wrap(cmd: string, args: string[], cwd: string, iso: Isolation = this.isolation) {
    const { home, texmfVar, tmp } = this.texDirs();
    return isolate(cmd, args, iso, {
      memoryMb: this.config.compile.memoryMb,
      maxFileMb: this.config.compile.maxFileMb,
      writable: [cwd, home, texmfVar, tmp],
    });
  }

  /** A deliberately small environment: the child never sees DATABASE_URL or other secrets. */
  private async texEnv(engine?: Engine): Promise<NodeJS.ProcessEnv> {
    return { ...(await this.baseEnv()), ...(engine?.env ?? {}) };
  }

  private async baseEnv(): Promise<NodeJS.ProcessEnv> {
    const { home, texmfVar, tmp } = this.texDirs();
    await Promise.all([home, texmfVar, tmp].map((d) => mkdir(d, { recursive: true })));
    return {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      TEXMFVAR: texmfVar,
      // Fonts made on demand go with the other caches, not into a shared /tmp.
      VARTEXFONTS: path.join(texmfVar, 'fonts'),
      TMPDIR: tmp,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: process.env.TZ ?? 'UTC',
      // Do not hard-wrap log lines at 79 columns, so they can be parsed reliably.
      max_print_line: '10000',
      error_line: '254',
      half_error_line: '238',
      // "Paranoid" file access: TeX may not read or write outside the project folder
      // via absolute paths or "..", which keeps server files (and /proc) out of reach.
      openin_any: 'p',
      openout_any: 'p',
      // f = no shell commands, p = TeX Live's restricted list, t = anything.
      shell_escape: { off: 'f', restricted: 'p', full: 't' }[this.config.compile.shellEscape],
    };
  }

  private async resolveEngine(id: string): Promise<Engine> {
    const engine = getEngine(id);
    if (!engine) {
      throw badRequest(
        `Unknown engine "${id}". Available: ${listEngines().map((e) => e.id).join(', ')}.`,
        'unknown_engine',
      );
    }
    if (this.config.compile.engines && !this.config.compile.engines.includes(id)) {
      throw badRequest(`The ${engine.label} engine is switched off on this server.`, 'engine_disabled');
    }
    const status = (await engineStatuses()).find((s) => s.id === id);
    if (!status?.available) {
      throw unavailable(
        `The ${engine.label} engine is not installed on this server (missing: ${status?.missing.join(', ')}).`,
        'engine_unavailable',
      );
    }
    return engine;
  }

  /** Queue a compile (or reuse an identical finished/running one). */
  async request(project: ProjectRow, userId: string, opts: CompileOptions = {}): Promise<CompileTicket> {
    if (this.config.compile.isolation === 'required' && !noNetwork(this.isolation)) {
      throw unavailable(
        'This server is set to compile only in isolation, and the host does not allow it.',
        'isolation_unavailable',
      );
    }
    const engine = await this.resolveEngine(opts.engine ?? project.engine);
    const mainFile = normalizePath(opts.mainFile ?? project.main_file, 'main file');
    const exists = await this.db.query<{ kind: string }>(
      'SELECT kind FROM project_files WHERE project_id = $1 AND path = $2',
      [project.id, mainFile],
    );
    if (exists.rows[0]?.kind !== 'text') {
      throw badRequest(
        `The main file "${mainFile}" does not exist in this project. Set the project's main file first.`,
        'main_file_missing',
      );
    }

    const options = { stopOnFirstError: Boolean(opts.stopOnFirstError) };
    const keyOf = (sourceHash: string) => sha256(JSON.stringify([sourceHash, engine.id, mainFile, options]));
    const key = keyOf(await sourceFingerprint(this.db, project.id));

    if (!opts.force && !opts.clean) {
      const running = this.inflight.get(project.id);
      if (running && running.key === key) {
        return { compileId: running.compileId, cached: false, done: running.promise };
      }
      const hit = await this.db.query<{ id: string }>(
        `SELECT id FROM compiles
          WHERE project_id = $1 AND source_hash = $2 AND status = 'success' AND pdf IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [project.id, key],
      );
      if (hit.rows[0]) return { compileId: hit.rows[0].id, cached: true, done: Promise.resolve() };
    }

    const jobName = jobNameFor(mainFile);
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO compiles (project_id, user_id, status, engine, main_file, job_name, options, source_hash)
       VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7) RETURNING id`,
      [project.id, userId, engine.id, mainFile, jobName, JSON.stringify(options), key],
    );
    const compileId = inserted.rows[0]!.id;

    const promise = this.execute(compileId, project.id, userId, engine, mainFile, jobName, options, Boolean(opts.clean), keyOf)
      .catch((err) => this.log.error({ err, compileId }, 'compile crashed'))
      .finally(() => {
        if (this.inflight.get(project.id)?.compileId === compileId) this.inflight.delete(project.id);
      });
    this.inflight.set(project.id, { key, compileId, promise });
    return { compileId, cached: false, done: promise };
  }

  private async execute(
    compileId: string,
    projectId: string,
    userId: string,
    engine: Engine,
    mainFile: string,
    jobName: string,
    options: { stopOnFirstError: boolean },
    clean: boolean,
    keyOf: (sourceHash: string) => string,
  ): Promise<void> {
    const releaseProject = await this.projectLocks.acquire(projectId);
    // The first compile with an engine checks that the engine works inside the file rules,
    // which differ from host to host; if it does not, the rules are dropped and it says so.
    if (this.isolation.files && !this.verified.has(engine.id)) {
      await this.runSelfTest([engine.id], { onlyUnverified: true }).catch(() => []);
    }
    const releaseSlot = await this.slots.acquire();
    const started = Date.now();
    let status: CompileStatus = 'error';
    let hasPdf = false;

    try {
      await this.db.query(`UPDATE compiles SET status = 'running', started_at = now() WHERE id = $1`, [compileId]);
      const ws = this.workspace(projectId);
      const { sourceHash } = await syncWorkspace(this.db, projectId, ws, { clean });

      // File mtimes can be coarser than Date.now(); allow a small margin.
      const since = Date.now() - 1500;
      const { cmd, args } = engine.command({
        mainFile,
        jobName,
        stopOnFirstError: options.stopOnFirstError,
        allowRc: this.config.compile.allowLatexmkrc,
      });
      const wrapped = this.wrap(cmd, args, ws.src);
      const res = await run(wrapped.cmd, wrapped.args, {
        cwd: ws.src,
        env: await this.texEnv(engine),
        timeoutMs: this.config.compile.timeoutMs,
      });

      const out = (ext: string) => path.join(ws.src, `${jobName}.${ext}`);
      const [pdf, logBuf, synctex, blg] = await Promise.all([
        readIfFresh(out('pdf'), since),
        readIfFresh(out('log'), since),
        readIfFresh(out('synctex.gz'), since),
        readIfFresh(out('blg'), since),
      ]);
      hasPdf = pdf !== null && pdf.byteLength > 0;
      const logText = logBuf ? logBuf.toString('utf8') : '';

      const diagnostics: Diagnostic[] = [
        ...(logText ? parseLatexLog(logText, { workdir: ws.src }) : []),
        ...(blg ? parseBibLog(blg.toString('utf8')) : []),
      ];

      let message: string | null = null;
      if (res.spawnError) {
        status = 'error';
        message = `The compiler could not be started: ${res.spawnError}`;
      } else if (res.timedOut) {
        status = 'timeout';
        message = `The compile was stopped after ${Math.round(this.config.compile.timeoutMs / 1000)} seconds.`;
      } else if (res.exitCode === 0 && hasPdf) {
        status = 'success';
      } else {
        status = 'failure';
        if (!diagnostics.some((d) => d.level === 'error')) {
          const tail = res.output.trim().split('\n').slice(-12).join('\n');
          diagnostics.unshift({
            level: 'error',
            message: hasPdf
              ? 'The compiler reported a problem (see the log for details).'
              : 'No PDF was produced (see the log for details).',
            file: null,
            line: null,
            source: 'latexmk',
            ...(tail ? { context: tail } : {}),
          });
        }
        message = hasPdf
          ? 'Compiled with errors; the PDF may be incomplete.'
          : 'The document could not be compiled.';
      }
      if (status === 'timeout' || status === 'error') {
        diagnostics.unshift({ level: 'error', message: message!, file: null, line: null, source: 'latexmk' });
      }

      const counts = summarize(diagnostics);
      await this.db.query(
        `UPDATE compiles
            SET status = $2, source_hash = $3, diagnostics = $4::jsonb, error_count = $5, warning_count = $6,
                message = $7, log = $8, console = $9, pdf = $10, pdf_size = $11, synctex = $12,
                finished_at = now(), duration_ms = $13
          WHERE id = $1`,
        [
          compileId,
          status,
          // Only a clean success is reusable as a cache hit.
          status === 'success' ? keyOf(sourceHash) : `!${compileId}`,
          JSON.stringify(diagnostics.slice(0, 500)),
          counts.errors,
          counts.warnings,
          message,
          clip(logText).replace(/\u0000/g, ''),
          clip(res.output, 128 * 1024).replace(/\u0000/g, ''),
          hasPdf ? pdf : null,
          hasPdf ? pdf!.byteLength : null,
          hasPdf ? synctex : null,
          Date.now() - started,
        ],
      );
      await this.prune(projectId);
    } catch (err) {
      status = 'error';
      const message = `Internal error while compiling: ${(err as Error).message}`;
      await this.db
        .query(
          `UPDATE compiles
              SET status = 'error', message = $2, source_hash = $3, finished_at = now(), duration_ms = $4,
                  error_count = 1, diagnostics = $5::jsonb
            WHERE id = $1`,
          [
            compileId,
            message,
            `!${compileId}`,
            Date.now() - started,
            JSON.stringify([{ level: 'error', message, file: null, line: null, source: 'latexmk' }]),
          ],
        )
        .catch(() => {});
      this.log.error({ err, compileId }, 'compile failed with an internal error');
    } finally {
      releaseSlot();
      releaseProject();
      this.events.emit('project.compiled', { projectId, userId, compileId, status, hasPdf });
    }
  }

  /** Keep the newest N compiles per project, plus the newest one that has a PDF. */
  private async prune(projectId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM compiles c
        WHERE c.project_id = $1
          AND c.id NOT IN (SELECT id FROM compiles WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2)
          AND c.id IS DISTINCT FROM (
                SELECT id FROM compiles WHERE project_id = $1 AND pdf IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1)`,
      [projectId, this.config.compile.keep],
    );
  }

  async get(projectId: string, compileId: string): Promise<CompileRow> {
    const res = await this.db.query<CompileRow>(
      `SELECT ${COMPILE_COLUMNS} FROM compiles WHERE id = $1 AND project_id = $2`,
      [compileId, projectId],
    );
    if (!res.rows[0]) throw notFound('No such compile.', 'compile_not_found');
    return res.rows[0];
  }

  async latest(projectId: string, opts: { withPdf?: boolean; withSynctex?: boolean } = {}): Promise<CompileRow | null> {
    const res = await this.db.query<CompileRow>(
      `SELECT ${COMPILE_COLUMNS} FROM compiles
        WHERE project_id = $1
          ${opts.withPdf ? 'AND pdf IS NOT NULL' : ''}
          ${opts.withSynctex ? 'AND synctex IS NOT NULL' : ''}
        ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    return res.rows[0] ?? null;
  }

  async list(projectId: string): Promise<CompileRow[]> {
    const res = await this.db.query<CompileRow>(
      `SELECT ${COMPILE_COLUMNS} FROM compiles WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [projectId],
    );
    return res.rows;
  }

  /**
   * Make sure the SyncTeX data of a compile is on local disk (it lives in the
   * database so that it survives restarts) and return the folder holding it.
   */
  async synctexDir(compile: CompileRow): Promise<string> {
    const ws = this.workspace(compile.project_id);
    const base = path.join(ws.root, 'synctex');
    const dir = path.join(base, compile.id);
    const file = path.join(dir, `${compile.job_name}.synctex.gz`);
    try {
      await stat(file);
      return dir;
    } catch {
      /* not on disk yet */
    }
    const res = await this.db.query<{ synctex: Buffer | null }>('SELECT synctex FROM compiles WHERE id = $1', [
      compile.id,
    ]);
    const data = res.rows[0]?.synctex;
    if (!data) throw notFound('This compile has no SyncTeX data.', 'no_synctex');
    for (const old of await readdir(base).catch(() => [] as string[])) {
      if (old !== compile.id) await rm(path.join(base, old), { recursive: true, force: true });
    }
    await mkdir(dir, { recursive: true });
    await fsWriteFile(file, data);
    return dir;
  }

  async clearCache(projectId: string): Promise<void> {
    const release = await this.projectLocks.acquire(projectId);
    try {
      await removeWorkspace(this.workspace(projectId));
    } finally {
      release();
    }
  }

  /**
   * Compile a tiny built-in document with each given engine to prove the TeX
   * installation works. Results are kept for `GET /api/system/info`.
   */
  async runSelfTest(engineIds: string[], opts: { onlyUnverified?: boolean } = {}): Promise<SelfTestResult[]> {
    const results: SelfTestResult[] = [];
    for (const engineId of engineIds) {
      // One self-test at a time: they share a folder per engine and may change the isolation.
      const releaseTest = await this.selfTestLock.acquire('selftest');
      try {
        if (opts.onlyUnverified && this.verified.has(engineId)) continue;
        results.push(await this.selfTestOne(engineId));
        this.verified.add(engineId);
      } finally {
        releaseTest();
      }
      this.selfTests = [...this.selfTests.filter((r) => r.engine !== engineId), results[results.length - 1]!];
    }
    return results;
  }

  /**
   * The isolation now in force, then the same with one layer fewer each time. A host can
   * accept a layer and still break TeX inside it; the self-test walks down this list until
   * the test document compiles. With isolation required, it stops before the network opens.
   */
  private fallbacks(): Isolation[] {
    const now = this.isolation;
    const steps: Isolation[] = [now];
    if (now.files) steps.push({ ...now, files: false, readPaths: [] });
    if (now.syscalls) steps.push({ ...now, files: false, readPaths: [], syscalls: false, launcher: null });
    steps.push(NO_ISOLATION);
    const seen = new Set<string>();
    return steps.filter((step, i) => {
      const key = JSON.stringify(step);
      if (seen.has(key)) return false;
      seen.add(key);
      return i === 0 || this.config.compile.isolation !== 'required' || noNetwork(step);
    });
  }

  private async selfTestOne(engineId: string): Promise<SelfTestResult> {
    const started = Date.now();
    const result = (ok: boolean, message: string, pdfBytes = 0): SelfTestResult => ({
      ok,
      engine: engineId,
      durationMs: Date.now() - started,
      pdfBytes,
      message,
      at: new Date().toISOString(),
    });
    try {
      const engine = await this.resolveEngine(engineId);
      const dir = path.join(this.config.compile.dir, 'selftest', engineId);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      // The Unicode engines get a document that exercises fontspec and non-ASCII text.
      const unicode = engineId === 'xelatex' || engineId === 'lualatex';
      await fsWriteFile(
        path.join(dir, 'selftest.tex'),
        [
          '\\documentclass{article}',
          unicode ? '\\usepackage{fontspec}' : '\\usepackage[utf8]{inputenc}\\usepackage[T1]{fontenc}',
          '\\usepackage{amsmath}',
          '\\begin{document}',
          'OpenLeaf self-test (café, naïve): $e^{i\\pi}+1=0$.',
          '\\end{document}',
          '',
        ].join('\n'),
      );
      const { cmd, args } = engine.command({
        mainFile: 'selftest.tex',
        jobName: 'selftest',
        stopOnFirstError: true,
        allowRc: false,
      });
      const release = await this.slots.acquire();
      let res;
      let pdf: Buffer | null;
      let why = '';
      try {
        const attempt = async (iso: Isolation) => {
          // From nothing each time: latexmk remembers a failed step and would not try it again.
          for (const left of await readdir(dir)) {
            if (left !== 'selftest.tex') await rm(path.join(dir, left), { recursive: true, force: true });
          }
          const wrapped = this.wrap(cmd, args, dir, iso);
          const r = await run(wrapped.cmd, wrapped.args, { cwd: dir, env: await this.texEnv(engine), timeoutMs: this.config.compile.timeoutMs });
          const out = await readIfFresh(path.join(dir, 'selftest.pdf'), 0);
          const ok = r.exitCode === 0 && out !== null && out.byteLength > 0;
          return { r, out, ok, why: ok ? '' : await whatWentWrong(dir, 'selftest', r.output) };
        };
        const steps = this.fallbacks();
        const first = await attempt(steps[0]!);
        let chosen = first;
        // What was tried and did not compile, most isolation first.
        const failed = first.ok ? [] : [{ inside: describeIsolation(steps[0]!, this.guarded), why: first.why }];
        for (let i = 1; !chosen.ok && i < steps.length; i++) {
          const next = await attempt(steps[i]!);
          if (!next.ok) {
            failed.push({ inside: describeIsolation(steps[i]!, this.guarded), why: next.why });
            continue;
          }
          this.log.error(
            { engine: engineId, now: describeIsolation(steps[i]!, this.guarded), failed },
            'compiles fail inside the isolation on this host; continuing with less of it',
          );
          this.isolation = steps[i]!;
          this.verified.clear();
          chosen = next;
        }
        res = chosen.r;
        pdf = chosen.out;
        why = chosen.why;
      } finally {
        release();
      }
      await rm(dir, { recursive: true, force: true });
      if (res.exitCode === 0 && pdf && pdf.byteLength > 0) {
        return result(true, 'Compiled a test document successfully.', pdf.byteLength);
      }
      return result(false, res.spawnError ?? (res.timedOut ? 'Timed out.' : `Exit code ${res.exitCode}: ${why}`));
    } catch (err) {
      return result(false, (err as Error).message);
    }
  }

  /** After a restart nothing is running any more; close out rows that say otherwise. */
  async recoverInterrupted(): Promise<number> {
    const res = await this.db.query(
      `UPDATE compiles
          SET status = 'error', message = 'The server restarted while this compile was running.',
              finished_at = now(), source_hash = '!' || id::text
        WHERE status IN ('queued', 'running')`,
    );
    return res.rowCount;
  }
}
