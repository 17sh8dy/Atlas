/**
 * Capability coverage: a measured answer to "how much can Atlas understand and do without a model?".
 *
 * Three measurements, kept apart because they mean different things:
 *   · the MAIN corpus (`coverage/corpus.ts`): ordinary requests × common wrappers. It was iterated against, so
 *     it is a regression guard and flatters the grammar;
 *   · HELD-OUT set A: written before a round of fixes, then used to make them. Also tuned, now;
 *   · HELD-OUT set B: written after those fixes and never used to decide anything. THIS is the estimate of how
 *     it does on sentences it was not shaped around.
 *
 * Run with UPDATE_COVERAGE=1 to rewrite docs/CAPABILITY-COVERAGE.md from the measurement. Without it the
 * test only checks floors, so a change that makes understanding worse fails here.
 *
 * Nothing in this file claims a number of "supported tasks". A skill is counted as REACHED only if some
 * measured sentence actually routed to it; REGISTERED is just what exists.
 */
import { describe, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { measure, tally, grammar, type Result } from './coverage/measure';
import { HELD_OUT, HELD_OUT_B, type Held } from './coverage/heldout';
import { understand } from './helpers/chain';
import { everySkill } from './helpers/every-skill';
import { familyOf } from '../src/capabilities';

interface HeldResult extends Held {
  verdict: 'ok' | 'wrong' | 'miss';
  got: string | null;
}

function runHeld(set: readonly Held[]): HeldResult[] {
  const g = grammar();
  return set.map((c) => {
    const got = understand(g, c.text).plan?.steps[0]?.skill ?? null;
    return { ...c, got, verdict: got === null ? 'miss' : c.skill.split('|').includes(got) ? 'ok' : 'wrong' };
  });
}

const count = (rs: readonly { verdict: string }[], v: string) => rs.filter((r) => r.verdict === v).length;
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

const main = measure();
const heldA = runHeld(HELD_OUT);
const heldB = runHeld(HELD_OUT_B);

describe('floors (a change that makes understanding worse fails here)', () => {
  const plain = main.filter((r) => r.wrapper === 'plain');

  test('main corpus: plain requests', () => {
    expect(count(plain, 'ok') / plain.length).toBeGreaterThanOrEqual(0.97);
    expect(count(plain, 'wrong')).toBeLessThanOrEqual(1);
  });

  test('main corpus: every wrapper keeps working', () => {
    for (const [wrapper, t] of Object.entries(tally(main, (r) => r.wrapper))) {
      // "SHOUTING" hits the case-sensitive environment-variable rule on a couple of settings; see the report.
      const floor = wrapper === 'shouting' ? 0.95 : 0.97;
      expect(t.ok / t.total, wrapper).toBeGreaterThanOrEqual(floor);
    }
  });

  test('held-out B (never tuned against) does not regress', () => {
    expect(count(heldB, 'ok') / heldB.length).toBeGreaterThanOrEqual(0.78);
    expect(count(heldB, 'wrong') / heldB.length).toBeLessThanOrEqual(0.1);
  });

  test('held-out A', () => {
    expect(count(heldA, 'ok') / heldA.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe('what is reached', () => {
  const all = everySkill();
  const reached = new Set<string>();
  for (const r of [...main, ...heldA, ...heldB]) if (r.verdict === 'ok' && r.got) reached.add(r.got);
  const registered = all.map((s) => s.id);

  test('the registry is much larger than what the measured phrasings reach, and the report says so', () => {
    expect(registered.length).toBeGreaterThan(330);
    expect(reached.size).toBeGreaterThan(60);
    expect(reached.size).toBeLessThan(registered.length);
  });
});

test('writes docs/CAPABILITY-COVERAGE.md when asked', () => {
  if (!process.env.UPDATE_COVERAGE) return;
  const all = everySkill();
  const registered = new Set(all.map((s) => s.id));
  const reached = new Set<string>();
  for (const r of [...main, ...heldA, ...heldB]) if (r.verdict === 'ok' && r.got) reached.add(r.got);

  const byArea = tally(main, (r) => r.area);
  const byWrapper = tally(main, (r) => r.wrapper);
  const row = (k: string, t: { total: number; ok: number; wrong: number; miss: number }) =>
    `| ${k} | ${t.total} | ${t.ok} (${pct(t.ok, t.total)}) | ${t.wrong} | ${t.miss} |`;

  const plain = main.filter((r) => r.wrapper === 'plain');
  const wrongs = (rs: readonly (Result | HeldResult)[]) => rs.filter((r) => r.verdict === 'wrong');
  const misses = (rs: readonly (Result | HeldResult)[]) => rs.filter((r) => r.verdict === 'miss');
  const heldLine = (name: string, rs: readonly HeldResult[]) =>
    `| ${name} | ${rs.length} | ${count(rs, 'ok')} (${pct(count(rs, 'ok'), rs.length)}) | ${count(rs, 'wrong')} (${pct(count(rs, 'wrong'), rs.length)}) | ${count(rs, 'miss')} (${pct(count(rs, 'miss'), rs.length)}) |`;

  const unreached = all.filter((s) => !reached.has(s.id));
  const unreachedByFamily = new Map<string, string[]>();
  for (const s of unreached) {
    const f = familyOf(s);
    unreachedByFamily.set(f, [...(unreachedByFamily.get(f) ?? []), s.id]);
  }

  const md = `# Atlas capability coverage (generated)

Generated by \`UPDATE_COVERAGE=1 pnpm --filter @atlas/engine exec vitest run test/coverage.test.ts\` from the
real grammar (no model). Nothing here is a claim about "how many tasks Atlas supports"; every number below is
a count of sentences that were actually run.

## What is counted

| Term | Meaning |
|---|---|
| **Registered** | A skill exists in the registry (${registered.size} skills built in test). It says nothing about whether plain language reaches it. |
| **Reached** | At least one measured sentence was understood as that skill, with no model. |
| **ok** | The sentence was understood as the skill it should be. |
| **wrong** | Understood as a different skill. Listed by name below; these are bugs, not misses. |
| **miss** | Not understood by the deterministic layer. Not wrong: it falls through to the model route (slower, and it needs a model). |

## Headline

| Measurement | Sentences | ok | wrong | miss |
|---|---|---|---|---|
| Main corpus, plain wording | ${plain.length} | ${count(plain, 'ok')} (${pct(count(plain, 'ok'), plain.length)}) | ${count(plain, 'wrong')} | ${count(plain, 'miss')} |
| Main corpus, all wrappers | ${main.length} | ${count(main, 'ok')} (${pct(count(main, 'ok'), main.length)}) | ${count(main, 'wrong')} | ${count(main, 'miss')} |
${heldLine('Held-out A (since used for fixes)', heldA)}
${heldLine('**Held-out B (never tuned against)**', heldB)}

**The number to trust is held-out B.** The main corpus and set A were iterated against, so they overstate how
Atlas handles sentences it was not shaped around. Set B was written after those fixes and has informed none of
them.

Skills: **${registered.size} registered**, **${reached.size} reached** by at least one measured sentence
(${pct(reached.size, registered.size)}); ${unreached.length} registered skills have no measured plain-language route yet
(they are still reachable through the model, the UI, or an exact phrase the grammar has but this corpus does not use).

## Main corpus by area

| Area | Sentences | ok | wrong | miss |
|---|---|---|---|---|
${Object.entries(byArea).map(([k, t]) => row(k, t)).join('\n')}

## Main corpus by wrapper

| Wrapper | Sentences | ok | wrong | miss |
|---|---|---|---|---|
${Object.entries(byWrapper).map(([k, t]) => row(k, t)).join('\n')}

## Known misreadings (the 'wrong' column)

${[...wrongs(main), ...wrongs(heldA), ...wrongs(heldB)].map((r) => `- \`${r.text}\` → **${r.got}** (should be ${r.skill})`).join('\n') || '- none'}

## Not understood without a model ('miss')

${[...misses(main), ...misses(heldA), ...misses(heldB)].map((r) => `- \`${r.text}\` (should reach ${r.skill})`).join('\n') || '- none'}

## Registered skills with no measured plain-language route yet

${[...unreachedByFamily.entries()].sort().map(([f, ids]) => `- **${f}** (${ids.length}): ${ids.sort().join(', ')}`).join('\n')}

## How to extend this honestly

1. Add the phrasing to \`test/coverage/corpus.ts\` (or a fresh held-out set) with the skill it should reach.
2. Run this test. If it misses or is wrong, fix the grammar (\`src/planner/*-grammar.ts\`) or add a row to
   \`phrasing-simple-grammar.ts\`; do not edit the expectation to match.
3. Regenerate this file. Never describe the result as a number of supported tasks.
`;
  const out = resolve(__dirname, '../../../docs/CAPABILITY-COVERAGE.md');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md, 'utf-8');
});
