/**
 * Who answers ordinary conversation — and that nothing about it can reach an action.
 *
 * With a compatible model connected and selected, greetings, thanks, jokes and "who are you"
 * go to the model. Atlas's own fixed replies are what is said when there is no such model, or
 * when the one connected fails. Either way the model only ever writes text: it has no path to
 * a skill, a confirmation or the machine.
 */
import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, ModelCapabilities, Skill } from '@atlas/core';
import {
  CLOUD_DECLARED_CAPABILITIES,
  NOVA_INTELLIGENCE_CAPABILITIES,
  UNKNOWN_CAPABILITIES,
} from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';

type Behaviour =
  | { kind: 'reply'; text: string }
  | { kind: 'error'; reason: string }
  | { kind: 'plan'; skill: string };

function provider(
  behaviour: Behaviour,
  prompts: string[],
  options: { local?: boolean; caps?: ModelCapabilities | undefined } = {},
): IntelligenceProvider {
  return {
    id: 'test-model',
    label: 'Test model',
    isConfigured: () => true,
    isLocal: () => options.local ?? false,
    capabilities: options.caps === undefined ? undefined : () => options.caps!,
    ask: (prompt, h) => {
      prompts.push(prompt);
      if (behaviour.kind === 'error') h.onError(behaviour.reason);
      else if (behaviour.kind === 'plan')
        h.onDone(JSON.stringify({ intent: 'x', confidence: 1, steps: [{ skill: behaviour.skill, args: {} }] }));
      else h.onDone(behaviour.text);
    },
  } as IntelligenceProvider;
}

function skill(id: string, ran: string[], risk: Skill['risk'] = 'safe'): Skill {
  return {
    id,
    label: id,
    domain: 'test',
    description: `does ${id}`,
    risk,
    params: {},
    run: async () => {
      ran.push(id);
      return { ok: true, message: `ran ${id}` };
    },
  };
}

function rig(p: IntelligenceProvider | null, voice: { atlasName?: string; userName?: string } = {}) {
  const ran: string[] = [];
  const said: string[] = [];
  const confirms: string[] = [];
  const skills = new SkillRegistry({ capabilities: () => [] });
  skills.registerMany([skill('test.safe', ran), skill('test.danger', ran, 'confirm')]);
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  const engine = new Engine({
    skills,
    grammar,
    working,
    voice,
    intelligence: {
      register: () => {},
      get: () => p,
      list: () => (p ? [p] : []),
      active: () => p,
      setActive: () => {},
    },
  });
  return {
    skills,
    ran,
    said,
    confirms,
    ask: (text: string) =>
      engine.ask(text, {
        say: (t: string) => said.push(t),
        confirm: async (q: string) => {
          confirms.push(q);
          return false;
        },
      }),
  };
}

const GREETINGS = ['hey', 'thanks', 'tell me a joke', 'how are you?', 'who are you?', 'bye', 'nice one'];

describe('a compatible model answers ordinary conversation', () => {
  for (const message of GREETINGS) {
    test(`“${message}” goes to the model and its reply is what is said`, async () => {
      const prompts: string[] = [];
      const r = rig(provider({ kind: 'reply', text: 'MODEL ANSWER' }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }));
      const out = await r.ask(message);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(message);
      expect(r.said.join('\n')).toContain('MODEL ANSWER');
      expect(out).toMatchObject({ ok: true, mode: 'chat' });
    });
  }

  test('a model with no capability descriptor at all is still given the conversation', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'reply', text: 'MODEL ANSWER' }, prompts));
    await r.ask('hello');
    expect(prompts).toHaveLength(1);
    expect(r.said.join('\n')).toContain('MODEL ANSWER');
  });

  test('a model whose descriptor is all-unknown is still given the conversation', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'reply', text: 'MODEL ANSWER' }, prompts, { caps: UNKNOWN_CAPABILITIES }));
    await r.ask('thanks');
    expect(prompts).toHaveLength(1);
  });

  test('social talk is never turned into a web search', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'reply', text: 'MODEL ANSWER' }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }));
    await r.ask('what is the latest, how are you');
    expect(prompts.length).toBeLessThanOrEqual(1);
  });
});

