/**
 * Enhanced Effects — no jsdom in this workspace (see `settings.test.ts`'s own
 * approach to the same constraint), so these hold the source to the
 * guarantees that actually matter: off by default, never active while
 * reduced motion is on, and wired through the real setting rather than local
 * component state.
 */

import { test, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

test('the stored preference defaults to off, not on', () => {
  const source = read('../src/app/effects.tsx');
  // Anything other than an exact 'true' comparison risks a stray localStorage
  // value (or its absence) reading as enabled — the one bug that would make
  // "off by default" false for everyone on first launch.
  assert.match(source, /localStorage\.getItem\(STORAGE_KEY\)\s*===\s*'true'/);
});

test('the effect is only ever active when the setting is on AND reduced motion is off', () => {
  const source = read('../src/app/effects.tsx');
  assert.match(source, /const active = enabled && !reducedMotion/);
  // The DOM attribute the CSS keys on must be driven by `active`, not by the
  // raw `enabled` preference — otherwise reduced motion would be advisory.
  assert.match(source, /dataset\.effects = active \? 'enhanced' : 'plain'/);
});

test('turning the setting on does not get silently reset by reduced motion', () => {
  const source = read('../src/app/effects.tsx');
  // `enabled` must persist independently of `reducedMotion` — the stored
  // preference is only ever written from `setEnabled`, never from the
  // reduced-motion media query listener.
  const setEnabledBody = source.slice(source.indexOf('const setEnabled ='));
  assert.notInclude(setEnabledBody.slice(0, 200), 'reducedMotion');
});

test('the pointer-glow listener is mounted only while the effect is active', () => {
  const source = read('../src/app/effects.tsx');
  const hook = source.slice(source.indexOf('function useCursorGlow'));
  assert.match(hook, /if \(!active\) return;/);
});

test('Settings -> Appearance wires the real setting, defaults the copy to "off", and names the reduced-motion case', () => {
  const source = read('../src/pages/settings/Appearance.tsx');
  assert.include(source, 'useEnhancedEffects');
  assert.include(source, 'Enhanced Effects');
  assert.match(source, /Off by\s+default/);
  assert.include(source, 'checked={enabled}');
  assert.include(source, 'onCheckedChange={setEnabled}');
  // The panel has to be able to say when the toggle is on but inactive
  // (reduced motion), not just show a switch that silently does nothing.
  assert.include(source, 'reduced motion');
});

test('the CSS only activates under the enhanced attribute, and rides the token that itself collapses under reduced motion', () => {
  const source = read('../src/styles/index.css');
  assert.include(source, "html[data-effects='enhanced'] .atlas-enhance");
  // Not a hard-coded duration: this has to inherit the same
  // reduced-motion collapse tokens.css already applies to `--duration-fast`,
  // as a second, independent line of defence.
  assert.include(source, 'var(--duration-fast)');
  assert.notMatch(source, /\.atlas-enhance[^{]*\{[^}]*transition:[^}]*\d+ms/);
});

test('the marker class is opt-in on real interactive elements, not the generic Surface panel', () => {
  const button = read('../../../packages/ui/src/components/Button.tsx');
  assert.include(button, 'atlas-enhance');

  // Surface renders plenty of purely informational panels (warnings, status
  // rows) with no click handler — giving those a hover lift would be a false
  // affordance, so it deliberately carries no marker class.
  const surface = read('../../../packages/ui/src/components/Surface.tsx');
  assert.notInclude(surface, 'atlas-enhance');
});
