/**
 * Turn a TeX log into a list of errors and warnings with file and line, so a
 * front end can show them next to the source.
 *
 * The compile runner sets `max_print_line=10000`, so log lines are not
 * hard-wrapped at 79 characters and can be matched whole.
 */

export type DiagnosticLevel = 'error' | 'warning' | 'typesetting';

export interface Diagnostic {
  level: DiagnosticLevel;
  message: string;
  /** Project-relative path when the problem is in a project file; otherwise the path as TeX printed it, or null. */
  file: string | null;
  line: number | null;
  source: 'latex' | 'bibtex' | 'biber' | 'latexmk';
  /** The offending source text or extra explanation TeX printed, if any. */
  context?: string;
}

const FILE_EXT =
  'tex|ltx|sty|cls|clo|cfg|def|fd|bbl|bib|aux|toc|lof|lot|out|nav|snm|ind|gls|tikz|pgf|code\\.tex|mkii|mkiv|lua|dict|enc|map|ldf|lbx|bbx|cbx|dtx|ins|txt';
const OPEN_FILE = new RegExp(`^((?:\\.{0,2}/|[A-Za-z]:[\\\\/])[^\\s(){}]+|[^\\s(){}/]+\\.(?:${FILE_EXT}))`);
const FILE_LINE_ERROR = /^((?:\.{0,2}\/)?[^\s:()][^:()]*?\.[A-Za-z0-9]+):(\d+): (.+)$/;
const BANG_ERROR = /^! (.+)$/;
const WARNING =
  /^(?:(LaTeX)(?: (Font|3))?|(Package|Class|Module) (\S+)|(pdfTeX|LuaTeX|XeTeX|luaotfload|\S+TeX)) [Ww]arning(?: \([^)]*\))?:\s*(.*)$/;
const BOX =
  /^((?:Over|Under)full \\[hv]box \(.*?\))(?: in paragraph at lines (\d+)--(\d+)| in alignment at lines (\d+)--(\d+)| detected at line (\d+)| has occurred while \\output is active)?/;
const INPUT_LINE = /on (?:input )?line (\d+)/;
const SOURCE_LINE = /^l\.(\d+) ?(.*)$/;

export interface ParseOptions {
  /** Absolute path of the compile directory; project paths are made relative to it. */
  workdir?: string;
}

function relativize(file: string | null, workdir?: string): string | null {
  if (!file) return null;
  let f = file.replace(/\\/g, '/');
  if (workdir) {
    const base = workdir.replace(/\/+$/, '');
    if (f.startsWith(`${base}/`)) f = f.slice(base.length + 1);
  }
  while (f.startsWith('./')) f = f.slice(2);
  return f;
}

class FileStack {
  private stack: (string | null)[] = [];

  scan(line: string): void {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') {
        const m = OPEN_FILE.exec(line.slice(i + 1));
        if (m) {
          this.stack.push(m[1]!);
          i += m[1]!.length;
        } else {
          this.stack.push(null);
        }
      } else if (ch === ')') {
        this.stack.pop();
      }
    }
  }

  current(): string | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]) return this.stack[i]!;
    }
    return null;
  }
}

