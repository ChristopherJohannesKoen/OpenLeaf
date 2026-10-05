// The OpenLeaf design system's components, as the app uses them.
// Every class here is styled by src/styles/openleaf.css from src/styles/tokens.css.
// Rules of the system (see the design system's brand book): no icons, no shadows, one 20px line,
// four marks, nine sigla, and bronze for the Compile button alone.
import * as React from 'react';
import type { ReactNode } from 'react';

export type Tone = 'settled' | 'asks' | 'broken' | 'note' | 'counsel' | 'here';
type SiglumTone = 'settled' | 'asks' | 'broken';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ marks */

const GLYPH: Record<Tone, string> = { broken: '†', asks: '*', note: '›', counsel: '›', here: '›', settled: '' };
const SAID: Record<Tone, string> = { broken: 'Broken', asks: 'Asks', note: 'Note', counsel: 'Counsel', here: 'Here', settled: 'Settled' };

/** One of the four editorial marks: obelus (broken), asterisk (asks), diple (note, counsel, here), halmos (settled). */
export function Mark({ tone = 'note', label }: { tone?: Tone; label?: string }) {
  return (
    <span className={cx('ol-mark', 'ol-mark--' + tone)} role="img" aria-label={label || SAID[tone]}>
      {GLYPH[tone]}
    </span>
  );
}

/** A mark and the words that go with it. The words carry the meaning; the mark and colour repeat it. */
export function State({ tone = 'note', children }: { tone?: Exclude<Tone, 'here'>; children?: ReactNode }) {
  return (
    <span className={cx('ol-state', 'ol-state--' + tone)}>
      <Mark tone={tone} />
      <span>{children}</span>
    </span>
  );
}

/** Numbers, times, paths and anything else counted or addressed: set in the source face. */
export function Fig({ children }: { children?: ReactNode }) {
  return <span className="ol-fig">{children}</span>;
}

/** A module's letter in a square. With onClick it is a button. `off`: the module is put away. */
export function Siglum(props: {
  letter: string; label: string; tone?: SiglumTone; active?: boolean; off?: boolean;
  size?: 'line' | 'rail'; onClick?: () => void;
}) {
  const { letter, label, tone, active, off, size = 'line', onClick } = props;
  const className = cx(
    'ol-siglum', size === 'rail' && 'ol-siglum--rail',
    tone && !off && 'ol-siglum--' + tone, off && 'ol-siglum--off', active && !off && 'ol-siglum--active',
  );
  const said = [label, tone && !off ? SAID[tone].toLowerCase() : '', off ? 'put away' : ''].filter(Boolean).join(', ');
  return onClick
    ? <button type="button" className={className} aria-label={said} aria-pressed={!off} title={said} onClick={onClick}>{letter}</button>
    : <span className={className} role="img" aria-label={said} title={said}>{letter}</span>;
}

/* --------------------------------------------------------------- identity */

/** The name set in the voice face: Open roman, Leaf italic. `mark` adds the leaf; `words={false}` leaves the leaf alone. */
export function Wordmark({ size = 'name', mark = true, words = true }: { size?: 'name' | 'title' | 'display'; mark?: boolean; words?: boolean }) {
  return (
    <span className={cx('ol-wordmark', size !== 'name' && 'ol-wordmark--' + size)} role="img" aria-label="OpenLeaf">
      {(mark || !words) && <span className="ol-leafmark" aria-hidden="true" />}
      {words && <span aria-hidden="true">Open<i>Leaf</i></span>}
    </span>
  );
}

/* ---------------------------------------------------------------- actions */

/** quiet (default), ink, compile, danger, bare. `keys` shows a shortcut inside the button. */
export function Button(props: {
  variant?: 'quiet' | 'ink' | 'compile' | 'danger' | 'bare'; keys?: string; armed?: boolean;
  disabled?: boolean; type?: 'button' | 'submit'; title?: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: ReactNode;
}) {
  const { variant = 'quiet', keys, armed, disabled, type = 'button', title, onClick, children } = props;
  return (
    <button
      type={type} disabled={disabled} onClick={onClick} title={title}
      className={cx('ol-button', variant !== 'quiet' && 'ol-button--' + variant, armed && 'ol-button--armed')}
    >
      <span>{children}</span>
      {keys && <span className="ol-key">{keys}</span>}
    </button>
  );
}

