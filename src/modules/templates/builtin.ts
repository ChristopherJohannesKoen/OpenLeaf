/**
 * Built-in starting points. `{{TITLE}}` and `{{AUTHOR}}` are replaced (LaTeX-escaped)
 * when a project is created from one. To add a template, add an entry here —
 * or save any project as a personal template through the API.
 */
export interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  engine: string;
  mainFile: string;
  files: Record<string, string>;
}

const REFERENCES = `@book{knuth1984texbook,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@book{lamport1994latex,
  author    = {Leslie Lamport},
  title     = {{\\LaTeX}: A Document Preparation System},
  edition   = {2},
  publisher = {Addison-Wesley},
  year      = {1994}
}
`;

const article: BuiltinTemplate = {
  id: 'article',
  name: 'Research article',
  description: 'A paper with abstract, sections, a figure/table skeleton and a BibTeX bibliography.',
  engine: 'pdflatex',
  mainFile: 'main.tex',
  files: {
    'main.tex': `\\documentclass[11pt,a4paper]{article}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath, amssymb, amsthm}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage[numbers]{natbib}
\\usepackage[hidelinks]{hyperref}

\\title{{{TITLE}}}
\\author{{{AUTHOR}}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Summarise the question, the method and the main result in a few sentences.
\\end{abstract}

\\section{Introduction}
\\label{sec:introduction}

State the problem and why it matters. Cite earlier work like this~\\citep{knuth1984texbook}.

\\section{Method}
\\label{sec:method}

An equation with a label:
\\begin{equation}
  \\label{eq:example}
  \\sigma = \\frac{M y}{I}
\\end{equation}
which can be referred to as Equation~\\eqref{eq:example}.

\\section{Results}
\\label{sec:results}

\\begin{table}[ht]
  \\centering
  \\caption{An example table.}
  \\label{tab:example}
  \\begin{tabular}{lrr}
    \\toprule
    Case & Value & Error \\\\
    \\midrule
    A & 1.00 & 0.02 \\\\
    B & 2.50 & 0.05 \\\\
    \\bottomrule
  \\end{tabular}
\\end{table}

Table~\\ref{tab:example} shows the results. To add a figure, upload an image to
\\texttt{figures/} and use \\verb|\\includegraphics|.

\\section{Conclusion}
\\label{sec:conclusion}

Summarise what was found, following \\citet{lamport1994latex}.

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`,
    'references.bib': REFERENCES,
    'figures/README.txt': 'Upload your figures (PDF, PNG or JPG) into this folder.\n',
  },
};

const report: BuiltinTemplate = {
  id: 'report',
  name: 'Thesis / long report',
  description: 'Chapters in separate files, title page, table of contents, appendix and bibliography.',
  engine: 'pdflatex',
  mainFile: 'main.tex',
  files: {
    'main.tex': `\\documentclass[12pt,a4paper]{report}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{setspace}
\\usepackage[numbers]{natbib}
\\usepackage[hidelinks]{hyperref}

\\graphicspath{{figures/}}
\\onehalfspacing

\\title{{{TITLE}}}
\\author{{{AUTHOR}}}
\\date{\\today}

\\begin{document}

\\maketitle

\\input{frontmatter/abstract}

\\tableofcontents
\\listoffigures
\\listoftables

\\include{chapters/introduction}
\\include{chapters/literature}
\\include{chapters/methodology}
\\include{chapters/results}
\\include{chapters/conclusion}

\\appendix
\\include{chapters/appendix}

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`,
    'frontmatter/abstract.tex': `\\begin{abstract}
A one-paragraph summary of the whole document.
\\end{abstract}
`,
    'chapters/introduction.tex': `\\chapter{Introduction}
\\label{ch:introduction}

Background, problem statement, objectives and the structure of the document.
`,
    'chapters/literature.tex': `\\chapter{Literature review}
\\label{ch:literature}

What is already known~\\citep{knuth1984texbook, lamport1994latex}.
`,
    'chapters/methodology.tex': `\\chapter{Methodology}
\\label{ch:methodology}

How the work was done.
\\begin{equation}
  \\label{eq:equilibrium}
  \\sum F = 0, \\qquad \\sum M = 0
\\end{equation}
`,
    'chapters/results.tex': `\\chapter{Results and discussion}
\\label{ch:results}

\\begin{table}[ht]
  \\centering
  \\caption{An example table.}
  \\label{tab:example}
  \\begin{tabular}{lrr}
    \\toprule
    Specimen & Load (kN) & Deflection (mm) \\\\
    \\midrule
    1 & 10.0 & 1.2 \\\\
    2 & 20.0 & 2.5 \\\\
    \\bottomrule
  \\end{tabular}
\\end{table}

Discuss Table~\\ref{tab:example} with reference to Equation~\\eqref{eq:equilibrium}.
`,
    'chapters/conclusion.tex': `\\chapter{Conclusion}
\\label{ch:conclusion}

Findings, limitations and recommendations.
`,
    'chapters/appendix.tex': `\\chapter{Supporting material}
\\label{ch:appendix}

Derivations, raw data, drawings.
`,
    'references.bib': REFERENCES,
    'figures/README.txt': 'Upload your figures (PDF, PNG or JPG) into this folder.\n',
  },
};

