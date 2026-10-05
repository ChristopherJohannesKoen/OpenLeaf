// What OpenLeaf reads out of LaTeX source without compiling it: the outline, the keys that are
// defined and used, a word count, and a few checks whose results are set in the margin.
import type { Diagnostic } from '../api/types';

/** Text files of a project by path. */
export type Sources = ReadonlyMap<string, string>;

/* ------------------------------------------------------------------ basics */

/** The line with its comment removed (an unescaped % starts a comment). */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '%') return line.slice(0, i);
  }
  return line;
}

/** Reads `{…}` starting at `from` (which must be the opening brace), honouring nested braces. */
export function braced(text: string, from: number): { value: string; end: number } | null {
  if (text[from] !== '{') return null;
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { value: text.slice(from + 1, i), end: i + 1 };
    }
  }
  return null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = keep;
    }
  }
  return prev[b.length]!;
}

/** The candidate nearest to `key`, if it is near enough to be a likely slip. */
export function closest(key: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  const limit = Math.max(1, Math.min(3, Math.floor(key.length / 3)));
  for (const c of candidates) {
    if (Math.abs(c.length - key.length) > limit) continue;
    const d = levenshtein(key.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) { best = c; bestDistance = d; }
  }
  return bestDistance <= limit ? best : null;
}

/* ----------------------------------------------------------------- outline */

export interface OutlineHeading {
  id: string;
  file: string;
  /** 1-based. */
  line: number;
  number: string;
  title: string;
  depth: number;
}

const LEVEL: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 };
const HEADING = /\\(part|chapter|section|subsection|subsubsection)(\*)?\s*(?:\[[^\]]*\]\s*)?(?=\{)/g;
const INCLUDE = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;

function resolveInclude(name: string, sources: Sources): string | null {
  const path = name.trim().replace(/^\.\//, '');
  if (sources.has(path)) return path;
  if (sources.has(`${path}.tex`)) return `${path}.tex`;
  return null;
}

/** Plain text of a heading: commands dropped, braces removed, math kept as typed. */
function plainTitle(raw: string): string {
  return raw
    .replace(/\\(?:label|index)\s*\{[^}]*\}/g, '')
    .replace(/\\(?:texorpdfstring)\s*\{([^}]*)\}\s*\{[^}]*\}/g, '$1')
    .replace(/\\[A-Za-z@]+\*?\s*/g, '')
    .replace(/[{}~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The sections of the document rooted at `mainFile`, in reading order, numbered as LaTeX would number them. */
export function outline(sources: Sources, mainFile: string): OutlineHeading[] {
  type Raw = { file: string; line: number; level: number; starred: boolean; title: string; appendix: boolean };
  const raw: Raw[] = [];
  const seen = new Set<string>();
  let appendix = false;

  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = sources.get(file);
    if (text === undefined) return;
    const lines = text.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = stripComment(lines[n]!);
      if (!line.includes('\\')) continue;
      type Hit = { at: number; kind: 'heading' | 'include' | 'appendix'; m: RegExpExecArray | null };
      const hits: Hit[] = [];
      HEADING.lastIndex = 0;
      INCLUDE.lastIndex = 0;
      for (let m = HEADING.exec(line); m; m = HEADING.exec(line)) hits.push({ at: m.index, kind: 'heading', m });
      for (let m = INCLUDE.exec(line); m; m = INCLUDE.exec(line)) hits.push({ at: m.index, kind: 'include', m });
      const app = line.indexOf('\\appendix');
      if (app >= 0) hits.push({ at: app, kind: 'appendix', m: null });
      hits.sort((a, b) => a.at - b.at);
      for (const hit of hits) {
        if (hit.kind === 'appendix') appendix = true;
        else if (hit.kind === 'include') {
          const target = resolveInclude(hit.m![1]!, sources);
          if (target) walk(target);
        } else {
          const m = hit.m!;
          // The title may run over the following lines; join a few to find the closing brace.
          const rest = [line.slice(m.index + m[0].length), ...lines.slice(n + 1, n + 4).map(stripComment)].join(' ');
          const arg = braced(rest, 0);
          raw.push({ file, line: n + 1, level: LEVEL[m[1]!]!, starred: !!m[2], title: plainTitle(arg ? arg.value : rest), appendix });
        }
      }
    }
  };
  walk(mainFile);

  if (raw.length === 0) return [];
  const top = Math.min(...raw.filter((h) => h.level > 0).map((h) => h.level), 4);
  const counters = [0, 0, 0, 0, 0];
  let inAppendix = false;
  return raw.map((h, i) => {
    let number = '';
    if (h.appendix && !inAppendix) {
      inAppendix = true;
      counters.fill(0);
    }
    if (!h.starred) {
      if (h.level === 0) {
        counters[0]!++;
        number = romanNumeral(counters[0]!);
      } else {
        counters[h.level]!++;
        for (let l = h.level + 1; l < counters.length; l++) counters[l] = 0;
        const parts: string[] = [];
        for (let l = top; l <= h.level; l++) {
          parts.push(l === top && inAppendix ? String.fromCharCode(64 + Math.max(1, counters[l]!)) : String(counters[l]!));
        }
        number = parts.join('.');
      }
    }
    return {
      id: `${h.file}:${h.line}:${i}`,
      file: h.file,
      line: h.line,
      number,
      title: h.title || '(untitled)',
      depth: Math.max(0, h.level - top),
    };
  });
}

