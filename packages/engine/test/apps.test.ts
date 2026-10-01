/**
 * Installing, removing and updating apps with winget — resolved to an exact
 * package first, never guessed.
 */

import { assert, test } from 'vitest';
import type { Platform, WingetPackage } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createAppsSkills, resolvePackage } from '../src/skills/apps-skills';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}
const plan = (text: string) =>
  grammar()
    .parse(text)
    ?.steps.map((s) => [s.skill, s.args]);

test('install, uninstall, update, and what has updates', () => {
  assert.deepEqual(plan('install spotify'), [['apps.install', { name: 'spotify' }]]);
  assert.deepEqual(plan('uninstall vlc'), [['apps.uninstall', { name: 'vlc' }]]);
  assert.deepEqual(plan('update vlc'), [['apps.update', { name: 'vlc' }]]);
  assert.deepEqual(plan('install the vlc app'), [['apps.install', { name: 'vlc' }]]);
  assert.deepEqual(plan('which apps need updates'), [['apps.updates', {}]]);
});

test('words that mean something else are left alone', () => {
  assert.deepEqual(plan('update windows'), [['system.settingsPage', { page: 'windows-update' }]]);
  assert.equal(grammar().parse('update atlas'), null);
  assert.equal(grammar().parse('install updates'), null);
  // developer phrasings keep their own rules
  assert.equal(grammar().parse('install express in this project'), null);
  assert.notEqual(grammar().parse('install pytest as a dev dependency')?.steps[0]?.skill, 'apps.install');
});

const SPOTIFY: WingetPackage = { name: 'Spotify', id: 'Spotify.Spotify', version: '1.2' };
const TOOLKIT: WingetPackage = { name: 'Spotify Toolkit', id: 'Some.SpotifyToolkit', version: '0.9' };

function machine(results: WingetPackage[], over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const platform = {
    wingetSearch: async (q: string) => {
      calls.push(`search ${q}`);
      if (over.noWinget) throw 'winget isn\'t installed on this PC';
      return results;
    },
    wingetInstall: async (id: string) => {
      calls.push(`install ${id}`);
      return 'Successfully installed';
    },
    wingetUninstall: async (id: string) => {
      calls.push(`uninstall ${id}`);
      return 'Successfully uninstalled';
    },
    wingetUpgrade: async (id: string) => {
      calls.push(`upgrade ${id}`);
      if (over.upgradeFails) throw new Error('winget couldn\'t update it.\nNo applicable upgrade found.');
      return 'ok';
    },
    wingetUpgrades: async () => results,
  } as unknown as Platform;
  const skills = Object.fromEntries(createAppsSkills(platform).map((s) => [s.id, s]));
  const run = (id: string, args: Record<string, unknown>) =>
    skills[id]!.run(args, { showResults: () => {} } as never) as Promise<{ ok: boolean; message?: string; error?: string }>;
  return { calls, run, skills, platform };
}

test('an exact name, or a single result, resolves; two possibilities do not', async () => {
  const exact = machine([SPOTIFY, TOOLKIT]);
  assert.deepEqual(await resolvePackage(exact.platform, 'spotify'), { ok: true, id: 'Spotify.Spotify', name: 'Spotify' });
  const single = machine([TOOLKIT]);
  assert.equal((await resolvePackage(single.platform, 'toolkit')).ok, true);
  const two = machine([SPOTIFY, { ...TOOLKIT, name: 'Spotify Helper' }, { name: 'Spotify Lite', id: 'Other.Lite', version: '1' }]);
  const amb = await resolvePackage(two.platform, 'spot');
  assert.equal(amb.ok, false);
  assert.match(!amb.ok ? amb.error : '', /more than one app/);
});

test('a store id does not beat a publisher id, but real ambiguity is still reported', async () => {
  const store = { name: 'VLC', id: 'XPDM1ZW6815MQM', version: '3' };
  const vlc = { name: 'VLC media player', id: 'VideoLAN.VLC', version: '3.0' };
  const other = { name: 'Jellyfin VLC Bridge', id: 'CrySer66.JellyfinVlcBridge', version: '1' };
  assert.deepEqual(await resolvePackage(machine([store, vlc, other]).platform, 'vlc'), { ok: true, id: 'VideoLAN.VLC', name: 'VLC media player' });
  const nightly = { name: 'VLC Nightly', id: 'VideoLAN.VLC.Nightly', version: '4' };
  const beta = { name: 'VLC Beta', id: 'VideoLAN.VLC.Beta', version: '4' };
  assert.equal((await resolvePackage(machine([store, nightly, beta]).platform, 'vlc')).ok, false);
});

test('an id is used as it is, without a search', async () => {
  const m = machine([]);
  const r = await m.run('apps.install', { name: 'Spotify.Spotify' });
  assert.equal(r.ok, true);
  assert.deepEqual(m.calls, ['install Spotify.Spotify']);
});

test('an ambiguous name installs nothing', async () => {
  const m = machine([SPOTIFY, TOOLKIT, { name: 'Spotify Lite', id: 'Other.Lite', version: '1' }]);
  const r = await m.run('apps.install', { name: 'spot' });
  assert.equal(r.ok, false);
  assert.deepEqual(m.calls, ['search spot']);
});

test('no winget is said plainly, and nothing else is attempted', async () => {
  const m = machine([], { noWinget: true });
  const r = await m.run('apps.install', { name: 'spotify' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /winget isn't installed/);
  assert.deepEqual(m.calls, ['search spotify']);
});

test('the three that change something ask first, and say what', () => {
  const { skills } = machine([]);
  for (const id of ['apps.install', 'apps.uninstall', 'apps.update']) assert.equal(skills[id]!.risk, 'confirm', id);
  assert.equal(skills['apps.updates']!.risk, 'safe');
  assert.equal(skills['apps.install']!.confirmAs?.({ name: 'spotify' }), 'install spotify using winget');
  assert.equal(skills['apps.uninstall']!.confirmAs?.({ name: 'vlc' }), 'uninstall vlc');
});

test('a failed update shows why', async () => {
  const r = await machine([SPOTIFY], { upgradeFails: true }).run('apps.update', { name: 'spotify' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /No applicable upgrade/);
});
