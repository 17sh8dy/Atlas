/**
 * What each kind of provider says it can do — and that saying so grants nothing.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import type { CloudProviderConfig } from '@atlas/core';
import { LOCAL_MODEL_PROFILES, canConverse, supports } from '@atlas/core';
import {
  DEFAULT_LOCAL_AI_RUNTIME,
  buildIntelligence,
  type LocalAiRuntime,
} from '../src/atlas/buildIntelligence';
import { NOVA_INTELLIGENCE_PROVIDER_ID } from '@atlas/platform';

const ON: LocalAiRuntime = {
  ...DEFAULT_LOCAL_AI_RUNTIME,
  local: { enabled: true, baseUrl: '' },
  nova: { enabled: true, baseUrl: '', folder: '', autoStart: false },
};

const CLOUD: CloudProviderConfig = {
  id: 'cloud-abc',
  kind: 'openai-compatible',
  label: 'My cloud',
  model: 'gpt-x',
  baseUrl: 'https://api.example.com/v1',
  enabled: true,
};

function registry() {
  return buildIntelligence({ localAi: ON, activeProviderId: null, cloudProviders: [CLOUD] }).registry;
}

beforeEach(() => {
  invoke.mockReset();
});

describe('before anything is asked', () => {
  test('a catalogue model is only known to converse; the rest is unknown', () => {
    const p = registry().get(LOCAL_MODEL_PROFILES[0]!.id)!;
    const caps = p.capabilities!();
    expect(caps.conversation).toBe('yes');
    expect(supports(caps, 'toolCalling')).toBe(false);
    expect(supports(caps, 'structuredOutput')).toBe(false);
    expect(supports(caps, 'vision')).toBe(false);
    expect(caps.source).toBe('declared');
  });

  test('describing a model costs no request', () => {
    const p = registry().get(LOCAL_MODEL_PROFILES[0]!.id)!;
    p.capabilities!();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('a cloud provider converses and nothing else is assumed', () => {
    const caps = registry().get('cloud-abc')!.capabilities!();
    expect(canConverse(caps)).toBe(true);
    for (const f of ['toolCalling', 'structuredOutput', 'longContext', 'vision', 'coding'] as const) {
      expect(supports(caps, f), f).toBe(false);
    }
  });

  test('Nova Intelligence is never a conversation partner', () => {
    const caps = registry().get(NOVA_INTELLIGENCE_PROVIDER_ID)!.capabilities!();
    expect(canConverse(caps)).toBe(false);
  });
});

describe('after the server answers', () => {
  const profile = LOCAL_MODEL_PROFILES[0]!;

  test('a reported tool-capable, long-context model is described as such', async () => {
    invoke.mockResolvedValue({
      contextLength: 40960,
      billions: 8,
      capabilities: ['completion', 'tools', 'thinking'],
    });
    const p = registry().get(profile.id)!;
    const caps = await p.refreshCapabilities!();
    expect(invoke).toHaveBeenCalledWith('local_model_info', expect.objectContaining({ model: profile.ollamaTag }));
    expect(supports(caps, 'toolCalling')).toBe(true);
    expect(supports(caps, 'longContext')).toBe(true);
    expect(supports(caps, 'vision')).toBe(false);
    expect(caps.source).toBe('reported');
    // The sync accessor now returns the same descriptor.
    expect(p.capabilities!()).toEqual(caps);
  });

  test('an older server with no capability list leaves tool calling unknown', async () => {
    invoke.mockResolvedValue({ contextLength: 8192, billions: 7 });
    const caps = await registry().get(profile.id)!.refreshCapabilities!();
    expect(caps.toolCalling).toBe('unknown');
    expect(supports(caps, 'toolCalling')).toBe(false);
  });

  test('an unreachable server keeps what was declared and never throws', async () => {
    const p = registry().get(profile.id)!;
    invoke.mockRejectedValue(new Error('offline'));
    const caps = await p.refreshCapabilities!();
    expect(caps.conversation).toBe('yes');
    expect(caps.toolCalling).toBe('unknown');
  });

  test('one lookup serves both capacity and capabilities', async () => {
    invoke.mockResolvedValue({ contextLength: 40960, billions: 8, capabilities: ['completion'] });
    const p = registry().get(profile.id)!;
    await p.capacity!();
    await p.refreshCapabilities!();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
