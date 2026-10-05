// The sample library: a few small projects so every screen can be tried without a service.
// The PDFs in public/sample were compiled from these sources with the two slips in "On measure" corrected.
const r = String.raw;

export interface SampleFile {
  path: string;
  /** Text content, or for a binary file the address of a static asset. */
  content?: string;
  asset?: string;
}

export interface SampleVersion {
  label: string;
  kind: 'manual' | 'auto';
  /** Hours before now. */
  hoursAgo: number;
  /** Replacements that turn the current files into this older state: path -> content (null: the file did not exist). */
  files: Record<string, string | null>;
}

export interface SampleDiagnostic {
  level: 'error' | 'warning' | 'typesetting';
  message: string;
  file: string | null;
  /** Text to find in the file; the diagnostic is placed on the line that holds it. */
  at?: string;
  context?: string;
}

export interface SampleProject {
  id: string;
  name: string;
  description: string;
  mainFile: string;
  engine: string;
  hoursAgo: number;
  pdf: string | null;
  pages?: number;
  files: SampleFile[];
  versions: SampleVersion[];
  /** How the last compile ended; null for a project never compiled. */
  compile: { status: 'success' | 'failure'; hoursAgo: number; durationMs: number; diagnostics: SampleDiagnostic[] } | null;
}

const PREAMBLE = r`\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath, amssymb, amsthm}
\usepackage{graphicx}
\usepackage{hyperref}

\newtheorem{theorem}{Theorem}
\newtheorem{lemma}{Lemma}
`;

const ON_MEASURE = r`\documentclass[11pt]{article}
\input{preamble}

\title{On measure}
\author{}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
A short account of why sets of measure zero do not matter to an integral,
written as a worked example.
\end{abstract}

\section{Introduction}
\label{sec:intro}

% the claim, said once and plainly
An integral does not see a set of measure zero. Section~\ref{sec:prelim} fixes
the notation and Section~\ref{sec:main} proves the estimate that makes this
precise.

\section{Preliminaries}
\label{sec:prelim}

% say what a measure is before using one
Let $(X, \Sigma, \mu)$ be a measure space, as in \cite{halmos50}.
We write $L^1(\mu)$ for the integrable functions.

\begin{figure}[t]
  \centering
  \includegraphics[width=0.8\linewidth]{fig/cover-2}
  \caption{A cover of $E$ by intervals of total length $<\varepsilon$.}
  \label{fig:cover}
\end{figure}

\begin{lemma}
\label{lem:null}
If $\mu(E) = 0$ then $\int_E f \, d\mu = 0$ for every $f \in L^1(\mu)$.
\end{lemma}

By Lemma~\ref{lem:nul}, the set in Figure~\ref{fig:cover} contributes nothing.

\section{The main estimate}
\label{sec:main}

\begin{theorem}
\label{thm:main}
For $f \in L^1(\mu)$ and $\varepsilon > 0$ there is $\delta > 0$ such that
\[
  \mu(E) < \delta \quad\Longrightarrow\quad \int_E |f| \, d\mu < \varepsilon .
\]
\end{theorem}

\subsection{A covering lemma}
\label{sec:covering}

% the proof wants Lemma 1 twice; say so once
Cover the set where $|f|$ is large by countably many intervals, as in
Figure~\ref{fig:cover}. Its measure tends to zero as the height grows, by
dominated convergence; see \cite{royden88}.

\subsection{Proof of the estimate}
\label{sec:proof}

\begin{proof}
Write $f_n = \min(|f|, n)$. Choose $n$ with $\int_X (|f| - f_n) \, d\mu <
\varepsilon / 2$ and put $\delta = \varepsilon / (2n)$. If $\mu(E) < \delta$ then
\[
  \int_E |f| \, d\mu \le \int_X (|f| - f_n) \, d\mu + n \, \mu(E) < \varepsilon .
\]
\end{proof}

\section{Two examples}
\label{sec:examples}

On the line with Lebesgue measure, $f(x) = x^{-1/2}$ on $(0, 1)$ is integrable and
unbounded, so $\delta$ cannot be taken proportional to $\varepsilon$. For a
bounded $f$ it can.

\appendix
\section{Notation}

$\mu(E)$ is the measure of $E$; $L^1(\mu)$ is the space of integrable functions.

\bibliographystyle{plain}
\bibliography{refs}

\end{document}
`;

