/** Minimal line diff (LCS) good enough for approval previews. Falls back to a summary for huge files. */
export function unifiedDiff(oldText: string, newText: string, label: string, context = 3): string {
  if (oldText === newText) return `--- ${label}\n(no changes)`;
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length * b.length > 4_000_000) {
    return `--- ${label} (too large for a line diff)\nold: ${a.length} lines, new: ${b.length} lines\n\n+++ new content (first 200 lines):\n${b.slice(0, 200).map((l) => "+" + l).join("\n")}`;
  }
  // LCS table (lengths), built from the end.
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  type Op = { t: " " | "-" | "+"; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ t: " ", s: a[i], ai: i++, bi: j++ });
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) ops.push({ t: "+", s: b[j], ai: i, bi: j++ });
    else ops.push({ t: "-", s: a[i], ai: i++, bi: j });
  }
  // Group into hunks with context.
  const out = [`--- ${label} (before)`, `+++ ${label} (after)`];
  const changed = ops.map((o, k) => (o.t !== " " ? k : -1)).filter((k) => k >= 0);
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k] - context);
    let end = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) {
      k++;
      end = Math.min(ops.length - 1, changed[k] + context);
    }
    out.push(`@@ line ${ops[start].ai + 1} → ${ops[start].bi + 1} @@`);
    for (let x = start; x <= end; x++) out.push(ops[x].t + ops[x].s);
    k++;
  }
  return out.join("\n");
}
