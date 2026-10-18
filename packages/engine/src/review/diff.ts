/**
 * Line diffs, and the edit arithmetic that has to agree with the native side.
 *
 * Pure functions, no dependencies, no I/O. Written from scratch (Myers' O(ND) algorithm) rather than
 * pulled in as a library because the installer is the size it is on purpose, and a diff is forty
 * lines of well-known maths.
 *
 *   · `diffText`   — what changed between two texts, as hunks with a few lines of context.
 *   · `applyEdit`  — the same "replace this exact text" the native `patch_text_file` performs, so a
 *                    PROPOSED edit can be shown before anything is written and still match what
 *                    would be written. Its refusals use the native messages word for word.
 *   · `reviewOf`   — one file's change, as the payload a card or panel shows.
 *
 * Honesty rules, which the tests hold:
 *   · counts are always the real counts, even when the lines are too many to show;
 *   · a text that only differs in line endings reports zero changes and says why;
 *   · nothing is rounded, trimmed or summarised into something it is not.
 */

import type { DiffHunk, DiffLine, FileReview, ReviewPayload, ReviewStatus } from '@atlas/core';

/** Compared line by line only up to this many lines on either side. */
export const MAX_DIFF_LINES = 20_000;
/** …and only while the shortest edit script stays this short; beyond it the files are "too different". */
export const MAX_EDIT_DISTANCE = 1_500;
/** A diff with more changed lines than this is not shown line by line in a card; the counts are. */
export const MAX_SHOWN_CHANGED = 2_000;
export const DEFAULT_CONTEXT = 3;

export interface DiffResult {
  added: number;
  removed: number;
  /** `null`: too large or too different to compare line by line. The counts are still exact. */
  hunks: DiffHunk[] | null;
  /** No line differs. (The raw text may still differ in line endings; see `eolOnly`.) */
  identical: boolean;
  /** The texts differ ONLY in line endings or the final newline. */
  eolOnly: boolean;
}

/** Lines without their line endings; a final newline does not make an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

type Op = { kind: 'equal' | 'delete' | 'insert'; a: number; b: number };

/**
 * The shortest edit script from `a` to `b` (Myers). Returns `null` if it would take more than
 * `maxD` edits, so a pathological pair cannot hang the interface.
 */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;

  // Walk back from the end, newest step first.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: 'equal', a: x, b: y });
    }
    if (x === prevX) {
      y--;
      ops.push({ kind: 'insert', a: x, b: y });
    } else {
      x--;
      ops.push({ kind: 'delete', a: x, b: y });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: 'equal', a: x, b: y });
  }
  ops.reverse();
  return ops;
}

/** What changed between two texts. */
export function diffText(before: string, after: string, context = DEFAULT_CONTEXT): DiffResult {
  const same = (s: string) => s.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const a = splitLines(before);
  const b = splitLines(after);

  // Common head and tail are never "different", and trimming them keeps the search small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);

  if (aMid.length === 0 && bMid.length === 0) {
    const eolOnly = before !== after && same(before) === same(after);
    return { added: 0, removed: 0, hunks: [], identical: true, eolOnly };
  }
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    // Too long to compare precisely. The counts below are the honest bound, not a measurement.
    return { added: bMid.length, removed: aMid.length, hunks: null, identical: false, eolOnly: false };
  }

  const script = myers(aMid, bMid, MAX_EDIT_DISTANCE);
  if (!script) {
    // Too different: everything in the middle is shown as replaced only as a COUNT, not as lines.
    return { added: bMid.length, removed: aMid.length, hunks: null, identical: false, eolOnly: false };
  }

  // Lay the full script out with line numbers (head and tail included as equal lines).
  const lines: DiffLine[] = [];
  for (let i = 0; i < head; i++) lines.push({ kind: 'context', text: a[i]!, oldNo: i + 1, newNo: i + 1 });
  for (const op of script) {
    if (op.kind === 'equal') {
      lines.push({ kind: 'context', text: aMid[op.a]!, oldNo: head + op.a + 1, newNo: head + op.b + 1 });
    } else if (op.kind === 'delete') {
      lines.push({ kind: 'remove', text: aMid[op.a]!, oldNo: head + op.a + 1 });
    } else {
      lines.push({ kind: 'add', text: bMid[op.b]!, newNo: head + op.b + 1 });
    }
  }
  for (let i = 0; i < tail; i++) {
    const ai = a.length - tail + i;
    const bi = b.length - tail + i;
    lines.push({ kind: 'context', text: a[ai]!, oldNo: ai + 1, newNo: bi + 1 });
  }

  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'remove') removed++;
  }
  return { added, removed, hunks: toHunks(lines, context), identical: false, eolOnly: false };
}

