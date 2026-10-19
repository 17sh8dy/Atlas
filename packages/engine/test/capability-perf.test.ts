/**
 * Performance of the 2.0.2 layers, measured, with bounds loose enough for a slow CI runner but tight enough
 * to catch an accidental quadratic. The numbers printed here are the ones quoted in the documentation.
 *
 * What is measured: the deterministic understanding of a sentence (grammar, courtesy strip, paraphrase),
 * capability retrieval over the real registry, and progressive disclosure. No model is involved anywhere.
 */
import { describe, expect, test } from 'vitest';
import { SkillRegistry } from '../src/skills/registry';
import { CapabilityIndex } from '../src/capabilities';
import { grammar, measure } from './coverage/measure';
import { BASES } from './coverage/corpus';
import { understand } from './helpers/chain';
import { everySkill } from './helpers/every-skill';

function time<T>(fn: () => T): [T, number] {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
}

describe('performance', () => {
  test('understanding a sentence: the whole chain, per request', () => {
    const g = grammar();
    const sentences = measure().map((r) => r.text);
    // warm up (JIT, regex caches)
    for (const s of sentences.slice(0, 100)) understand(g, s);
    const [, ms] = time(() => {
      for (const s of sentences) understand(g, s);
    });
    const per = ms / sentences.length;
    console.log(`PERF understand: ${sentences.length} sentences in ${ms.toFixed(0)} ms = ${(per * 1000).toFixed(0)} µs each`);
    expect(per).toBeLessThan(5);
  });

  test('a sentence nothing understands still costs little (the worst case: every attempt fails)', () => {
    const g = grammar();
    const odd = ['please arrange the quarterly synergy deck into a mood board', 'zzzz qqqq xxxx', 'can you compose a sonnet about my cat for me?'];
    for (const s of odd) understand(g, s);
    const [, ms] = time(() => {
      for (let i = 0; i < 200; i++) for (const s of odd) understand(g, s);
    });
    const per = ms / (200 * odd.length);
    console.log(`PERF no-match: ${(per * 1000).toFixed(0)} µs each`);
    expect(per).toBeLessThan(10);
  });

  test('capability retrieval and disclosure over the real registry', () => {
    const all = everySkill();
    const needs = [...new Set(all.flatMap((s) => s.needs ?? []))] as never[];
    const registry = new SkillRegistry({ capabilities: () => needs });
    registry.registerMany(all);
    const [index, buildMs] = time(() => new CapabilityIndex(registry));
    const queries = BASES.slice(0, 60).map((b) => b.text);
    for (const q of queries.slice(0, 5)) index.disclose(q);
    const [, ms] = time(() => {
      for (const q of queries) index.disclose(q, { limit: 14 });
    });
    const per = ms / queries.length;
    console.log(`PERF index: built in ${buildMs.toFixed(1)} ms over ${registry.all().length} skills; disclose ${per.toFixed(2)} ms each`);
    expect(per).toBeLessThan(50);
  });
});
