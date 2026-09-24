/**
 * Changing a voice must not wait for Ollama.
 *
 * Every settings change re-reads all settings together, and one of the reads is
 * "what does Ollama have installed?" — a network call that, with Ollama not
 * running, takes Windows two to four seconds to fail. So a click on the Voice
 * tab took that long to show. A change that cannot alter what Ollama has passes
 * the last answer in (`known`) and must not ask again; a change that can
 * (switching local models on, changing the address) still must.
 *
 * Stands where the request leaves the webview — `invoke`, mocked — and counts
 * what is sent to it.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import type { Storage } from '@atlas/core';
import { writeLocalModelsEnabled } from '@atlas/data';
import { loadLocalAiRuntime } from '../src/atlas/buildIntelligence';

function memoryStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => void data.set(key, value),
    remove: async (key: string) => void data.delete(key),
  };
}

const probes = () => invoke.mock.calls.filter(([cmd]) => cmd === 'local_models_installed').length;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'local_models_installed') return [{ name: 'qwen3:8b' }];
    return undefined;
  });
});

describe('loadLocalAiRuntime', () => {
  test('asks Ollama what it has when local models are on', async () => {
    const storage = memoryStorage();
    await writeLocalModelsEnabled(storage, true);
    const runtime = await loadLocalAiRuntime(storage);
    expect(probes()).toBe(1);
    expect(runtime.installed).toEqual(['qwen3:8b']);
  });

  test('does NOT ask again when handed the last answer — that ask is the slow part', async () => {
    const storage = memoryStorage();
    await writeLocalModelsEnabled(storage, true);
    const runtime = await loadLocalAiRuntime(storage, ['gpt-oss:20b']);
    expect(probes()).toBe(0);
    expect(runtime.installed).toEqual(['gpt-oss:20b']);
    // Everything else is still read fresh.
    expect(runtime.local.enabled).toBe(true);
  });

  test('an empty last answer (Ollama was not running) is reused too, not re-probed', async () => {
    const storage = memoryStorage();
    await writeLocalModelsEnabled(storage, true);
    const runtime = await loadLocalAiRuntime(storage, []);
    expect(probes()).toBe(0);
    expect(runtime.installed).toEqual([]);
  });

  test('never probes while local models are off, as before', async () => {
    const runtime = await loadLocalAiRuntime(memoryStorage());
    expect(probes()).toBe(0);
    expect(runtime.installed).toEqual([]);
  });
});
