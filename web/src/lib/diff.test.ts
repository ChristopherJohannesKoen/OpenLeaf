import { describe, expect, it } from 'vitest';
import { readPatch, unifiedPatch } from './diff';

describe('unifiedPatch', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
  const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i'].join('\n');
  const patch = unifiedPatch('x.tex', before, after, 1);

  it('writes hunks with the right line numbers', () => {
    expect(patch).toContain('@@ -3,3 +3,3 @@');
    expect(patch).toContain('-d\n+D');
    expect(patch).toContain('+i');
  });
  it('reads back into rows with a number on each side', () => {
    const rows = readPatch(patch).filter((l) => l.kind !== 'hunk');
    expect(rows.find((l) => l.kind === 'removed')).toMatchObject({ text: 'd', before: 4 });
    expect(rows.find((l) => l.kind === 'added')).toMatchObject({ text: 'D', after: 4 });
    expect(rows.at(-1)).toMatchObject({ kind: 'added', text: 'i', after: 9 });
  });
  it('is empty of hunks when nothing changed', () => {
    expect(readPatch(unifiedPatch('x.tex', before, before))).toEqual([]);
  });
});
