/**
 * Selecting a model actually changes the model Atlas asks.
 *
 * The claim worth proving is not that a label changed in Settings but that the
 * request which leaves Atlas names the selected model — so these tests stand
 * where the request leaves the webview (`invoke`, mocked) and check what is
 * on the wire for every selectable model, for cloud providers, for Nova
 * Intelligence, and through the real Engine.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import type { CloudProviderConfig } from '@atlas/core';
import { LOCAL_MODEL_PROFILES } from '@atlas/core';
import { Engine, Grammar, SkillRegistry } from '@atlas/engine';
import {
  DEFAULT_LOCAL_AI_RUNTIME,
  buildIntelligence,
  type LocalAiRuntime,
} from '../src/atlas/buildIntelligence';

const ON: LocalAiRuntime = {
  ...DEFAULT_LOCAL_AI_RUNTIME,
  local: { enabled: true, baseUrl: '' },
};

const CLOUD: CloudProviderConfig = {
  id: 'cloud-abc',
  kind: 'openai-compatible',
  label: 'My cloud',
  model: 'gpt-x',
  baseUrl: 'https://api.example.com/v1',
  enabled: true,
};

function setup(over: {
  localAi?: LocalAiRuntime;
  activeProviderId?: string | null;
  cloudProviders?: CloudProviderConfig[];
}) {
  return buildIntelligence({
    localAi: over.localAi ?? ON,
    activeProviderId: over.activeProviderId ?? null,
    cloudProviders: over.cloudProviders ?? [],
  });
}

type Outcome = { ok: true; text: string } | { ok: false; reason: string };

function askActive(
  built: ReturnType<typeof setup>,
  prompt = 'hello',
  options?: { deeper?: boolean },
): Promise<Outcome> {
  return new Promise((resolve) => {
    const provider = built.registry.active();
    if (!provider) {
      resolve({ ok: false, reason: 'nothing-selected' });
      return;
    }
    provider.ask(
      prompt,
      {
        onDelta: () => {},
        onDone: (text) => resolve({ ok: true, text }),
        onError: (reason) => resolve({ ok: false, reason }),
      },
      options,
    );
  });
}

const commandsCalled = () => invoke.mock.calls.map((c) => c[0] as string);
const lastArgs = () => invoke.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue('an answer');
});

describe('the default', () => {
  test('with local models on and nothing picked, Qwen3-8B is the model asked', async () => {
    const built = setup({});
    expect(built.activeId).toBe('local:qwen3-8b');
    await askActive(built, 'what is a kernel');
    expect(commandsCalled()).toEqual(['ask_local_model_stream']);
    expect(lastArgs()).toMatchObject({
      model: 'qwen3:8b',
      prompt: 'what is a kernel',
      think: false,
    });
  });

  test('a pick that no longer exists falls back to the default rather than failing', async () => {
    const built = setup({ activeProviderId: 'cloud-that-was-removed' });
    expect(built.activeId).toBe('local:qwen3-8b');
    await askActive(built);
    expect(lastArgs()).toMatchObject({ model: 'qwen3:8b' });
  });
});

describe('each selectable local model puts its own tag on the wire', () => {
  test.each(LOCAL_MODEL_PROFILES.map((p) => [p.label, p] as const))(
    '%s',
    async (_label, profile) => {
      const built = setup({ activeProviderId: profile.id });
      expect(built.registry.active()?.id).toBe(profile.id);
      await askActive(built);
      expect(lastArgs()).toMatchObject({ model: profile.ollamaTag, think: profile.think ?? null });
    },
  );

  test('switching the selection switches the model, on the very next request', async () => {
    const models: string[] = [];
    for (const profile of LOCAL_MODEL_PROFILES) {
      await askActive(setup({ activeProviderId: profile.id }));
      models.push(lastArgs().model as string);
    }
    expect(models).toEqual(['qwen3:8b', 'qwen3:30b', 'qwen3.5:35b']);
    expect(new Set(models).size).toBe(3);
  });

  test('a model Ollama has that is not in the catalogue is usable too, under its own name', async () => {
    const localAi = { ...ON, installed: ['qwen3.5:9b', 'qwen3:8b'] };
    const built = setup({ localAi, activeProviderId: 'local:qwen3.5:9b' });
    expect(built.activeId).toBe('local:qwen3.5:9b');
    await askActive(built);
    // an uncatalogued model is an everyday chat model: thinking off, for speed
    expect(lastArgs()).toMatchObject({ model: 'qwen3.5:9b', think: false });
    // a catalogued model that is installed is not listed twice
    expect(built.registry.list().filter((p) => p.id.includes('qwen3:8b'))).toHaveLength(0);
  });

  test('the model that was chosen is the only one asked — one request, one model', async () => {
    await askActive(setup({ activeProviderId: 'local:qwen3-30b-a3b' }));
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('local models are off until switched on', () => {
  test('off means nothing is selected and nothing leaves', async () => {
    const built = setup({
      localAi: DEFAULT_LOCAL_AI_RUNTIME,
      activeProviderId: 'local:qwen3-30b-a3b',
    });
    expect(built.registry.active()).toBeNull();
    expect(await askActive(built)).toEqual({ ok: false, reason: 'nothing-selected' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('a model that is not installed says exactly what to run', async () => {
    invoke.mockRejectedValue('model-missing:qwen3:30b');
    const out = await askActive(setup({ activeProviderId: 'local:qwen3-30b-a3b' }));
    expect(out).toMatchObject({ ok: false });
    expect((out as { reason: string }).reason).toContain('ollama pull qwen3:30b');
    expect((out as { reason: string }).reason).toContain('Qwen3-30B-A3B');
  });

  test('Ollama not running is reported as the offline sentinel the engine already understands', async () => {
    invoke.mockRejectedValue('offline');
    expect(await askActive(setup({}))).toEqual({ ok: false, reason: 'offline' });
  });
});

describe('cloud providers still work through the existing system', () => {
  test('an enabled cloud provider that is selected is the one asked, and no local model is', async () => {
    const built = setup({ activeProviderId: CLOUD.id, cloudProviders: [CLOUD] });
    expect(built.activeId).toBe(CLOUD.id);
    await askActive(built, 'hi cloud');
    expect(commandsCalled()).toEqual(['ask_cloud_provider']);
    expect(lastArgs()).toEqual({
      providerId: CLOUD.id,
      kind: 'openai-compatible',
      baseUrl: CLOUD.baseUrl,
      model: 'gpt-x',
      prompt: 'hi cloud',
    });
  });

  test('a cloud provider works even with local models off', async () => {
    const built = setup({
      localAi: DEFAULT_LOCAL_AI_RUNTIME,
      activeProviderId: CLOUD.id,
      cloudProviders: [CLOUD],
    });
    expect((await askActive(built)).ok).toBe(true);
    expect(commandsCalled()).toEqual(['ask_cloud_provider']);
  });

  test('a disabled cloud provider is inert even when selected', async () => {
    const built = setup({
      activeProviderId: CLOUD.id,
      cloudProviders: [{ ...CLOUD, enabled: false }],
    });
    expect(built.registry.active()).toBeNull();
    await askActive(built);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('cloud providers come only from the list the user built', () => {
    expect(
      setup({})
        .registry.list()
        .some((p) => p.id.startsWith('cloud-')),
    ).toBe(false);
    expect(
      setup({ cloudProviders: [CLOUD] })
        .registry.list()
        .some((p) => p.id === CLOUD.id),
    ).toBe(true);
  });
});

describe('Nova Intelligence', () => {
  test('when switched on and selected, it is the provider asked — through its own endpoint', async () => {
    const localAi = { ...ON, nova: { enabled: true, baseUrl: '' } };
    const built = setup({ localAi, activeProviderId: 'nova-intelligence' });
    expect(built.activeId).toBe('nova-intelligence');
    await askActive(built, 'continue this');
    expect(commandsCalled()).toEqual(['ask_nova_intelligence_stream']);
    expect(lastArgs()).toMatchObject({ prompt: 'continue this', baseUrl: 'http://127.0.0.1:8766' });
    expect(lastArgs()).not.toHaveProperty('model');
  });

  test('switched off, selecting it does nothing', async () => {
    const built = setup({ activeProviderId: 'nova-intelligence' });
    expect(built.registry.active()).toBeNull();
  });
});

describe('through the real Engine', () => {
  function engineFor(built: ReturnType<typeof setup>) {
    const said: string[] = [];
    const skills = new SkillRegistry({ capabilities: () => [] });
    const engine = new Engine({
      skills,
      grammar: new Grammar(),
      intelligence: built.registry,
    });
    return {
      said,
      ask: (text: string) =>
        engine.ask(text, { say: (t) => said.push(t), confirm: async () => true }),
    };
  }

  test.each(LOCAL_MODEL_PROFILES.map((p) => [p.label, p] as const))(
    'a conversational question goes through %s and nothing else',
    async (_label, profile) => {
      const e = engineFor(setup({ activeProviderId: profile.id }));
      await e.ask('tell me something interesting about volcanoes');
      expect(invoke).toHaveBeenCalled();
      // every request the Engine made for this question — planning included —
      // named the selected model
      const models = new Set(invoke.mock.calls.map((c) => (c[1] as { model: string }).model));
      expect([...models]).toEqual([profile.ollamaTag]);
      expect(new Set(commandsCalled())).toEqual(new Set(['ask_local_model_stream']));
      expect(e.said.join(' ')).toContain('an answer');
    },
  );

  test('with nothing selected the Engine still answers from its own tiers and asks no model', async () => {
    const e = engineFor(setup({ localAi: DEFAULT_LOCAL_AI_RUNTIME }));
    await e.ask('tell me something interesting about volcanoes');
    expect(invoke).not.toHaveBeenCalled();
    expect(e.said.length).toBeGreaterThan(0);
  });
});

describe('Think longer, on the wire', () => {
  test('the everyday model normally runs with thinking off, and Think longer switches it on', async () => {
    const built = setup({ activeProviderId: 'local:qwen3-8b' });
    await askActive(built, 'hi');
    expect(lastArgs()).toMatchObject({ model: 'qwen3:8b', think: false });
    await askActive(built, 'hi', { deeper: true });
    expect(lastArgs()).toMatchObject({ model: 'qwen3:8b', think: true });
  });

  test('it is still the same model — only the thinking changes', async () => {
    const built = setup({ activeProviderId: 'local:qwen3-30b-a3b' });
    await askActive(built, 'hi', { deeper: true });
    expect(lastArgs()).toMatchObject({ model: 'qwen3:30b', think: true });
    await askActive(built, 'hi');
    expect(lastArgs()).toMatchObject({ model: 'qwen3:30b', think: null });
  });

  test('an uncatalogued model goes from thinking off to on', async () => {
    const localAi = { ...ON, installed: ['qwen3.5:9b'] };
    const built = setup({ localAi, activeProviderId: 'local:qwen3.5:9b' });
    await askActive(built, 'hi');
    expect(lastArgs()).toMatchObject({ model: 'qwen3.5:9b', think: false });
    await askActive(built, 'hi', { deeper: true });
    expect(lastArgs()).toMatchObject({ model: 'qwen3.5:9b', think: true });
  });

  test('a cloud provider is not sent anything it did not ask for', async () => {
    const built = setup({ activeProviderId: CLOUD.id, cloudProviders: [CLOUD] });
    await askActive(built, 'hi', { deeper: true });
    expect(Object.keys(lastArgs()).sort()).toEqual(
      ['baseUrl', 'kind', 'model', 'prompt', 'providerId'].sort(),
    );
  });
});
