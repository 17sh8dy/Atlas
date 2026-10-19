/**
 * The universal agent: the shared loop pointed at the whole registry through the capability index.
 *
 * What has to hold: it is only OFFERED a bounded, relevant catalog; it can only RUN what it was offered
 * and what is not denied; every step still goes through the real executor (so a "no" stops it); and a
 * big registry does not make the prompt bigger.
 */
import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, IntelligenceRegistry, Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { Executor } from '../src/planner/executor';
import { CATALOG_SIZE, MAX_UNIVERSAL_ITERATIONS, runUniversalTask } from '../src/universal/loop';
import { parseSolveRequest } from '../src/planner/universal-grammar';
import type { AgentDeps } from '../src/agent/loop';

function ctx(answer = true): SkillContext & { said: string[] } {
  const said: string[] = [];
  return { say: (t: string) => void said.push(t), confirm: async () => answer, said } as never;
}

function provider(next: (call: number, prompt: string) => string): IntelligenceProvider & { prompts: string[] } {
  const p = {
    id: 't', label: 'T', prompts: [] as string[], isConfigured: () => true, isLocal: () => true,
    ask(prompt: string, h: { onDone: (s: string) => void }) { p.prompts.push(prompt); h.onDone(next(p.prompts.length, prompt)); },
  };
  return p as never;
}
const registryOf = (p: IntelligenceProvider | null): IntelligenceRegistry =>
  ({ register: () => {}, get: () => p, list: () => (p ? [p] : []), active: () => p, setActive: () => {} }) as never;

const skill = (id: string, description: string, risk: 'safe' | 'confirm', ran: string[], extra: Partial<Skill> = {}): Skill => ({
  id, label: id, icon: '•', domain: id.split('.')[0]!, description, risk, params: {},
  summarize: () => id,
  async run() { ran.push(id); return { ok: true, message: `${id} finished` }; },
  ...extra,
});

function rig(replies: string[], answer = true, extra: Skill[] = []) {
  const ran: string[] = [];
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany([
    skill('app.open', 'Launch an installed application by name.', 'safe', ran),
    skill('files.find', 'Find files by name on this PC.', 'safe', ran),
    skill('storage.largest', 'List the largest files and folders on a drive.', 'safe', ran),
    skill('files.delete', 'Delete a file (moves it to the recycle bin).', 'confirm', ran),
    skill('devagent.run', 'Build or fix a project with the developer agent.', 'confirm', ran),
    skill('system.shutdownNow', 'Shut the PC down immediately.', 'confirm', ran),
    ...extra,
  ]);
  const p = provider((n) => replies[Math.min(n - 1, replies.length - 1)]!);
  const deps: AgentDeps = { skills: registry, intelligence: registryOf(p), executor: new Executor(registry), getExecutionMode: () => 'doIt' };
  return { deps, ran, p, run: (goal: string) => runUniversalTask(goal, deps, ctx(answer)) };
}

describe('what it is offered', () => {
  test('a bounded, relevant catalog, re-selected each step', async () => {
    const r = rig([
      '{"skill":"storage.largest","args":{}}',
      '{"done":true,"summary":"found them"}',
    ]);
    const report = await r.run('find the largest files on my D drive');
    expect(report.ok).toBe(true);
    expect(r.ran).toEqual(['storage.largest']);
    const first = r.p.prompts[0]!;
    expect(first).toContain('storage.largest');
    // The shutdown skill matches nothing about this goal, so it is not even shown.
    expect(first).not.toContain('system.shutdownNow');
    expect(r.p.prompts).toHaveLength(2);
  });

  test('the prompt does not grow with the registry', async () => {
    const small = rig(['{"done":true,"summary":"x"}']);
    await small.run('open steam and find my videos');
    const extra: Skill[] = [];
    const sink: string[] = [];
    for (let i = 0; i < 3000; i++) extra.push(skill(`synthetic${i % 30}.op${i}`, `Does made up thing number ${i} with a widget`, 'safe', sink));
    const big = rig(['{"done":true,"summary":"x"}'], true, extra);
    await big.run('open steam and find my videos');
    const a = small.p.prompts[0]!.length;
    const b = big.p.prompts[0]!.length;
    expect(b).toBeLessThan(a + 3000);
    const catalogLines = big.p.prompts[0]!.split('\n').filter((l) => /^[a-z0-9]+\.[A-Za-z0-9]+\(/.test(l));
    expect(catalogLines.length).toBeLessThanOrEqual(CATALOG_SIZE);
  });
});

describe('what it can run', () => {
  test('a tool that was never offered does not run, even if it exists', async () => {
    const r = rig(['{"skill":"system.shutdownNow","args":{}}', '{"done":true,"summary":"ok"}']);
    await r.run('find the largest files on my D drive');
    expect(r.ran).toEqual([]);
  });

  test('other agents are never available, however well they match', async () => {
    const r = rig(['{"skill":"devagent.run","args":{}}', '{"done":true,"summary":"ok"}']);
    await r.run('build and fix a project with the developer agent');
    expect(r.ran).toEqual([]);
    expect(r.p.prompts[0]).not.toContain('devagent.run(');
  });

  test('a step goes through the real executor: a risky step asks, and a "no" ends the task', async () => {
    const r = rig(['{"skill":"files.delete","args":{}}', '{"skill":"app.open","args":{}}'], false);
    const report = await r.run('delete the old file');
    expect(r.ran).toEqual([]);
    expect(report.stoppedBecause).toBe('declined');
  });

  test('a malformed argument is rejected by the registry, not run', async () => {
    const r = rig(['{"skill":"app.open","args":"nope"}', '{"done":true,"summary":"stopped"}']);
    await r.run('open steam');
    expect(r.ran).toEqual([]);
  });

  test('is bounded by a step budget', async () => {
    const r = rig(['{"skill":"files.find","args":{"q":"1"}}']);
    // The same call repeating is stopped as a repeated action long before the budget; vary it.
    let n = 0;
    r.p.ask = ((prompt: string, h: { onDone: (s: string) => void }) => {
      r.p.prompts.push(prompt);
      h.onDone(`{"skill":"files.find","args":{"q":"${++n}"}}`);
    }) as never;
    const report = await r.run('find files named report');
    expect(r.ran.length).toBeLessThanOrEqual(MAX_UNIVERSAL_ITERATIONS);
    expect(['budget', 'done', 'repeated-failure']).toContain(report.stoppedBecause);
  });

  test('needs a model, and says so', async () => {
    const registry = new SkillRegistry({ capabilities: () => [] });
    const report = await runUniversalTask('open steam', { skills: registry, intelligence: registryOf(null), executor: new Executor(registry), getExecutionMode: () => 'doIt' }, ctx());
    expect(report.ok).toBe(false);
    expect(report.stoppedBecause).toBe('no-provider');
  });
});

describe('the explicit phrasing', () => {
  test('only "figure out / work out" hands a goal over', () => {
    expect(parseSolveRequest('figure out how to free up space on my D drive')).toBe('free up space on my D drive');
    expect(parseSolveRequest('work out how to see what is slowing my PC')).toBe('see what is slowing my PC');
    expect(parseSolveRequest('handle this: clean up my downloads and tell me what you removed')).toMatch(/clean up my downloads/);
    for (const t of ['open steam', 'how do I free up space', 'figure', 'what is the capital of Peru']) expect(parseSolveRequest(t), t).toBeNull();
  });
});
