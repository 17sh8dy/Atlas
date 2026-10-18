import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiffLine, FileReview, ReviewPayload } from '@atlas/core';
import { compactReview, diffText, payloadOf, reviewOf } from '@atlas/engine';
import { highlightLine, languageOf, type Lang } from '../src/components/review/highlight';
import { hunkHeader, splitRows } from '../src/components/review/diffRows';
import { DiffView } from '../src/components/review/DiffView';
import { ReviewBlock } from '../src/components/review/ReviewBlock';
import {
  STATUS_WORDS,
  canUndo,
  countsLabel,
  needsDecision,
  proposalHeading,
  summaryLine,
} from '../src/components/review/reviewModel';

const BEFORE = ['function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i;', '  return sum;', '}', ''].join('\n');
const AFTER = BEFORE.replace('let sum = 0;', 'let sum = 0; // running total');

const file = (status: FileReview['status'], extra: Partial<FileReview> = {}): FileReview => ({
  ...reviewOf('D:\\proj\\src\\total.ts', BEFORE, AFTER, status),
  ...extra,
});

describe('the highlighter never changes what is shown', () => {
  const LANGS: Lang[] = ['js', 'json', 'python', 'rust', 'c', 'css', 'html', 'shell', 'markdown', 'yaml', 'plain'];
  const SAMPLES = [
    'const x = "a // not a comment" + \'it\\\'s\'; // real comment',
    '  return `template ${value}`;',
    '#fff and # a comment and a#b',
    '/* block */ let a = 0x1F + 1_000.5e3; /* unclosed',
    '<div class="a">text</div> <!-- note -->',
    '`code` # Heading with `ticks`',
    '\t\ttabs\tand   spaces   ',
    '',
    '   ',
    'ünïcode — “quotes” 日本語 🙂',
    '"unterminated string',
    "'\\",
    '<<<<<<< HEAD',
  ];

  test('the tokens of a line, joined, are exactly the line — in every language', () => {
    for (const lang of LANGS) {
      for (const line of SAMPLES) {
        expect(highlightLine(line, lang).map((t) => t.text).join(''), `${lang}: ${JSON.stringify(line)}`).toBe(line);
      }
    }
  });

  test('holds for thousands of random lines too', () => {
    const alphabet = ['a', 'b', ' ', '"', "'", '`', '/', '*', '#', '\\', '<', '>', '!', '-', '0', '9', '.', '_', '$', '\t', 'é', '日'];
    let seed = 20261018;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 4000; i++) {
      const line = Array.from({ length: rnd(40) }, () => alphabet[rnd(alphabet.length)]!).join('');
      const lang = LANGS[rnd(LANGS.length)]!;
      expect(highlightLine(line, lang).map((t) => t.text).join(''), `${lang}: ${JSON.stringify(line)}`).toBe(line);
    }
  });

  test('colours the obvious things', () => {
    const kinds = (line: string, lang: Lang) => highlightLine(line, lang).filter((t) => t.kind !== 'plain').map((t) => `${t.kind}:${t.text}`);
    expect(kinds('const a = "hi"; // note', 'js')).toEqual(['keyword:const', 'string:"hi"', 'comment:// note']);
    expect(kinds('x = 42', 'python')).toEqual(['number:42']);
    expect(kinds('fn main() { let n = 3; }', 'rust')).toEqual(['keyword:fn', 'keyword:let', 'number:3']);
    expect(kinds('# heading', 'markdown')).toEqual(['keyword:# heading']);
    expect(kinds('a { color: #fff; }', 'css')).toEqual([]);
  });

  test('does not colour inside a string or take a "#" in the middle of a word for a comment', () => {
    expect(highlightLine('"// still a string"', 'js').map((t) => t.kind)).toEqual(['string']);
    expect(highlightLine('a#b', 'shell').some((t) => t.kind === 'comment')).toBe(false);
  });

  test('unknown file types stay plain', () => {
    expect(languageOf('notes.xyz')).toBe('plain');
    expect(highlightLine('const x = 1', 'plain')).toEqual([{ kind: 'plain', text: 'const x = 1' }]);
  });

  test('recognises languages by extension, either kind of path', () => {
    expect(languageOf('C:\\a\\b.tsx')).toBe('js');
    expect(languageOf('/a/b.py')).toBe('python');
    expect(languageOf('lib.RS')).toBe('rust');
    expect(languageOf('Makefile')).toBe('plain');
  });
});

