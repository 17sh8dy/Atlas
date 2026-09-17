import { test, assert } from 'vitest';
import {
  DEFAULT_TEXT_STYLE,
  FONTS,
  TEXT_COLORS,
  readTextStyle,
  revealPlan,
} from '../src/text-style';

// The surfaces a reply is read on, per theme — copied from tokens.css. If
// those change, these must too, which is the point: a reply colour tuned
// against an old background is exactly how contrast fails quietly.
const SURFACES = {
  dark: { background: '8 8 11', surface: '18 18 23', raised: '26 26 33' },
  light: { background: '240 241 245', surface: '250 250 252', raised: '255 255 255' },
};

function luminance(channels: string): number {
  const [r, g, b] = channels.split(' ').map((c) => {
    const v = Number(c) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test('every reply colour meets WCAG AA on every surface of the theme it is for', () => {
  for (const color of TEXT_COLORS) {
    for (const theme of ['dark', 'light'] as const) {
      const value = color[theme];
      if (value === null) continue; // the theme's own foreground, checked in tokens.test.ts
      for (const [name, surface] of Object.entries(SURFACES[theme])) {
        const ratio = contrast(value, surface);
        assert.isAtLeast(ratio, 4.5, `${color.id} on ${theme} ${name}: ${ratio.toFixed(2)}`);
      }
    }
  }
});

test('ids are unique, and every font stack ends in a generic family', () => {
  assert.equal(new Set(FONTS.map((f) => f.id)).size, FONTS.length);
  assert.equal(new Set(TEXT_COLORS.map((c) => c.id)).size, TEXT_COLORS.length);
  for (const font of FONTS) assert.match(font.stack, /(sans-serif|serif|monospace)$/, font.id);
  assert.isAtLeast(FONTS.length, 20);
});

test('a stored style is read field by field, so one stale value costs only itself', () => {
  assert.deepEqual(readTextStyle(null), DEFAULT_TEXT_STYLE);
  assert.deepEqual(readTextStyle({ font: 'georgia', size: 'huge', animation: 'typewriter' }), {
    ...DEFAULT_TEXT_STYLE,
    font: 'georgia',
    animation: 'typewriter',
  });
});

test('reveal pacing is capped, so a long reply never becomes a wait', () => {
  assert.deepEqual(revealPlan(500, 'off', 'normal'), { stepMs: 0, totalMs: 0 });
  assert.deepEqual(revealPlan(500, 'fade', 'normal'), { stepMs: 0, totalMs: 0 });
  const short = revealPlan(10, 'words', 'normal');
  assert.equal(short.totalMs, 320);
  const long = revealPlan(2000, 'words', 'normal');
  assert.equal(long.totalMs, 1600);
  assert.isBelow(revealPlan(2000, 'typewriter', 'quick').totalMs, revealPlan(2000, 'typewriter', 'relaxed').totalMs);
});