function romanNumeral(n: number): string {
  const table: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

/** The heading that contains `line` of `file`: the last one at or before it. */
export function headingAt(headings: OutlineHeading[], file: string, line: number): OutlineHeading | null {
  let found: OutlineHeading | null = null;
  for (const h of headings) if (h.file === file && h.line <= line) found = h;
  return found;
}

/* ------------------------------------------------------------- project index */

export interface KeyPlace { file: string; line: number }

export interface ProjectIndex {
  labels: Map<string, KeyPlace>;
  /** Bibliography keys with a short description (author, title, year) when it can be read. */
  bibliography: Map<string, string>;
  hasGraphicsPath: boolean;
}

const REF_COMMANDS = 'ref|eqref|autoref|cref|Cref|pageref|nameref|vref';
const CITE_COMMANDS = 'cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite|footcite';

function bibField(entry: string, field: string): string {
  const m = new RegExp(`\\b${field}\\s*=\\s*`, 'i').exec(entry);
  if (!m) return '';
  const start = m.index + m[0].length;
  let value = '';
  if (entry[start] === '{') value = braced(entry, start)?.value ?? '';
  else if (entry[start] === '"') value = entry.slice(start + 1, entry.indexOf('"', start + 1));
  else value = /^[^,\n}]+/.exec(entry.slice(start))?.[0] ?? '';
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function describeBibEntry(entry: string): string {
  const author = bibField(entry, 'author') || bibField(entry, 'editor');
  const first = author.split(/\s+and\s+/i)[0] ?? '';
  const surname = first.includes(',') ? first.split(',')[0]!.trim() : (first.split(' ').pop() ?? '').trim();
  const others = author.split(/\s+and\s+/i).length > 1 ? ' et al.' : '';
  const title = bibField(entry, 'title');
  const year = bibField(entry, 'year') || bibField(entry, 'date').slice(0, 4);
  return [surname ? surname + others : '', title, year].filter(Boolean).join(', ');
}

export function indexProject(sources: Sources): ProjectIndex {
  const labels = new Map<string, KeyPlace>();
  const bibliography = new Map<string, string>();
  let hasGraphicsPath = false;
  for (const [file, text] of sources) {
    if (/\.bib$/i.test(file)) {
      const entry = /@(\w+)\s*\{\s*([^,\s{}]+)\s*,/g;
      const starts: { key: string; at: number; type: string }[] = [];
      for (let m = entry.exec(text); m; m = entry.exec(text)) starts.push({ key: m[2]!, at: m.index, type: m[1]!.toLowerCase() });
      starts.forEach((s, i) => {
        if (s.type === 'comment' || s.type === 'string' || s.type === 'preamble') return;
        bibliography.set(s.key, describeBibEntry(text.slice(s.at, starts[i + 1]?.at ?? text.length)));
      });
      continue;
    }
    const lines = text.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = stripComment(lines[n]!);
      if (!line.includes('\\')) continue;
      const label = /\\label\s*\{([^}]+)\}/g;
      for (let m = label.exec(line); m; m = label.exec(line)) {
        if (!labels.has(m[1]!)) labels.set(m[1]!, { file, line: n + 1 });
      }
      const bibitem = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
      for (let m = bibitem.exec(line); m; m = bibitem.exec(line)) if (!bibliography.has(m[1]!)) bibliography.set(m[1]!, '');
      if (line.includes('\\graphicspath')) hasGraphicsPath = true;
    }
  }
  return { labels, bibliography, hasGraphicsPath };
}