describe('side by side', () => {
  const line = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text });

  test('pairs a run of removals with the additions that follow, row for row', () => {
    const rows = splitRows([line('context', 'a'), line('remove', 'b'), line('remove', 'c'), line('add', 'B'), line('context', 'd')]);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ left: { text: 'b' }, right: { text: 'B' } });
    expect(rows[2]!.left!.text).toBe('c');
    expect(rows[2]!.right).toBeUndefined();
    expect(rows[0]!.left).toBe(rows[0]!.right);
  });

  test('a pure addition or removal leaves the other side empty', () => {
    expect(splitRows([line('add', 'x')])).toEqual([{ right: { kind: 'add', text: 'x' } }]);
    expect(splitRows([line('remove', 'x')])).toEqual([{ left: { kind: 'remove', text: 'x' } }]);
  });

  test('every changed line appears exactly once', () => {
    const d = diffText('a\nb\nc\nd\ne\n', 'a\nX\nY\nd\nZ\ne\n');
    const lines = d.hunks!.flatMap((h) => h.lines);
    const rows = d.hunks!.flatMap((h) => splitRows(h.lines));
    const count = (k: DiffLine['kind']) => rows.reduce((n, r) => n + [r.left, r.right].filter((l) => l?.kind === k).length, 0);
    expect(count('remove')).toBe(lines.filter((l) => l.kind === 'remove').length);
    expect(count('add')).toBe(lines.filter((l) => l.kind === 'add').length);
  });

  test('hunk headers read like git’s', () => {
    expect(hunkHeader({ oldStart: 12, oldCount: 3, newStart: 12, newCount: 4, lines: [] })).toBe('@@ -12,3 +12,4 @@');
    expect(hunkHeader({ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, lines: [] })).toBe('@@ -5 +5 @@');
  });
});

