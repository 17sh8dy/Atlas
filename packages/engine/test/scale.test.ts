/**
 * A bigger model is given a bigger job — sized from what the model really supports, never beyond it.
 * Facts the sizing rests on come from the model's own server (Ollama `/api/show`), and the product pages cited in
 * `agent/scale.ts` (Qwen3.5: 0.8B–122B, 262,144 tokens natively).
 */
import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, IntelligenceRegistry, Skill, SkillContext } from '@atlas/core';
import { DEFAULT_TOKENS, MAX_TOKENS, MIN_TOKENS, chooseWorkingMemory, scaleFor } from '../src/agent/scale';
import { SkillRegistry } from '../src/skills/registry';
import { Executor } from '../src/planner/executor';
import { runDevTask, MAX_DEV_ITERATIONS } from '../src/devagent/loop';

const cap = (contextTokens: number, billions?: number) => ({ contextTokens, ...(billions !== undefined ? { billions } : {}) });

describe('chooseWorkingMemory', () => {
  test('an unknown model gets what has always worked', () => {
    expect(chooseWorkingMemory(null)).toBe(DEFAULT_TOKENS);
    expect(chooseWorkingMemory(undefined)).toBe(DEFAULT_TOKENS);
    expect(chooseWorkingMemory({ contextTokens: 0 })).toBe(DEFAULT_TOKENS);
  });

  test('a model is sized by how big it is, and never past its own limit', () => {
    expect(chooseWorkingMemory(cap(262_144, 2))).toBe(24_576);
    expect(chooseWorkingMemory(cap(262_144, 9.7))).toBe(32_768);
    expect(chooseWorkingMemory(cap(262_144, 27))).toBe(65_536);
    expect(chooseWorkingMemory(cap(262_144, 72))).toBe(131_072);
    expect(chooseWorkingMemory(cap(262_144, 122))).toBe(262_144);
    expect(chooseWorkingMemory(cap(262_144))).toBe(32_768); // size unknown but the limit is known
    expect(chooseWorkingMemory(cap(8_192, 122))).toBe(8_192); // a big model with a small window gets the small window
    expect(chooseWorkingMemory(cap(4_096, 3))).toBe(MIN_TOKENS === 8_192 ? 8_192 : 4_096);
  });

  test('a pinned value is honoured but held to the model’s limit and the floor/ceiling', () => {
    expect(chooseWorkingMemory(cap(262_144, 9.7), 100_000)).toBe(100_000);
    expect(chooseWorkingMemory(cap(32_768, 9.7), 200_000)).toBe(32_768);
    expect(chooseWorkingMemory(cap(262_144, 9.7), 100)).toBe(MIN_TOKENS);
    expect(chooseWorkingMemory(cap(2_000_000, 400), 9_000_000)).toBe(MAX_TOKENS);
    expect(chooseWorkingMemory(cap(262_144, 9.7), Number.NaN)).toBe(32_768);
  });
});

describe('scaleFor', () => {
  test('the small, standard size is exactly what Atlas used before', () => {
    const s = scaleFor(null);
    expect(s).toMatchObject({ contextTokens: 16_384, historyChars: 7_000, keepFull: 3, maxIterations: 12 });
    expect(s.basis).toMatch(/model size unknown/);
  });

  test('a bigger model gets a longer job: more steps, more history, more research room', () => {
    const small = scaleFor(cap(262_144, 9.7));
    const mid = scaleFor(cap(262_144, 27));
    const big = scaleFor(cap(262_144, 122));
    expect(small.maxIterations).toBeLessThan(mid.maxIterations);
    expect(mid.maxIterations).toBeLessThan(big.maxIterations);
    expect(small.historyChars).toBeGreaterThan(7_000);
    expect(mid.historyChars).toBeGreaterThan(small.historyChars);
    expect(big.historyChars).toBeGreaterThan(mid.historyChars);
    expect(big.researchChars).toBeGreaterThan(small.researchChars);
    expect(big.keepFull).toBeGreaterThan(small.keepFull);
    expect(big.maxIterations).toBe(64);
    expect(big.basis).toMatch(/122B-parameter model with a 262,144-token limit/);
  });

  test('the history never claims more room than the working memory has', () => {
    for (const b of [1, 5, 9.7, 27, 72, 122]) {
      const s = scaleFor(cap(262_144, b));
      expect(s.historyChars).toBeLessThan(s.contextTokens * 3 * 0.5);
      expect(s.researchChars).toBeLessThanOrEqual(24_000);
    }
  });

  test('a pinned size is reported in the basis', () => {
    expect(scaleFor(cap(262_144, 9.7), 65_536).basis).toMatch(/pinned to 65,536/);
  });
});

