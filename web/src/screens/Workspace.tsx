// The workspace: the source with its margin, the apparatus under it, the proof beside it,
// and whichever of Outline, Files and History are out.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Compile, type FileMeta, type Project, type Version } from '../api/types';
import { useApp } from '../app/context';
import {
  Apparatus, Button, Field, Fig, Headline, Outline, Pane, Rail, State, StatusLine, Tabs, Workspace,
  type Entry, type Heading, type RailModule,
} from '../ds';
import { SourceEditor, type Caret, type SourceEditorHandle } from '../editor/SourceEditor';
import { clock, saveBlob, seconds, shownAs, slug } from '../lib/format';
import {
  compileNotes, describe, headingAt, indexProject, outline, readingNotes, resolvedNote, toneOf, wordCount,
  type MarginNote, type OutlineHeading,
} from '../lib/latex';
import type { PaneKey } from '../lib/prefs';
import { go } from '../lib/router';
import { sayCompile } from '../lib/state';
import { FilesPane } from '../panes/FilesPane';
import { HistoryPane } from '../panes/HistoryPane';
import { PatchView } from '../panes/PatchView';
import { failure, Notice, type NoticeData } from '../parts/Notice';
import { Palette, type PaletteEntry } from '../parts/Palette';
import { ProofView, type SyncMark } from '../proof/ProofView';

/** A text file being edited. */
interface Doc {
  /** The service's version number of the text last loaded or saved. */
  version: number;
  saved: string;
  current: string;
  /** Raised to make the editor start again from `current` (after a restore or a reload). */
  revision: number;
}

interface DiffTab { key: string; version: Version; path: string }

const SIDE_PX = 260;
const MAIN_FULL_PX = 950;
const MAIN_BARE_PX = 670;
const PROOF_MIN_PX = 340;
const PROOF_LEAST_PX = 280;
const MAX_INDEXED_BYTES = 400_000;
const AUTOSAVE_MS = 1500;

function mainWidth(panes: number, side: boolean, proof: boolean): number {
  const room = panes - (side ? SIDE_PX + 1 : 0) - (proof ? 1 : 0);
  if (!proof) return room;
  if (room - MAIN_FULL_PX >= PROOF_MIN_PX) return MAIN_FULL_PX;
  // The margin takes what is left once the proof has its least comfortable width...
  if (room - MAIN_BARE_PX >= PROOF_MIN_PX) return room - PROOF_MIN_PX;
  // ...then the margin goes, and the source keeps its 80 columns for as long as the proof stays usable.
  if (room - MAIN_BARE_PX >= PROOF_LEAST_PX) return MAIN_BARE_PX;
  return Math.max(320, Math.round(room * 0.58));
}

