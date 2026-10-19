/**
 * Automatic routing to the universal agent, and distrust of half-understood chained requests, inside the REAL
 * Engine with a scripted model. What must hold:
 *   · a request the rules understand completely is untouched;
 *   · a chained request the rules only half understand is not run as just its first half when a model is there;
 *   · an unfamiliar job made of Atlas's capabilities is OFFERED to the agent on a card, in every execution mode,
 *     and nothing happens on a "no";
 *   · text/chat requests are never offered; with no model nothing new happens except the honest note.
 */
import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, IntelligenceRegistry, Skill } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { createUniversalAgentSkill } from '../src/skills/universal-skill';
import { WorkingMemory } from '../src/working-memory';
import { Executor } from '../src/planner/executor';
import { everySkill } from './helpers/every-skill';

function rig(opts: { model: boolean; mode?: 'doIt' | 'doItPlus' | 'confirmActions'; agentReplies?: string[]; confirmAnswers?: boolean[]; plannerReply?: string; enabled?: boolean }) {
  const ran: string[] = [];
  const cards: string[] = [];
  const registry = new SkillRegistry({ capabilities: () => [] });
  // The REAL catalog (so retrieval scores are the real ones), with every action replaced by a recorder.
  registry.registerMany(
    everySkill().map((k): Skill => {
      const { verify, preview, guard, needs, ...rest } = k as Skill & Record<string, unknown>;
      void verify; void preview; void guard; void needs;
      return { ...(rest as Skill), async run() { ran.push(k.id); return { ok: true, message: `${k.id} done` }; } };
    }),
  );
  const prompts: string[] = [];
  let agentCall = 0;
  const provider = {
    id: 't', label: 'T', isConfigured: () => true, isLocal: () => true,
    ask(prompt: string, h: { onDone: (s: string) => void }) {
      prompts.push(prompt);
      if (/general task agent/.test(prompt)) h.onDone((opts.agentReplies ?? ['{"done":true,"summary":"done"}'])[Math.min(agentCall++, (opts.agentReplies ?? ['x']).length - 1)]!);
      else if (opts.plannerReply && /JSON plan|tool calls/.test(prompt)) h.onDone(opts.plannerReply);
      else h.onDone('I am not sure what you mean.');
    },
  } as unknown as IntelligenceProvider;
  const intelligence: IntelligenceRegistry = { register() {}, get: () => provider, list: () => [provider], active: () => (opts.model ? provider : null), setActive() {} } as never;
  registry.register(createUniversalAgentSkill({ skills: registry, intelligence, getExecutionMode: () => opts.mode ?? 'doIt', isEnabled: () => opts.enabled !== false }));
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  grammar.addMany(createExtraGrammar());
  const engine = new Engine({ skills: registry, grammar, working, intelligence, getExecutionMode: () => opts.mode ?? 'doIt', routing: { universalAgent: () => opts.enabled !== false } });
  const said: string[] = [];
  const answers = [...(opts.confirmAnswers ?? [])];
  const io = {
    say: (t: string) => void said.push(t),
    confirm: async (q: string) => { cards.push(q); return answers.length ? answers.shift()! : true; },
    showResults: () => {},
  };
  return { engine, io, ran, cards, said, prompts };
}

const JOB = 'check how much space my downloads folder uses and then clean out the temp files';

describe('offering the agent', () => {
  test('a chained job the rules cannot fully do is offered on a card, in every execution mode', async () => {
    for (const mode of ['doIt', 'doItPlus', 'confirmActions'] as const) {
      const r = rig({ model: true, mode, confirmAnswers: [false] });
      await r.engine.ask(JOB, r.io);
      expect(r.cards.some((c) => /Work this out step by step/.test(c)), mode).toBe(true);
      expect(r.ran, `${mode}: nothing runs on a no`).toEqual([]);
    }
  });

  test('on a yes the agent runs, and each of its actions still asks (cautious)', async () => {
    const r = rig({
      model: true, mode: 'doIt',
      agentReplies: ['{"skill":"files.delete","args":{"path":"C:/x/old.txt"}}', '{"done":true,"summary":"cleaned"}'],
      confirmAnswers: [true, false],
    });
    await r.engine.ask('check how much space my downloads folder uses and then delete the old installers', r.io);
    // The first card started the agent; the second was the zip action, which the person declined.
    expect(r.cards.length).toBeGreaterThanOrEqual(2);
    expect(r.ran).not.toContain('files.delete');
  });

  test('a yes then a yes runs the action', async () => {
    const r = rig({
      model: true, mode: 'doIt',
      agentReplies: ['{"skill":"storage.folderSize","args":{"path":"downloads"}}', '{"skill":"cleanup.clean","args":{"kind":"temp"}}', '{"done":true,"summary":"ok"}'],
      confirmAnswers: [true, true],
    });
    await r.engine.ask(JOB, r.io);
    expect(r.ran).toContain('storage.folderSize');
    expect(r.ran).toContain('cleanup.clean');
  });

  test('conversation and writing are never offered', async () => {
    for (const t of ['write a poem about my cat and the sea', 'tell me a story about a dragon who loves tea']) {
      const r = rig({ model: true });
      await r.engine.ask(t, r.io);
      expect(r.cards.filter((c) => /step by step/.test(c)), t).toEqual([]);
      expect(r.ran, t).toEqual([]);
    }
  });

  test('with no model nothing is offered', async () => {
    const r = rig({ model: false });
    await r.engine.ask(JOB, r.io);
    expect(r.cards.filter((c) => /step by step/.test(c))).toEqual([]);
  });

  test('a request the rules fully understand never reaches the agent', async () => {
    const r = rig({ model: true });
    await r.engine.ask('open steam', r.io);
    expect(r.ran).toEqual(['app.open']);
    expect(r.cards).toEqual([]);
    expect(r.prompts).toEqual([]);
  });
});

