/**
 * Turning hunks into rows a screen can lay out. Pure, so the arrangement can be tested without
 * rendering anything.
 *
 * Inline view is the hunks as they are. Side-by-side pairs each run of removed lines with the run
 * of added lines that follows it, row for row, with a blank cell where one side is longer, which is
 * how every diff tool lays out a change. Context lines sit on both sides.
 */

import type { DiffHunk, DiffLine } from '@atlas/core';

export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/** One hunk's lines as side-by-side rows. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    // A run of removals, then the run of additions right after it, are one change.
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'remove') removed.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === 'add') added.push(lines[i++]!);
    const n = Math.max(removed.length, added.length);
    for (let k = 0; k < n; k++) {
      const row: SplitRow = {};
      if (removed[k]) row.left = removed[k]!;
      if (added[k]) row.right = added[k]!;
      rows.push(row);
    }
  }
  return rows;
}

/** `@@ -12,3 +12,4 @@` — where a hunk sits, in the form people recognise. */
export function hunkHeader(h: DiffHunk): string {
  const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);
  return `@@ -${range(h.oldStart, h.oldCount)} +${range(h.newStart, h.newCount)} @@`;
}
