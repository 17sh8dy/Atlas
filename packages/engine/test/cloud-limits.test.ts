import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';
import { describeProviderFailure, parseProviderFailure } from '../src/cloud-limits';

describe('the words for a cloud limit', () => {
  test('a provider that is out of money says so and says what Atlas did and did not do', () => {
    const t = describeProviderFailure('limit-reached:provider', 'Claude')!;
    expect(t).toContain('⚠️ Cloud AI Limit Reached');
    expect(t).toContain('Your Claude account has reached its spending limit.');
    expect(t).toContain('Atlas has paused requests to this provider.');
    expect(t).toContain('You can switch to a local model or manage your limits through your provider.');
    expect(t).not.toMatch(/has switched|switched you/);
  });

  test('a cap the person set is named as theirs, with its number', () => {
    expect(describeProviderFailure('limit-reached:atlas-requests:500', 'OpenAI')).toContain('500 requests a month');
    expect(describeProviderFailure('limit-reached:atlas-tokens:200000', 'OpenAI')).toContain('200,000 tokens a month');
  });

  test('a runaway loop and a plain rate limit are told apart from a spending limit', () => {
    expect(describeProviderFailure('limit-reached:burst:30', 'Kimi')).toContain('looks like a loop');
    const rate = describeProviderFailure('rate-limited:Rate limited by the provider — try again in a moment.', 'Kimi')!;
    expect(rate).toContain('rate limiting');
    expect(rate).toContain('has not paused it');
    expect(rate).not.toContain('Limit Reached');
  });

  test('anything else is not ours to describe', () => {
    for (const r of ['offline', 'not-configured', 'That API key was rejected.', 'limit-reached:something-else']) {
      expect(parseProviderFailure(r)).toBeNull();
      expect(describeProviderFailure(r, 'X')).toBeNull();
    }
  });
});

function engineWith(providers: IntelligenceProvider[], active: IntelligenceProvider) {
  const skills = new SkillRegistry({ capabilities: () => [] });
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  const setActive: string[] = [];
  const engine = new Engine({
    skills,
    grammar,
    working,
    intelligence: {
      register: () => {},
      get: (id: string) => providers.find((p) => p.id === id) ?? null,
      list: () => providers,
      active: () => active,
      setActive: (id: string | null) => {
        if (id) setActive.push(id);
      },
    },
  });
  const said: string[] = [];
  const ask = (text: string) => engine.ask(text, { say: (t: string) => said.push(t), confirm: async () => false });
  return { ask, said, setActive };
}

function provider(id: string, label: string, onAsk: (h: { onError(e: string): void; onDone(t: string): void }) => void, calls: string[]): IntelligenceProvider {
  return {
    id,
    label,
    isConfigured: () => true,
    isLocal: () => false,
    ask: (_p: string, h: never) => {
      calls.push(id);
      onAsk(h);
    },
  } as unknown as IntelligenceProvider;
}

describe('when the active cloud provider is out of money', () => {
  test('the person is told, and no other provider is asked or selected', async () => {
    const calls: string[] = [];
    const a = provider('a', 'Claude', (h) => h.onError('limit-reached:provider'), calls);
    const b = provider('b', 'OpenAI', (h) => h.onDone('I am the other paid provider'), calls);
    const local = provider('local', 'Local model', (h) => h.onDone('I am local'), calls);
    const r = engineWith([a, b, local], a);
    await r.ask('please explain how a tide works in a few sentences');
    expect(calls).toEqual(['a']); // asked once, and only the active one
    expect(r.setActive).toEqual([]); // and the selection was not changed
    const all = r.said.join('\n');
    expect(all).toContain('Cloud AI Limit Reached');
    expect(all).toContain('Your Claude account has reached its spending limit.');
    expect(all).not.toContain('the other paid provider');
    expect(all).not.toContain('I am local');
  });

  test('it is shown even when the question would otherwise have been answered by Atlas itself', async () => {
    const calls: string[] = [];
    const a = provider('a', 'Claude', (h) => h.onError('limit-reached:provider'), calls);
    const r = engineWith([a], a);
    await r.ask('hello there, how are you doing today');
    expect(r.said.join('\n')).toContain('Cloud AI Limit Reached');
  });

  test("a cap Atlas enforces reads the same way and also never switches", async () => {
    const calls: string[] = [];
    const a = provider('a', 'OpenAI', (h) => h.onError('limit-reached:atlas-requests:100'), calls);
    const b = provider('b', 'Kimi', (h) => h.onDone('other'), calls);
    const r = engineWith([a, b], a);
    await r.ask('please explain how a tide works in a few sentences');
    expect(calls).toEqual(['a']);
    expect(r.said.join('\n')).toContain('100 requests a month');
  });
});
