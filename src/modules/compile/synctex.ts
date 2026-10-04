import path from 'node:path';
import { run } from './runner.js';

export interface PdfPosition {
  page: number;
  /** Position and size of the matching box, in PDF points from the top-left of the page. */
  h: number;
  v: number;
  width: number;
  height: number;
}

export interface SourcePosition {
  /** Project-relative file path. */
  file: string;
  line: number;
  column: number;
}

function records(output: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let inside = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('SyncTeX result begin')) {
      inside = true;
      continue;
    }
    if (line.startsWith('SyncTeX result end')) break;
    if (!inside) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i);
    const value = line.slice(i + 1);
    if (key === 'Output') {
      current = {};
      out.push(current);
      continue;
    }
    if (current) current[key] = value;
  }
  return out;
}

async function synctex(args: string[], cwd: string): Promise<string> {
  const res = await run('synctex', args, {
    cwd,
    env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' },
    timeoutMs: 15_000,
    maxOutputBytes: 512 * 1024,
  });
  if (res.spawnError) throw new Error(`synctex is not available: ${res.spawnError}`);
  return res.output;
}

/**
 * Source -> PDF ("where on the page is line 42 of intro.tex?").
 * `dir` holds `<jobName>.synctex.gz`; `srcDir` is the directory the document was compiled in.
 */
export async function forwardSearch(
  dir: string,
  srcDir: string,
  jobName: string,
  file: string,
  line: number,
  column = 0,
): Promise<PdfPosition[]> {
  const out = await synctex(
    ['view', '-i', `${line}:${column}:${path.join(srcDir, file)}`, '-o', path.join(dir, `${jobName}.pdf`)],
    dir,
  );
  const seen = new Set<string>();
  const positions: PdfPosition[] = [];
  for (const r of records(out)) {
    const pos = {
      page: Number(r.Page),
      h: Number(r.h),
      v: Number(r.v) - Number(r.H),
      width: Number(r.W),
      height: Number(r.H),
    };
    if (!Number.isFinite(pos.page) || !Number.isFinite(pos.h) || !Number.isFinite(pos.v)) continue;
    const key = `${pos.page}:${pos.h.toFixed(1)}:${pos.v.toFixed(1)}:${pos.width.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    positions.push(pos);
  }
  return positions;
}

/** PDF -> source ("which line produced the text at this point on page 3?"). */
export async function inverseSearch(
  dir: string,
  srcDir: string,
  jobName: string,
  page: number,
  h: number,
  v: number,
): Promise<SourcePosition | null> {
  const out = await synctex(['edit', '-o', `${page}:${h}:${v}:${path.join(dir, `${jobName}.pdf`)}`], dir);
  const first = records(out)[0];
  if (!first?.Input || !first.Line) return null;
  const normalized = path.normalize(first.Input);
  const base = path.normalize(srcDir);
  if (!normalized.startsWith(base + path.sep)) return null; // a system file, not part of the project
  return {
    file: normalized.slice(base.length + 1).split(path.sep).join('/'),
    line: Number(first.Line),
    column: Math.max(0, Number(first.Column)),
  };
}
