// The Source pane's editor: CodeMirror dressed as the design system's Source component.
// One 20px line per row, a ruler over 80 columns, marks in the gutter, and scholia in a margin
// that starts exactly at the wrap column.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import {
  Decoration, drawSelection, EditorView, gutter, GutterMarker, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { MeasureRule } from '../ds';
import { mergeNotes, type MarginNote } from '../lib/latex';
import { COMMON_COMMANDS, COMMON_ENVIRONMENTS, latex } from './latexLanguage';

const COLUMNS = 80;
/** Inconsolata advances exactly half an em: 7.5px a column at 15px. */
const COLUMN_PX = 7.5;
const GUTTER_PX = 60;
const PAD_PX = 10;
const MARGIN_PX = 280;
const MARGIN_MIN_PX = 180;

export interface Caret { line: number; column: number; lineText: string }

export interface SourceEditorHandle {
  focus(): void;
  goTo(line: number, column?: number): void;
  /** Replace columns [from, to) of a line (1-based line, 0-based columns). */
  replaceInLine(line: number, from: number, to: number, text: string): void;
  content(): string;
  openSearch(): void;
}

interface Props {
  /** The file shown. Each path keeps its own undo history, selection and scroll position. */
  path: string;
  /** The text to start from when `path` is first shown (or shown again after `revision` changed). */
  initial: string;
  /** Increase to throw away the kept state of `path` and start again from `initial` (after a restore, say). */
  revision: number;
  /** What the compiler said about this file. `stamp` names the compile; the notes are placed once per compile and then move with the text. */
  compile: { stamp: string; notes: MarginNote[] };
  /** What reading the file against the project says. Recomputed as the text changes. */
  reading: MarginNote[];
  /** Whether the scholia margin is wanted; it is still dropped when the pane is too narrow for it. */
  margin: boolean;
  onChange: (path: string, content: string) => void;
  onCaret: (caret: Caret) => void;
  onNoteFix: (note: MarginNote) => void;
  onNoteGoto: (note: MarginNote) => void;
  /** Keys to offer inside \ref{…} and \cite{…}. */
  keys: () => { labels: string[]; citations: string[] };
}

/* ------------------------------------------------------------------ notes */

const setCompileNotes = StateEffect.define<MarginNote[]>();
const setReadingNotes = StateEffect.define<MarginNote[]>();

const GLYPH: Record<MarginNote['tone'], string> = { broken: '†', asks: '*', note: '›', settled: '' };

class MarkMarker extends GutterMarker {
  constructor(readonly tone: MarginNote['tone']) { super(); }
  eq(other: MarkMarker) { return other.tone === this.tone; }
  toDOM() {
    const el = document.createElement('span');
    el.className = `ol-mark ol-mark--${this.tone}`;
    el.textContent = GLYPH[this.tone];
    return el;
  }
}

interface NoteCallbacks { fix: (note: MarginNote) => void; go: (note: MarginNote) => void }

class ScholiaMarker extends GutterMarker {
  constructor(readonly notes: MarginNote[], readonly calls: NoteCallbacks) { super(); }
  eq(other: ScholiaMarker) {
    return other.notes.length === this.notes.length && other.notes.every((n, i) => {
      const m = this.notes[i]!;
      return n.tone === m.tone && n.lemma === m.lemma && n.text === m.text && n.line === m.line && n.fix?.replace === m.fix?.replace;
    });
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'ol-cm-scholia';
    for (const note of this.notes) {
      const el = document.createElement('div');
      el.className = `ol-scholion ol-scholion--${note.tone}`;
      el.setAttribute('role', 'note');
      const mark = document.createElement('span');
      mark.className = `ol-mark ol-mark--${note.tone}`;
      mark.textContent = GLYPH[note.tone];
      const body = document.createElement('div');
      if (note.lemma) {
        const lemma = document.createElement('span');
        lemma.className = 'ol-scholion__lemma';
        lemma.textContent = note.lemma;
        body.appendChild(lemma);
      }
      const text = document.createElement('span');
      text.textContent = note.text;
      body.appendChild(text);
      const actions: [string, () => void][] = [];
      if (note.fix) actions.push([note.fix.label, () => this.calls.fix(note)]);
      if (note.goto) actions.push(['Go there', () => this.calls.go(note)]);
      if (actions.length) {
        const row = document.createElement('span');
        row.className = 'ol-scholion__actions';
        for (const [label, run] of actions) {
          const a = document.createElement('a');
          a.className = 'ol-link';
          a.setAttribute('role', 'button');
          a.tabIndex = 0;
          a.textContent = label;
          a.addEventListener('mousedown', (e) => e.preventDefault());
          a.addEventListener('click', (e) => { e.preventDefault(); run(); });
          a.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
          row.appendChild(a);
        }
        body.appendChild(row);
      }
      el.append(mark, body);
      wrap.appendChild(el);
    }
    return wrap;
  }
}