const beamer: BuiltinTemplate = {
  id: 'beamer',
  name: 'Presentation (Beamer)',
  description: 'Slides with a title frame, an outline and example content frames.',
  engine: 'pdflatex',
  mainFile: 'slides.tex',
  files: {
    'slides.tex': `\\documentclass[aspectratio=169]{beamer}

\\usetheme{Madrid}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{booktabs}

\\title{{{TITLE}}}
\\author{{{AUTHOR}}}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Motivation}

\\begin{frame}{Motivation}
  \\begin{itemize}
    \\item What is the problem?
    \\item Why does it matter?
    \\item What is new here?
  \\end{itemize}
\\end{frame}

\\section{Method}

\\begin{frame}{Method}
  \\begin{block}{Key relation}
    \\[
      \\delta = \\frac{P L^3}{48 E I}
    \\]
  \\end{block}
\\end{frame}

\\section{Results}

\\begin{frame}{Results}
  \\centering
  \\begin{tabular}{lrr}
    \\toprule
    Case & Predicted & Measured \\\\
    \\midrule
    A & 1.20 & 1.25 \\\\
    B & 2.40 & 2.31 \\\\
    \\bottomrule
  \\end{tabular}
\\end{frame}

\\begin{frame}{Conclusion}
  \\begin{enumerate}
    \\item First takeaway
    \\item Second takeaway
  \\end{enumerate}
\\end{frame}

\\end{document}
`,
  },
};

const notes: BuiltinTemplate = {
  id: 'notes',
  name: 'Research notes',
  description: 'Compact notes with theorem, definition and remark environments.',
  engine: 'pdflatex',
  mainFile: 'notes.tex',
  files: {
    'notes.tex': `\\documentclass[11pt,a4paper]{article}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=2.2cm]{geometry}
\\usepackage{amsmath, amssymb, amsthm, mathtools}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}

\\theoremstyle{plain}
\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{lemma}[theorem]{Lemma}
\\theoremstyle{definition}
\\newtheorem{definition}[theorem]{Definition}
\\theoremstyle{remark}
\\newtheorem{remark}[theorem]{Remark}

\\title{{{TITLE}}}
\\author{{{AUTHOR}}}
\\date{\\today}

\\begin{document}

\\maketitle
\\tableofcontents

\\section{Setting}

\\begin{definition}
  State the objects you are working with.
\\end{definition}

\\section{Results}

\\begin{theorem}
  \\label{thm:main}
  For all $x \\in \\mathbb{R}$, $e^{x} \\geq 1 + x$.
\\end{theorem}

\\begin{proof}
  The function $f(x) = e^{x} - 1 - x$ has $f(0) = 0$, $f'(x) = e^{x} - 1$,
  so $f$ is minimised at $x = 0$.
\\end{proof}

\\begin{remark}
  Theorem~\\ref{thm:main} is tight at $x = 0$.
\\end{remark}

\\section{Open questions}

\\begin{enumerate}[label=(\\alph*)]
  \\item First question.
  \\item Second question.
\\end{enumerate}

\\end{document}
`,
  },
};

const assignment: BuiltinTemplate = {
  id: 'assignment',
  name: 'Assignment / lab report',
  description: 'Header with course details and numbered problems with worked solutions.',
  engine: 'pdflatex',
  mainFile: 'main.tex',
  files: {
    'main.tex': `\\documentclass[11pt,a4paper]{article}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{siunitx}
\\usepackage{fancyhdr}

\\newcommand{\\course}{Course name}
\\newcommand{\\assignment}{{{TITLE}}}
\\newcommand{\\student}{{{AUTHOR}}}

\\pagestyle{fancy}
\\fancyhf{}
\\lhead{\\course}
\\rhead{\\assignment}
\\cfoot{\\thepage}

\\newcounter{problem}
\\newcommand{\\problem}[1]{\\stepcounter{problem}\\section*{Problem \\theproblem: #1}}

\\begin{document}

\\begin{center}
  {\\Large \\textbf{\\assignment}} \\\\[4pt]
  \\course \\\\[2pt]
  \\student \\quad \\today
\\end{center}

\\problem{Simply supported beam}

A beam of span $L = \\SI{6}{\\metre}$ carries a uniformly distributed load
$w = \\SI{10}{\\kilo\\newton\\per\\metre}$. The maximum bending moment is
\\begin{align}
  M_{\\max} &= \\frac{w L^2}{8} \\\\
            &= \\frac{10 \\times 6^2}{8} = \\SI{45}{\\kilo\\newton\\metre}.
\\end{align}

\\problem{Results table}

\\begin{table}[h]
  \\centering
  \\begin{tabular}{lS[table-format=2.1]S[table-format=1.2]}
    \\toprule
    Test & {Load (\\si{\\kilo\\newton})} & {Deflection (\\si{\\milli\\metre})} \\\\
    \\midrule
    1 & 10.0 & 1.20 \\\\
    2 & 20.0 & 2.45 \\\\
    \\bottomrule
  \\end{tabular}
\\end{table}

\\end{document}
`,
  },
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [article, report, beamer, notes, assignment];
