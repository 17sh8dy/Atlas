/**
 * The accent schemes, checked as data.
 *
 * A scheme is only useful if its button label is legible on its own fill, and
 * if the same colour still reads as text on the theme's page. Both are numbers,
 * so both are pinned here — a new palette that looks fine in one theme and
 * fails in the other should fail a test rather than reach a screenshot.
 */

import { assert, test } from 'vitest';
import { ACCENTS, DEFAULT_ACCENT, accentById, isAccentId } from '../src/accents';

type Rgb = [number, number, number];

const channels = (raw: string): Rgb => raw.split(/\s+/).map(Number) as Rgb;

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// tokens.css: --color-surface in each theme.
const DARK_SURFACE: Rgb = [18, 18, 23];
const LIGHT_SURFACE: Rgb = [250, 250, 252];

// The palettes added in 1.0.5, whose numbers were chosen for this bar. The
// older five predate the test and are held to a looser one below.
const HELD_TO_AA = ['emerald', 'titanium', 'arctic', 'gold', 'rose'] as const;
// Sunset and Ocean were darkened in 1.0.5 to clear the same bar, and Purple is
// the default. A hovered button is brightened 10% (`hover:brightness-110`), so
// the bar is held there too — the state where the label would otherwise slip.
const LABEL_AA = [...HELD_TO_AA, 'sunset', 'ocean', 'purple'] as const;

const brighten = ([r, g, b]: Rgb, k = 1.1): Rgb => [r, g, b].map((c) => Math.min(255, Math.round(c * k))) as Rgb;

test('Purple is the default, and is first in the list', () => {
  assert.equal(DEFAULT_ACCENT, 'purple');
  assert.equal(ACCENTS[0]!.id, 'purple');
  // An unknown value read back from storage falls back to it, not to a random scheme.
  assert.equal(accentById('not-a-scheme').id, 'purple');
});

test('every scheme id is unique and recognised', () => {
  const ids = ACCENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.isTrue(isAccentId(id));
});

test('the requested palettes carry their exact colours in dark mode', () => {
  const emerald = accentById('emerald').dark;
  assert.deepEqual(channels(emerald.primary), [0x39, 0xd9, 0x8a]); // #39D98A
  assert.deepEqual(channels(emerald.accent), [0xa3, 0xff, 0xd1]); // #A3FFD1
  assert.deepEqual(channels(emerald.primaryForeground), [0x10, 0x1b, 0x17]); // #101B17

  const titanium = accentById('titanium').dark;
  assert.deepEqual(channels(titanium.primary), [0xd1, 0xd5, 0xdb]); // #D1D5DB
  assert.deepEqual(channels(titanium.accent), [0xff, 0xff, 0xff]); // #FFFFFF
  assert.deepEqual(channels(titanium.primaryForeground), [0x17, 0x19, 0x1d]); // #17191D
});

test('a button label clears AA on its own fill, in both themes', () => {
  for (const id of LABEL_AA) {
    const scheme = accentById(id);
    for (const [theme, vars] of [
      ['dark', scheme.dark],
      ['light', scheme.light],
    ] as const) {
      assert.isAtLeast(
        contrast(channels(vars.primaryForeground), channels(vars.primary)),
        4.5,
        `${id} ${theme}: label on fill`,
      );
    }
  }
  // The older schemes are held to a floor, not AA: Sunset and Ocean, whose white labels
  // measure about 2.8:1 (known weak spots, left as they shipped). This stops any of
  // them getting worse; it is not a claim that they pass.
  for (const scheme of ACCENTS) {
    for (const vars of [scheme.dark, scheme.light]) {
      assert.isAtLeast(
        contrast(channels(vars.primaryForeground), channels(vars.primary)),
        2.7,
        `${scheme.id}: label on fill`,
      );
    }
  }
});

test('Sunset and Ocean keep their white label at 4.5:1 on both gradient stops, at rest and hovered', () => {
  for (const id of ['sunset', 'ocean'] as const) {
    const scheme = accentById(id);
    for (const [theme, vars] of [
      ['dark', scheme.dark],
      ['light', scheme.light],
    ] as const) {
      const label = channels(vars.primaryForeground);
      for (const [stop, fill] of [
        ['primary', channels(vars.primary)],
        ['accent', channels(vars.accent)],
      ] as const) {
        assert.isAtLeast(contrast(label, fill), 4.5, `${id} ${theme} ${stop}: at rest`);
        assert.isAtLeast(contrast(label, brighten(fill)), 4.5, `${id} ${theme} ${stop}: hovered`);
      }
    }
  }
});

test('Sunset and Ocean are still themselves — hue is kept, only the depth changed', () => {
  const hue = ([r, g, b]: Rgb) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const wasHue = {
    sunset: { primary: [249, 115, 22], accent: [236, 72, 153] },
    ocean: { primary: [14, 165, 233], accent: [20, 184, 166] },
  } as const;
  for (const id of ['sunset', 'ocean'] as const) {
    const dark = accentById(id).dark;
    for (const stop of ['primary', 'accent'] as const) {
      const was = hue([...wasHue[id][stop]] as Rgb);
      const now = hue(channels(dark[stop]));
      assert.isBelow(Math.abs(was - now), 8, `${id} ${stop}: hue moved from ${was} to ${now}`);
    }
  }
});

test('the ring and selected accents stay visible against the surface', () => {
  // Focus rings and selected states are this colour on the page; non-text UI
  // needs 3:1 (WCAG 2.2 1.4.11).
  for (const id of LABEL_AA) {
    const scheme = accentById(id);
    assert.isAtLeast(contrast(channels(scheme.dark.primary), DARK_SURFACE), 3, `${id} dark`);
    assert.isAtLeast(contrast(channels(scheme.light.primary), LIGHT_SURFACE), 3, `${id} light`);
  }
});

test('the accent reads as text against the surface it sits on', () => {
  // `text-primary` and the focus ring are this colour on the page.
  for (const id of HELD_TO_AA) {
    const scheme = accentById(id);
    assert.isAtLeast(contrast(channels(scheme.dark.primary), DARK_SURFACE), 4.5, `${id} dark`);
    assert.isAtLeast(contrast(channels(scheme.light.primary), LIGHT_SURFACE), 4.5, `${id} light`);
  }
});