/* ------------------------------------------------------------ margin notes */

export type NoteTone = 'broken' | 'asks' | 'settled' | 'note';

/** A note for the margin, tied to a line of a file. `replace` is the text an action would put in place of the lemma. */
export interface MarginNote {
  /** 1-based. */
  line: number;
  tone: NoteTone;
  lemma?: string;
  text: string;
  /** Where the lemma is in the line (0-based columns), when it was found. */
  from?: number;
  to?: number;
  fix?: { label: string; replace: string };
  /** Where to go when the note names another place. */
  goto?: KeyPlace;
  origin: 'compile' | 'reading';
}

const GRAPHIC_EXTENSIONS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps'];

function keysOf(arg: string): string[] {
  return arg.split(',').map((k) => k.trim()).filter((k) => k && k !== '*');
}

/**
 * What can be said about a file by reading it against the rest of the project: keys that are used but
 * defined nowhere, and pictures that are not among the files. `paths` is every file path in the project.
 */
export function readingNotes(file: string, text: string, index: ProjectIndex, paths: ReadonlySet<string>): MarginNote[] {
  const notes: MarginNote[] = [];
  if (/\.bib$/i.test(file)) return notes;
  const lines = text.split('\n');
  const refs = new RegExp(`\\\\(?:${REF_COMMANDS})\\*?\\s*\\{([^}]*)\\}`, 'g');
  const cites = new RegExp(`\\\\(?:${CITE_COMMANDS})\\*?\\s*(?:\\[[^\\]]*\\]\\s*){0,2}\\{([^}]*)\\}`, 'g');
  const graphics = /\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;

  for (let n = 0; n < lines.length; n++) {
    const line = stripComment(lines[n]!);
    if (!line.includes('\\')) continue;
    const place = (key: string, m: RegExpExecArray) => {
      const from = line.indexOf(key, m.index);
      return from >= 0 ? { from, to: from + key.length } : {};
    };

    for (let m = refs.exec(line); m; m = refs.exec(line)) {
      for (const key of keysOf(m[1]!)) {
        if (index.labels.has(key)) continue;
        const near = closest(key, index.labels.keys());
        const where = near ? index.labels.get(near)! : null;
        notes.push({
          line: n + 1, tone: 'asks', lemma: key, origin: 'reading', ...place(key, m),
          text: near
            ? `undefined; ${near} is defined at l. ${where!.line}${where!.file !== file ? ` of ${where!.file}` : ''}.`
            : 'undefined; no label by that name in the project.',
          ...(near ? { fix: { label: 'Correct', replace: near }, goto: where! } : {}),
        });
      }
    }

    if (index.bibliography.size > 0) {
      for (let m = cites.exec(line); m; m = cites.exec(line)) {
        for (const key of keysOf(m[1]!)) {
          if (index.bibliography.has(key)) continue;
          const near = closest(key, index.bibliography.keys());
          notes.push({
            line: n + 1, tone: 'asks', lemma: key, origin: 'reading', ...place(key, m),
            text: near ? `not in the bibliography; ${near} is.` : 'not in the bibliography.',
            ...(near ? { fix: { label: 'Correct', replace: near } } : {}),
          });
        }
      }
    }

    if (!index.hasGraphicsPath) {
      for (let m = graphics.exec(line); m; m = graphics.exec(line)) {
        const name = m[1]!.trim();
        if (!name || name.includes('\\') || name.includes('#')) continue;
        if (GRAPHIC_EXTENSIONS.some((ext) => paths.has(name + ext))) continue;
        const stems = new Map<string, string>();
        for (const p of paths) if (/\.(pdf|png|jpe?g|eps)$/i.test(p)) stems.set(p.replace(/\.[^.]+$/, ''), p);
        const near = closest(name.replace(/\.[^.]+$/, ''), stems.keys());
        notes.push({
          line: n + 1, tone: 'broken', lemma: name, origin: 'reading', ...place(name, m),
          text: near ? `not found; ${stems.get(near)} is among the files.` : 'not found among the files.',
          ...(near ? { fix: { label: 'Use it', replace: near } } : {}),
        });
      }
    }
  }
  return notes;
}

