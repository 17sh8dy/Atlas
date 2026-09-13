/**
 * The capability cards, held against the registry.
 *
 * These cards used to be Home's whole first screen; they now live in
 * `components/CapabilityCards.tsx`, reachable from Home's "What can Atlas
 * do?" link rather than occupying it (see that file's doc comment). They are
 * hand-written, so there is no literal skill id or example text to check a
 * chip against the way the old chip-grid tests did. What can still be
 * checked mechanically: every domain a card claims to cover is a domain some
 * skill in the registry actually declares, so a category can't quietly
 * promise an ability every skill pack has dropped. A card whose `domains`
 * all vanished from `declaredDomains()` is exactly that bug.
 */

import { test, assert } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARDS } from '../src/components/CapabilityCards';

/** Every `domain:` tag any skill pack declares. */
function declaredDomains(): Set<string> {
  const dir = fileURLToPath(new URL('../../../packages/engine/src/skills/', import.meta.url));
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const m of source.matchAll(/\bdomain:\s*'([\w-]+)'/g)) found.add(m[1]!);
  }
  return found;
}

const DOMAINS = declaredDomains();

test('the scan finds real domains', () => {
  assert.isAbove(DOMAINS.size, 5);
  assert.isTrue(DOMAINS.has('web'));
  assert.isTrue(DOMAINS.has('files'));
});

test('there are exactly six cards', () => {
  // The number the "six tiles read as a dashboard" lesson was learned from —
  // more than this and Home is a dashboard again, just with paragraphs.
  assert.equal(CARDS.length, 6);
});

test('no two cards share a label or an icon', () => {
  assert.equal(new Set(CARDS.map((c) => c.label)).size, CARDS.length);
  assert.equal(new Set(CARDS.map((c) => c.icon)).size, CARDS.length);
});

test('every card has a description', () => {
  for (const card of CARDS) {
    assert.isAbove(card.description.length, 0, `${card.label} has no description`);
  }
});

test('every domain a card claims is one the registry actually declares', () => {
  const dead: string[] = [];
  for (const card of CARDS) {
    for (const domain of card.domains) {
      if (!DOMAINS.has(domain)) dead.push(`${card.label}: '${domain}'`);
    }
  }
  assert.deepEqual(dead, [], `Cards claiming a domain nothing declares: ${dead.join(', ')}`);
});

test('a starter, when given, ends mid-sentence ready to keep typing', () => {
  // "open" without the trailing space would land the cursor glued to the next
  // word the person types. Cards without a natural single starter (see the
  // CARDS doc comment) correctly have none at all — that's the empty-focus
  // case, not a bug.
  for (const card of CARDS) {
    if (card.starter === undefined) continue;
    assert.isAbove(card.starter.length, 0);
    assert.equal(
      card.starter,
      card.starter.trimEnd() + ' ',
      `"${card.starter}" has no trailing space`,
    );
  }
});

test('no starter carries a filesystem path', () => {
  // Same bug class the old chip grid hit: `files.list`'s example named a path
  // on the D: drive, which only works on the machine it was written on.
  for (const card of CARDS) {
    if (!card.starter) continue;
    assert.notMatch(
      card.starter,
      /[a-zA-Z]:[\\/]|\\\\\S|(^|\s)~?\/\S/,
      `${card.label}: "${card.starter}"`,
    );
  }
});
