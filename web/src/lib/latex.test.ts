import { describe as suite, expect, it } from 'vitest';
import { closest, compileNotes, describe, indexProject, mergeNotes, outline, readingNotes, resolvedNote, stripComment, wordCount } from './latex';

const r = String.raw;

suite('stripComment', () => {
  it('cuts at an unescaped percent sign and keeps an escaped one', () => {
    expect(stripComment(r`50\% of it % a note`)).toBe(r`50\% of it `);
    expect(stripComment('no comment')).toBe('no comment');
  });
});

suite('outline', () => {
  const sources = new Map([
    ['main.tex', r`\documentclass{report}
\begin{document}
\include{ch/one}
% \chapter{Commented out}
\input{ch/two.tex}
\appendix
\chapter{Notation}
\end{document}`],
    ['ch/one.tex', r`\chapter{Introduction}
\section{The \emph{question}}\label{sec:q}
\section*{An aside}
\subsection[short]{Detail}`],
    ['ch/two.tex', r`\chapter{Method}
\section{Setting}`],
  ]);
  const items = outline(sources, 'main.tex');

  it('follows \\include and \\input in reading order', () => {
    expect(items.map((h) => h.title)).toEqual(['Introduction', 'The question', 'An aside', 'Detail', 'Method', 'Setting', 'Notation']);
    expect(items[4]).toMatchObject({ file: 'ch/two.tex', line: 1 });
  });
  it('numbers as LaTeX does: starred headings unnumbered, appendix lettered', () => {
    expect(items.map((h) => h.number)).toEqual(['1', '1.1', '', '1.1.1', '2', '2.1', 'A']);
  });
  it('gives depth relative to the top level in use', () => {
    expect(items.map((h) => h.depth)).toEqual([0, 1, 1, 2, 0, 1, 0]);
  });
  it('numbers an article from its sections', () => {
    const article = outline(new Map([['a.tex', r`\section{One}\subsection{Sub}` + '\n' + r`\section{Two}`]]), 'a.tex');
    expect(article.map((h) => `${h.number} ${h.title}`)).toEqual(['1 One', '1.1 Sub', '2 Two']);
  });
});

suite('reading a file against the project', () => {
  const main = r`\section{A}\label{sec:a}
See Section~\ref{sec:b} and \ref{sec:a}.
\includegraphics[width=\linewidth]{fig/cover-2}
\includegraphics{fig/cover-01}
As in \cite{halmos50} and \citep[p.~3]{halmos}.
% \ref{nowhere}`;
  const sources = new Map([
    ['main.tex', main],
    ['refs.bib', '@book{halmos50,\n  author = {Paul R. Halmos},\n  title = {Measure Theory},\n  year = {1950}\n}\n'],
  ]);
  const index = indexProject(sources);
  const paths = new Set(['main.tex', 'refs.bib', 'fig', 'fig/cover-01.pdf', 'fig/cover-02.pdf']);
  const notes = readingNotes('main.tex', main, index, paths);

  it('indexes labels and bibliography entries', () => {
    expect(index.labels.get('sec:a')).toEqual({ file: 'main.tex', line: 1 });
    expect(index.bibliography.get('halmos50')).toBe('Halmos, Measure Theory, 1950');
  });
  it('flags an undefined reference and offers the nearest label', () => {
    const note = notes.find((n) => n.lemma === 'sec:b')!;
    expect(note).toMatchObject({ line: 2, tone: 'asks', fix: { replace: 'sec:a' } });
    expect(main.split('\n')[1]!.slice(note.from, note.to)).toBe('sec:b');
  });
  it('flags a picture that is not among the files and offers the nearest one', () => {
    const note = notes.find((n) => n.lemma === 'fig/cover-2')!;
    expect(note.tone).toBe('broken');
    expect(note.fix?.replace).toMatch(/^fig\/cover-0[12]$/);
    expect(notes.some((n) => n.lemma === 'fig/cover-01')).toBe(false);
  });
  it('flags a citation that is not in the bibliography', () => {
    expect(notes.find((n) => n.lemma === 'halmos')).toMatchObject({ line: 5, tone: 'asks', fix: { replace: 'halmos50' } });
    expect(notes.some((n) => n.lemma === 'halmos50')).toBe(false);
  });
  it('leaves comments alone', () => {
    expect(notes.some((n) => n.lemma === 'nowhere')).toBe(false);
  });
  it('says what the key on the caret line resolves to', () => {
    expect(resolvedNote('main.tex', 5, main.split('\n')[4]!, index)).toMatchObject({ tone: 'settled', lemma: 'halmos50', text: 'Halmos, Measure Theory, 1950.' });
  });
  it('does not check citations when the project has no bibliography', () => {
    const bare = indexProject(new Map([['main.tex', main]]));
    expect(readingNotes('main.tex', main, bare, paths).some((n) => n.lemma === 'halmos')).toBe(false);
  });
});

suite('describe', () => {
  it('takes the lemma out of a quoted message', () => {
    expect(describe({ level: 'error', message: "File `fig/cover-2' not found." })).toEqual({ lemma: 'fig/cover-2', fragment: 'file not found.', sentence: 'File not found.' });
    expect(describe({ level: 'warning', message: "Reference `lem:nul' on page 3 undefined on input line 52." })).toMatchObject({ lemma: 'lem:nul', sentence: 'Reference undefined.' });
  });
  it('finds the control sequence in the context', () => {
    expect(describe({ level: 'error', message: 'Undefined control sequence.', context: r`Some text \undefinedmacro` })).toMatchObject({ lemma: r`\undefinedmacro`, fragment: 'undefined control sequence.' });
  });
  it('shortens box warnings and BibTeX misses', () => {
    expect(describe({ level: 'typesetting', message: r`Overfull \hbox (3.2pt too wide) in paragraph at lines 49--50` }).sentence).toBe(r`Overfull \hbox, 3.2pt too wide.`);
    expect(describe({ level: 'warning', message: `I didn't find a database entry for "knuth84"` })).toMatchObject({ lemma: 'knuth84' });
  });
});

suite('margin notes', () => {
  it('places compiler messages on their lines and finds the lemma', () => {
    const text = 'one\n' + r`\includegraphics{fig/x}` + '\nthree';
    const notes = compileNotes('main.tex', text, [
      { level: 'error', message: "File `fig/x' not found.", file: 'main.tex', line: 2, source: 'latex' },
      { level: 'warning', message: 'Elsewhere.', file: 'other.tex', line: 1, source: 'latex' },
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ line: 2, tone: 'broken', lemma: 'fig/x', from: 17, to: 22 });
  });
  it('lets a reading note replace the compiler note that says the same thing', () => {
    const merged = mergeNotes(
      [{ line: 2, tone: 'broken', lemma: 'fig/x', text: 'file not found.', origin: 'compile' }],
      [{ line: 2, tone: 'broken', lemma: 'fig/x', text: 'not found; fig/y.pdf is among the files.', origin: 'reading' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.origin).toBe('reading');
  });
});

suite('helpers', () => {
  it('finds the nearest key only when it is near', () => {
    expect(closest('lem:nul', ['lem:null', 'thm:main'])).toBe('lem:null');
    expect(closest('abc', ['completely-different'])).toBeNull();
  });
  it('counts the words a reader reads', () => {
    expect(wordCount(r`\section{Two words} Let $x^2$ be given, as in \cite{k}. % not these`)).toBe(7);
  });
});