/** For the line the caret is on: what the first key on it resolves to. Quiet confirmation, not a warning. */
export function resolvedNote(file: string, lineNo: number, lineText: string, index: ProjectIndex): MarginNote | null {
  const line = stripComment(lineText);
  const cite = new RegExp(`\\\\(?:${CITE_COMMANDS})\\*?\\s*(?:\\[[^\\]]*\\]\\s*){0,2}\\{([^}]*)\\}`).exec(line);
  if (cite) {
    for (const key of keysOf(cite[1]!)) {
      const entry = index.bibliography.get(key);
      if (entry) return { line: lineNo, tone: 'settled', lemma: key, text: entry.endsWith('.') ? entry : `${entry}.`, origin: 'reading' };
    }
  }
  const ref = new RegExp(`\\\\(?:${REF_COMMANDS})\\*?\\s*\\{([^}]*)\\}`).exec(line);
  if (ref) {
    for (const key of keysOf(ref[1]!)) {
      const place = index.labels.get(key);
      if (place) {
        return {
          line: lineNo, tone: 'settled', lemma: key, origin: 'reading', goto: place,
          text: `defined at l. ${place.line}${place.file !== file ? ` of ${place.file}` : ''}.`,
        };
      }
    }
  }
  return null;
}

/* ---------------------------------------------------------- compiler messages */

export interface Described {
  /** The exact text the message is about, when it names one. */
  lemma?: string;
  /** For the margin: a lowercase fragment ending in a full stop. */
  fragment: string;
  /** For the apparatus: one plain sentence. */
  sentence: string;
}

function sentenceCase(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return t;
  const withStop = /[.!?]$/.test(t) ? t : `${t}.`;
  return withStop[0]!.toUpperCase() + withStop.slice(1);
}

function lowerFirst(s: string): string {
  // Keep TeX's own words as they are (LaTeX, Overfull stays lowercase-able; acronyms and macros do not).
  if (/^[A-Z][a-z]/.test(s)) return s[0]!.toLowerCase() + s.slice(1);
  return s;
}