describe('the diff as drawn', () => {
  test('inline: both line numbers, markers, and colour classes for added and removed', () => {
    const html = renderToStaticMarkup(createElement(DiffView, { file: file('applied'), mode: 'inline' }));
    expect(html).toContain('data-kind="add"');
    expect(html).toContain('data-kind="remove"');
    expect(html).toContain('bg-success/15');
    expect(html).toContain('bg-danger/15');
    expect(html).toContain('@@ -1,');
    expect(html).toContain('running total');
  });

  test('side by side draws two columns', () => {
    const html = renderToStaticMarkup(createElement(DiffView, { file: file('applied'), mode: 'split' }));
    expect(html).toContain('side by side');
    expect(html).toContain('divide-x');
  });

  test('file contents are text, never markup', () => {
    const f = reviewOf('x.html', '<p>a</p>\n', '<script>alert(1)</script>\n', 'applied');
    const html = renderToStaticMarkup(createElement(DiffView, { file: f, mode: 'inline' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;');
  });

  test('says why when there are no lines to show', () => {
    const none = renderToStaticMarkup(createElement(DiffView, { file: { ...file('applied'), hunks: null, note: 'Too large to show.' }, mode: 'inline' }));
    expect(none).toContain('Too large to show.');
    const same = renderToStaticMarkup(createElement(DiffView, { file: reviewOf('a.txt', 'a\r\n', 'a\n', 'applied'), mode: 'inline' }));
    expect(same).toMatch(/line endings/i);
  });
});

describe('proposed is never dressed as applied', () => {
  const proposal: ReviewPayload = payloadOf(file('proposed'));
  const written: ReviewPayload = payloadOf(file('applied', { changeId: 'chg-1' }));

  test('a card that has not been answered says nothing was written, and shows the diff', () => {
    const html = renderToStaticMarkup(createElement(ReviewBlock, { review: proposal, context: 'proposal' }));
    expect(html).toContain('Nothing has been written to your files yet');
    expect(html).toContain('Proposed');
    expect(html).not.toMatch(/Applied|Undo/);
    expect(html).toContain('data-kind="add"'); // the diff is open before you answer
  });

  test('a declined card says so, and the file is not "applied"', () => {
    const html = renderToStaticMarkup(createElement(ReviewBlock, { review: proposal, context: 'proposal', answered: 'no' }));
    expect(html).toContain('Declined. Nothing was written to your files');
    expect(html).toContain('Not applied');
    expect(html).not.toContain('Applied<');
  });

  test('a stopped card says so too', () => {
    expect(proposalHeading('halted')).toMatch(/Nothing was written/);
    expect(proposalHeading('yes')).toMatch(/approved/i);
  });

  test('a written change says it was written, and offers undo; it never says "proposed"', () => {
    const html = renderToStaticMarkup(createElement(ReviewBlock, { review: written, context: 'result' }));
    expect(html).toContain('Applied');
    expect(html).toContain('Undo');
    expect(html).toContain('Keep');
    expect(html).toContain('Review');
    expect(html).not.toMatch(/Proposed|would/);
  });

  test('a written change with no checkpoint offers no undo and says why', () => {
    const noCheckpoint = payloadOf(file('applied', { note: 'No checkpoint was kept in this build, so this edit can’t be undone from here.' }));
    const html = renderToStaticMarkup(createElement(ReviewBlock, { review: noCheckpoint, context: 'result' }));
    expect(html).not.toContain('Undo');
    expect(html).toContain('can’t be undone from here');
  });

  test('the words for each state are distinct and honest', () => {
    expect(STATUS_WORDS.proposed.detail).toMatch(/Not written yet/);
    expect(STATUS_WORDS.applied.detail).toMatch(/Written to your file/);
    expect(STATUS_WORDS.reverted.detail).toMatch(/put back/);
    expect(new Set(Object.values(STATUS_WORDS).map((w) => w.label)).size).toBe(4);
  });
});

describe('summaries and controls', () => {
  test('counts and totals', () => {
    expect(countsLabel({ added: 12, removed: 3 })).toBe('+12 −3');
    const r = payloadOf(file('applied'), file('applied'));
    expect(summaryLine(r)).toBe('2 files · +2 −2');
    expect(summaryLine(payloadOf(file('applied')))).toBe('1 file · +1 −1');
  });

  test('undo needs a written change and a checkpoint; keep needs one still waiting', () => {
    expect(canUndo({ status: 'applied', changeId: 'x' })).toBe(true);
    expect(canUndo({ status: 'kept', changeId: 'x' })).toBe(true);
    expect(canUndo({ status: 'applied' })).toBe(false);
    expect(canUndo({ status: 'proposed', changeId: 'x' })).toBe(false);
    expect(canUndo({ status: 'reverted', changeId: 'x' })).toBe(false);
    expect(needsDecision({ status: 'applied', changeId: 'x' })).toBe(true);
    expect(needsDecision({ status: 'kept', changeId: 'x' })).toBe(false);
  });
});

describe('what is saved in the conversation', () => {
  test('keeps counts and status, drops the lines, and can still find the checkpoint', () => {
    const saved = compactReview(payloadOf(file('applied', { changeId: 'chg-7' })));
    expect(saved.files[0]).toMatchObject({ status: 'applied', changeId: 'chg-7', added: 1, removed: 1, hunks: null });
    expect(JSON.stringify(saved)).not.toContain('running total');
  });

  test('a saved card still renders honestly with no lines', () => {
    const saved = compactReview(payloadOf(file('applied', { changeId: 'chg-7' })));
    const html = renderToStaticMarkup(createElement(ReviewBlock, { review: saved, context: 'result' }));
    expect(html).toContain('total.ts');
    expect(html).toContain('+1');
    expect(html).toContain('Applied');
  });
});
