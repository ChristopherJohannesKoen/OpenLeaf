import { findBinary, run } from './runner.js';

export interface EngineInvocation {
  /** Path of the root document, relative to the compile directory. */
  mainFile: string;
  /** Base name of the outputs: `<jobName>.pdf`, `<jobName>.log`, `<jobName>.synctex.gz`. */
  jobName: string;
  stopOnFirstError: boolean;
  /** Whether a `latexmkrc` in the project may be honoured (it can run arbitrary code). */
  allowRc: boolean;
}

/**
 * A LaTeX engine. To add one (Tectonic, ConTeXt, a pandoc pipeline…), write an
 * object like the ones below and call `registerEngine` from a module.
 * The only contract: run in the given directory and leave `<jobName>.pdf`
 * (and ideally `<jobName>.log` / `<jobName>.synctex.gz`) behind.
 */
export interface Engine {
  id: string;
  label: string;
  description: string;
  /** Programs that must be on PATH for this engine to work. */
  binaries: string[];
  /** A command whose first output line identifies the version. */
  versionCommand?: [string, ...string[]];
  /** Settings this engine needs on top of the environment every compile gets. */
  env?: Record<string, string>;
  command(inv: EngineInvocation): { cmd: string; args: string[] };
}

function latexmkEngine(
  id: string,
  label: string,
  description: string,
  modeFlag: string,
  binary: string,
  env?: Record<string, string>,
): Engine {
  return {
    id,
    label,
    description,
    binaries: ['latexmk', binary],
    versionCommand: [binary, '--version'],
    ...(env ? { env } : {}),
    command(inv) {
      return {
        cmd: 'latexmk',
        args: [
          ...(inv.allowRc ? [] : ['-norc']),
          modeFlag,
          `-jobname=${inv.jobName}`,
          '-interaction=nonstopmode',
          '-file-line-error',
          '-synctex=1',
          // -f: keep going after errors so a PDF is still produced when possible.
          ...(inv.stopOnFirstError ? ['-halt-on-error'] : ['-f']),
          inv.mainFile,
        ],
      };
    },
  };
}

const registry = new Map<string, Engine>();

export function registerEngine(engine: Engine): void {
  registry.set(engine.id, engine);
}

export function getEngine(id: string): Engine | undefined {
  return registry.get(id);
}

export function listEngines(): Engine[] {
  return [...registry.values()];
}

registerEngine(
  latexmkEngine('pdflatex', 'pdfLaTeX', 'The classic engine; fastest and most compatible.', '-pdf', 'pdflatex'),
);
registerEngine(
  latexmkEngine('xelatex', 'XeLaTeX', 'Unicode and system/OpenType fonts via fontspec.', '-xelatex', 'xelatex'),
);
registerEngine(
  latexmkEngine('lualatex', 'LuaLaTeX', 'Unicode, OpenType fonts and Lua scripting.', '-lualatex', 'lualatex', {
    // Current LuaTeX applies `openin_any` to files that Lua code opens, and its own font loader
    // opens its data by full path (luaotfload reads the Unicode script tables that way). With
    // the paranoid setting every compile otherwise gets ("p": no absolute paths) LuaLaTeX
    // cannot load a font at all. "r" still refuses dot files. What a LuaLaTeX document can
    // read is then a matter for the file rules of the isolation (see sandbox.ts), which is
    // where a language as open as Lua has to be held in any case.
    openin_any: 'r',
  }),
);

export interface EngineStatus {
  id: string;
  label: string;
  description: string;
  available: boolean;
  missing: string[];
  version: string | null;
}

let statusCache: { at: number; value: EngineStatus[] } | null = null;

/** Which engines can actually run on this machine (cached for a minute). */
export async function engineStatuses(force = false): Promise<EngineStatus[]> {
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  const value: EngineStatus[] = [];
  for (const engine of listEngines()) {
    const missing: string[] = [];
    for (const bin of engine.binaries) {
      if (!(await findBinary(bin))) missing.push(bin);
    }
    let version: string | null = null;
    if (!missing.length && engine.versionCommand) {
      const [cmd, ...args] = engine.versionCommand;
      const res = await run(cmd, args, { cwd: '/', env: process.env, timeoutMs: 10_000, maxOutputBytes: 4096 });
      version = res.output.split('\n')[0]?.trim() || null;
    }
    value.push({
      id: engine.id,
      label: engine.label,
      description: engine.description,
      available: missing.length === 0,
      missing,
      version,
    });
  }
  statusCache = { at: Date.now(), value };
  return value;
}
