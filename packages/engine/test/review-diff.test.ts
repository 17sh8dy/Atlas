/**
 * The diff engine behind code review. It has to be RIGHT, not just plausible: a wrong diff on a card
 * is a wrong thing a person approves. So beyond the hand-written cases, a randomised property check
 * applies every script it produces and demands the result be exactly the target, and compares the
 * script length with an independent LCS to prove it is minimal.
 */
import { describe, expect, test } from 'vitest';
import {
  applyEdit,
  compactReview,
  diffText,
  fileNameOf,
  MAX_DIFF_LINES,
  payloadOf,
  reviewOf,
  splitLines,
} from '../src/review/diff';
import type { DiffHunk } from '@atlas/core';

/** Rebuild the "after" text from hunks laid over "before", the way a patch tool would. */
function applyHunks(before: string, hunks: DiffHunk[]): string[] {
  const old = splitLines(before);
  const out: string[] = [];
  let cursor = 0; // index into old
  for (const h of hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1; // an insert-only hunk anchors AFTER oldStart-1 lines
    while (cursor < start) out.push(old[cursor++]!);
    for (const l of h.lines) {
      if (l.kind === 'context') {
        out.push(old[cursor++]!);
      } else if (l.kind === 'remove') {
        cursor++;
      } else {
        out.push(l.text);
      }
    }
  }
  while (cursor < old.length) out.push(old[cursor++]!);
  return out;
}

/** Longest common subsequence length, the slow obvious way. */
function lcs(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      t[i]![j] = a[i - 1] === b[j - 1] ? t[i - 1]![j - 1]! + 1 : Math.max(t[i - 1]![j]!, t[i]![j - 1]!);
  return t[a.length]![b.length]!;
}

