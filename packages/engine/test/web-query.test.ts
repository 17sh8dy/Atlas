import { describe, expect, test } from 'vitest';
import { rewriteQuery } from '../src/web/query';

const NOW = new Date(2026, 8, 19); // September 2026

describe('rewriteQuery', () => {
  test('the example that started this', () => {
    expect(rewriteQuery('What season of Fortnite is it?', 'release', NOW)).toBe(
      'Fortnite current season September 2026',
    );
  });

  test('"what season is X on" has the same shape', () => {
    expect(rewriteQuery('what season is Apex Legends on right now', 'release', NOW)).toBe(
      'Apex Legends current season September 2026',
    );
  });

  test('strips conversational filler and question words', () => {
    expect(
      rewriteQuery('hey atlas, can you tell me who won the Lakers game last night?', 'live', NOW),
    ).toBe('won the Lakers game last night September 2026');
    expect(rewriteQuery('please look up the release date of Silksong', 'explicit', NOW)).toBe(
      'release date of Silksong',
    );
  });

  test('adds an intent word to release questions that lack one, but not when one is present', () => {
    expect(rewriteQuery('when does the new Apex season start', 'release', NOW)).toContain('latest');
    expect(rewriteQuery('what is the latest version of Node', 'release', NOW)).not.toMatch(
      /latest.*latest/,
    );
  });

  test('does not add a date to questions that are not about now, or that already have one', () => {
    expect(rewriteQuery('how much does a PS5 cost', 'price', NOW)).not.toMatch(/2026/);
    expect(rewriteQuery('best laptops 2026', 'dated', NOW)).toBe('best laptops 2026');
    expect(rewriteQuery('best laptops 2027', 'release', NOW)).toContain('2027');
    expect(rewriteQuery('best laptops 2027', 'release', NOW)).not.toContain('2026');
  });

  test('falls back to the original text when nothing usable is left', () => {
    expect(rewriteQuery('is it?', 'recency', NOW)).toBe('is it?');
    expect(rewriteQuery('', 'recency', NOW)).toBe('');
  });

  test('never invents a subject: the result only contains words from the input (plus intent and date)', () => {
    const q = rewriteQuery('what happened in the Fortnite update today', 'recency', NOW);
    const allowed = new Set(
      'what happened in the fortnite update today latest september 2026'.split(' '),
    );
    for (const w of q.toLowerCase().split(/\s+/)) expect(allowed.has(w), w).toBe(true);
  });
});