export function WorkspaceScreen({ id }: { id: string }) {
  const { api, info, prefs, setPrefs } = useApp();
  const editor = useRef<SourceEditorHandle>(null);
  const panesEl = useRef<HTMLDivElement>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<DiffTab[]>([]);
  const [compile, setCompile] = useState<Compile | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [edited, setEdited] = useState(false);
  const [pdf, setPdf] = useState<{ data: ArrayBuffer; madeAt: string | null } | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [caret, setCaret] = useState<Caret>({ line: 1, column: 0, lineText: '' });
  const [sync, setSync] = useState<SyncMark | null>(null);
  const [reveal, setReveal] = useState(0);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [palette, setPalette] = useState(false);
  const [rawLog, setRawLog] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [panesWidth, setPanesWidth] = useState(1400);
  /** Raised when text changes, so what is derived from the sources is worked out again. */
  const [sourcesTick, setSourcesTick] = useState(0);
  const [filesTick, setFilesTick] = useState(0);
  /** Raised after each save, so History compares against what the service now holds. */
  const [savedTick, setSavedTick] = useState(0);
  const [unsaved, setUnsaved] = useState<ReadonlySet<string>>(new Set());
  const [words, setWords] = useState(0);
  const [indexed, setIndexed] = useState(false);

  const docs = useRef(new Map<string, Doc>());
  const sources = useRef(new Map<string, string>());
  const saveTimer = useRef<number | undefined>(undefined);
  const tickTimer = useRef<number | undefined>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project;

  const has = (name: string) => info?.modules.some((m) => m.name === name) ?? true;
  const canCompile = has('compile');
  const canHistory = has('history');
  const show = prefs.panes;
  const togglePane = useCallback((key: PaneKey) => setPrefs((p) => ({ ...p, panes: { ...p.panes, [key]: !p.panes[key] } })), [setPrefs]);

  /* ------------------------------------------------------------- loading */

  const loadFiles = useCallback(async () => {
    const listed = await api.listFiles(id);
    setFiles(listed.files);
    setFilesTick((t) => t + 1);
    return listed;
  }, [api, id]);

  const readInto = useCallback(async (path: string, keepRevision?: number) => {
    const file = await api.readText(id, path);
    const previous = docs.current.get(path);
    docs.current.set(path, { version: file.version, saved: file.content, current: file.content, revision: keepRevision ?? (previous ? previous.revision + 1 : 0) });
    sources.current.set(path, file.content);
    return file;
  }, [api, id]);

  /** Read every text file, a few at a time: the outline and the checks on keys need the whole project. */
  const readAll = useCallback(async (list: FileMeta[], force = false) => {
    const queue = list.filter((f) => f.kind === 'text' && f.size <= MAX_INDEXED_BYTES && (force || !docs.current.has(f.path)));
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try { await readInto(f.path); } catch { /* a file that cannot be read is left out of the index */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    for (const path of [...sources.current.keys()]) if (!list.some((f) => f.path === path)) sources.current.delete(path);
    setIndexed(true);
    setSourcesTick((t) => t + 1);
  }, [readInto]);

  const loadProof = useCallback(async (of: Compile | null) => {
    if (!canCompile) return;
    try {
      const data = await api.pdf(id, of?.hasPdf ? of.id : undefined);
      setPdf({ data, madeAt: of?.hasPdf ? (of.finishedAt ?? of.createdAt) : null });
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 404 && err.code !== 'no_pdf')) throw err;
    }
  }, [api, id, canCompile]);

  useEffect(() => {
    let alive = true;
    docs.current = new Map();
    sources.current = new Map();
    setProject(null); setMissing(null); setTabs([]); setActive(null); setDiffs([]); setCompile(null); setPdf(null);
    setPages(null); setSync(null); setNotice(null); setEdited(false); setUnsaved(new Set()); setIndexed(false); setRawLog(null);
    void (async () => {
      try {
        const [loaded, listed] = await Promise.all([api.getProject(id), loadFiles()]);
        if (!alive) return;
        setProject(loaded);
        const first = listed.files.find((f) => f.path === loaded.mainFile && f.kind === 'text') ?? listed.files.find((f) => f.kind === 'text');
        if (first) {
          await readInto(first.path, 0);
          if (!alive) return;
          setTabs([first.path]);
          setActive(first.path);
        }
        void readAll(listed.files);
        if (canCompile) {
          const latest = await api.latestCompile(id).catch(() => null);
          if (!alive) return;
          setCompile(latest);
          await loadProof(latest).catch(() => {});
        }
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setMissing('There is no project at this address. It may have been deleted.');
        else setMissing(err instanceof Error ? err.message : 'The project could not be opened.');
      }
    })();
    return () => { alive = false; window.clearTimeout(saveTimer.current); window.clearTimeout(tickTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id]);

  /* -------------------------------------------------------------- saving */

  const refreshUnsaved = useCallback(() => {
    const next = new Set<string>();
    for (const [path, doc] of docs.current) if (doc.current !== doc.saved) next.add(path);
    setUnsaved((previous) => (previous.size === next.size && [...next].every((p) => previous.has(p)) ? previous : next));
  }, []);

  const saveOne = useCallback(async (path: string, force = false): Promise<void> => {
    const doc = docs.current.get(path);
    if (!doc || doc.current === doc.saved) return;
    const sending = doc.current;
    try {
      const meta = await api.saveText(id, path, sending, force ? {} : { baseVersion: doc.version });
      const now = docs.current.get(path);
      if (now) docs.current.set(path, { ...now, version: meta.version, saved: sending });
      setSavedTick((t) => t + 1);
      setNotice((n) => (n?.tone === 'broken' ? null : n));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict') {
        setNotice({
          tone: 'asks', text: `${path} was changed somewhere else.`,
          detail: 'Keep what is here and it replaces the other change. Load the other and what is here is put aside.',
          actions: [
            { label: 'Keep mine', run: () => { setNotice(null); void saveOne(path, true).then(refreshUnsaved); } },
            { label: 'Load theirs', run: () => { setNotice(null); void readInto(path).then(() => { refreshUnsaved(); setSourcesTick((t) => t + 1); }); } },
          ],
        });
      } else {
        setNotice({ ...failure(err, `save ${path}`), actions: [{ label: 'Try again', run: () => { void saveOne(path).then(refreshUnsaved); } }] });
      }
      throw err;
    }
  }, [api, id, readInto, refreshUnsaved]);

  /** Save everything unsaved, one request after another, and say whether it all went through. */
  const saveAll = useCallback((): Promise<void> => {
    window.clearTimeout(saveTimer.current);
    const next = saving.current.catch(() => {}).then(async () => {
      for (const path of [...docs.current.keys()]) await saveOne(path);
      refreshUnsaved();
    });
    saving.current = next.catch(() => { refreshUnsaved(); });
    return next;
  }, [saveOne, refreshUnsaved]);

  const onChange = useCallback((path: string, content: string) => {
    const doc = docs.current.get(path);
    if (!doc) return;
    doc.current = content;
    sources.current.set(path, content);
    setEdited(true);
    refreshUnsaved();
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveAll().catch(() => {}); }, AUTOSAVE_MS);
    window.clearTimeout(tickTimer.current);
    tickTimer.current = window.setTimeout(() => setSourcesTick((t) => t + 1), 350);
  }, [refreshUnsaved, saveAll]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if ([...docs.current.values()].some((d) => d.current !== d.saved)) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  /* ------------------------------------------------------------- compile */

  const compilingNow = useRef(false);
  const runCompile = useCallback(async (options: { clean?: boolean } = {}) => {
    if (compilingNow.current || !canCompile) return;
    compilingNow.current = true;
    setCompiling(true);
    setRawLog(null);
    try {
      await saveAll();
      const result = await api.compile(id, options.clean ? { clean: true, force: true } : {});
      setCompile(result);
      setEdited(false);
      if (result.hasPdf) await loadProof(result);
      setFilesTick((t) => t + 1);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'version_conflict')) setNotice(failure(err, 'compile'));
    } finally {
      compilingNow.current = false;
      setCompiling(false);
    }
  }, [api, id, canCompile, saveAll, loadProof]);

  // Compile a moment after a save, if that is asked for.
  const autoTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!prefs.autoCompile || !edited || compiling || unsaved.size > 0) return;
    autoTimer.current = window.setTimeout(() => { void runCompile(); }, 1200);
    return () => window.clearTimeout(autoTimer.current);
  }, [prefs.autoCompile, edited, compiling, unsaved, runCompile]);

  // Keep the page count with the project, so the Library can show it.
  const onPages = useCallback((count: number) => {
    setPages(count);
    const current = projectRef.current;
    const known = (current?.settings.openleaf as { pages?: number } | undefined)?.pages;
    if (current && known !== count) void api.patchProject(id, { settings: { openleaf: { pages: count } } }).then(setProject).catch(() => {});
  }, [api, id]);

  /* -------------------------------------------------------- derived data */

  const index = useMemo(() => indexProject(sources.current), [sourcesTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const headings: OutlineHeading[] = useMemo(
    () => (project ? outline(sources.current, project.mainFile) : []),
    [sourcesTick, project?.mainFile], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const paths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const activeDoc = active ? docs.current.get(active) : undefined;
  const activeDiff = diffs.find((d) => d.key === active) ?? null;

  const diagnostics = compile?.diagnostics ?? [];
  const compileStamp = compile?.id ?? 'none';
  const compileForFile = useMemo(
    () => ({ stamp: `${compileStamp}:${active ?? ''}`, notes: active && activeDoc ? compileNotes(active, activeDoc.saved, diagnostics) : [] }),
    [compileStamp, active, activeDoc !== undefined], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const reading: MarginNote[] = useMemo(() => {
    if (!active || !activeDoc || !indexed) return [];
    const notes = readingNotes(active, activeDoc.current, index, paths);
    const here = resolvedNote(active, caret.line, caret.lineText, index);
    if (here && !notes.some((n) => n.line === here.line)) notes.push(here);
    return notes;
  }, [active, activeDoc, indexed, index, paths, caret.line, caret.lineText, sourcesTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setTimeout(() => setWords(wordCount(activeDoc?.current ?? '')), 400);
    return () => window.clearTimeout(timer);
  }, [activeDoc, sourcesTick]);

  const entries: Entry[] = useMemo(() => {
    const weight = { error: 0, warning: 1, typesetting: 2 } as const;
    return diagnostics
      .map((d, i) => ({ d, i }))
      .sort((a, b) => weight[a.d.level] - weight[b.d.level] || (a.d.file ?? '').localeCompare(b.d.file ?? '') || (a.d.line ?? 0) - (b.d.line ?? 0))
      .map(({ d, i }) => {
        const said = describe(d);
        return { key: String(i), tone: toneOf(d.level), line: d.line, lemma: said.lemma, note: said.sentence, file: d.file };
      });
  }, [diagnostics]);

  const outlineItems: Heading[] = useMemo(() => {
    const flagged = new Map<string, 'broken' | 'asks'>();
    for (const d of diagnostics) {
      if (!d.file || d.line === null || d.level === 'typesetting') continue;
      const h = headingAt(headings, d.file, d.line);
      if (!h) continue;
      if (d.level === 'error') flagged.set(h.id, 'broken');
      else if (!flagged.has(h.id)) flagged.set(h.id, 'asks');
    }
    return headings.map((h) => ({ id: h.id, number: h.number, title: h.title, depth: h.depth, tone: flagged.get(h.id) }));
  }, [headings, diagnostics]);
  const hereHeading = active ? headingAt(headings, active, caret.line) : null;

  const said = compiling ? { tone: 'asks' as const, words: 'Compiling' } : sayCompile(compile, { time: true });
  const stale = pdf !== null && (edited || unsaved.size > 0 || (compile !== null && compile.status !== 'success'));
  const errors = compile?.errorCount ?? 0;
  const warnings = compile?.warningCount ?? 0;

  /* ----------------------------------------------------------- navigation */

  const openFile = useCallback(async (path: string, line?: number, column?: number) => {
    try {
      if (!docs.current.has(path)) await readInto(path, 0);
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      setActive(path);
      if (line !== undefined) window.setTimeout(() => editor.current?.goTo(line, column), 30);
      else window.setTimeout(() => editor.current?.focus(), 30);
    } catch (err) {
      setNotice(failure(err, `open ${path}`));
    }
  }, [readInto]);

  const openMeta = useCallback((file: FileMeta) => {
    if (file.kind === 'text') { void openFile(file.path); return; }
    // A picture or a PDF is shown by the browser in its own tab, as the type its name says and
    // never as whatever the bytes claim to be. Anything else is handed over as a download.
    void api.readRaw(id, file.path)
      .then((blob) => {
        const type = shownAs(file.path);
        if (!type) { saveBlob(blob, file.path.slice(file.path.lastIndexOf('/') + 1)); return; }
        const url = URL.createObjectURL(new Blob([blob], { type }));
        window.open(url, '_blank', 'noopener');
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch((err: unknown) => setNotice(failure(err, `open ${file.path}`)));
  }, [api, id, openFile]);

  const closeTab = useCallback((name: string) => {
    setDiffs((d) => d.filter((x) => x.key !== name));
    setTabs((t) => {
      const next = t.filter((x) => x !== name);
      setActive((a) => (a === name ? next[Math.max(0, t.indexOf(name) - 1)] ?? null : a));
      return next;
    });
  }, []);

  const afterFilesChanged = useCallback(async (opts: { reread?: boolean } = {}) => {
    const listed = await loadFiles();
    const there = new Set(listed.files.map((f) => f.path));
    for (const path of [...docs.current.keys()]) if (!there.has(path)) docs.current.delete(path);
    setTabs((t) => {
      const next = t.filter((x) => there.has(x) || x.includes(' @ '));
      setActive((a) => (a && (there.has(a) || a.includes(' @ ')) ? a : next[0] ?? null));
      return next;
    });
    await readAll(listed.files, opts.reread);
    refreshUnsaved();
    setProject(await api.getProject(id));
  }, [api, id, loadFiles, readAll, refreshUnsaved]);

  /* ------------------------------------------------------- source ⇄ proof */

  useEffect(() => {
    if (!active || activeDiff || !compile?.hasSynctex || edited || !pdf) { setSync(null); return; }
    const timer = window.setTimeout(() => {
      api.synctexForward(id, { file: active, line: caret.line, column: caret.column })
        .then((positions) => { const p = positions[0]; setSync(p ? { page: p.page, v: p.v + p.height / 2 } : null); })
        .catch(() => setSync(null));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [api, id, active, activeDiff, caret.line, compile, edited, pdf]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPick = useCallback((page: number, h: number, v: number) => {
    api.synctexInverse(id, { page, h, v })
      .then((place) => { if (place) void openFile(place.file, place.line, place.column); })
      .catch(() => {});
  }, [api, id, openFile]);

  /* ----------------------------------------------------------------- keys */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k' || (key === 'p' && e.shiftKey)) { e.preventDefault(); setPalette((p) => !p); }
      else if (key === 'enter') { e.preventDefault(); void runCompile({ clean: e.shiftKey }); }
      else if (key === 's') { e.preventDefault(); void saveAll().catch(() => {}); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runCompile, saveAll]);

  useLayoutEffect(() => {
    const el = panesEl.current;
    if (!el) return;
    const measure = () => setPanesWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [project !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  /* -------------------------------------------------------------- palette */

  const paletteEntries = useMemo((): PaletteEntry[] => {
    const pane = (key: PaneKey, name: string): PaletteEntry => ({ group: 'commands', label: `${show[key] ? 'Put away' : 'Bring out'} ${name}`, run: () => togglePane(key) });
    const commands: PaletteEntry[] = [
      { group: 'commands', label: 'Compile', keys: 'Ctrl Enter', run: () => void runCompile() },
      { group: 'commands', label: 'Compile from scratch', keys: 'Ctrl Shift Enter', run: () => void runCompile({ clean: true }) },
      { group: 'commands', label: 'Save', keys: 'Ctrl S', run: () => void saveAll().catch(() => {}) },
      { group: 'commands', label: 'Find in this file', keys: 'Ctrl F', run: () => editor.current?.openSearch() },
      { group: 'commands', label: 'Find this line in the proof', run: () => setReveal((r) => r + 1) },
      pane('proof', 'the Proof'), pane('apparatus', 'the Apparatus'), pane('outline', 'the Outline'), pane('files', 'Files'),
      ...(canHistory ? [pane('history', 'History')] : []), pane('margin', 'the margin'),
      { group: 'commands', label: 'Download the proof', run: () => pdf && project && saveBlob(new Blob([pdf.data], { type: 'application/pdf' }), `${slug(project.name)}.pdf`) },
      { group: 'commands', label: 'Download the project as a zip', run: () => void api.exportZip(id).then((b) => saveBlob(b, `${slug(project?.name ?? 'project')}.zip`)).catch((err: unknown) => setNotice(failure(err, 'download the project'))) },
      { group: 'commands', label: 'Daylight', run: () => setPrefs((p) => ({ ...p, theme: 'light' })) },
      { group: 'commands', label: 'Lamplight', run: () => setPrefs((p) => ({ ...p, theme: 'dark' })) },
      { group: 'commands', label: 'Go to the Library', run: () => go({ name: 'library' }) },
      { group: 'commands', label: 'Go to Modules', run: () => go({ name: 'modules' }) },
    ];
    return [
      ...commands,
      ...files.filter((f) => f.kind === 'text').map((f): PaletteEntry => ({ group: 'files', label: f.path, run: () => void openFile(f.path) })),
      ...headings.map((h): PaletteEntry => ({ group: 'sections', label: `${h.number ? `§${h.number} ` : ''}${h.title}`, run: () => void openFile(h.file, h.line) })),
      ...[...index.labels].map(([key, place]): PaletteEntry => ({ group: 'labels', label: key, run: () => void openFile(place.file, place.line) })),
    ];
  }, [show, togglePane, runCompile, saveAll, canHistory, pdf, project, api, id, setPrefs, files, headings, index, openFile]);

  /* --------------------------------------------------------------- render */

  if (missing) {
    return (
      <div className="ol-screen">
        <Rail modules={[{ letter: 'L', label: 'Library' }]} foot={[{ letter: 'M', label: 'Modules' }]} onSelect={(l) => go({ name: l === 'M' ? 'modules' : 'library' })} />
        <main className="ol-screen__page">
          <h1 className="ol-screen__title">Not here</h1>
          <p className="ol-screen__lede">{missing}</p>
          <div className="ol-screen__bar"><Button variant="ink" onClick={() => go({ name: 'library' })}>Back to the Library</Button></div>
        </main>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="ol-screen">
        <Rail modules={[{ letter: 'L', label: 'Library' }]} foot={[{ letter: 'M', label: 'Modules' }]} onSelect={(l) => go({ name: l === 'M' ? 'modules' : 'library' })} />
        <main className="ol-screen__page"><p className="ol-screen__lede">Opening the project.</p></main>
      </div>
    );
  }

  const sideOut = show.outline || show.files || (show.history && canHistory);
  const proofOut = show.proof && canCompile;
  const apparatusOut = show.apparatus && canCompile;

  const modules: RailModule[] = [
    { letter: 'S', label: 'Source' },
    { letter: 'P', label: 'Proof', off: !proofOut, tone: stale ? 'asks' : undefined },
    { letter: 'A', label: 'Apparatus', off: !apparatusOut, tone: errors ? 'broken' : warnings ? 'asks' : undefined },
    { letter: 'O', label: 'Outline', off: !show.outline },
    { letter: 'F', label: 'Files', off: !show.files, tone: unsaved.size ? 'asks' : undefined },
    { letter: 'H', label: 'History', off: !(show.history && canHistory) },
    { letter: 'C', label: 'Counsel', off: true },
  ];
  const onRail = (letter: string) => {
    if (letter === 'S') editor.current?.focus();
    else if (letter === 'P') togglePane('proof');
    else if (letter === 'A') togglePane('apparatus');
    else if (letter === 'O') togglePane('outline');
    else if (letter === 'F') togglePane('files');
    else if (letter === 'H') { if (canHistory) togglePane('history'); else setNotice({ tone: 'note', text: 'History is switched off on this service.' }); }
    else if (letter === 'C') setNotice({ tone: 'note', text: 'Counsel is not built yet.', detail: 'It needs a model link on the service. Its notes will be set in the margin, like every other.' });
    else if (letter === 'L') go({ name: 'library' });
    else if (letter === 'M') go({ name: 'modules' });
  };

  const tabList = tabs.map((name) => ({
    name,
    tone: name.includes(' @ ') ? undefined
      : unsaved.has(name) ? ('asks' as const)
      : diagnostics.some((d) => d.file === name && d.level === 'error') ? ('broken' as const) : undefined,
  }));

  const sourcePane = (
    <Pane
      letter="S" title="Source"
      meta={activeDiff ? `${activeDiff.path} · since ${clock(activeDiff.version.createdAt)}` : active ? `${active} · l. ${caret.line}, c. ${caret.column}` : ''}
      actions={!activeDiff && active && (
        <>
          <Button variant="bare" onClick={() => editor.current?.openSearch()}>Find</Button>
          {proofOut && pdf && <Button variant="bare" onClick={() => setReveal((r) => r + 1)} disabled={!sync} title={sync ? undefined : 'Compile first; the proof and the source must match'}>In proof</Button>}
          <Button variant="bare" onClick={() => togglePane('margin')}>{show.margin ? 'Hide margin' : 'Margin'}</Button>
        </>
      )}
    >
      <div className="ol-source-pane">
        <Tabs tabs={tabList} active={active ?? undefined} onSelect={setActive} onClose={closeTab} />
        <div className="ol-source-pane__body">
          {activeDiff ? (
            <div className="ol-pane__scroll"><PatchView api={api} projectId={id} versionId={activeDiff.version.id} path={activeDiff.path} /></div>
          ) : active && activeDoc ? (
            <SourceEditor
              ref={editor} path={active} initial={activeDoc.current} revision={activeDoc.revision}
              compile={compileForFile} reading={reading} margin={show.margin}
              onChange={onChange} onCaret={setCaret}
              onNoteFix={(note) => { if (note.fix && note.from !== undefined && note.to !== undefined) editor.current?.replaceInLine(note.line, note.from, note.to, note.fix.replace); }}
              onNoteGoto={(note) => { if (note.goto) void openFile(note.goto.file, note.goto.line); }}
              keys={() => ({ labels: [...index.labels.keys()], citations: [...index.bibliography.keys()] })}
            />
          ) : (
            <p className="ol-empty">{files.some((f) => f.kind === 'text') ? 'Open a file from Files.' : 'This project has no text files yet. Make one in Files.'}</p>
          )}
        </div>
      </div>
    </Pane>
  );

  const apparatusPane = apparatusOut && (
    <Pane
      letter="A" title="Apparatus" ground="well" tone={errors ? 'broken' : warnings ? 'asks' : undefined}
      meta={compile ? [compile.engine, clock(compile.finishedAt ?? compile.createdAt), seconds(compile.durationMs), compile.cached ? 'unchanged' : ''].filter(Boolean).join(' · ') : ''}
      actions={
        <>
          {errors > 0 && <State tone="broken"><Fig>{errors}</Fig></State>}
          {warnings > 0 && <State tone="asks"><Fig>{warnings}</Fig></State>}
          {compile && (
            <Button
              variant="bare"
              onClick={() => {
                if (rawLog !== null) setRawLog(null);
                else void api.log(id, compile.id).then(setRawLog).catch((err: unknown) => setNotice(failure(err, 'read the log')));
              }}
            >{rawLog !== null ? 'Notes' : 'Raw log'}</Button>
          )}
        </>
      }
    >
      <div className="ol-apparatus-pane">
        {rawLog !== null ? <pre className="ol-log">{rawLog || 'The log is empty.'}</pre>
          : compiling ? <p className="ol-apparatus-pane__none">Compiling. A sleeping service takes a minute to start.</p>
          : !compile ? <p className="ol-apparatus-pane__none">Nothing yet. Compile, and what the compiler says is set here.</p>
          : entries.length === 0 ? <p className="ol-apparatus-pane__none">{compile.message ?? 'Nothing to report.'}</p>
          : <Apparatus entries={entries} onSelect={(e) => { if (e.file && paths.has(e.file)) void openFile(e.file, e.line ?? undefined); }} />}
      </div>
    </Pane>
  );

  const proofPane = proofOut && (
    <Pane
      letter="P" title="Proof" ground="desk" tone={stale ? 'asks' : undefined}
      meta={pdf ? [pages ? `${pages} pp` : '', pdf.madeAt ? `of ${clock(pdf.madeAt)}` : ''].filter(Boolean).join(' · ') : ''}
      actions={pdf && (
        <>
          {stale && <State tone="asks">Stale</State>}
          <Button variant="bare" onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))} title="Smaller">−</Button>
          <Button variant="bare" onClick={() => setZoom(1)} title="Fit the width">Fit</Button>
          <Button variant="bare" onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))} title="Larger">+</Button>
          <Button variant="bare" onClick={() => saveBlob(new Blob([pdf.data], { type: 'application/pdf' }), `${slug(project.name)}.pdf`)}>Download</Button>
        </>
      )}
    >
      <ProofView
        data={pdf?.data ?? null} zoom={zoom} sync={stale ? null : sync} reveal={reveal} onPages={onPages}
        onPick={compile?.hasSynctex ? onPick : undefined}
        empty={<p className="ol-empty">{compiling ? 'The first proof is being made.' : api.kind === 'sample' && compile ? 'The sample library cannot run LaTeX, so this project has no proof.' : 'No proof yet. Compile, and the pages are laid here.'}</p>}
      />
    </Pane>
  );

  const side = sideOut && (
    <>
      {show.outline && (
        <Pane letter="O" title="Outline" meta={headings.length ? String(headings.length) : ''}>
          <div className="ol-pane__scroll">
            {headings.length === 0
              ? <p className="ol-empty ol-empty--pane">{indexed ? 'No sections yet. The first \\section appears here.' : 'Reading the project.'}</p>
              : <Outline items={outlineItems} active={hereHeading?.id} onSelect={(h) => { const target = headings.find((x) => x.id === h.id); if (target) void openFile(target.file, target.line); }} />}
          </div>
        </Pane>
      )}
      {show.files && (
        <FilesPane
          files={files} mainFile={project.mainFile} active={active && !activeDiff ? active : null} unsaved={unsaved}
          onOpen={openMeta}
          onCreateFile={async (path) => { await api.saveText(id, path, '', { createOnly: true }); await afterFilesChanged(); await openFile(path); }}
          onCreateFolder={async (path) => { await api.createFolder(id, path); await afterFilesChanged(); }}
          onMove={async (from, to) => {
            await saveAll();
            await api.movePath(id, from, to);
            for (const path of [...docs.current.keys()]) {
              if (path !== from && !path.startsWith(`${from}/`)) continue;
              const moved = to + path.slice(from.length);
              docs.current.set(moved, docs.current.get(path)!);
              docs.current.delete(path);
              sources.current.set(moved, sources.current.get(path) ?? '');
              sources.current.delete(path);
            }
            const rename = (p: string) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
            setTabs((t) => t.map(rename));
            setActive((a) => (a ? rename(a) : a));
            await afterFilesChanged();
          }}
          onDelete={async (path) => { await api.deletePath(id, path); await afterFilesChanged(); }}
          onSetRoot={async (path) => { setProject(await api.patchProject(id, { mainFile: path })); setSourcesTick((t) => t + 1); }}
          onUpload={async (picked, folder) => { await api.upload(id, picked, folder || undefined); await afterFilesChanged({ reread: true }); }}
          onDownload={(path) => void api.readRaw(id, path).then((b) => saveBlob(b, path.slice(path.lastIndexOf('/') + 1))).catch((err: unknown) => setNotice(failure(err, `download ${path}`)))}
        />
      )}
      {show.history && canHistory && (
        <HistoryPane
          api={api} projectId={id} projectName={project.name} tick={filesTick + savedTick}
          beforeAction={saveAll}
          onDiff={(version, path) => {
            const key = `${path} @ ${clock(version.createdAt)}`;
            setDiffs((d) => (d.some((x) => x.key === key) ? d : [...d, { key, version, path }]));
            setTabs((t) => (t.includes(key) ? t : [...t, key]));
            setActive(key);
          }}
          onRestored={async () => { await afterFilesChanged({ reread: true }); setEdited(true); }}
        />
      )}
    </>
  );

  return (
    <>
      <Workspace
        panesRef={panesEl}
        sideWidth={SIDE_PX}
        mainWidth={mainWidth(panesWidth, !!sideOut, !!proofOut)}
        rail={<Rail active="S" modules={modules} foot={[{ letter: 'L', label: 'Library' }, { letter: 'M', label: 'Modules' }]} onSelect={onRail} />}
        headline={
          <Headline
            onHome={() => go({ name: 'library' })}
            name={renaming === null
              ? <button type="button" className="ol-headline__rename" title="Rename" onClick={() => setRenaming(project.name)}>{project.name}</button>
              : (
                <form className="ol-headline__form" onSubmit={(e) => {
                  e.preventDefault();
                  const name = renaming.trim();
                  setRenaming(null);
                  if (name && name !== project.name) void api.patchProject(id, { name }).then(setProject).catch((err: unknown) => setNotice(failure(err, 'rename the project')));
                }}>
                  <Field label="Title" value={renaming} onChange={setRenaming} autoFocus onEscape={() => setRenaming(null)} />
                </form>
              )}
            meta={`${project.mainFile} · ${project.engine}`}
          >
            {canCompile && <State tone={said.tone}>{said.words}</State>}
            <Button variant="bare" onClick={() => setPalette(true)} title="Commands, files and labels">Go to</Button>
            {canCompile && <Button variant="compile" keys="Ctrl Enter" disabled={compiling} onClick={() => void runCompile()}>{compiling ? 'Compiling' : 'Compile'}</Button>}
          </Headline>
        }
        side={side || undefined}
        main={<>{notice && <Notice notice={notice} onDismiss={() => setNotice(null)} />}{sourcePane}</>}
        under={apparatusPane || undefined}
        proof={proofPane || undefined}
        status={
          <StatusLine
            end={
              <>
                <State tone={api.kind === 'sample' ? 'note' : 'settled'}>{api.kind === 'sample' ? 'Sample library' : 'Service awake'}</State>
                {active && !activeDiff && <Fig>l. {caret.line}, c. {caret.column}</Fig>}
                {active && !activeDiff && <Fig>{words.toLocaleString('en-GB')} words</Fig>}
              </>
            }
          >
            {unsaved.size > 0 ? <State tone="asks"><Fig>{unsaved.size}</Fig> unsaved</State> : <State tone="settled">Saved</State>}
            {errors > 0 && <State tone="broken"><Fig>{errors}</Fig></State>}
            {warnings > 0 && <State tone="asks"><Fig>{warnings}</Fig></State>}
            {hereHeading && <span>{hereHeading.number ? <Fig>§{hereHeading.number}</Fig> : null} {hereHeading.title}</span>}
          </StatusLine>
        }
      />
      {palette && <Palette entries={paletteEntries} onClose={() => { setPalette(false); window.setTimeout(() => editor.current?.focus(), 0); }} />}
    </>
  );
}