describe('diffText', () => {
  test('identical text has no changes', () => {
    const d = diffText('a\nb\nc\n', 'a\nb\nc\n');
    expect(d).toMatchObject({ added: 0, removed: 0, identical: true, eolOnly: false });
    expect(d.hunks).toEqual([]);
  });

  test('one changed line is one removal and one addition, with context around it', () => {
    const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].join('\n');
    const after = before.replace('five', 'FIVE');
    const d = diffText(before, after);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks![0]!;
    expect(h.lines.filter((l) => l.kind === 'remove').map((l) => l.text)).toEqual(['five']);
    expect(h.lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['FIVE']);
    // Three lines of context either side, like `git diff`.
    expect(h.lines.filter((l) => l.kind === 'context')).toHaveLength(6);
    expect(h.oldStart).toBe(2);
    expect(h.newStart).toBe(2);
  });

  test('line numbers are the real ones on each side', () => {
    const d = diffText('a\nb\nc\nd\n', 'a\nX\nY\nc\nd\n');
    const lines = d.hunks!.flatMap((h) => h.lines);
    const removed = lines.find((l) => l.kind === 'remove')!;
    expect(removed).toMatchObject({ text: 'b', oldNo: 2 });
    expect(removed.newNo).toBeUndefined();
    const adds = lines.filter((l) => l.kind === 'add');
    expect(adds.map((l) => [l.text, l.newNo])).toEqual([
      ['X', 2],
      ['Y', 3],
    ]);
    expect(adds[0]!.oldNo).toBeUndefined();
  });

  test('far-apart changes are separate hunks, nearby ones merge', () => {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const far = [...base];
    far[2] = 'CHANGED A';
    far[35] = 'CHANGED B';
    expect(diffText(base.join('\n'), far.join('\n')).hunks).toHaveLength(2);
    const near = [...base];
    near[10] = 'X';
    near[13] = 'Y';
    expect(diffText(base.join('\n'), near.join('\n')).hunks).toHaveLength(1);
  });

  test('a new file is all additions, a deleted body is all removals', () => {
    expect(diffText('', 'a\nb\n')).toMatchObject({ added: 2, removed: 0 });
    expect(diffText('a\nb\n', '')).toMatchObject({ added: 0, removed: 2 });
  });

  test('line endings alone are not a change, and the diff says so', () => {
    const d = diffText('a\r\nb\r\nc\r\n', 'a\nb\nc\n');
    expect(d).toMatchObject({ added: 0, removed: 0, identical: true, eolOnly: true });
    expect(diffText('a\nb', 'a\nb\n')).toMatchObject({ identical: true, eolOnly: true });
    expect(diffText('a\nb\n', 'a\nb\n').eolOnly).toBe(false);
  });

  test('CRLF files diff by content, not by their line endings', () => {
    const d = diffText('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n');
    expect(d).toMatchObject({ added: 1, removed: 1 });
    expect(d.hunks![0]!.lines.find((l) => l.kind === 'add')!.text).toBe('B');
  });

  test('blank lines and repeated lines are handled', () => {
    const d = diffText('x\n\n\nx\n', 'x\n\nx\n');
    expect(d).toMatchObject({ added: 0, removed: 1 });
    const e = diffText('a\na\na\n', 'a\na\na\na\n');
    expect(e).toMatchObject({ added: 1, removed: 0 });
  });

  test('applying the hunks to "before" gives exactly "after" — 300 random edits', () => {
    // A tiny deterministic generator, so a failure is reproducible.
    let seed = 20261018;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const words = ['alpha', 'beta', 'gamma', 'delta', '', '}', '{', 'return x;', 'const a = 1;'];
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: rnd(25) }, () => words[rnd(words.length)]!);
      const b = [...a];
      for (let k = rnd(6); k > 0; k--) {
        const op = rnd(3);
        if (op === 0 && b.length) b.splice(rnd(b.length), 1);
        else if (op === 1) b.splice(rnd(b.length + 1), 0, words[rnd(words.length)]!);
        else if (b.length) b[rnd(b.length)] = words[rnd(words.length)]!;
      }
      const before = a.length ? a.join('\n') + '\n' : '';
      const after = b.length ? b.join('\n') + '\n' : '';
      const d = diffText(before, after);
      expect(d.hunks, `round ${round}`).not.toBeNull();
      expect(applyHunks(before, d.hunks!), `round ${round}`).toEqual(splitLines(after));
      // Minimal: removals + additions == the shortest possible edit script (via LCS).
      expect(d.added + d.removed, `round ${round}`).toBe(a.length + b.length - 2 * lcs(a, b));
    }
  });

  test('a huge file is counted, not compared', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 5 }, (_, i) => `l${i}`).join('\n');
    const d = diffText(big, big + '\nextra');
    expect(d.hunks).toBeNull();
    expect(d.added).toBeGreaterThan(0);
  });

  test('two completely different files are counted, not compared', () => {
    const a = Array.from({ length: 1800 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 1800 }, (_, i) => `new ${i}`).join('\n');
    const d = diffText(a, b);
    expect(d.hunks).toBeNull();
    expect(d).toMatchObject({ added: 1800, removed: 1800 });
  });
});

