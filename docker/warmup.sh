#!/bin/sh
# Runs once while the Docker image is built, as the unprivileged runtime user.
#
#  1. Proves that all three engines really work in this image (the build fails if not).
#  2. Pre-builds the font caches LuaLaTeX and XeLaTeX need, into the same folders the
#     server uses at runtime, so the first compile after a (cold) start is not slow.
set -eu

BASE="${COMPILE_DIR:-/var/lib/openleaf/compiles}"
export HOME="$BASE/home"
export TEXMFVAR="$BASE/texmf-var"
mkdir -p "$HOME" "$TEXMFVAR"

WORK="$(mktemp -d)"
cd "$WORK"

cat > classic.tex <<'TEX'
\documentclass{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath, graphicx, hyperref, booktabs, siunitx, tikz}
\begin{document}
Warm-up (pdfLaTeX): café, naïve, $e^{i\pi}+1=0$, \SI{9.81}{\metre\per\second\squared}.
\textbf{bold} \textit{italic} \texttt{mono} \textsf{sans}
\tikz \draw (0,0) -- (1,1);
\end{document}
TEX

cat > unicode.tex <<'TEX'
\documentclass{article}
\usepackage{fontspec}
\usepackage{amsmath}
\begin{document}
Warm-up (Unicode engines): café, naïve, ünïcödé, $e^{i\pi}+1=0$.
\textbf{bold} \textit{italic} \texttt{mono} \textsf{sans}
\end{document}
TEX

run() {
  mode="$1"; doc="$2"
  echo "== warm-up: latexmk $mode $doc"
  latexmk -norc "$mode" -interaction=nonstopmode -halt-on-error -file-line-error "$doc.tex" > "$doc$mode.out" 2>&1 \
    || { tail -n 40 "$doc$mode.out"; echo "warm-up FAILED for $mode"; exit 1; }
  test -s "$doc.pdf" || { echo "warm-up produced no PDF for $mode"; exit 1; }
  latexmk -norc -C "$doc.tex" > /dev/null 2>&1 || true
}

run -pdf classic
run -xelatex unicode
run -lualatex unicode

# Index fonts by name so \setmainfont{Some Font Name} does not trigger a slow scan later.
luaotfload-tool --update > /dev/null 2>&1 || echo "note: luaotfload-tool --update did not complete (fonts by name will be indexed on first use)"

cd /
rm -rf "$WORK"
echo "== warm-up complete: pdflatex, xelatex and lualatex all produced a PDF"
