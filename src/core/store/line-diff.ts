type Edit = { kind: " " | "+" | "-"; text: string };

/** Myers' shortest edit script over exact lines, including their line endings. */
export function lineEdits(before: string, after: string): Edit[] {
  const a = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const b = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const old = a.slice(prefix, a.length - suffix),
    next = b.slice(prefix, b.length - suffix);
  const v = new Map<number, number>([[1, 0]]),
    trace: Map<number, number>[] = [];
  let distance = 0;
  search: for (let d = 0; d <= old.length + next.length; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
          ? (v.get(k + 1) ?? 0)
          : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < old.length && y < next.length && old[x] === next[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= old.length && y >= next.length) {
        distance = d;
        break search;
      }
    }
  }
  const middle: Edit[] = [];
  let x = old.length,
    y = next.length;
  for (let d = distance; d >= 0; d--) {
    const previous = trace[d]!,
      k = x - y;
    const previousK =
      k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1))
        ? k + 1
        : k - 1;
    const px = previous.get(previousK) ?? 0,
      py = px - previousK;
    while (x > px && y > py) {
      middle.push({ kind: " ", text: old[--x]! });
      y--;
    }
    if (d === 0) break;
    if (x === px) middle.push({ kind: "+", text: next[--y]! });
    else middle.push({ kind: "-", text: old[--x]! });
  }
  return [
    ...a.slice(0, prefix).map((text) => ({ kind: " " as const, text })),
    ...middle.reverse(),
    ...a.slice(a.length - suffix).map((text) => ({ kind: " " as const, text })),
  ];
}

/** Minimal line edits grouped into standard unified hunks with three context lines. */
export function unifiedLineDiff(
  before: string,
  after: string,
  oldPath: string,
  newPath: string,
): string {
  if (before === after) return "";
  const edits = lineEdits(before, after),
    changed = edits.flatMap((e, i) => (e.kind === " " ? [] : [i]));
  const spans: { start: number; end: number }[] = [];
  for (const i of changed) {
    const start = Math.max(0, i - 3),
      end = Math.min(edits.length, i + 4),
      last = spans.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  }
  const positions = [{ a: 1, b: 1 }];
  for (const edit of edits) {
    const p = positions.at(-1)!;
    positions.push({ a: p.a + (edit.kind === "+" ? 0 : 1), b: p.b + (edit.kind === "-" ? 0 : 1) });
  }
  const range = (line: number, count: number) =>
    count === 1 ? String(line) : `${count === 0 ? line - 1 : line},${count}`;
  let result = `--- a/${oldPath}\n+++ b/${newPath}\n`;
  for (const { start, end } of spans) {
    const p = positions[start]!,
      q = positions[end]!;
    result += `@@ -${range(p.a, q.a - p.a)} +${range(p.b, q.b - p.b)} @@\n`;
    for (const edit of edits.slice(start, end))
      result +=
        edit.kind +
        edit.text +
        (edit.text.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");
  }
  return result;
}
