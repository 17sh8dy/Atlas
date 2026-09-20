import { describe, expect, test } from 'vitest';
import {
  MIN_HEIGHT,
  NOTE_FROM,
  SEND_LIMIT,
  composerMaxHeight,
  fitComposer,
  lengthNote,
} from '../src/components/composer-size';

describe('composerMaxHeight', () => {
  test('is a share of the window, so it scales with it', () => {
    expect(composerMaxHeight(700)).toBe(280);
    expect(composerMaxHeight(600)).toBe(240);
  });

  test('has a floor on a tiny window and a ceiling on a huge one', () => {
    expect(composerMaxHeight(200)).toBe(112);
    expect(composerMaxHeight(1440)).toBe(360);
    expect(composerMaxHeight(5000)).toBe(360);
  });

  test('never returns nonsense for a bad viewport', () => {
    for (const v of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const h = composerMaxHeight(v);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(112);
      expect(h).toBeLessThanOrEqual(360);
    }
  });
});

describe('fitComposer', () => {
  const VIEW = 800; // max 320

  test('a short message is one line tall and never scrolls', () => {
    expect(fitComposer(20, VIEW)).toEqual({ height: MIN_HEIGHT, scrolls: false });
    expect(fitComposer(0, VIEW)).toEqual({ height: MIN_HEIGHT, scrolls: false });
  });

  test('a few lines grow the box to fit, still without a scrollbar', () => {
    expect(fitComposer(96, VIEW)).toEqual({ height: 96, scrolls: false });
    expect(fitComposer(320, VIEW)).toEqual({ height: 320, scrolls: false });
  });

  test('past the maximum it stops growing and scrolls instead', () => {
    expect(fitComposer(321, VIEW)).toEqual({ height: 320, scrolls: true });
    expect(fitComposer(2_000, VIEW)).toEqual({ height: 320, scrolls: true });
  });

  test('a very large paste stays within bounds', () => {
    // ~100,000 characters at ~90 per line, ~20px a line ≈ 22,000px of content
    const fit = fitComposer(22_000, VIEW);
    expect(fit.height).toBe(320);
    expect(fit.scrolls).toBe(true);
    // and on the largest window it is still capped
    expect(fitComposer(22_000, 4000).height).toBe(360);
  });

  test('the box always leaves room for the conversation', () => {
    for (const view of [300, 500, 800, 1080, 2160]) {
      expect(fitComposer(100_000, view).height).toBeLessThanOrEqual(view * 0.5);
    }
  });

  test('garbage input cannot produce a broken height', () => {
    for (const c of [Number.NaN, -50]) {
      expect(fitComposer(c, VIEW)).toEqual({ height: MIN_HEIGHT, scrolls: false });
    }
  });
});

describe('lengthNote', () => {
  test('an ordinary message has none', () => {
    expect(lengthNote(0)).toBeNull();
    expect(lengthNote(NOTE_FROM - 1)).toBeNull();
  });

  test('a long one gets a quiet count', () => {
    expect(lengthNote(NOTE_FROM)).toEqual({ tone: 'info', text: '4,000 characters' });
    expect(lengthNote(12_345)).toEqual({ tone: 'info', text: '12,345 characters' });
    expect(lengthNote(SEND_LIMIT)?.tone).toBe('info');
  });

  test('past the sending limit it warns, and says what to do', () => {
    const n = lengthNote(SEND_LIMIT + 1);
    expect(n?.tone).toBe('warn');
    expect(n?.text).toContain('100,001 characters');
    expect(n?.text).toMatch(/Split it up/);
  });
});