describe('Atlas’s own replies are the fallback', () => {
  test('with no model connected the fixed reply is used and nothing is asked', async () => {
    const r = rig(null);
    const out = await r.ask('hey');
    expect(r.said.join('\n')).toMatch(/what can i do for you|what do you need|what are we doing/i);
    expect(out).toMatchObject({ ok: true, mode: 'chat' });
  });

  for (const reason of ['offline', 'not-configured', 'Rate limited by the provider — try again in a moment.']) {
    test(`a model failure (${reason.slice(0, 20)}…) falls back to Atlas's reply, not an error`, async () => {
      const prompts: string[] = [];
      const r = rig(provider({ kind: 'error', reason }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }));
      const out = await r.ask('thanks');
      expect(prompts).toHaveLength(1);
      const said = r.said.join('\n');
      expect(said).toMatch(/any time|welcome|no trouble/i);
      expect(said).not.toMatch(/⚠️|rate limit|couldn.?t reach|offline/i);
      expect(out).toMatchObject({ ok: true });
    });
  }

  test('a model that cannot converse (Nova Intelligence) is never asked', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'reply', text: 'NOVA TEXT' }, prompts, { local: true, caps: NOVA_INTELLIGENCE_CAPABILITIES }));
    await r.ask('hello');
    expect(prompts).toEqual([]);
    expect(r.said.join('\n')).not.toContain('NOVA TEXT');
    expect(r.said.join('\n')).toMatch(/what can i do for you|what do you need|what are we doing/i);
  });

  test('the fallback does not pretend to be the model', async () => {
    const r = rig(null);
    await r.ask('who are you?');
    const said = r.said.join('\n');
    expect(said).not.toMatch(/\b(?:think|reason|understand|feel)\b/i);
  });
});

describe('what the model is told', () => {
  test('it is told who Atlas is, with the real capability count', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'reply', text: 'ok' }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }), {
      atlasName: 'Atlas',
    });
    await r.ask('who are you?');
    expect(prompts[0]).toMatch(/You are Atlas, a desktop assistant for Windows/);
    expect(prompts[0]).toContain(`about ${r.skills.available().length} of them`);
    expect(prompts[0]).toMatch(/only write the reply/);
    expect(prompts[0]).not.toMatch(/nothing is sent|nothing leaves/i);
  });

  test('a renamed Atlas is a renamed Atlas', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'reply', text: 'ok' }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }), {
      atlasName: 'Juniper',
    });
    await r.ask('hello');
    expect(prompts[0]).toMatch(/You are Juniper/);
  });

  test('a cloud model is not told the person’s name; a local one is', async () => {
    const cloud: string[] = [];
    await rig(provider({ kind: 'reply', text: 'ok' }, cloud, { local: false, caps: CLOUD_DECLARED_CAPABILITIES }), {
      userName: 'Sam',
    }).ask('hello');
    expect(cloud[0]).not.toContain('Sam');

    const local: string[] = [];
    await rig(provider({ kind: 'reply', text: 'ok' }, local, { local: true, caps: CLOUD_DECLARED_CAPABILITIES }), {
      userName: 'Sam',
    }).ask('hello');
    expect(local[0]).toContain('Sam');
  });

  test('conversation sends the identity facts and the message — nothing else', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'reply', text: 'ok' }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }));
    await r.ask('thanks');
    const [facts, message, ...rest] = prompts[0]!.split('\n\n');
    expect(rest).toEqual([]);
    expect(facts).toMatch(/^You are Atlas/);
    expect(message).toBe('thanks');
    // No paths, no readings, no history.
    expect(prompts[0]).not.toMatch(/[A-Za-z]:\\|\bCPU\b|\bGB\b|recent|history/i);
  });

  test('a question that is not about Atlas is still sent exactly as written', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'reply', text: 'ok' }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }));
    await r.ask('why is the sky blue?');
    expect(prompts[0]).toBe('why is the sky blue?');
  });

  test('a question about Atlas gets the facts', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'reply', text: 'ok' }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }));
    await r.ask('are you able to run commands for me?');
    expect(prompts[0]).toMatch(/You are Atlas/);
  });
});

describe('the model can only write text', () => {
  test('a reply to a greeting that looks like a plan runs nothing and asks nothing', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'plan', skill: 'test.danger' }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }));
    await r.ask('hello');
    expect(r.ran).toEqual([]);
    expect(r.confirms).toEqual([]);
    // It is shown as the text it is.
    expect(r.said.join('\n')).toContain('test.danger');
  });

  test('an instruction still goes through the planner and the executor, not the conversation path', async () => {
    const prompts: string[] = [];
    const r = rig(provider({ kind: 'plan', skill: 'test.danger' }, prompts, { caps: CLOUD_DECLARED_CAPABILITIES }));
    await r.ask('please tidy up the zebra situation');
    // The planned step is consequential, so it asks — and the answer was no.
    expect(r.confirms.length).toBeGreaterThan(0);
    expect(r.ran).toEqual([]);
  });
});