export function parseLatexLog(log: string, opts: ParseOptions = {}): Diagnostic[] {
  const lines = log.split(/\r?\n/);
  const files = new FileStack();
  const out: Diagnostic[] = [];
  const fatal: Diagnostic[] = [];

  /** Gather the lines TeX prints after an error (help text and the `l.12 …` source line). */
  const errorTail = (start: number): { line: number | null; context: string; next: number } => {
    let lineNo: number | null = null;
    const ctx: string[] = [];
    let j = start;
    for (; j < lines.length && j < start + 14; j++) {
      const l = lines[j]!;
      const src = SOURCE_LINE.exec(l);
      if (src) {
        lineNo = Number(src[1]);
        if (src[2]!.trim()) ctx.push(src[2]!.trim());
        j++;
        break;
      }
      if (BANG_ERROR.test(l) || FILE_LINE_ERROR.test(l)) break;
      if (l.trim() && !/^(See the LaTeX manual|Type {2}H <return>| \.\.\.)/.test(l)) ctx.push(l.trim());
    }
    return { line: lineNo, context: ctx.slice(0, 4).join('\n'), next: j };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fle = FILE_LINE_ERROR.exec(line);
    if (fle) {
      const tail = errorTail(i + 1);
      out.push({
        level: 'error',
        message: fle[3]!.replace(/^(LaTeX|Package \S+|Class \S+) Error: /, '').trim(),
        file: relativize(fle[1]!, opts.workdir),
        line: Number(fle[2]),
        source: 'latex',
        ...(tail.context ? { context: tail.context } : {}),
      });
      i = tail.next - 1;
      continue;
    }

    const bang = BANG_ERROR.exec(line);
    if (bang) {
      const message = bang[1]!.trim();
      const tail = errorTail(i + 1);
      const diag: Diagnostic = {
        level: 'error',
        message: message.replace(/^(LaTeX|Package \S+|Class \S+) Error: /, ''),
        file: relativize(files.current(), opts.workdir),
        line: tail.line,
        source: 'latex',
        ...(tail.context ? { context: tail.context } : {}),
      };
      // These only say "the run stopped"; keep them back unless nothing better was found.
      if (/^(Emergency stop|\s*==> Fatal error occurred)/.test(message)) fatal.push(diag);
      else out.push(diag);
      i = tail.next - 1;
      continue;
    }

    const warn = WARNING.exec(line);
    if (warn) {
      const origin = warn[4] ?? null;
      let message = warn[6] ?? '';
      // Continuation lines: "(hyperref)   more text" or indented text, until a blank line.
      let j = i + 1;
      for (; j < lines.length && j < i + 6; j++) {
        const l = lines[j]!;
        if (!l.trim()) break;
        const cont = origin ? new RegExp(`^\\(${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*(.*)$`).exec(l) : null;
        if (cont) message += ` ${cont[1]!.trim()}`;
        else if (/^\s{2,}\S/.test(l)) message += ` ${l.trim()}`;
        else break;
      }
      i = j - 1;
      message = message.replace(/\s+/g, ' ').trim();
      const ln = INPUT_LINE.exec(message);
      out.push({
        level: 'warning',
        message: origin ? `${origin}: ${message}` : message,
        file: relativize(files.current(), opts.workdir),
        line: ln ? Number(ln[1]) : null,
        source: 'latex',
      });
      continue;
    }

    const box = BOX.exec(line);
    if (box) {
      const ln = box[2] ?? box[4] ?? box[6];
      out.push({
        level: 'typesetting',
        message: line.trim(),
        file: relativize(files.current(), opts.workdir),
        line: ln ? Number(ln) : null,
        source: 'latex',
      });
      continue;
    }

    files.scan(line);
  }

  if (!out.some((d) => d.level === 'error')) out.push(...fatal);
  return dedupe(out);
}

/** Parse a BibTeX or Biber `.blg` file. */
export function parseBibLog(blg: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = blg.split(/\r?\n/);
  const isBiber = lines.some((l) => /Biber\.pm|This is Biber/.test(l));

  if (isBiber) {
    for (const line of lines) {
      const m = /> (WARN|ERROR|FATAL) - (.*)$/.exec(line);
      if (!m) continue;
      const fileLine = /(\S+\.bib)(?:_\d+\.utf8)?, line (\d+)/.exec(m[2]!);
      out.push({
        level: m[1] === 'WARN' ? 'warning' : 'error',
        message: m[2]!.trim(),
        file: fileLine ? fileLine[1]!.replace(/^\.\//, '') : null,
        line: fileLine ? Number(fileLine[2]) : null,
        source: 'biber',
      });
    }
    return out;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const located = /^(.*?)-{2,3}line (\d+) of file (.+)$/.exec(line);
    if (line.startsWith('Warning--')) {
      const next = /^-{2,3}line (\d+) of file (.+)$/.exec(lines[i + 1] ?? '');
      out.push({
        level: 'warning',
        message: line.slice('Warning--'.length).trim(),
        file: next ? next[2]!.trim().replace(/^\.\//, '') : null,
        line: next ? Number(next[1]) : null,
        source: 'bibtex',
      });
      if (next) i++;
    } else if (located && located[1]!.trim()) {
      out.push({
        level: 'error',
        message: located[1]!.trim(),
        file: located[3]!.trim().replace(/^\.\//, ''),
        line: Number(located[2]),
        source: 'bibtex',
      });
    } else if (/^I couldn't open (database|style) file /.test(line) || /^I found no /.test(line)) {
      const next = /^-{2,3}line (\d+) of file (.+)$/.exec(lines[i + 1] ?? '');
      out.push({
        level: 'error',
        message: line.trim(),
        file: next ? next[2]!.trim().replace(/^\.\//, '') : null,
        line: next ? Number(next[1]) : null,
        source: 'bibtex',
      });
      if (next) i++;
    }
  }
  return out;
}

function dedupe(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.level}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function summarize(diagnostics: Diagnostic[]) {
  return {
    errors: diagnostics.filter((d) => d.level === 'error').length,
    warnings: diagnostics.filter((d) => d.level === 'warning').length,
    typesetting: diagnostics.filter((d) => d.level === 'typesetting').length,
  };
}
