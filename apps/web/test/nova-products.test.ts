/**
 * The product switcher must know an app from a website.
 *
 *   · a website opens in the default browser;
 *   · an app is launched in the background by id, from what is installed;
 *   · an app that is not installed goes to its own download page when it has one, and to the
 *     Nova home page when it doesn't; nobody is ever sent to a guessed address.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Platform } from '@atlas/core';

import { NOVA_HOME_URL, openNovaProduct, type NovaLaunchable } from '../src/components/novaProducts';

function fakePlatform(over: Partial<Platform> = {}) {
  const openUrl = vi.fn(async () => true);
  const launchApp = vi.fn(async () => true);
  const listApps = vi.fn(async () => [
    { id: 'calculator', name: 'Calculator', target: 'x' },
    { id: 'replaygg', name: 'Replay.gg', target: 'y' },
  ]);
  const platform = { openUrl, launchApp, listApps, ...over } as unknown as Platform;
  return { platform, openUrl, launchApp, listApps };
}

const site: NovaLaunchable = { id: 's', label: 'Some Site', kind: 'site', url: 'https://example.test/' };
const replay: NovaLaunchable = { id: 'replay-gg', label: 'Replay.gg', kind: 'app', appIds: ['replaygg'] };
const novaCut: NovaLaunchable = { id: 'nova-cut', label: 'Nova Cut', kind: 'app', appIds: ['novacut'] };
const withPage: NovaLaunchable = {
  id: 'p',
  label: 'Paged',
  kind: 'app',
  appIds: ['paged'],
  getUrl: 'https://example.test/get',
};

describe('openNovaProduct', () => {
  it('opens a website in the default browser and launches nothing', async () => {
    const { platform, openUrl, launchApp } = fakePlatform();
    expect(await openNovaProduct(platform, site)).toEqual({ ok: true });
    expect(openUrl).toHaveBeenCalledWith('https://example.test/');
    expect(launchApp).not.toHaveBeenCalled();
  });

  it('launches an installed app by its id and opens no browser', async () => {
    const { platform, openUrl, launchApp } = fakePlatform();
    expect(await openNovaProduct(platform, replay)).toEqual({ ok: true });
    expect(launchApp).toHaveBeenCalledWith('replaygg');
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('sends an app with no download page of its own to the Nova home page', async () => {
    const { platform, openUrl, launchApp } = fakePlatform();
    expect(await openNovaProduct(platform, novaCut)).toEqual({ ok: true });
    expect(launchApp).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith(NOVA_HOME_URL);
    expect(NOVA_HOME_URL).toBe('https://nova-780.pages.dev/');
  });

  it('sends a not-installed app to its page when it has one', async () => {
    const { platform, openUrl } = fakePlatform();
    expect(await openNovaProduct(platform, withPage)).toEqual({ ok: true });
    expect(openUrl).toHaveBeenCalledWith('https://example.test/get');
  });

  it('falls back to the page when launching fails', async () => {
    const { platform, openUrl } = fakePlatform({
      launchApp: vi.fn(async () => false),
      listApps: vi.fn(async () => [{ id: 'paged', name: 'Paged', target: 'z' }]),
    } as Partial<Platform>);
    expect(await openNovaProduct(platform, withPage)).toEqual({ ok: true });
    expect(openUrl).toHaveBeenCalledWith('https://example.test/get');
  });

  it('where apps cannot be listed (a plain browser), uses the page or reports it', async () => {
    const { platform, openUrl } = fakePlatform({ listApps: undefined, launchApp: undefined } as Partial<Platform>);
    expect(await openNovaProduct(platform, withPage)).toEqual({ ok: true });
    expect(openUrl).toHaveBeenCalledWith('https://example.test/get');
    await openNovaProduct(platform, replay);
    expect(openUrl).toHaveBeenLastCalledWith(NOVA_HOME_URL);
  });

  it('never opens a coming-soon product', async () => {
    const { platform, openUrl, launchApp } = fakePlatform();
    const r = await openNovaProduct(platform, { id: 'g', label: 'Nova Games', kind: 'soon' });
    expect(r.ok).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
    expect(launchApp).not.toHaveBeenCalled();
  });
});
