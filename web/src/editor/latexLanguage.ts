// LaTeX for the editor: a small stream grammar whose tokens are the design system's ol-tok-* classes.
// Four colours and no more: commands, math, keys, delimiters. Environment names are bold; comments are
// set in the voice face, because a comment is counsel and not code.
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from '@codemirror/language';
import { Tag } from '@lezer/highlight';

const tag = {
  command: Tag.define(),
  env: Tag.define(),
  brace: Tag.define(),
  math: Tag.define(),
  key: Tag.define(),
  comment: Tag.define(),
};

const BEGIN_END = /^\\(begin|end)$/;
const KEYED = /^\\(ref|eqref|autoref|cref|Cref|pageref|nameref|vref|label|cite[a-zA-Z]*|parencite|textcite|autocite|footcite|nocite|input|include|subfile|includegraphics|bibliography|addbibresource|usepackage|documentclass|RequirePackage)\*?$/;
const MATH_ENV = /^(equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math)\*?$/;

interface State {
  /** What closes math, or null outside math. */
  math: '$' | '$$' | '\\]' | '\\)' | 'env' | null;
  /** The command just read wants its next braced argument coloured. */
  pending: 'env' | 'key' | null;
  beginning: boolean;
  /** Inside that braced argument. */
  arg: 'env' | 'key' | null;
  /** Inside the optional [...] between such a command and its argument. */
  option: boolean;
}

const parser: StreamParser<State> = {
  name: 'latex',
  startState: () => ({ math: null, pending: null, beginning: false, arg: null, option: false }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (stream.sol()) {
      // Arguments and options do not run over a line end here; that keeps a slip from colouring the rest of the file.
      state.arg = null;
      state.option = false;
    }
    if (state.arg) {
      if (stream.eat('}')) {
        state.arg = null;
        return 'brace';
      }
      stream.eatWhile(/[^}]/);
      const name = stream.current();
      const kind = state.arg;
      if (kind === 'env' && state.beginning && MATH_ENV.test(name)) state.math = 'env';
      return kind;
    }
    if (stream.eatSpace()) return null;
    const ch = stream.peek()!;

    if (ch === '%') {
      stream.skipToEnd();
      return 'comment';
    }

    if (ch === '\\') {
      stream.next();
      if (stream.eatWhile(/[A-Za-z@]/)) stream.eat('*');
      else stream.next();
      const command = stream.current();
      if (state.math) {
        if (command === state.math) {
          state.math = null;
          return 'math';
        }
        if (state.math === 'env' && command === '\\end') {
          state.math = null;
          state.pending = 'env';
          state.beginning = false;
          return 'command';
        }
        return 'math';
      }
      if (command === '\\[' || command === '\\(') {
        state.math = command === '\\[' ? '\\]' : '\\)';
        return 'math';
      }
      const beginEnd = BEGIN_END.exec(command);
      state.pending = beginEnd ? 'env' : KEYED.test(command) ? 'key' : null;
      state.beginning = beginEnd?.[1] === 'begin';
      return 'command';
    }

    if (ch === '$') {
      stream.next();
      const double = stream.eat('$');
      if (state.math === '$' || state.math === '$$') state.math = null;
      else if (!state.math) state.math = double ? '$$' : '$';
      return 'math';
    }

    if (state.math) {
      stream.next();
      stream.eatWhile(/[^\\$%]/);
      return 'math';
    }

    if (ch === '{' && state.pending) {
      stream.next();
      state.arg = state.pending;
      state.pending = null;
      state.option = false;
      return 'brace';
    }
    if (ch === '[' && state.pending && !state.option) {
      stream.next();
      state.option = true;
      return 'brace';
    }
    if (ch === ']' && state.option) {
      stream.next();
      state.option = false;
      return 'brace';
    }
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
      stream.next();
      if (!state.option) state.pending = null;
      return 'brace';
    }

    stream.next();
    stream.eatWhile(/[^\\%${}[\]\s]/);
    if (!state.option) state.pending = null;
    return null;
  },
  languageData: { commentTokens: { line: '%' } },
  tokenTable: tag,
};

const style = HighlightStyle.define([
  { tag: tag.command, class: 'ol-tok-command' },
  { tag: tag.env, class: 'ol-tok-env' },
  { tag: tag.brace, class: 'ol-tok-brace' },
  { tag: tag.math, class: 'ol-tok-math' },
  { tag: tag.key, class: 'ol-tok-key' },
  { tag: tag.comment, class: 'ol-tok-comment' },
]);

export const latex = [StreamLanguage.define(parser), syntaxHighlighting(style)];

export const COMMON_ENVIRONMENTS = [
  'document', 'abstract', 'figure', 'table', 'tabular', 'itemize', 'enumerate', 'description', 'equation', 'equation*',
  'align', 'align*', 'gather', 'multline', 'theorem', 'lemma', 'proof', 'definition', 'remark', 'corollary', 'proposition',
  'center', 'quote', 'verbatim', 'frame', 'columns', 'tikzpicture', 'minipage', 'appendix', 'thebibliography',
];

export const COMMON_COMMANDS = [
  'section', 'subsection', 'subsubsection', 'chapter', 'paragraph', 'label', 'ref', 'eqref', 'cite', 'footnote', 'caption',
  'includegraphics', 'input', 'include', 'begin', 'end', 'item', 'emph', 'textbf', 'textit', 'texttt', 'frac', 'sqrt',
  'sum', 'int', 'left', 'right', 'usepackage', 'documentclass', 'title', 'author', 'date', 'maketitle', 'tableofcontents',
  'bibliography', 'bibliographystyle', 'newcommand', 'renewcommand', 'newtheorem', 'centering', 'linewidth', 'textwidth',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'lambda', 'mu', 'sigma', 'omega', 'infty', 'partial',
  'mathbb', 'mathcal', 'mathrm', 'quad', 'ldots', 'cdot', 'times', 'leq', 'geq', 'neq', 'approx', 'in', 'subset',
];
