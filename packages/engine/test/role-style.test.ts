/**
 * A role is a communication style and nothing else.
 *
 * It may change how Atlas words its own replies and what a model is asked to
 * sound like. It must not change a confirmation or safety sentence, the
 * default role must stay byte-identical to what Atlas has always said, and no
 * role may change what a model is shown about the tools.
 */
import { describe, expect, test } from 'vitest';
import { ATLAS_ROLES, ATLAS_ROLE_META, DEFAULT_ATLAS_ROLE } from '@atlas/core';
import type { AtlasRole, IntelligenceProvider } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';
import { createPhrasing } from '../src/phrasing';

const NON_DEFAULT = ATLAS_ROLES.filter((r) => r !== DEFAULT_ATLAS_ROLE);
/** Roles with their own built-in wording. `custom` takes its style from the person and keeps Atlas's own lines neutral. */
const BUILT_IN = NON_DEFAULT.filter((r) => r !== 'custom');

function promptFor(role: AtlasRole | undefined, question: string, customStyle?: string): string[] {
  const prompts: string[] = [];
  const p = {
    id: 'm',
    label: 'm',
    isConfigured: () => true,
    isLocal: () => true,
    ask: (prompt: string, h: { onDone(t: string): void }) => {
      prompts.push(prompt);
      h.onDone('ok');
    },
  } as unknown as IntelligenceProvider;
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  const engine = new Engine({
    skills: new SkillRegistry({ capabilities: () => [] }),
    grammar,
    working,
    voice: role ? { role, ...(customStyle ? { customStyle } : {}) } : {},
    intelligence: {
      register: () => {},
      get: () => p,
      list: () => [p],
      active: () => p,
      setActive: () => {},
    },
  });
  void engine.ask(question, { say: () => {}, confirm: async () => false });
  return prompts;
}

describe('role style in what a model is asked', () => {
  const question = 'why is the sky blue during the day';

  test('the default role sends exactly what it always did', async () => {
    const none = promptFor(undefined, question);
    const assistant = promptFor('assistant', question);
    await new Promise((r) => setTimeout(r, 0));
    expect(assistant).toEqual(none);
    for (const prompt of assistant) expect(prompt).not.toMatch(/pilot|terse|warm/i);
  });

  test('every other role puts its own style ahead of the question', async () => {
    for (const role of BUILT_IN) {
      const prompts = promptFor(role, question);
      await new Promise((r) => setTimeout(r, 0));
      const style = ATLAS_ROLE_META[role].style;
      expect(style, role).toBeTruthy();
      expect(prompts.length, role).toBeGreaterThan(0);
      expect(prompts[0], role).toContain(style!);
      expect(prompts[0], role).toContain(question);
    }
  });
});

describe('the custom role and how you like to be addressed', () => {
  const question = 'why is the sky blue during the day';

  test('the custom style is what the model is asked to write in, on one line and capped', async () => {
    const prompts = promptFor('custom', question, 'Talk like a pirate,\n\n   but keep it short.');
    await new Promise((r) => setTimeout(r, 0));
    expect(prompts[0]).toContain('Talk like a pirate, but keep it short.');
    const long = promptFor('custom', question, 'x'.repeat(500));
    await new Promise((r) => setTimeout(r, 0));
    expect(long[0]).not.toContain('x'.repeat(201));
  });

  test('custom with no style written sends exactly what the default role sends', async () => {
    const none = promptFor(undefined, question);
    const custom = promptFor('custom', question);
    await new Promise((r) => setTimeout(r, 0));
    expect(custom).toEqual(none);
  });

  test("Atlas's own lines under custom are the neutral ones", () => {
    const bare = createPhrasing({});
    const p = createPhrasing({ role: 'custom', customStyle: 'anything' });
    expect(p.declined()).toBe(bare.declined());
    expect(p.rightThen(['a', 'b'])).toBe(bare.rightThen(['a', 'b']));
  });

  test('"sir" replaces the name in the greeting and the farewell, for every role', () => {
    for (const role of ATLAS_ROLES) {
      const p = createPhrasing({ role, userName: 'Brandon', address: 'sir' });
      expect(p.greeting(), role).not.toContain('Brandon');
      expect(p.smallTalk('goodbye', 1), role).not.toContain('Brandon');
    }
    expect(createPhrasing({ role: 'formal', address: 'sir' }).greeting()).toBe(
      'Good day, sir. How may I be of assistance?',
    );
  });

  test('the new tones are distinct, and none of them is the baseline', () => {
    const baseline = createPhrasing({ userName: 'Sam' });
    for (const role of ['formal', 'casual', 'humorous', 'sarcastic'] as const) {
      const p = createPhrasing({ role, userName: 'Sam' });
      expect(p.greeting(), role).not.toBe(baseline.greeting());
      expect(p.smallTalk('thanks', 1), role).not.toBe(baseline.smallTalk('thanks', 1));
    }
  });
});

describe('role wording in Atlas’s own replies', () => {
  test('the default role says what it always said', () => {
    const p = createPhrasing({ role: 'assistant' });
    const bare = createPhrasing({});
    expect(p.declined()).toBe('Okay — left alone.');
    expect(p.rightThen(['a', 'b'])).toBe('Right — a, then b.');
    expect(p.smallTalk('thanks', 1)).toBe(bare.smallTalk('thanks', 1));
    expect(p.smallTalk('howAreYou', 1)).toBe(bare.smallTalk('howAreYou', 1));
  });

  test('other roles word these replies differently, and every one is non-empty', () => {
    const baseline = createPhrasing({});
    for (const role of BUILT_IN) {
      const p = createPhrasing({ role });
      expect(p.declined().length, role).toBeGreaterThan(0);
      expect(p.declined(), role).not.toBe(baseline.declined());
      expect(p.rightThen(['a', 'b']), role).not.toBe(baseline.rightThen(['a', 'b']));
      expect(p.rightThen(['a', 'b']), role).toMatch(/a, then b\.$/);
      expect(p.smallTalk('thanks', 1).length, role).toBeGreaterThan(0);
    }
  });

  test('a confirmation or safety sentence never depends on the role', () => {
    const baseline = createPhrasing({ atlasName: 'Atlas' });
    for (const role of ATLAS_ROLES) {
      const p = createPhrasing({ atlasName: 'Atlas', role });
      expect(p.confirmPrompt('Delete a file.', 'D:\\x.txt')).toEqual(
        baseline.confirmPrompt('Delete a file.', 'D:\\x.txt'),
      );
      expect(p.planApproval([{ label: 'one', consequential: true }])).toEqual(
        baseline.planApproval([{ label: 'one', consequential: true }]),
      );
      expect(p.failed('It broke.')).toBe(baseline.failed('It broke.'));
    }
  });
});

describe('what Atlas says about itself', () => {
  test('"who are you" does not promise that nothing is ever sent anywhere', () => {
    for (const role of ATLAS_ROLES) {
      const text = createPhrasing({ role }).smallTalk('identity', 100);
      expect(text, role).not.toMatch(/nothing sent anywhere|entirely on this machine/i);
      expect(text, role).toMatch(/cloud model|web search|update/i);
    }
    expect(createPhrasing({}).smallTalk('name', 1)).not.toMatch(/entirely/i);
  });
});
