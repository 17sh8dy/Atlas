/**
 * Switching Nova Intelligence on is enough: Atlas finds it and starts it, and
 * when it can't, says which thing is missing.
 *
 * Stands where the request leaves the webview (`invoke`, mocked) and checks the
 * commands that actually go out — including that nothing is started when
 * something is already answering.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import { ensureNovaIntelligence, explainEnsure } from '../src/atlas/novaLauncher';

interface Machine {
  answering?: boolean;
  folder?: { path: string; hasModel: boolean } | null;
  startResult?: string | Error;
}

function machine(m: Machine) {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'nova_intelligence_reachable') return m.answering ?? false;
    if (command === 'nova_intelligence_locate') return m.folder ?? null;
    if (command === 'nova_intelligence_start') {
      if (m.startResult instanceof Error) throw m.startResult.message;
      return m.startResult ?? 'started';
    }
    throw new Error(`unexpected command ${command}`);
  });
}

const commands = () => invoke.mock.calls.map((c) => c[0] as string);
const SETTINGS = { folder: '', baseUrl: '' };
const FOUND = { path: 'D:\\Dev\\NovaIntelligence', hasModel: true };

beforeEach(() => {
  // Braces matter: returning the mock would make vitest call it as a teardown.
  invoke.mockReset();
});

describe('ensureNovaIntelligence', () => {
  test('already answering: nothing is looked for and nothing is started', async () => {
    machine({ answering: true, folder: FOUND });
    expect(await ensureNovaIntelligence(SETTINGS)).toEqual({ kind: 'up' });
    expect(commands()).toEqual(['nova_intelligence_reachable']);
  });

  test('not answering, folder found: starts it from that folder', async () => {
    machine({ folder: FOUND });
    expect(await ensureNovaIntelligence(SETTINGS)).toEqual({
      kind: 'started',
      folder: FOUND.path,
    });
    expect(commands()).toEqual([
      'nova_intelligence_reachable',
      'nova_intelligence_locate',
      'nova_intelligence_start',
    ]);
    expect(invoke).toHaveBeenLastCalledWith('nova_intelligence_start', {
      folder: FOUND.path,
      baseUrl: 'http://127.0.0.1:8766',
    });
  });

  test('the folder the person chose is what gets looked for first', async () => {
    machine({ folder: FOUND });
    await ensureNovaIntelligence({ folder: 'E:\\Mine\\Nova', baseUrl: '' });
    expect(invoke).toHaveBeenCalledWith('nova_intelligence_locate', { hint: 'E:\\Mine\\Nova' });
  });

  test('a custom port is passed through, not replaced with the default', async () => {
    machine({ folder: FOUND });
    await ensureNovaIntelligence({ folder: '', baseUrl: 'http://127.0.0.1:9100' });
    expect(invoke).toHaveBeenLastCalledWith('nova_intelligence_start', {
      folder: FOUND.path,
      baseUrl: 'http://127.0.0.1:9100',
    });
  });

  test('no folder anywhere: says so, and starts nothing', async () => {
    machine({ folder: null });
    const result = await ensureNovaIntelligence(SETTINGS);
    expect(result).toEqual({ kind: 'not-found' });
    expect(commands()).not.toContain('nova_intelligence_start');
    // Plain about why: it is not part of the download.
    expect(explainEnsure(result)).toMatch(/isn’t part of the Atlas download/);
  });

  test('a folder without its trained model is not started', async () => {
    machine({ folder: { path: FOUND.path, hasModel: false } });
    const result = await ensureNovaIntelligence(SETTINGS);
    expect(result.kind).toBe('no-model');
    expect(commands()).not.toContain('nova_intelligence_start');
    expect(explainEnsure(result)).toMatch(/model is missing/);
  });

  test('a refusal from the native side is passed on in its own words', async () => {
    machine({
      folder: FOUND,
      startResult: new Error('Couldn’t start Nova Intelligence: access denied'),
    });
    const result = await ensureNovaIntelligence(SETTINGS);
    expect(result).toEqual({
      kind: 'error',
      message: 'Couldn’t start Nova Intelligence: access denied',
    });
  });

  test('something already answering on the port counts as up, not as a second start', async () => {
    machine({ folder: FOUND, startResult: 'already-running' });
    expect(await ensureNovaIntelligence(SETTINGS)).toEqual({ kind: 'up' });
  });

  test('the web build (no native side) is simply "not found"', async () => {
    invoke.mockRejectedValue(new Error('not tauri'));
    expect(await ensureNovaIntelligence(SETTINGS)).toEqual({ kind: 'not-found' });
  });
});