const REFS = r`@book{halmos50,
  author    = {Paul R. Halmos},
  title     = {Measure Theory},
  publisher = {Van Nostrand},
  year      = {1950}
}

@book{royden88,
  author    = {H. L. Royden},
  title     = {Real Analysis},
  edition   = {3},
  publisher = {Macmillan},
  year      = {1988}
}

@book{rudin87,
  author    = {Walter Rudin},
  title     = {Real and Complex Analysis},
  edition   = {3},
  publisher = {McGraw-Hill},
  year      = {1987}
}
`;

const ON_MEASURE_OUTLINE_ONLY = r`\documentclass[11pt]{article}
\input{preamble}

\title{On measure}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
\label{sec:intro}

\section{Preliminaries}
\label{sec:prelim}

\section{The main estimate}
\label{sec:main}

\end{document}
`;

const THESIS_MAIN = r`\documentclass[11pt, a4paper]{report}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath, amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{A thesis in three chapters}
\author{}
\date{\today}

\begin{document}

\maketitle
\tableofcontents

\include{chapters/introduction}
\include{chapters/background}
\include{chapters/method}

\appendix
\include{appendix/notation}

\end{document}
`;

const THESIS_INTRO = r`\chapter{Introduction}
\label{ch:intro}

This chapter says what the thesis is for and how it is laid out.

\section{The question}
\label{sec:question}

Every thesis answers one question. State it in a sentence, then say why the
answer matters and to whom.

\section{What follows}

Chapter~\ref{ch:background} collects what is already known and
Chapter~\ref{ch:method} sets out the method.
`;

const THESIS_BACKGROUND = r`\chapter{Background}
\label{ch:background}

\section{Earlier work}

Summarise the work this thesis builds on, in the order a reader needs it.

\section{What is missing}
\label{sec:gap}

Name the gap. The method in Chapter~\ref{ch:method} is built to close it.
`;

const THESIS_METHOD = r`\chapter{Method}
\label{ch:method}

\section{Setting}

Fix the notation of Appendix~\ref{app:notation} and the assumptions used
throughout.

\section{The procedure}

\subsection{First step}

Describe the first step, and the quantity it controls:
\begin{equation}
  \label{eq:bound}
  \| u - u_h \| \le C h^2 .
\end{equation}

\subsection{Second step}

The bound \eqref{eq:bound} carries over to the second step unchanged.
`;

const THESIS_NOTATION = r`\chapter{Notation}
\label{app:notation}

\begin{tabular}{ll}
  $h$ & the mesh width \\
  $u_h$ & the discrete solution \\
  $C$ & a constant independent of $h$
\end{tabular}
`;

const WEEK9 = r`\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath, amssymb}

\title{Lecture notes, week 9}
\author{}
\date{}

\begin{document}
\maketitle

\section{Compactness}
\label{sec:compact}

A subset of $\mathbb{R}^n$ is compact exactly when it is closed and bounded; this is the Heine--Borel theorem, proved in \cite{rudin76}.

\section{Exercises}

\begin{enumerate}
  \item Show that a closed subset of a compact set is compact.
  \item Show that a continuous image of a compact set is compact.
  \item Give an open cover of $(0, 1)$ with no finite subcover.
  \item Deduce from Section~\ref{sec:compact} that a continuous function on $[a, b]$ is bounded.
\end{enumerate}

\end{document}
`;

const REPORT = r`\documentclass[11pt]{article}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath, amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Report, second draft}
\author{}
\date{\today}

\begin{document}

\maketitle

\section{Summary}

\section{Findings}

\section{Next steps}

\end{document}
`;