/** Turns what TeX printed into the two forms OpenLeaf shows: `lemma] fragment.` and a sentence. */
export function describe(d: Pick<Diagnostic, 'message' | 'context' | 'level'>): Described {
  let message = d.message.replace(/\s+/g, ' ').trim();
  let lemma: string | undefined;

  const missingEntry = /^I didn't find a database entry for "([^"]+)"/.exec(message);
  if (missingEntry) return { lemma: missingEntry[1]!, fragment: 'no entry by that key in the bibliography.', sentence: 'No entry by that key in the bibliography.' };

  const box = /^((?:Over|Under)full \\[hv]box) \(([^)]*)\)/.exec(message);
  if (box) {
    const text = `${box[1]}, ${box[2]}`;
    return { fragment: `${lowerFirst(text)}.`, sentence: sentenceCase(text) };
  }

  const quoted =
    /[`‘]([^`‘'’]{1,80})['’]/.exec(message) ??
    (message.split('"').length === 3 ? /"([^"]{1,80})"/.exec(message) : null) ??
    (message.split("'").length === 3 ? /'([^']{1,80})'/.exec(message) : null);
  if (quoted) {
    lemma = quoted[1]!.trim();
    message = (message.slice(0, quoted.index) + ' ' + message.slice(quoted.index + quoted[0].length)).replace(/\s+/g, ' ');
  } else if (/^Undefined control sequence/.test(message) && d.context) {
    const all = d.context.split('\n')[0]!.match(/\\[A-Za-z@]+/g);
    if (all) lemma = all[all.length - 1];
  } else if (/^Environment (\S+) undefined/.test(message)) {
    lemma = /^Environment (\S+) undefined/.exec(message)![1];
    message = 'Environment undefined.';
  }

  message = message
    .replace(/\s+on input line \d+\.?/, '')
    .replace(/\s+on page \d+/, '')
    .replace(/^(?:LaTeX|Package \S+|Class \S+) (?:Error|Warning): /, '')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
  if (!message) message = d.level === 'error' ? 'error' : 'warning';

  const sentence = sentenceCase(message);
  return { ...(lemma ? { lemma } : {}), fragment: lowerFirst(sentence), sentence };
}

export function toneOf(level: Diagnostic['level']): NoteTone {
  return level === 'error' ? 'broken' : level === 'warning' ? 'asks' : 'note';
}

/** Margin notes for the compiler's messages about `file`, with the lemma located in its line when it can be. */
export function compileNotes(file: string, text: string, diagnostics: Diagnostic[]): MarginNote[] {
  const lines = text.split('\n');
  const notes: MarginNote[] = [];
  for (const d of diagnostics) {
    if (d.file !== file || d.line === null || d.line < 1 || d.line > lines.length) continue;
    const said = describe(d);
    const lineText = lines[d.line - 1]!;
    const from = said.lemma ? lineText.indexOf(said.lemma) : -1;
    notes.push({
      line: d.line, tone: toneOf(d.level), text: said.fragment, origin: 'compile',
      ...(said.lemma ? { lemma: said.lemma } : {}),
      ...(from >= 0 ? { from, to: from + said.lemma!.length } : {}),
    });
  }
  return notes;
}

/**
 * One list for the margin. A reading note that says the same thing as a compiler note (same line, same
 * lemma) replaces it, because the reading note knows the remedy; at most three notes are kept per line.
 */
export function mergeNotes(compile: MarginNote[], reading: MarginNote[]): MarginNote[] {
  const key = (n: MarginNote) => `${n.line}|${n.lemma ?? ''}`;
  const fromReading = new Set(reading.map(key));
  const order: Record<NoteTone, number> = { broken: 0, asks: 1, note: 2, settled: 3 };
  const all = [...compile.filter((n) => !fromReading.has(key(n))), ...reading];
  all.sort((a, b) => a.line - b.line || order[a.tone] - order[b.tone]);
  const perLine = new Map<number, number>();
  return all.filter((n) => {
    const count = perLine.get(n.line) ?? 0;
    perLine.set(n.line, count + 1);
    return count < 3;
  });
}

/* --------------------------------------------------------------- word count */

/** Words a reader would read: comments, commands, their keys and math are left out. An estimate. */
export function wordCount(text: string): number {
  const body = text
    .split('\n')
    .map(stripComment)
    .join('\n')
    .replace(/\\begin\{(?:equation|align|gather|multline|eqnarray|displaymath)\*?\}[\s\S]*?\\end\{(?:equation|align|gather|multline|eqnarray|displaymath)\*?\}/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/\\(?:begin|end|label|ref|eqref|autoref|cref|Cref|pageref|cite[a-z]*|input|include|includegraphics|usepackage|documentclass|bibliography|bibliographystyle)\*?\s*(?:\[[^\]]*\])*\s*\{[^}]*\}/g, ' ')
    .replace(/\\[A-Za-z@]+\*?/g, ' ')
    .replace(/\\./g, ' ');
  const words = body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}