interface NoteState {
  /** The compiler's notes, each held by a position in the text so it moves as the text is edited. */
  compile: { note: MarginNote; pos: number }[];
  reading: MarginNote[];
  marks: RangeSet<GutterMarker>;
  scholia: RangeSet<GutterMarker>;
  decorations: DecorationSet;
}

const EMPTY: NoteState = { compile: [], reading: [], marks: RangeSet.empty, scholia: RangeSet.empty, decorations: Decoration.none };
const WEIGHT: Record<MarginNote['tone'], number> = { broken: 0, asks: 1, note: 2, settled: 3 };

function rebuild(state: EditorState, value: Pick<NoteState, 'compile' | 'reading'>, calls: NoteCallbacks): NoteState {
  // Where each compiler note is now. One whose lemma has gone from its line was dealt with: drop it.
  const compile: MarginNote[] = [];
  for (const { note, pos } of value.compile) {
    const line = state.doc.lineAt(Math.min(pos, state.doc.length));
    if (note.lemma) {
      const from = line.text.indexOf(note.lemma);
      if (from < 0) continue;
      compile.push({ ...note, line: line.number, from, to: from + note.lemma.length });
    } else {
      compile.push({ ...note, line: line.number });
    }
  }
  const byLine = new Map<number, MarginNote[]>();
  for (const n of mergeNotes(compile, value.reading)) {
    if (n.line < 1 || n.line > state.doc.lines) continue;
    const list = byLine.get(n.line) ?? [];
    list.push(n);
    byLine.set(n.line, list);
  }
  const marks = new RangeSetBuilder<GutterMarker>();
  const scholia = new RangeSetBuilder<GutterMarker>();
  const decorations: Range<Decoration>[] = [];
  for (const lineNo of [...byLine.keys()].sort((a, b) => a - b)) {
    const list = byLine.get(lineNo)!.sort((a, b) => WEIGHT[a.tone] - WEIGHT[b.tone]);
    const line = state.doc.line(lineNo);
    const worst = list[0]!.tone;
    if (worst === 'broken' || worst === 'asks') marks.add(line.from, line.from, new MarkMarker(worst));
    scholia.add(line.from, line.from, new ScholiaMarker(list, calls));
    if (worst === 'broken') decorations.push(Decoration.line({ class: 'ol-cm-line--broken' }).range(line.from));
    for (const n of list) {
      if (n.from === undefined || n.to === undefined || n.to <= n.from) continue;
      const from = line.from + Math.min(n.from, line.length);
      const to = line.from + Math.min(n.to, line.length);
      if (to > from) decorations.push(Decoration.mark({ class: `ol-lemma ol-lemma--${n.tone}` }).range(from, to));
    }
  }
  return { ...value, marks: marks.finish(), scholia: scholia.finish(), decorations: Decoration.set(decorations, true) };
}