export const SAMPLE_PROJECTS: SampleProject[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'On measure',
    description: '',
    mainFile: 'main.tex',
    engine: 'pdflatex',
    hoursAgo: 0.2,
    pdf: '/sample/on-measure.pdf',
    pages: 2,
    files: [
      { path: 'main.tex', content: ON_MEASURE },
      { path: 'preamble.tex', content: PREAMBLE },
      { path: 'refs.bib', content: REFS },
      { path: 'fig' },
      { path: 'fig/cover-01.pdf', asset: '/sample/cover.pdf' },
      { path: 'fig/cover-02.pdf', asset: '/sample/cover.pdf' },
    ],
    versions: [
      {
        label: 'state the covering lemma before it is used', kind: 'manual', hoursAgo: 0.4,
        files: {
          'main.tex': ON_MEASURE
            .replace(r`{fig/cover-2}`, r`{fig/cover-02}`)
            .replace(r`\ref{lem:nul}`, r`\ref{lem:null}`),
        },
      },
      {
        label: '', kind: 'auto', hoursAgo: 26,
        files: {
          'main.tex': ON_MEASURE
            .replace(r`{fig/cover-2}`, r`{fig/cover-01}`)
            .replace(r`\ref{lem:nul}`, r`\ref{lem:null}`)
            .replace(/\\section\{Two examples\}[\s\S]*?\\appendix/, '\\appendix'),
          'fig/cover-02.pdf': null,
        },
      },
      {
        label: 'first outline', kind: 'manual', hoursAgo: 75,
        files: { 'main.tex': ON_MEASURE_OUTLINE_ONLY, 'refs.bib': null, 'fig/cover-01.pdf': null, 'fig/cover-02.pdf': null, fig: null },
      },
    ],
    compile: {
      status: 'failure', hoursAgo: 0.2, durationMs: 4100,
      diagnostics: [
        { level: 'error', message: "File `fig/cover-2' not found.", file: 'main.tex', at: '{fig/cover-2}', context: '\\includegraphics[width=0.8\\linewidth]{fig/cover-2}' },
        { level: 'warning', message: "Reference `lem:nul' on page 1 undefined.", file: 'main.tex', at: '{lem:nul}' },
        { level: 'warning', message: 'There were undefined references.', file: 'main.tex' },
      ],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Thesis',
    description: 'chapter 3: second pass on the method',
    mainFile: 'main.tex',
    engine: 'pdflatex',
    hoursAgo: 27,
    pdf: '/sample/thesis.pdf',
    pages: 6,
    files: [
      { path: 'main.tex', content: THESIS_MAIN },
      { path: 'chapters' },
      { path: 'chapters/introduction.tex', content: THESIS_INTRO },
      { path: 'chapters/background.tex', content: THESIS_BACKGROUND },
      { path: 'chapters/method.tex', content: THESIS_METHOD },
      { path: 'appendix' },
      { path: 'appendix/notation.tex', content: THESIS_NOTATION },
    ],
    versions: [
      { label: 'chapter 3: second pass on the method', kind: 'manual', hoursAgo: 27, files: {} },
      { label: '', kind: 'auto', hoursAgo: 120, files: { 'chapters/method.tex': THESIS_METHOD.replace(/\\subsection\{Second step\}[\s\S]*$/, '') } },
    ],
    compile: { status: 'success', hoursAgo: 27, durationMs: 6200, diagnostics: [] },
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Lecture notes, week 9',
    description: 'exercises 3 and 4',
    mainFile: 'notes.tex',
    engine: 'pdflatex',
    hoursAgo: 52,
    pdf: '/sample/week-09.pdf',
    pages: 1,
    files: [{ path: 'notes.tex', content: WEEK9 }],
    versions: [{ label: 'exercises 3 and 4', kind: 'manual', hoursAgo: 52, files: {} }],
    compile: {
      status: 'success', hoursAgo: 52, durationMs: 2300,
      diagnostics: [
        { level: 'warning', message: "Citation `rudin76' on page 1 undefined.", file: 'notes.tex', at: '{rudin76}' },
        { level: 'warning', message: 'There were undefined references.', file: 'notes.tex' },
      ],
    },
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    name: 'Report, second draft',
    description: 'outline only',
    mainFile: 'main.tex',
    engine: 'pdflatex',
    hoursAgo: 310,
    pdf: null,
    files: [{ path: 'main.tex', content: REPORT }],
    versions: [],
    compile: null,
  },
];

export const BLANK_DOCUMENT = (title: string) => r`\documentclass[11pt]{article}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath, amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{` + title.replace(/[\\{}%$&#_^~]/g, '') + r`}
\author{}
\date{\today}

\begin{document}

\maketitle

\section{Introduction}

Start writing here.

\end{document}
`;

export const SAMPLE_TEMPLATES = [
  { id: 'article', name: 'Research article', description: 'A paper with abstract, sections, a figure/table skeleton and a BibTeX bibliography.', engine: 'pdflatex', mainFile: 'main.tex', builtin: true, fileCount: 2 },
  { id: 'report', name: 'Thesis / long report', description: 'Chapters in separate files, title page, table of contents, appendix and bibliography.', engine: 'pdflatex', mainFile: 'main.tex', builtin: true, fileCount: 6 },
  { id: 'notes', name: 'Research notes', description: 'Compact notes with theorem, definition and remark environments.', engine: 'pdflatex', mainFile: 'notes.tex', builtin: true, fileCount: 1 },
];