/** A labelled text field. `source` sets what is typed in mono (paths, ids, addresses). `error` replaces the hint. */
export function Field(props: {
  label: string; value?: string; placeholder?: string; hint?: ReactNode; error?: ReactNode; source?: boolean;
  type?: string; name?: string; autoComplete?: string; autoFocus?: boolean; disabled?: boolean;
  onChange?: (value: string) => void; onEnter?: () => void; onEscape?: () => void;
}) {
  const { label, value, placeholder, hint, error, source, type = 'text', name, autoComplete, autoFocus, disabled, onChange, onEnter, onEscape } = props;
  const id = React.useId();
  return (
    <div className={cx('ol-field', !!error && 'ol-field--broken')}>
      <label className="ol-field__label" htmlFor={id}>{label}</label>
      <input
        id={id} type={type} name={name} value={value} placeholder={placeholder} disabled={disabled}
        autoComplete={autoComplete} autoFocus={autoFocus} spellCheck={false}
        readOnly={value !== undefined && !onChange}
        aria-invalid={!!error} aria-describedby={hint || error ? id + '-hint' : undefined}
        className={cx('ol-field__input', source && 'ol-field__input--source')}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); }
          if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); }
        }}
      />
      {(error || hint) && (
        <span className="ol-field__hint" id={id + '-hint'} role={error ? 'alert' : undefined}>
          {error && <Mark tone="broken" />}
          <span>{error || hint}</span>
        </span>
      )}
    </div>
  );
}

/** On or off, said in a word as well as shown. */
export function Switch(props: { label: string; checked?: boolean; disabled?: boolean; onChange?: (checked: boolean) => void }) {
  const { label, checked, disabled, onChange } = props;
  return (
    <label className="ol-switch">
      <input
        className="ol-switch__input" type="checkbox" role="switch" checked={!!checked} disabled={disabled}
        aria-label={label} onChange={(e) => onChange && onChange(e.target.checked)}
      />
      <span className="ol-switch__track" aria-hidden="true" />
      <span className="ol-caps ol-switch__state" aria-hidden="true">{checked ? 'on' : 'off'}</span>
    </label>
  );
}

export type MenuItem = {
  label?: string; keys?: string; tone?: 'broken'; active?: boolean; heading?: string; rule?: boolean;
  disabled?: boolean; onSelect?: () => void;
};

