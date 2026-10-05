/**
 * "what is lagoon?" took 35+ seconds on a local model and described a body of water, when the person
 * meant the theme park. Two fixes, both at the point the question reaches the model: a short
 * definition question is asked for in a few sentences (the length of the reply IS the wait on a
 * CPU-only model), and the model is told to name the other meanings so a wrong guess is one line
 * away from being corrected instead of one essay away.
 */
import { describe, expect, test } from 'vitest';
import { Engine, wantsBriefAnswer } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';

function rig() {
  const prompts: string[] = [];
  const provider = {
    id: 'm',
    label: 'm',
    isConfigured: () => true,
    isLocal: () => true,
    ask: (prompt: string, h: { onDone(t: string): void }) => {
      prompts.push(prompt);
      h.onDone('an answer');
    },
  };
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  const engine = new Engine({
    skills: new SkillRegistry({ capabilities: () => [] }),
    grammar,
    working,
    intelligence: {
      register: () => {},
      get: () => provider,
      list: () => [provider],
      active: () => provider,
      setActive: () => {},
    },
  });
  return {
    prompts,
    ask: (text: string, options?: { thinkLonger?: boolean }) =>
      engine.ask(text, { say: () => {}, confirm: async () => true }, options),
  };
}

describe('short definition questions', () => {
  test('are asked for briefly, and with the other meanings named', async () => {
    const r = rig();
    await r.ask('what is lagoon?');
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toMatch(/^Answer briefly: one to three plain sentences/);
    expect(r.prompts[0]).toMatch(/more than one common meaning/);
    expect(r.prompts[0]).toMatch(/what is lagoon\?$/);
  });

  test('recognises the shapes that have a short right answer', () => {
    for (const q of ['what is lagoon?', "what's a lagoon", 'who is Ada Lovelace', 'define entropy', 'what does ephemeral mean', 'tell me about Utah', 'what are quasars']) {
      expect(wantsBriefAnswer(q), q).toBe(true);
    }
  });

  test('leaves alone anything that wants room: why, how, long, or an instruction', () => {
    for (const q of [
      'why is the sky blue?',
      'how do I make bread',
      'explain how a compiler works',
      'what is the best way to structure a large react project with many teams and shared state',
      'write a poem about lagoons',
      '',
    ]) {
      expect(wantsBriefAnswer(q), q).toBe(false);
    }
  });

  test('"Think longer" keeps the full room, and the question as written', async () => {
    const r = rig();
    await r.ask('what is lagoon?', { thinkLonger: true });
    expect(r.prompts[0]).not.toMatch(/Answer briefly/);
    expect(r.prompts[0]).toMatch(/what is lagoon\?$/);
  });

  test('a why-question is still sent exactly as written', async () => {
    const r = rig();
    await r.ask('why is the sky blue?');
    expect(r.prompts[0]).toBe('why is the sky blue?');
  });
});
