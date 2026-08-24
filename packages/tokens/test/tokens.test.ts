/**
 * The themes, checked as data.
 *
 * ── The bug this exists to prevent ──────────────────────────────────────────
 * Light mode shipped with `background: 250 250 252`, `surface: 255 255 255`
 * and `surface-raised: 255 255 255`. Nothing had elevation: every card, every
 * secondary button and every switch track was the same colour as the page
 * behind it, and only borders said they existed. It typechecked, it rendered,
 * and it looked flat and generic next to dark — which is exactly the class of
 * problem no unit test was ever going to notice.
 *
 * It is noticeable as *numbers*, though. A surface ramp with two identical
 * steps is a fact about the file, and so is a text colour that misses AA.
 * Both are checked below.
 *
 * This does not test that the themes look good. It tests the two things that
 * were measurably wrong, so they cannot come back quietly.
 */

import { test, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(fileURLToPath(new URL('../src/tokens.css', import.meta.url)), 'utf8');

type Rgb = [number, number, number];

/** The custom properties inside one selector block. */
function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(selector);
  assert.notEqual(start, -1, `no ${selector} block`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('\n}', open);
  const body = CSS.slice(open, close);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const DARK = block(':root {');
const LIGHT = block(":root[data-theme='light']");

function rgb(vars: Map<string, string>, name: string): Rgb {
  const raw = vars.get(name);
  assert.isDefined(raw, `${name} is not defined`);
  const parts = raw!.split(/\s+/).map(Number);
  assert.lengthOf(parts, 3, `${name} is not three channels: ${raw}`);
  return parts as Rgb;
}

/** WCAG relative luminance. */
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

test('both themes define the same colour tokens', () => {
  // A token defined only in dark silently falls back to the dark value in
  // light, which is how one stray colour ends up unreadable on white.
  const colours = (vars: Map<string, string>) =>
    [...vars.keys()].filter((k) => k.startsWith('--color-')).sort();
  const missing = colours(DARK).filter((k) => !LIGHT.has(k));
  // These are genuinely theme-independent and are deliberately not re-stated.
  const shared = ['--color-danger', '--color-success', '--color-warning'];
  assert.deepEqual(
    missing.filter((k) => !shared.includes(k)),
    [],
  );
});

test('each theme has three distinct surface steps', () => {
  for (const [name, vars] of [
    ['dark', DARK],
    ['light', LIGHT],
  ] as const) {
    const steps = [
      rgb(vars, '--color-background'),
      rgb(vars, '--color-surface'),
      rgb(vars, '--color-surface-raised'),
    ].map((c) => c.join(','));
    assert.equal(new Set(steps).size, 3, `${name}: surfaces are not three distinct values`);
  }
});

test('elevation moves toward the bright end in both themes', () => {
  // The relationship dark has, re-derived for light rather than inverted:
  // background < surface < surface-raised in luminance. It is what makes one
  // `surface-raised` token work for both a control on a card and an active
  // tab on the page.
  for (const [name, vars] of [
    ['dark', DARK],
    ['light', LIGHT],
  ] as const) {
    const bg = luminance(rgb(vars, '--color-background'));
    const surface = luminance(rgb(vars, '--color-surface'));
    const raised = luminance(rgb(vars, '--color-surface-raised'));
    assert.isBelow(bg, surface, `${name}: surface is not above the background`);
    assert.isBelow(surface, raised, `${name}: raised is not above the surface`);
  }
});

test('body text clears WCAG AA against every surface it sits on', () => {
  for (const [name, vars] of [
    ['dark', DARK],
    ['light', LIGHT],
  ] as const) {
    for (const surface of ['--color-background', '--color-surface', '--color-surface-raised']) {
      const bg = rgb(vars, surface);
      assert.isAtLeast(
        contrast(rgb(vars, '--color-foreground'), bg),
        7,
        `${name}: foreground on ${surface}`,
      );
      assert.isAtLeast(
        contrast(rgb(vars, '--color-foreground-muted'), bg),
        4.5,
        `${name}: foreground-muted on ${surface}`,
      );
      // The one that was failing: most text using `subtle` is 12px, where AA
      // wants 4.5:1. The old light value measured about 3.6.
      assert.isAtLeast(
        contrast(rgb(vars, '--color-foreground-subtle'), bg),
        4.5,
        `${name}: foreground-subtle on ${surface}`,
      );
    }
  }
});

test('borders are visible against the surfaces they divide', () => {
  for (const [name, vars] of [
    ['dark', DARK],
    ['light', LIGHT],
  ] as const) {
    const border = rgb(vars, '--color-border');
    const surface = rgb(vars, '--color-surface');
    // Not an accessibility threshold — a hairline only has to be *seen*.
    assert.isAtLeast(contrast(border, surface), 1.1, `${name}: border on surface`);
    assert.isAtLeast(
      contrast(rgb(vars, '--color-border-strong'), surface),
      1.25,
      `${name}: border-strong on surface`,
    );
  }
});

test('the accent stays legible against its own foreground', () => {
  for (const [name, vars] of [
    ['dark', DARK],
    ['light', LIGHT],
  ] as const) {
    // Primary buttons and your own messages are this pairing.
    assert.isAtLeast(
      contrast(rgb(vars, '--color-primary-foreground'), rgb(vars, '--color-primary')),
      4.5,
      `${name}: primary-foreground on primary`,
    );
  }
});