function notesField(calls: NoteCallbacks) {
  return StateField.define<NoteState>({
    create: () => EMPTY,
    update(value, tr) {
      let compile = value.compile;
      let reading = value.reading;
      let changed = false;
      if (tr.docChanged) compile = compile.map((c) => ({ note: c.note, pos: tr.changes.mapPos(c.pos, 1) }));
      for (const effect of tr.effects) {
        if (effect.is(setCompileNotes)) {
          compile = effect.value
            .filter((n) => n.line >= 1 && n.line <= tr.state.doc.lines)
            .map((note) => ({ note, pos: tr.state.doc.line(note.line).from }));
          changed = true;
        } else if (effect.is(setReadingNotes)) {
          reading = effect.value;
          changed = true;
        }
      }
      if (changed) return rebuild(tr.state, { compile, reading }, calls);
      if (!tr.docChanged) return value;
      // Between two readings the sets simply move with the text.
      return { compile, reading, marks: value.marks.map(tr.changes), scholia: value.scholia.map(tr.changes), decorations: value.decorations.map(tr.changes) };
    },
    provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
  });
}

/* ------------------------------------------------------------------ theme */

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--depth-1)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-source)', fontSize: '15px', lineHeight: '20px', overflowX: 'hidden' },
  '.cm-content': {
    flex: '0 0 auto', width: 'var(--ol-content, 610px)', padding: '0', caretColor: 'var(--bronze-ink)',
    fontVariantLigatures: 'none',
  },
  '.cm-line': { padding: `0 0 0 ${PAD_PX}px` },
  '.cm-gutters': { backgroundColor: 'var(--depth-1)', color: 'var(--ink-3)', border: 'none' },
  '.cm-gutter.ol-cm-marks': { width: '20px' },
  '.cm-gutter.ol-cm-marks .cm-gutterElement': { textAlign: 'center', padding: '0' },
  '.cm-lineNumbers': { width: '40px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 0', minWidth: '40px', fontSize: '13px', textAlign: 'right' },
  '.cm-activeLine': { backgroundColor: 'var(--depth-0)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--depth-0)', color: 'var(--ink)' },
  '.ol-cm-line--broken, .ol-cm-line--broken.cm-activeLine': { backgroundColor: 'var(--cinnabar-wash)' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--bronze-ink)', marginLeft: '-1px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--bronze-wash)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'transparent', boxShadow: 'inset 0 -1px 0 var(--ink)', fontWeight: '700' },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: 'var(--cinnabar-ink)' },
  '.cm-searchMatch': { backgroundColor: 'var(--bronze-wash)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--bronze-wash)', boxShadow: 'inset 0 0 0 1px var(--bronze-ink)' },

  // The scholia margin: a gutter after the content whose left edge is the wrap column.
  '.cm-gutters.cm-gutters-after': { flex: '1 1 0', minWidth: '0', borderLeft: '1px solid var(--rule)', backgroundColor: 'var(--depth-1)' },
  '.cm-gutter.ol-cm-margin': { width: '100%' },
  '.cm-gutters-after .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-gutter.ol-cm-margin .cm-gutterElement': { overflow: 'visible', position: 'relative', padding: '0' },
  '.ol-cm-scholia': { position: 'relative', zIndex: '1', margin: '0 10px', backgroundColor: 'var(--depth-1)', paddingBottom: '5px' },

  // Search, in the system's own controls.
  '.cm-panels': { backgroundColor: 'var(--depth-2)', color: 'var(--ink)', borderBottom: '1px solid var(--rule)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--rule)' },
  '.cm-panel.cm-search': { padding: '5px 10px', fontFamily: 'var(--font-control)', fontSize: '13px', lineHeight: '20px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '5px 10px' },
  '.cm-panel.cm-search br': { display: 'none' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '5px', color: 'var(--ink-2)', fontSize: '12px' },
  '.cm-textfield': {
    height: '30px', padding: '0 10px', margin: '0', border: '1px solid var(--rule-strong)', borderRadius: 'var(--radius-nib)',
    backgroundColor: 'var(--depth-0)', color: 'var(--ink)', fontFamily: 'var(--font-source)', fontSize: '13px',
  },
  '.cm-button': {
    height: '30px', padding: '0 15px', margin: '0', border: '1px solid var(--rule-strong)', borderRadius: 'var(--radius-nib)',
    backgroundImage: 'none', backgroundColor: 'transparent', color: 'var(--ink)', fontFamily: 'var(--font-control)', fontSize: '13px', fontWeight: '500',
  },
  '.cm-button:hover': { borderColor: 'var(--ink)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--ink-2)', fontSize: '20px', padding: '0 5px', cursor: 'pointer' },

  // Completions, as a Menu: ink outline, no shadow.
  '.cm-tooltip': { border: '1px solid var(--ink)', borderRadius: 'var(--radius-nib)', backgroundColor: 'var(--depth-0)', color: 'var(--ink)', boxShadow: 'none' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-source)', fontSize: '13px', lineHeight: '20px', maxHeight: '220px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--depth-2)', color: 'var(--ink)' },
  '.cm-completionDetail': { fontFamily: 'var(--font-voice)', fontStyle: 'italic', color: 'var(--ink-2)' },
  '.cm-completionIcon': { display: 'none' },
});