describe('half-understood chains', () => {
  test('without a model the understood part runs and the rest is said out loud', async () => {
    const r = rig({ model: false });
    await r.engine.ask(JOB, r.io);
    expect(r.ran[0]).toBe('system.info');
    expect(r.said.join('\n')).toMatch(/I only did the first part|haven't done/);
  });
});

test('Executor import stays used (the engine owns one)', () => {
  expect(typeof Executor).toBe('function');
});

describe('a model plan is held to the same standard', () => {
  const HALF = JSON.stringify({ intent: 'x', confidence: 0.9, steps: [{ skill: 'files.createFolder', args: { path: 'C:/x/reports' } }] });
  const TWO_JOBS = 'create a folder called reports in C:/x and then move big.log into it';

  test('a one-step plan for a two-job request is offered to the agent, not run as the whole answer', async () => {
    const r = rig({ model: true, plannerReply: HALF, confirmAnswers: [false] });
    await r.engine.ask(TWO_JOBS, r.io);
    expect(r.cards.some((c) => /step by step/.test(c))).toBe(true);
    expect(r.ran).toEqual([]);
  });

  test('"figure out how to" wins over every other rule', async () => {
    const r = rig({ model: true, plannerReply: HALF, confirmAnswers: [false] });
    await r.engine.ask(`figure out how to ${TWO_JOBS}`, r.io);
    expect(r.ran).toEqual([]);
    expect(r.cards.length).toBeGreaterThan(0);
  });
});

describe('the Universal Agent switch (off means off)', () => {
  const HALF = JSON.stringify({ intent: 'x', confidence: 0.9, steps: [{ skill: 'files.createFolder', args: { path: 'C:/x/reports' } }] });
  const TWO_JOBS = 'create a folder called reports in C:/x and then move big.log into it';
  const JOB = 'check how much space my downloads folder uses and then clean out the temp files';

  test('off: no offer appears for a job that is offered when on', async () => {
    const on = rig({ model: true, confirmAnswers: [false] });
    await on.engine.ask(JOB, on.io);
    expect(on.cards.some((c) => /step by step/.test(c))).toBe(true);
    const off = rig({ model: true, enabled: false, confirmAnswers: [false] });
    await off.engine.ask(JOB, off.io);
    expect(off.cards.filter((c) => /step by step/.test(c))).toEqual([]);
    expect(off.prompts.filter((p) => /general task agent/.test(p))).toEqual([]);
  });

  test('off: an explicit "figure out how to" does nothing and says why, with no card', async () => {
    const r = rig({ model: true, enabled: false, plannerReply: HALF });
    await r.engine.ask(`figure out how to ${TWO_JOBS}`, r.io);
    expect(r.ran).toEqual([]);
    expect(r.cards).toEqual([]);
    expect(r.prompts.filter((p) => /general task agent/.test(p))).toEqual([]);
    expect(r.said.join(' ')).toMatch(/Universal Agent is off/);
  });

  test('off: the engine with no routing option at all offers nothing (absent means off)', async () => {
    const r = rig({ model: true, confirmAnswers: [false] });
    // Rebuild an engine the way an older caller would: no `routing` option.
    const { Engine: E } = await import('../src/engine');
    const bare = new E({ skills: (r.engine as never as { skills: SkillRegistry }).skills, grammar: (r.engine as never as { grammar: Grammar }).grammar, working: new WorkingMemory(), intelligence: (r.engine as never as { intelligence: IntelligenceRegistry }).intelligence, getExecutionMode: () => 'doIt' });
    await bare.ask(JOB, r.io);
    expect(r.cards.filter((c) => /step by step/.test(c))).toEqual([]);
  });
});