/** A menu or, with `query`, the command palette. Outlined in ink; it casts no shadow. */
export function Menu(props: {
  items: MenuItem[]; query?: string; placeholder?: string; onQuery?: (query: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void; autoFocus?: boolean; width?: number;
}) {
  const { items, query, placeholder, onQuery, onKeyDown, autoFocus, width } = props;
  return (
    <div className="ol-menu" role="menu" style={width ? { width } : undefined} onKeyDown={onKeyDown}>
      {query !== undefined && (
        <div className="ol-menu__query">
          <Mark tone="note" />
          <input
            className="ol-menu__input" value={query} placeholder={placeholder} readOnly={!onQuery} aria-label="Search"
            autoFocus={autoFocus} spellCheck={false} onChange={(e) => onQuery && onQuery(e.target.value)}
          />
        </div>
      )}
      {items.map((item, i) =>
        item.rule ? <div key={i} className="ol-menu__rule" role="separator" />
        : item.heading ? <div key={i} className="ol-caps ol-menu__head">{item.heading}</div>
        : (
          <button
            key={i} type="button" role="menuitem" disabled={item.disabled} onClick={item.onSelect}
            className={cx('ol-menu__item', item.active && 'ol-menu__item--active', item.tone === 'broken' && 'ol-menu__item--broken')}
            ref={item.active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
          >
            <span className="ol-menu__label">{item.label}</span>
            {item.keys && <span className="ol-menu__keys">{item.keys}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** The deliberate step before anything that cannot be undone. Replaces the row it concerns; never a modal. */
export function Confirm(props: {
  question: string; detail?: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean;
  onConfirm?: () => void; onCancel?: () => void;
}) {
  const { question, detail, confirmLabel, cancelLabel = 'Keep', danger = true, onConfirm, onCancel } = props;
  return (
    <div className="ol-confirm" role="alertdialog" aria-label={question} onKeyDown={(e) => { if (e.key === 'Escape') onCancel?.(); }}>
      <div className="ol-confirm__words">
        <p className="ol-confirm__question">{question}</p>
        {detail && <p className="ol-confirm__detail">{detail}</p>}
      </div>
      <div className="ol-confirm__actions">
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={danger ? 'danger' : 'ink'} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- workspace */

export type RailModule = { letter: string; label: string; tone?: SiglumTone; off?: boolean };

/** The module rail: one siglum per module. The active one is inked in; one that is put away is dashed. */
export function Rail(props: { modules: RailModule[]; active?: string; foot?: RailModule[]; onSelect?: (letter: string) => void }) {
  const { modules, active, foot = [], onSelect } = props;
  const one = (m: RailModule) => (
    <Siglum key={m.letter} size="rail" letter={m.letter} label={m.label} tone={m.tone} off={m.off} active={m.letter === active} onClick={() => onSelect && onSelect(m.letter)} />
  );
  return (
    <nav className="ol-rail" aria-label="Modules">
      {modules.map(one)}
      {foot.length > 0 && <div className="ol-rail__foot">{foot.map(one)}</div>}
    </nav>
  );
}

/** The top line of the workspace: the leaf, the document, where it lives, and what is asked of it. */
export function Headline(props: { name: ReactNode; meta?: ReactNode; onHome?: () => void; children?: ReactNode }) {
  const { name, meta, onHome, children } = props;
  return (
    <header className="ol-headline">
      {onHome
        ? <button type="button" className="ol-headline__home" onClick={onHome} title="Library" aria-label="Library"><Wordmark words={false} /></button>
        : <Wordmark words={false} />}
      <span className="ol-headline__name">{name}</span>
      {meta && <span className="ol-fig ol-headline__meta">{meta}</span>}
      <div className="ol-headline__end">{children}</div>
    </header>
  );
}

/** One module in the workspace: siglum, name, an address in mono, a few bare actions, then the body. */
export function Pane(props: {
  letter: string; title: string; meta?: ReactNode; actions?: ReactNode; ground?: 'writing' | 'chrome' | 'desk' | 'well';
  tone?: SiglumTone; className?: string; children?: ReactNode;
}) {
  const { letter, title, meta, actions, ground = 'writing', tone, className, children } = props;
  return (
    <section className={cx('ol-pane', ground !== 'writing' && 'ol-pane--' + ground, className)} aria-label={title}>
      <header className="ol-pane__head">
        <Siglum letter={letter} label={title} tone={tone} />
        <h2 className="ol-pane__title">{title}</h2>
        {meta && <span className="ol-fig ol-pane__meta">{meta}</span>}
        {actions && <div className="ol-pane__actions">{actions}</div>}
      </header>
      <div className="ol-pane__body">{children}</div>
    </section>
  );
}

export type Tab = { name: string; tone?: 'asks' | 'broken' };

/** Open files. Names are addresses, so they are set in mono; a mark before the name says its state. */
export function Tabs(props: { tabs: Tab[]; active?: string; onSelect?: (name: string) => void; onClose?: (name: string) => void }) {
  const { tabs, active, onSelect, onClose } = props;
  return (
    <div className="ol-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.name} type="button" role="tab" aria-selected={t.name === active}
          className={cx('ol-tab', t.name === active && 'ol-tab--active')}
          onClick={() => onSelect && onSelect(t.name)}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose?.(t.name); } }}
        >
          {t.tone && <Mark tone={t.tone} label={t.tone === 'asks' ? 'Unsaved' : 'Broken'} />}
          <span>{t.name}</span>
          {t.name === active && (
            <span className="ol-tab__close" role="button" aria-label={'Close ' + t.name} onClick={(e) => { e.stopPropagation(); onClose && onClose(t.name); }}>×</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** The ruler over the source column: a tick every two columns, a numbered one every `step`, the caret's column in bronze. */
export function MeasureRule({ columns = 80, step = 10, caret }: { columns?: number; step?: number; caret?: number }) {
  const numbers: number[] = [];
  for (let n = 0; n < columns; n += step) numbers.push(n);
  return (
    <div className="ol-measure" style={{ '--ol-columns': columns } as React.CSSProperties} aria-hidden="true">
      {numbers.map((n) => (
        <span key={n} className="ol-measure__n" style={{ '--ol-n': n } as React.CSSProperties}><span>{n}</span></span>
      ))}
      {caret !== undefined && caret <= columns && <span className="ol-measure__caret" style={{ '--ol-col': caret } as React.CSSProperties} />}
    </div>
  );
}

export type NoteAction = { label: string; onSelect?: () => void };

/** A margin note: mark, lemma], the note in italic, and at most two actions. */
export function Scholion({ tone = 'note', lemma, actions, children }: { tone?: Tone; lemma?: string; actions?: NoteAction[]; children?: ReactNode }) {
  return (
    <div className={cx('ol-scholion', 'ol-scholion--' + tone)} role="note">
      <Mark tone={tone} />
      <div>
        {lemma && <span className="ol-scholion__lemma">{lemma}</span>}
        <span>{children}</span>
        {actions && actions.length > 0 && (
          <span className="ol-scholion__actions">
            {actions.map((a) => (
              <a key={a.label} className="ol-link" role="button" tabIndex={0} onClick={a.onSelect} onKeyDown={(e) => { if (e.key === 'Enter') a.onSelect?.(); }}>{a.label}</a>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

export type Entry = { key: string; tone: Tone; line: number | null; lemma?: string; note: string; file?: string | null };

/** What the compiler said, as an editor would print it: mark, line, lemma], note, file. */
export function Apparatus({ entries, active, onSelect }: { entries: Entry[]; active?: string; onSelect?: (entry: Entry) => void }) {
  return (
    <ol className="ol-apparatus">
      {entries.map((e) => (
        <li key={e.key} className={cx('ol-entry', e.key === active && 'ol-entry--active')} onClick={() => onSelect && onSelect(e)}>
          <span className="ol-entry__mark"><Mark tone={e.tone} /></span>
          <span className="ol-entry__line">{e.line ?? ''}</span>
          <span className="ol-entry__text">{e.lemma && <span className="ol-entry__lemma">{e.lemma}</span>}{e.note}</span>
          {e.file && <span className="ol-entry__file">{e.file}</span>}
        </li>
      ))}
    </ol>
  );
}

/** The desk and the sheets on it. Children are Sheet elements. */
export const Proof = React.forwardRef<HTMLDivElement, { width?: number; onScroll?: () => void; children?: ReactNode }>(
  function Proof({ width, onScroll, children }, ref) {
    return (
      <div ref={ref} className="ol-proof" onScroll={onScroll} style={width ? ({ '--ol-sheet': width + 'px' } as React.CSSProperties) : undefined}>
        {children}
      </div>
    );
  },
);

/** One page. `sync` (0 to 100) puts the diple beside the line the caret is on. The body is the rendered PDF page. */
export function Sheet(props: {
  folio?: string; sync?: number; ratio?: number; body?: boolean;
  onDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void; children?: ReactNode;
}) {
  const { folio, sync, ratio, body, onDoubleClick, children } = props;
  return (
    <>
      <div className="ol-sheet-wrap">
        <div className="ol-sheet" style={ratio ? { aspectRatio: String(ratio) } : undefined} onDoubleClick={onDoubleClick}>
          {body ? <div className="ol-sheet__body">{children}</div> : children}
        </div>
        {sync !== undefined && <span className="ol-sheet__sync" style={{ '--ol-sync': sync + '%' } as React.CSSProperties}><Mark tone="here" label="The caret is here" /></span>}
      </div>
      {folio && <span className="ol-fig ol-sheet__folio">{folio}</span>}
    </>
  );
}

export type Heading = { id: string; number: string; title: string; depth?: number; tone?: 'asks' | 'broken' };

/** The document's sections, numbered as LaTeX numbers them. */
export function Outline({ items, active, onSelect }: { items: Heading[]; active?: string; onSelect?: (heading: Heading) => void }) {
  return (
    <ol className="ol-outline">
      {items.map((h) => (
        <li key={h.id}>
          <button
            type="button" onClick={() => onSelect && onSelect(h)}
            className={cx('ol-outline__item', h.id === active && 'ol-outline__item--active')}
            style={{ '--ol-depth': h.depth || 0 } as React.CSSProperties} aria-current={h.id === active ? 'true' : undefined}
          >
            <span>{h.id === active && <Mark tone="here" />}</span>
            <span className="ol-outline__no">{h.number ? '§' + h.number : ''}</span>
            <span className="ol-outline__title">{h.title}</span>
            <span>{h.tone && <Mark tone={h.tone} />}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export type FileItem = {
  path: string; name: string; depth?: number; dir?: boolean; open?: boolean; status?: 'M' | 'A' | 'D'; root?: boolean;
};

/** The project's files. No pictures: a directory ends in a slash, and a letter says a file's status. */
export function FileTree(props: {
  items: FileItem[]; active?: string; onSelect?: (item: FileItem) => void;
  onContext?: (item: FileItem, anchor: HTMLElement) => void;
}) {
  const { items, active, onSelect, onContext } = props;
  return (
    <ul className="ol-files">
      {items.map((f) => (
        <li key={f.path}>
          <button
            type="button" onClick={() => onSelect && onSelect(f)}
            onContextMenu={onContext ? (e) => { e.preventDefault(); onContext(f, e.currentTarget); } : undefined}
            className={cx('ol-file', f.dir && 'ol-file--dir', f.path === active && 'ol-file--active')}
            style={{ '--ol-depth': f.depth || 0 } as React.CSSProperties} title={f.path}
          >
            <span className="ol-file__twist">{f.dir ? (f.open ? '−' : '+') : ''}</span>
            <span className="ol-file__name">{f.name}{f.dir ? '/' : ''}{f.root && <span className="ol-caps">root</span>}</span>
            <span className={cx('ol-file__status', f.status && 'ol-file__status--' + f.status)}>{f.status}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The bottom line. `children` sit left; `end` sits right. */
export function StatusLine({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <footer className="ol-status">
      {children}
      {end && <div className="ol-status__end">{end}</div>}
    </footer>
  );
}

/** The workspace shell: rail, headline, the main pane with what sits under it, the proof, the status line; `side` adds a column. */
export function Workspace(props: {
  rail?: ReactNode; headline?: ReactNode; side?: ReactNode; main?: ReactNode; under?: ReactNode; proof?: ReactNode;
  status?: ReactNode; sideWidth?: number; mainWidth?: number; panesRef?: React.Ref<HTMLDivElement>;
}) {
  const { rail, headline, side, main, under, proof, status, sideWidth, mainWidth, panesRef } = props;
  const style = {
    ...(sideWidth ? { '--ol-side': sideWidth + 'px' } : {}),
    ...(mainWidth ? { '--ol-main': mainWidth + 'px' } : {}),
  } as React.CSSProperties;
  return (
    <div className="ol-workspace">
      {rail}
      {headline}
      <div ref={panesRef} className={cx('ol-workspace__panes', !!side && 'ol-workspace__panes--side', !proof && 'ol-workspace__panes--solo')} style={style}>
        {side && <div className="ol-workspace__side">{side}</div>}
        <div className="ol-workspace__main">{main}</div>
        {under && <div className="ol-workspace__under">{under}</div>}
        {proof && <div className="ol-workspace__proof">{proof}</div>}
      </div>
      {status}
    </div>
  );
}

/* ---------------------------------------------------------------- library */

export type CatalogueRow = {
  id: string; title: string; address: string; tone: Exclude<Tone, 'here'>; state: ReactNode;
  pages?: number | null; edited: string; note?: string;
};

/** The Library's list of projects: a ruled catalogue, one row a project, its last note in the margin. */
export function Catalogue(props: {
  projects: CatalogueRow[]; onOpen?: (id: string) => void; onMenu?: (id: string, anchor: HTMLElement) => void;
}) {
  const { projects, onOpen, onMenu } = props;
  return (
    <table className="ol-catalogue">
      <thead>
        <tr>
          <th className="ol-caps">title</th>
          <th className="ol-caps">state</th>
          <th className="ol-caps ol-catalogue__num">pages</th>
          <th className="ol-caps">edited</th>
          <th className="ol-caps ol-catalogue__margin">last note</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr
            key={p.id} onClick={() => onOpen && onOpen(p.id)}
            onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(p.id, e.currentTarget); } : undefined}
          >
            <td>
              <a className="ol-catalogue__title" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(p.id); }}>{p.title}</a>
              <span className="ol-fig ol-catalogue__repo">{p.address}</span>
            </td>
            <td><State tone={p.tone}>{p.state}</State></td>
            <td className="ol-fig ol-catalogue__num">{p.pages == null ? '–' : p.pages}</td>
            <td className="ol-fig ol-catalogue__when">{p.edited}</td>
            <td className="ol-catalogue__margin">
              <span className="ol-catalogue__note">{p.note}</span>
              {onMenu && (
                <button
                  type="button" className="ol-button ol-button--bare ol-catalogue__more" aria-label={'Actions for ' + p.title}
                  onClick={(e) => { e.stopPropagation(); onMenu(p.id, e.currentTarget); }}
                >more</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type LedgerRow = { letter?: string; tone?: SiglumTone; title: string; note?: ReactNode; end?: ReactNode };

/** Ruled rows of a thing, what it is, and its one control: modules, connections. */
export function Ledger({ rows }: { rows: LedgerRow[] }) {
  return (
    <ul className="ol-ledger">
      {rows.map((r) => (
        <li key={r.title} className={cx('ol-ledger__row', !r.letter && 'ol-ledger__row--plain')}>
          {r.letter && <Siglum size="rail" letter={r.letter} label={r.title} tone={r.tone} />}
          <div>
            <p className="ol-ledger__title">{r.title}</p>
            {r.note && <p className="ol-ledger__note">{r.note}</p>}
          </div>
          <div className="ol-ledger__end">{r.end}</div>
        </li>
      ))}
    </ul>
  );
}
