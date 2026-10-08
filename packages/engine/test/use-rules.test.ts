/**
 * The use rules reach a connected model on the paths where Atlas acts, and only there. They are
 * the same whichever model is connected, and they are NOT added to an ordinary question (that
 * would slow chat and change what the Atlas Terms say is sent).
 */
import { describe, expect, test } from 'vitest';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';
import { USE_RULES } from '../src/safety/use-rules';

function rig(local: boolean) {
  const prompts: string[] = [];
  const provider = {
    id: 'm',
    label: 'm',
    isConfigured: () => true,
    isLocal: () => local,
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
    ask: (text: string) => engine.ask(text, { say: () => {}, confirm: async () => true }),
  };
}

describe('use rules reach the model', () => {
  test('the wording explains and teaches are fine, and names no model', () => {
    expect(USE_RULES).toMatch(/Explaining and teaching about sensitive subjects is fine/);
    expect(USE_RULES).toMatch(/whichever model is in use/);
  });

  for (const local of [true, false]) {
    test(`an unmatched instruction carries them (${local ? 'local' : 'cloud'} model)`, async () => {
      const r = rig(local);
      await r.ask('please tidy up the zebra situation');
      expect(r.prompts.length).toBeGreaterThan(0);
      expect(r.prompts.every((p) => p.includes(USE_RULES))).toBe(true);
    });
  }

  test('an ordinary question is still sent exactly as written', async () => {
    const r = rig(true);
    await r.ask('why is the sky blue?');
    expect(r.prompts).toEqual(['why is the sky blue?']);
  });
});
