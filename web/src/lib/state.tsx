// How a compile is said in a few words: the State shown in the Library, the headline and the status line.
import type { ReactNode } from 'react';
import type { Compile } from '../api/types';
import { Fig, type Tone } from '../ds';
import { clock, count } from './format';

export interface Said { tone: Exclude<Tone, 'here' | 'counsel'>; words: ReactNode }

/** `compile` is undefined while it is still being asked for, null when the project was never compiled. */
export function sayCompile(compile: Compile | null | undefined, opts: { time?: boolean } = {}): Said {
  if (compile === undefined) return { tone: 'note', words: 'Reading' };
  if (compile === null) return { tone: 'note', words: 'Never compiled' };
  switch (compile.status) {
    case 'queued':
    case 'running':
      return { tone: 'asks', words: 'Compiling' };
    case 'timeout':
      return { tone: 'broken', words: 'Timed out' };
    case 'error':
      return { tone: 'broken', words: 'Could not compile' };
    case 'failure': {
      const first = compile.diagnostics?.find((d) => d.level === 'error' && d.line !== null);
      return { tone: 'broken', words: first ? <>Fails at l. <Fig>{first.line}</Fig></> : 'Fails' };
    }
    case 'success':
      if (compile.warningCount > 0) return { tone: 'asks', words: <><Fig>{compile.warningCount}</Fig> {compile.warningCount === 1 ? 'warning' : 'warnings'}</> };
      return { tone: 'settled', words: opts.time ? <>Compiled <Fig>{clock(compile.finishedAt ?? compile.createdAt)}</Fig></> : 'Compiled' };
  }
}

export function sayCounts(errors: number, warnings: number): string {
  return [errors ? count(errors, 'error') : '', warnings ? count(warnings, 'warning') : ''].filter(Boolean).join(', ');
}
