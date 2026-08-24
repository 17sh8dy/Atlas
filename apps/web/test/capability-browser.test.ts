/**
 * The capability browser's one piece of real logic: turning grouped rows into
 * sections.
 *
 * Deliberately not a render test. What can go wrong here is not "the markup
 * changed" — it is a skill quietly vanishing from the list because its domain
 * was never mapped, or a new domain appearing and nobody noticing. Both are
 * data questions, and both are caught below without a DOM.
 *
 * How it actually *looks* is checked by opening Atlas and looking at it. A
 * snapshot of the JSX would only tell us the JSX is what we wrote.
 */

import { test, assert } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResultRow } from '@atlas/core';
import { MAPPED_DOMAINS, toSections } from '../src/components/CapabilityBrowser';

function row(title: string, group?: string): ResultRow {
  return { title, group };
}

test('rows are gathered into the categories that claim their domain', () => {
  const sections = toSections([
    row('Find files', 'files'),
    row('Open app', 'apps'),
    row('System info', 'system'),
    row('Calculator', 'math'),
    row('Time now', 'time'),
  ]);

  // Files and System lead — the order is the table's, not the rows'.
  assert.deepEqual(
    sections.map((s) => s.label),
    ['Files', 'System', 'Utilities'],
  );

  // math and time are one section to a person, two domains to the registry.
  assert.deepEqual(
    sections.find((s) => s.label === 'Utilities')?.rows.map((r) => r.title),
    ['Calculator', 'Time now'],
  );
});

test('an empty category is not rendered at all', () => {
  assert.deepEqual(
    toSections([row('Find files', 'files')]).map((s) => s.label),
    ['Files'],
  );
});

test('an unmapped group is surfaced under its own name, never dropped', () => {
  // The failure this prevents: adding a domain, forgetting the table, and
  // silently losing every skill in it from "what can you do?".
  const sections = toSections([row('Find files', 'files'), row('Something new', 'quantum')]);
  assert.deepEqual(
    sections.map((s) => s.label),
    ['Files', 'Quantum'],
  );
  assert.lengthOf(sections[1]!.rows, 1);
});

test('rows with no group at all still appear', () => {
  const sections = toSections([row('Ungrouped')]);
  assert.lengthOf(sections, 1);
  assert.equal(sections[0]!.label, 'Other');
});

test('nothing is lost: every row in is a row out', () => {
  const rows = [
    row('a', 'files'),
    row('b', 'system'),
    row('c', 'notes'),
    row('d', 'clipboard'),
    row('e', 'mystery'),
  ];
  const out = toSections(rows).flatMap((s) => s.rows);
  assert.deepEqual(out.map((r) => r.title).sort(), rows.map((r) => r.title).sort());
});

/**
 * Every domain the skill packs actually declare, read out of the source.
 *
 * Read rather than constructed: building the real registry here would mean
 * stubbing a Platform and a Memory, and a stub that drifts would make this
 * test pass while the product broke. The declarations are the truth, and they
 * are trivially greppable.
 */
function declaredDomains(): string[] {
  const dir = fileURLToPath(new URL('../../../packages/engine/src/skills/', import.meta.url));
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const m of source.matchAll(/domain:\s*'([a-z]+)'/g)) found.add(m[1]!);
  }
  return [...found].sort();
}

test('every domain the registry actually ships has a category', () => {
  const domains = declaredDomains();
  // Anchor the scan: if the regex stops matching, this must fail loudly
  // rather than pass over an empty list.
  assert.isAbove(domains.length, 10);

  const unmapped = domains.filter((d) => !MAPPED_DOMAINS.includes(d));
  assert.deepEqual(
    unmapped,
    [],
    `These domains have no home in the browser, so their skills would land ` +
      `under a raw domain name: ${unmapped.join(', ')}. Add them to CATEGORIES.`,
  );
});

test('the category table names no domain that no longer exists', () => {
  const domains = declaredDomains();
  const stale = MAPPED_DOMAINS.filter((d) => !domains.includes(d));
  assert.deepEqual(stale, [], `no skill declares: ${stale.join(', ')}`);
  assert.equal(new Set(MAPPED_DOMAINS).size, MAPPED_DOMAINS.length, 'a domain is listed twice');
});
