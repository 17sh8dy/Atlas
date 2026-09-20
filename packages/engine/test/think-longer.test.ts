/**
 * "Think longer": the person asks for extended thinking and a fuller answer.
 *
 * What matters, checked at the point the request reaches the model:
 *  - it is off unless asked for, and asking changes nothing else;
 *  - when on, the provider is told (`deeper`) and the prompt asks for a fuller
 *    answer, so a model with no thinking mode is still asked for more;
 *  - only the *answer* goes deeper — planning an action never does, because a
 *    slower plan is a slower everything and gains nothing.
 */
import { describe, expect, test } from 'vitest';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';

interface Call {
  prompt: string;
  deeper: boolean | undefined;
}

function rig() {
  const calls: Call[] = [];
  const provider = {
    id: 'm',
    label: 'm',
    isConfigured: () => true,
    isLocal: () => true,
    ask: (prompt: string, h: { onDone(t: string): void }, options?: { deeper?: boolean }) => {
      calls.push({ prompt, deeper: options?.deeper });
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
    calls,
    ask: (text: string, options?: { thinkLonger?: boolean }) =>
      engine.ask(text, { say: () => {}, confirm: async () => true }, options),
  };
}

describe('Think longer', () => {
  test('is off by default: the model gets the question as written, and no deeper flag', async () => {
    const r = rig();
    await r.ask('why is the sky blue?');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toEqual({ prompt: 'why is the sky blue?', deeper: false });
  });

  test('when on, the provider is told and the prompt asks for a fuller answer', async () => {
    const r = rig();
    await r.ask('why is the sky blue?', { thinkLonger: true });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.deeper).toBe(true);
    expect(r.calls[0]!.prompt).toMatch(/thorough, detailed answer/);
    expect(r.calls[0]!.prompt.endsWith('why is the sky blue?')).toBe(true);
  });

  test('explicitly off behaves exactly like not asking', async () => {
    const a = rig();
    const b = rig();
    await a.ask('why is the sky blue?');
    await b.ask('why is the sky blue?', { thinkLonger: false });
    expect(a.calls).toEqual(b.calls);
  });

  test('planning an action is never asked to go deeper', async () => {
    const r = rig();
    // an instruction Atlas cannot resolve itself: the model is asked to plan
    // it first, then (failing that) to answer
    await r.ask('make me a folder for my taxes', { thinkLonger: true });
    const [planning, ...rest] = r.calls;
    // absent, not merely false: planning never carries the flag at all
    expect(planning!.deeper).toBeUndefined();
    expect(planning!.prompt).not.toMatch(/thorough, detailed answer/);
    // the reply that follows is the answer, and that one goes deeper
    expect(rest.at(-1)!.deeper).toBe(true);
  });

  test('a request Atlas understands on its own never reaches a model at all', async () => {
    const r = rig();
    await r.ask('create a folder called Notes in D:\\Dev', { thinkLonger: true });
    expect(r.calls).toEqual([]);
  });
});
