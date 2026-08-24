/**
 * The Home screen's suggestion table, held against the registry and the
 * grammar.
 *
 * Every chip on Home is `skill.examples[…]` looked up by id at render, and a
 * lookup that misses is skipped silently — the right behaviour on a platform
 * that lacks the skill, and a silent bug when the id is simply wrong.
 * `web.searchYouTube` (capital Y) was exactly that: it typechecked, it
 * rendered, and it quietly dropped a suggestion. The real id is
 * `web.searchYoutube`. Two more skills turned out to declare no examples at
 * all, so they would have contributed nothing.
 *
 * The last test is the one that matters most: it clicks every chip through
 * the real grammar and checks it lands on the skill the heading promised. A
 * suggestion that opens the wrong thing is worse than no suggestion.
 */

import { test, assert } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grammar, WorkingMemory, createCoreGrammar, createExtraGrammar } from '@atlas/engine';
import { SUGGESTED } from '../src/pages/Conversation';
import { MAPPED_DOMAINS } from '../src/components/CapabilityBrowser';

/**
 * Every skill a pack declares, with the examples it offers.
 *
 * Read from source rather than from a constructed registry: building the real
 * one needs a Platform and a Memory, and a stub that drifts would keep this
 * passing while Home broke.
 */
function declaredSkills(): Map<string, string[]> {
  const dir = fileURLToPath(new URL('../../../packages/engine/src/skills/', import.meta.url));
  const found = new Map<string, string[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    // Each skill literal runs from its id to the next id (or the end of file).
    const ids = [...source.matchAll(/\bid:\s*'([\w.]+)'/g)];
    ids.forEach((m, i) => {
      const body = source.slice(m.index!, ids[i + 1]?.index ?? source.length);
      const block = /examples:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? '';
      // Both quote styles — "what's running" cannot be single-quoted.
      const examples = [...block.matchAll(/'([^']+)'|"([^"]+)"/g)].map((e) => e[1] ?? e[2]!);
      found.set(m[1]!, examples);
    });
  }
  return found;
}

const DECLARED = declaredSkills();

/** What Home actually renders: the shortest example, the same rule the screen uses. */
function chipFor(id: string): string | undefined {
  const examples = DECLARED.get(id);
  if (!examples?.length) return undefined;
  return [...examples].sort((a, b) => a.length - b.length)[0];
}

const SUGGESTED_IDS = SUGGESTED.flatMap((g) => g.skills);

test('the scan finds the real catalog', () => {
  assert.isAbove(DECLARED.size, 90);
  assert.isTrue(DECLARED.has('files.find'));
  assert.isTrue(DECLARED.has('web.searchYoutube'));
});

test('every suggested skill actually exists', () => {
  const missing = SUGGESTED_IDS.filter((id) => !DECLARED.has(id));
  assert.deepEqual(
    missing,
    [],
    `Home suggests skills no pack declares, so they are silently dropped: ${missing.join(', ')}`,
  );
});

test('every suggested skill has an example to show', () => {
  // The chip label IS the example. A skill without one contributes nothing.
  const exampleless = SUGGESTED_IDS.filter((id) => !DECLARED.get(id)?.length);
  assert.deepEqual(exampleless, [], `no examples to render: ${exampleless.join(', ')}`);
});

test('no skill is suggested twice', () => {
  assert.equal(new Set(SUGGESTED_IDS).size, SUGGESTED_IDS.length);
});

test('Home and the capability browser agree on the category names', () => {
  // Both screens answer "what can this thing do?". Different headings on each
  // would make them look like two different products.
  const browserCategories = ['Files', 'System', 'Web', 'Text', 'Utilities', 'Notes'];
  for (const { category } of SUGGESTED) {
    assert.include(browserCategories, category);
  }
  assert.isAbove(MAPPED_DOMAINS.length, 0);
});

test('the grid is denser than the six cards it replaced', () => {
  // The whole point of the change. If this drops back to six, the screen has
  // quietly become a dashboard again.
  assert.isAtLeast(SUGGESTED_IDS.length, 15);
});

test('every chip on Home reaches the skill it advertises', () => {
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(new WorkingMemory()));
  grammar.addMany(createExtraGrammar());

  const wrong: string[] = [];
  for (const id of SUGGESTED_IDS) {
    const chip = chipFor(id);
    if (!chip) continue;
    const planned = grammar.parse(chip)?.steps[0]?.skill;
    if (planned !== id) wrong.push(`"${chip}" -> ${planned ?? 'no match'} (advertised ${id})`);
  }
  assert.deepEqual(wrong, [], `Home suggestions that mislead:\n${wrong.join('\n')}`);
});
