/**
 * Minimal self-contained unified diff generator.
 *
 * zeenha fork: Azure DevOps has no unified-diff endpoint and the repo has no
 * `diff` dependency, so patches are built from old/new file contents here.
 */

export type FileChangeStatus = 'add' | 'edit' | 'delete' | 'rename';

export interface FilePatch {
  patch: string;
  additions: number;
  deletions: number;
}

const CONTEXT_LINES = 3;
const MAX_TEXT_CHARS = 512 * 1024;
const MAX_LINES = 20000;
/** Cap on the LCS table size (cells); larger middles fall back to replace-all */
const MAX_LCS_CELLS = 4_000_000;
const NO_EOL_MARKER = '\u0001NOEOL';

type Op = { type: ' ' | '+' | '-'; line: string };

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  } else {
    lines[lines.length - 1] += NO_EOL_MARKER;
  }
  return lines;
}

function isUnsupported(text: string | null): boolean {
  if (text === null) return false;
  if (text.length > MAX_TEXT_CHARS || text.includes('\0')) return true;
  let count = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    count += 1;
    if (count > MAX_LINES) return true;
  }
  return false;
}

function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: ' ', line: a[i] });

  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) {
    for (let i = start; i < endA; i += 1) ops.push({ type: '-', line: a[i] });
    for (let j = start; j < endB; j += 1) ops.push({ type: '+', line: b[j] });
  } else {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[start + i] === b[start + j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ type: ' ', line: a[start + i] });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        ops.push({ type: '-', line: a[start + i] });
        i += 1;
      } else {
        ops.push({ type: '+', line: b[start + j] });
        j += 1;
      }
    }
    for (; i < n; i += 1) ops.push({ type: '-', line: a[start + i] });
    for (; j < m; j += 1) ops.push({ type: '+', line: b[start + j] });
  }

  for (let i = endA; i < a.length; i += 1) ops.push({ type: ' ', line: a[i] });
  return ops;
}

function renderLine(op: Op): string {
  if (op.line.endsWith(NO_EOL_MARKER)) {
    return `${op.type}${op.line.slice(0, -NO_EOL_MARKER.length)}\n\\ No newline at end of file`;
  }
  return `${op.type}${op.line}`;
}

function renderHunks(ops: Op[]): string[] {
  const out: string[] = [];
  const changed: number[] = [];
  ops.forEach((op, idx) => {
    if (op.type !== ' ') changed.push(idx);
  });
  if (changed.length === 0) return out;

  // Group changes whose context windows overlap
  const groups: Array<[number, number]> = [];
  let from = Math.max(0, changed[0] - CONTEXT_LINES);
  let to = Math.min(ops.length - 1, changed[0] + CONTEXT_LINES);
  for (let k = 1; k < changed.length; k += 1) {
    const lo = Math.max(0, changed[k] - CONTEXT_LINES);
    const hi = Math.min(ops.length - 1, changed[k] + CONTEXT_LINES);
    if (lo <= to + 1) {
      to = hi;
    } else {
      groups.push([from, to]);
      from = lo;
      to = hi;
    }
  }
  groups.push([from, to]);

  // Running line numbers (1-based) before each op
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldBefore.push(o);
    newBefore.push(n);
    if (op.type !== '+') o += 1;
    if (op.type !== '-') n += 1;
  }

  for (const [s, e] of groups) {
    const slice = ops.slice(s, e + 1);
    const oldCount = slice.filter((x) => x.type !== '+').length;
    const newCount = slice.filter((x) => x.type !== '-').length;
    const oldStart = oldCount === 0 ? oldBefore[s] - 1 : oldBefore[s];
    const newStart = newCount === 0 ? newBefore[s] - 1 : newBefore[s];
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(renderLine(op));
  }
  return out;
}

/**
 * Build a `diff --git` unified patch for one file. Paths have no leading slash.
 * Binary, NUL-containing or oversized content yields a header-only patch.
 */
export function buildFilePatch(
  oldPath: string,
  newPath: string,
  oldText: string | null,
  newText: string | null,
  status: FileChangeStatus
): FilePatch {
  const lines: string[] = [`diff --git a/${oldPath} b/${newPath}`];
  if (status === 'add') lines.push('new file mode 100644');
  if (status === 'delete') lines.push('deleted file mode 100644');
  if (status === 'rename' && oldPath !== newPath) {
    lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  }

  if (isUnsupported(oldText) || isUnsupported(newText)) {
    lines.push(`Binary files a/${oldPath} and b/${newPath} differ`);
    return { patch: `${lines.join('\n')}\n`, additions: 0, deletions: 0 };
  }

  const before = status === 'add' ? [] : splitLines(oldText ?? '');
  const after = status === 'delete' ? [] : splitLines(newText ?? '');
  const ops = diffLines(before, after);
  const hunks = renderHunks(ops);
  if (hunks.length > 0) {
    lines.push(status === 'add' ? '--- /dev/null' : `--- a/${oldPath}`);
    lines.push(status === 'delete' ? '+++ /dev/null' : `+++ b/${newPath}`);
    lines.push(...hunks);
  }

  return {
    patch: `${lines.join('\n')}\n`,
    additions: ops.filter((x) => x.type === '+').length,
    deletions: ops.filter((x) => x.type === '-').length
  };
}