describe('the developer agent uses the scale it is given', () => {
  const act = (n: number) => JSON.stringify({ skill: 'code.search', args: { query: `q${n}` } });

  function run(scale: ReturnType<typeof scaleFor> | undefined, steps: number) {
    const skills = new SkillRegistry({ capabilities: () => ['devtools'] });
    skills.register({ id: 'code.search', label: 's', domain: 'code', description: 'search', risk: 'safe', params: { query: { type: 'string', required: true, description: 'q' } }, run: async () => ({ ok: true, message: 'found ' + 'x'.repeat(2500) }) } satisfies Skill);
    const prompts: string[] = [];
    const asked: Array<number | undefined> = [];
    let i = 0;
    const provider = {
      id: 'p', label: 'P', isConfigured: () => true, isLocal: () => true,
      ask(prompt: string, h: { onDone: (s: string) => void }, opts?: { contextTokens?: number }) {
        prompts.push(prompt);
        asked.push(opts?.contextTokens);
        i += 1;
        h.onDone(i <= steps ? act(i) : JSON.stringify({ done: true, summary: 'ok' }));
      },
    } as unknown as IntelligenceProvider;
    const registry: IntelligenceRegistry = { register: () => {}, get: () => provider, list: () => [provider], active: () => provider, setActive: () => {} };
    const ctx = { say() {}, confirm: async () => true } as unknown as SkillContext;
    return runDevTask('look around', 'C:\\proj', { skills, intelligence: registry, executor: new Executor(skills), getExecutionMode: () => 'doIt', scale }, ctx).then((report) => ({ report, prompts, asked }));
  }

  test('without a scale: twelve steps, as before, and no working memory is requested', async () => {
    const { report, asked } = await run(undefined, 30);
    expect(report.stoppedBecause).toBe('budget');
    expect(report.steps).toHaveLength(MAX_DEV_ITERATIONS);
    expect(asked.every((a) => a === undefined)).toBe(true);
  });

  test('with a bigger model: the step budget grows, and every request asks for the working memory the scale chose', async () => {
    const s = scaleFor(cap(262_144, 27)); // 65,536 tokens, 36 steps
    const { report, asked } = await run(s, 60);
    expect(report.stoppedBecause).toBe('budget');
    expect(report.steps).toHaveLength(s.maxIterations);
    expect(s.maxIterations).toBeGreaterThan(MAX_DEV_ITERATIONS);
    expect(new Set(asked)).toEqual(new Set([65_536]));
  });

  test('a bigger scale keeps more of the history in the prompt than the small one does', async () => {
    const small = await run(scaleFor(null), 11);
    const big = await run(scaleFor(cap(262_144, 27)), 11);
    const last = (r: { prompts: string[] }) => r.prompts[r.prompts.length - 1]!;
    // The newest steps are shown whole (inside the fence); the standard size keeps 3 of them, a 27B-class model 7.
    const whole = (p: string) => (p.match(/<<<UNTRUSTED OUTPUT from code\.search/g) ?? []).length;
    expect(whole(last(small))).toBe(3);
    expect(whole(last(big))).toBe(7);
    expect(last(big).length).toBeGreaterThan(last(small).length);
  });
});
