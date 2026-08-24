/**
 * The Settings rail, held against reality.
 *
 * Two failures this catches, both of which look to a user like a broken
 * product rather than a mistake:
 *
 *   · a tab in the rail with no panel behind it — an empty pane that reads
 *     as a feature that failed to load;
 *   · a settings page still sitting in the folder that nothing links to,
 *     which is how a deleted feature comes back by accident.
 *
 * It also pins the decision that placeholder pages are gone, so that
 * "Startup — Planned for a later phase" cannot quietly return.
 */

import { test, assert } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SECTIONS } from '../src/pages/Settings';

const SETTINGS_TSX = readFileSync(
  fileURLToPath(new URL('../src/pages/Settings.tsx', import.meta.url)),
  'utf8',
);

/** Every `<TabsContent value="x">` in the shell. */
function panels(): string[] {
  return [...SETTINGS_TSX.matchAll(/<TabsContent value="([a-z-]+)"/g)].map((m) => m[1]!);
}

test('every tab in the rail has a panel behind it', () => {
  const ids = SECTIONS.map((s) => s.id);
  const rendered = panels();
  assert.isAbove(ids.length, 0);
  assert.deepEqual([...ids].sort(), [...rendered].sort());
});

test('the default tab is one that exists', () => {
  const fallback = /defaultValue="([a-z-]+)"/.exec(SETTINGS_TSX)?.[1];
  assert.isDefined(fallback);
  assert.include(
    SECTIONS.map((s) => s.id),
    fallback!,
  );
});

test('the placeholder tabs are gone and have not come back', () => {
  // Each of these was a page whose entire content explained that the thing
  // it named did not exist yet.
  for (const gone of ['startup', 'privacy', 'default-apps']) {
    assert.notInclude(
      SECTIONS.map((s) => s.id),
      gone,
    );
  }
  assert.lengthOf(SECTIONS, 7);
});

test('no settings page is left orphaned in the folder', () => {
  const dir = fileURLToPath(new URL('../src/pages/settings/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
  const orphans = files.filter(
    (f) => !SETTINGS_TSX.includes(`./settings/${f.replace('.tsx', '')}`),
  );
  assert.deepEqual(orphans, [], `not reachable from the rail: ${orphans.join(', ')}`);
});
