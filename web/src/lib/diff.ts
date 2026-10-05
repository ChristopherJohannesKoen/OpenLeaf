// Line differences, for the History pane. The service sends unified patches; sample mode makes its own.

export type PatchLine = { kind: 'context' | 'added' | 'removed' | 'hunk'; text: string; before?: number; after?: number };

/** Reads a unified patch into lines that can be set one per row, with their line numbers on either side. */
export function readPatch(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let before = 0;
  let after = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('Index:') || line.startsWith('====') || line.startsWith('\\')) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      out.push({ kind: 'hunk', text: `l. ${before}` });
    } else if (line.startsWith('+')) out.push({ kind: 'added', text: line.slice(1), after: after++ });
    else if (line.startsWith('-')) out.push({ kind: 'removed', text: line.slice(1), before: before++ });
    else if (line.startsWith(' ')) out.push({ kind: 'context', text: line.slice(1), before: before++, after: after++ });
  }
  return out;
}

type Op = { kind: 'context' | 'added' | 'removed'; text: string };

function lineOps(a: string[], b: string[]): Op[] {
  // Longest common subsequence by dynamic programming; fine for the file sizes a LaTeX project has.
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'context', text: a[i]! }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) ops.push({ kind: 'removed', text: a[i++]! });
    else ops.push({ kind: 'added', text: b[j++]! });
  }
  while (i < n) ops.push({ kind: 'removed', text: a[i++]! });
  while (j < m) ops.push({ kind: 'added', text: b[j++]! });
  return ops;
}

/** A unified patch from `before` to `after`, with `context` unchanged lines around each change. */
export function unifiedPatch(path: string, before: string, after: string, context = 3): string {
  const ops = lineOps(before === '' ? [] : before.split('\n'), after === '' ? [] : after.split('\n'));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op.kind === 'context') return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
  });
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let a = 1;
  let b = 1;
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k]!.kind !== 'added') a++;
      if (ops[k]!.kind !== 'removed') b++;
      k++;
      continue;
    }
    const startA = a;
    const startB = b;
    const body: string[] = [];
    let countA = 0;
    let countB = 0;
    while (k < ops.length && keep[k]) {
      const op = ops[k]!;
      body.push((op.kind === 'context' ? ' ' : op.kind === 'added' ? '+' : '-') + op.text);
      if (op.kind !== 'added') { a++; countA++; }
      if (op.kind !== 'removed') { b++; countB++; }
      k++;
    }
    out.push(`@@ -${startA},${countA} +${startB},${countB} @@`, ...body);
  }
  return out.join('\n') + '\n';
}