/* ------------------------------------------------------------ completions */

function completions(keys: Props['keys']) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(context.state.doc.lineAt(context.pos).from, context.pos);
    const key = /\\(ref|eqref|autoref|cref|Cref|pageref|nameref|vref|cite[a-zA-Z]*|parencite|textcite|autocite|footcite)\*?(?:\[[^\]]*\])*\{([^}]*)$/.exec(before);
    if (key) {
      const typed = key[2]!.split(',').pop()!.trimStart();
      const cite = /^(cite|parencite|textcite|autocite|footcite)/.test(key[1]!);
      const all = cite ? keys().citations : keys().labels;
      return { from: context.pos - typed.length, options: all.map((label) => ({ label, type: 'text' })), validFor: /^[^},]*$/ };
    }
    const env = /\\(?:begin|end)\{([^}]*)$/.exec(before);
    if (env) return { from: context.pos - env[1]!.length, options: COMMON_ENVIRONMENTS.map((label) => ({ label })), validFor: /^[A-Za-z*]*$/ };
    const command = /\\([A-Za-z]*)$/.exec(before);
    if (command && (command[1]!.length > 0 || context.explicit)) {
      return { from: context.pos - command[1]!.length, options: COMMON_COMMANDS.map((label) => ({ label })), validFor: /^[A-Za-z]*$/ };
    }
    return null;
  };
}

/* -------------------------------------------------------------- component */