describe('applyEdit mirrors the native patch', () => {
  test('replaces a unique piece of text', () => {
    expect(applyEdit('let a = 1;\nlet b = 2;\n', 'let b = 2;', 'let b = 3;')).toEqual({
      ok: true,
      after: 'let a = 1;\nlet b = 3;\n',
      count: 1,
    });
  });

  test('refuses text that is missing, empty, or not unique — in the native words', () => {
    expect(applyEdit('abc', 'zzz', 'y')).toEqual({ ok: false, error: "That text isn't in the file — nothing to replace." });
    expect(applyEdit('abc', '', 'y')).toEqual({ ok: false, error: 'Nothing to find — the search text is empty.' });
    expect(applyEdit('xx xx', 'xx', 'y')).toEqual({
      ok: false,
      error: 'That text appears 2 times — pass more context to make it unique, or replaceAll.',
    });
  });

  test('replaceAll replaces every occurrence and counts them', () => {
    expect(applyEdit('xx xx xx', 'xx', 'y', true)).toEqual({ ok: true, after: 'y y y', count: 3 });
  });

  test('occurrences do not overlap, as the native side counts them', () => {
    // "aaa" contains "aa" once without overlap (then one "a" left).
    expect(applyEdit('aaa', 'aa', 'b')).toEqual({ ok: true, after: 'ba', count: 1 });
    expect(applyEdit('aaaa', 'aa', 'b')).toMatchObject({ ok: false });
    expect(applyEdit('aaaa', 'aa', 'b', true)).toEqual({ ok: true, after: 'bb', count: 2 });
  });

  test('the replacement is literal: $ patterns and regex characters mean nothing', () => {
    expect(applyEdit('price', 'price', '$& $1 $$ (.*)')).toMatchObject({ ok: true, after: '$& $1 $$ (.*)' });
    expect(applyEdit('a.b', '.', '\\')).toMatchObject({ ok: true, after: 'a\\b' });
  });

  test('replaces the FIRST occurrence when asked for one and it is unique', () => {
    expect(applyEdit('one two', 'two', 'TWO')).toMatchObject({ ok: true, after: 'one TWO' });
  });
});

describe('reviewOf', () => {
  test('describes a single applied edit', () => {
    const r = reviewOf('D:\\Dev\\app\\src\\main.ts', 'a\nb\nc\n', 'a\nB\nc\n', 'applied', { changeId: 'chg-1' });
    expect(r).toMatchObject({ name: 'main.ts', status: 'applied', added: 1, removed: 1, changeId: 'chg-1' });
    expect(r.hunks).toHaveLength(1);
    expect(r.note).toBeUndefined();
  });

  test('a file that did not exist is a new file, all additions', () => {
    const r = reviewOf('/tmp/new.txt', null, 'x\ny\n', 'proposed');
    expect(r).toMatchObject({ added: 2, removed: 0, status: 'proposed', note: 'A new file.' });
  });

  test('says when only line endings changed', () => {
    const r = reviewOf('a.txt', 'a\r\nb\r\n', 'a\nb\n', 'applied');
    expect(r).toMatchObject({ added: 0, removed: 0 });
    expect(r.note).toMatch(/line endings/i);
  });

  test('gives honest counts and a reason when the lines are not shown', () => {
    const a = Array.from({ length: 1800 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 1800 }, (_, i) => `new ${i}`).join('\n');
    const r = reviewOf('big.txt', a, b, 'applied');
    expect(r.hunks).toBeNull();
    expect(r).toMatchObject({ added: 1800, removed: 1800 });
    expect(r.note).toMatch(/too large or too different/i);
  });

  test('the status is carried exactly as given — a proposal is never relabelled', () => {
    for (const status of ['proposed', 'applied', 'kept', 'reverted'] as const) {
      expect(reviewOf('f.ts', 'a', 'b', status).status).toBe(status);
    }
  });

  test('file names come from either kind of separator', () => {
    expect(fileNameOf('C:\\a\\b\\c.rs')).toBe('c.rs');
    expect(fileNameOf('/a/b/c.rs')).toBe('c.rs');
    expect(fileNameOf('c.rs')).toBe('c.rs');
  });
});

describe('compactReview (what is kept in the saved conversation)', () => {
  test('drops the lines but keeps counts, status and the id to find them again', () => {
    const full = payloadOf(reviewOf('x.ts', 'a\n', 'b\n', 'applied', { changeId: 'chg-9' }));
    const small = compactReview(full);
    expect(small.files[0]).toMatchObject({ added: 1, removed: 1, status: 'applied', changeId: 'chg-9', hunks: null });
    expect(JSON.stringify(small)).not.toContain('"text"');
  });

  test('a proposal that was never written keeps only its counts', () => {
    const small = compactReview(payloadOf(reviewOf('x.ts', 'a\n', 'b\n', 'proposed')));
    expect(small.files[0]).toMatchObject({ status: 'proposed', hunks: null });
    expect(small.files[0]!.changeId).toBeUndefined();
  });
});
