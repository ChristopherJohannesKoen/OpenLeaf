import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Keep at most this many bytes of combined stdout/stderr (the tail). */
  maxOutputBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
  /** Set when the program could not be started at all. */
  spawnError?: string;
}

/**
 * Run a program with a hard time limit. The child gets its own process group
 * so that on timeout the whole tree (latexmk -> pdflatex -> bibtex…) is killed.
 */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const max = opts.maxOutputBytes ?? 256 * 1024;

  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const collect = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size > max * 2) {
        const joined = Buffer.concat(chunks);
        chunks = [joined.subarray(joined.byteLength - max)];
        size = max;
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);

    const finish = (result: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const joined = Buffer.concat(chunks);
      resolve({
        exitCode: null,
        signal: null,
        timedOut,
        output: joined.subarray(Math.max(0, joined.byteLength - max)).toString('utf8'),
        durationMs: Date.now() - started,
        ...result,
      });
    };

    child.on('error', (err) => finish({ spawnError: err.message }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
  });
}

/** Find an executable on PATH (like `which`). */
export async function findBinary(name: string, envPath = process.env.PATH ?? ''): Promise<string | null> {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