/** Group changed lines with `context` unchanged lines either side; nearby groups merge into one hunk. */
function toHunks(lines: readonly DiffLine[], context: number): DiffHunk[] {
  const changed: number[] = [];
  lines.forEach((l, i) => {
    if (l.kind !== 'context') changed.push(i);
  });
  if (!changed.length) return [];

  const ranges: Array<[number, number]> = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }

  return ranges.map(([lo, hi]) => {
    const slice = lines.slice(lo, hi + 1);
    const olds = slice.filter((l) => l.kind !== 'add');
    const news = slice.filter((l) => l.kind !== 'remove');
    // Where the hunk sits. A side with no lines in it (a pure insertion, or a pure deletion) is
    // anchored the way `git diff` does it: the number of lines of that side that come BEFORE it.
    const oldBefore = lines.slice(0, lo).filter((l) => l.kind !== 'add').length;
    const newBefore = lines.slice(0, lo).filter((l) => l.kind !== 'remove').length;
    return {
      oldStart: olds.length ? olds[0]!.oldNo! : oldBefore,
      oldCount: olds.length,
      newStart: news.length ? news[0]!.newNo! : newBefore,
      newCount: news.length,
      lines: slice,
    };
  });
}

// ---- the edit arithmetic, matching the native side ---------------------------------------

export type EditOutcome = { ok: true; after: string; count: number } | { ok: false; error: string };

/**
 * "Replace this exact text" — what `patch_text_file` does, to the same rules and with the same
 * words when it refuses: the text must be present, and unique unless `replaceAll` is set. Occurrences
 * are counted without overlapping, left to right, as the native side counts them.
 */
export function applyEdit(before: string, find: string, replace: string, replaceAll = false): EditOutcome {
  if (find === '') return { ok: false, error: 'Nothing to find — the search text is empty.' };
  const parts = before.split(find);
  const occurrences = parts.length - 1;
  if (occurrences === 0) return { ok: false, error: "That text isn't in the file — nothing to replace." };
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      error: `That text appears ${occurrences} times — pass more context to make it unique, or replaceAll.`,
    };
  }
  if (replaceAll) return { ok: true, after: parts.join(replace), count: occurrences };
  // First occurrence only. Built from the parts so `$&` and friends in `replace` stay literal.
  return { ok: true, after: parts[0]! + replace + parts.slice(1).join(find), count: 1 };
}

// ---- turning a diff into what a card shows --------------------------------------------------

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * One file's change as a payload. `before === null` means the file did not exist (everything is
 * added). The note says what the lines alone cannot: that only line endings changed, or that the
 * file was too large or too different to show line by line.
 */
export function reviewOf(
  path: string,
  before: string | null,
  after: string,
  status: ReviewStatus,
  extra: { changeId?: string; note?: string } = {},
): FileReview {
  const d = diffText(before ?? '', after);
  let hunks = d.hunks;
  let note = extra.note;
  if (d.hunks === null) {
    note = note ?? `Too large or too different to show line by line: ${d.removed} lines removed, ${d.added} added.`;
  } else if (d.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind !== 'context').length, 0) > MAX_SHOWN_CHANGED) {
    hunks = null;
    note = note ?? `Too many changes to show here: ${d.removed} lines removed, ${d.added} added.`;
  } else if (d.identical && d.eolOnly) {
    note = note ?? 'Only line endings or the final newline changed.';
  } else if (before === null) {
    note = note ?? 'A new file.';
  }
  return {
    path,
    name: fileNameOf(path),
    status,
    added: d.added,
    removed: d.removed,
    hunks,
    ...(extra.changeId ? { changeId: extra.changeId } : {}),
    ...(note ? { note } : {}),
  };
}

export function payloadOf(...files: FileReview[]): ReviewPayload {
  return { files };
}

/**
 * The version of a review that is safe to keep in the saved conversation: counts, status and the
 * change id, but not the lines. Whoever opens it later gets the diff back from the checkpoint by id;
 * a proposal that was never written has no checkpoint, so only its counts survive.
 */
export function compactReview(review: ReviewPayload): ReviewPayload {
  return {
    files: review.files.map((f) => {
      const { note, ...rest } = f;
      const kept = note && !note.startsWith('Too ') ? note : f.changeId ? 'Open the review to see the lines.' : undefined;
      return { ...rest, hunks: null, ...(kept ? { note: kept } : {}) };
    }),
  };
}