export const SourceEditor = forwardRef<SourceEditorHandle, Props>(function SourceEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, { state: EditorState; scroll: number; revision: number; stamp: string | null }>());
  const shown = useRef<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const marginCompartment = useRef(new Compartment());
  const [caretColumn, setCaretColumn] = useState(0);
  const [fit, setFit] = useState({ margin: MARGIN_PX, content: COLUMNS * COLUMN_PX + PAD_PX });
  const showMargin = props.margin && fit.margin > 0;

  const calls = useRef<NoteCallbacks>({ fix: (n) => latest.current.onNoteFix(n), go: (n) => latest.current.onNoteGoto(n) });
  const field = useRef(notesField(calls.current));

  const marginGutter = (): Extension =>
    gutter({ class: 'ol-cm-margin', side: 'after', markers: (v) => v.state.field(field.current).scholia });

  const extensions = (): Extension[] => [
    gutter({ class: 'ol-cm-marks', markers: (v) => v.state.field(field.current).marks, initialSpacer: () => new MarkMarker('note') }),
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches({ minSelectionLength: 3 }),
    search({ top: true }),
    autocompletion({ override: [completions(() => latest.current.keys())], icons: false }),
    EditorView.lineWrapping,
    EditorState.tabSize.of(2),
    latex,
    field.current,
    marginCompartment.current.of(showMargin ? marginGutter() : []),
    theme,
    keymap.of([
      // Compile and save are answered by the workspace, wherever the focus is. Claiming the keys here
      // only stops the editor's own bindings (Ctrl Enter would otherwise insert a blank line).
      { key: 'Mod-Enter', run: () => true },
      { key: 'Shift-Mod-Enter', run: () => true },
      { key: 'Mod-s', run: () => true },
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && shown.current) latest.current.onChange(shown.current, update.state.doc.toString());
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        setCaretColumn(head - line.from);
        latest.current.onCaret({ line: line.number, column: head - line.from, lineText: line.text });
      }
    }),
    EditorView.contentAttributes.of({ 'aria-label': 'LaTeX source', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
  ];

  // Create the view once.
  useLayoutEffect(() => {
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: '', extensions: extensions() }) });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the file named by `path`, keeping every other file's state for when it is shown again.
  useLayoutEffect(() => {
    const v = view.current;
    if (!v) return;
    if (shown.current && shown.current !== props.path) {
      const kept = states.current.get(shown.current);
      if (kept) states.current.set(shown.current, { ...kept, state: v.state, scroll: v.scrollDOM.scrollTop });
    }
    const kept = states.current.get(props.path);
    const fresh = !kept || kept.revision !== props.revision;
    const state = fresh ? EditorState.create({ doc: props.initial, extensions: extensions() }) : kept.state;
    const record = { state, scroll: fresh ? 0 : kept.scroll, revision: props.revision, stamp: fresh ? null : kept.stamp };
    shown.current = props.path;
    v.setState(state);
    const effects: StateEffect<unknown>[] = [
      setReadingNotes.of(latest.current.reading),
      marginCompartment.current.reconfigure(showMargin ? marginGutter() : []),
    ];
    if (record.stamp !== latest.current.compile.stamp) {
      effects.push(setCompileNotes.of(latest.current.compile.notes));
      record.stamp = latest.current.compile.stamp;
    }
    states.current.set(props.path, record);
    v.dispatch({ effects });
    v.scrollDOM.scrollTop = record.scroll;
    const head = v.state.selection.main.head;
    const line = v.state.doc.lineAt(head);
    setCaretColumn(head - line.from);
    latest.current.onCaret({ line: line.number, column: head - line.from, lineText: line.text });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path, props.revision]);

  // A new compile: place its notes on the file being shown. Other files get theirs when they are shown.
  useEffect(() => {
    const v = view.current;
    const record = shown.current ? states.current.get(shown.current) : undefined;
    if (!v || !record || record.stamp === props.compile.stamp) return;
    record.stamp = props.compile.stamp;
    v.dispatch({ effects: setCompileNotes.of(props.compile.notes) });
  }, [props.compile]);

  useEffect(() => {
    view.current?.dispatch({ effects: setReadingNotes.of(props.reading) });
  }, [props.reading]);

  useEffect(() => {
    view.current?.dispatch({ effects: marginCompartment.current.reconfigure(showMargin ? marginGutter() : []) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMargin]);

  // Fit the measure to the pane: the margin gives way first, then the columns.
  useLayoutEffect(() => {
    const el = frame.current!;
    const measure = () => {
      const width = el.clientWidth;
      const full = COLUMNS * COLUMN_PX + PAD_PX;
      const room = width - GUTTER_PX - full;
      const margin = latest.current.margin && room >= MARGIN_MIN_PX ? Math.min(MARGIN_PX, room) : 0;
      const content = Math.max(200, Math.min(full, width - GUTTER_PX - margin));
      setFit((f) => (f.margin === margin && f.content === content ? f : { margin, content }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.margin]);

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    goTo(line, column = 0) {
      const v = view.current;
      if (!v) return;
      const target = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
      const pos = Math.min(target.from + column, target.to);
      v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      v.focus();
    },
    replaceInLine(line, from, to, text) {
      const v = view.current;
      if (!v || line < 1 || line > v.state.doc.lines) return;
      const target = v.state.doc.line(line);
      v.dispatch({ changes: { from: target.from + from, to: Math.min(target.from + to, target.to), insert: text } });
    },
    content: () => view.current?.state.doc.toString() ?? '',
    openSearch() {
      const v = view.current;
      if (!v) return;
      v.focus();
      openSearchPanel(v);
    },
  }), []);

  const columns = Math.floor((fit.content - PAD_PX) / COLUMN_PX);
  return (
    <div ref={frame} className={`ol-editor${showMargin ? '' : ' ol-editor--bare'}`} style={{ '--ol-content': `${fit.content}px`, '--ol-columns': columns } as CSSProperties}>
      <div className="ol-editor__head">
        <MeasureRule columns={columns} caret={caretColumn} />
        {showMargin && <span className="ol-caps ol-editor__margin-head">scholia</span>}
      </div>
      <div ref={host} className="ol-editor__host" />
    </div>
  );
});
