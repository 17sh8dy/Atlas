/**
 * Wallpaper, mouse speed, file extensions and hidden files, Explorer, Do Not
 * Disturb, Wi-Fi and Bluetooth, and what is playing: understood, and honest.
 */

import { assert, test } from 'vitest';
import type { FileEntry, NowPlaying, Platform, RadioInfo } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createSettingsSkills } from '../src/skills/settings-skills';

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

// ---- understanding ---------------------------------------------------------------------

test('wallpaper', () => {
  assert.deepEqual(plan('set my wallpaper to sunset.jpg in pictures'), [['system.wallpaper', { target: 'sunset.jpg in pictures' }]]);
  assert.deepEqual(plan('use beach.png as my wallpaper'), [['system.wallpaper', { target: 'beach.png' }]]);
  assert.deepEqual(plan('make mountains.jpg my background'), [['system.wallpaper', { target: 'mountains.jpg' }]]);
});

test('mouse speed', () => {
  assert.deepEqual(plan('set the mouse speed to 12'), [['system.mouseSpeed', { speed: 12 }]]);
  assert.deepEqual(plan('make the mouse faster'), [['system.mouseSpeed', { direction: 'faster' }]]);
  assert.deepEqual(plan('what is the mouse speed'), [['system.mouseSpeed', {}]]);
});

test('file extensions and hidden files are an Explorer setting, not a file called "hidden files"', () => {
  assert.deepEqual(plan('show file extensions'), [['system.explorerOption', { which: 'file-extensions', show: true }]]);
  assert.deepEqual(plan('hide file extensions'), [['system.explorerOption', { which: 'file-extensions', show: false }]]);
  assert.deepEqual(plan('show hidden files'), [['system.explorerOption', { which: 'hidden-files', show: true }]]);
  assert.deepEqual(plan('hide hidden files'), [['system.explorerOption', { which: 'hidden-files', show: false }]]);
  // and hiding one real file is still the file skill
  assert.equal(grammar().parse('hide secret.txt')?.steps[0]?.skill, 'files.attributes');
});

test('restart explorer, do not disturb', () => {
  assert.deepEqual(plan('restart explorer'), [['system.restartExplorer', {}]]);
  assert.deepEqual(plan('restart the taskbar'), [['system.restartExplorer', {}]]);
  assert.deepEqual(plan('turn on do not disturb'), [['system.doNotDisturb', { on: true }]]);
  assert.deepEqual(plan('turn off do not disturb'), [['system.doNotDisturb', { on: false }]]);
  assert.deepEqual(plan('silence notifications'), [['system.doNotDisturb', { on: true }]]);
});

test('radios — and airplane mode is the radios going OFF', () => {
  assert.deepEqual(plan('turn off bluetooth'), [['system.radio', { kind: 'bluetooth', state: 'off' }]]);
  assert.deepEqual(plan('turn on wifi'), [['system.radio', { kind: 'wifi', state: 'on' }]]);
  assert.deepEqual(plan('enable airplane mode'), [['system.radio', { kind: 'airplane', state: 'off' }]]);
  assert.deepEqual(plan('turn off airplane mode'), [['system.radio', { kind: 'airplane', state: 'on' }]]);
  assert.deepEqual(plan('is bluetooth on'), [['system.radio', { kind: 'bluetooth', state: 'status' }]]);
});

test('what is playing, and shuffle', () => {
  assert.deepEqual(plan("what's playing"), [['media.nowPlaying', {}]]);
  assert.deepEqual(plan('what song is this'), [['media.nowPlaying', {}]]);
  assert.deepEqual(plan('turn on shuffle'), [['media.shuffle', { on: true }]]);
  assert.deepEqual(plan('shuffle off'), [['media.shuffle', { on: false }]]);
  // the transport keys are unchanged
  assert.equal(grammar().parse('pause the music')?.steps[0]?.skill, 'media.control');
});

// ---- behaviour ---------------------------------------------------------------------------

function machine(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  let speed = 10;
  const radios: RadioInfo[] = [
    { kind: 'wifi', name: 'Wi-Fi', on: true },
    { kind: 'bluetooth', name: 'Bluetooth', on: true },
  ];
  const platform = {
    mouseSpeed: async () => speed,
    setMouseSpeed: async (n: number) => {
      calls.push(`mouse ${n}`);
      speed = n;
      return speed;
    },
    explorerOptions: async () => ({ fileExtensions: false, hiddenFiles: false }),
    setExplorerOption: async (w: string, show: boolean) => {
      calls.push(`explorer ${w} ${show}`);
      return { fileExtensions: w === 'file-extensions' && show, hiddenFiles: w === 'hidden-files' && show };
    },
    restartExplorer: async () => {
      calls.push('restartExplorer');
      return 1;
    },
    doNotDisturb: async () => false,
    setDoNotDisturb: async (on: boolean) => {
      calls.push(`dnd ${on}`);
      return on;
    },
    radios: async () => radios,
    setRadio: async (k: string, on: boolean) => {
      calls.push(`radio ${k} ${on}`);
      if (k === 'bluetooth' && over.noBluetooth) throw new Error('This PC has no Bluetooth radio.');
      return radios;
    },
    nowPlaying: async (): Promise<NowPlaying | null> => (over.nothing ? null : { title: 'Song', artist: 'Band', album: '', status: 'playing', app: 'Spotify.exe', shuffle: false }),
    setShuffle: async (on: boolean) => {
      calls.push(`shuffle ${on}`);
      return true;
    },
    setWallpaper: async (p: string) => {
      calls.push(`wallpaper ${p}`);
      return true;
    },
    knownFolder: async () => 'C:\\U\\Pictures',
    listDir: async () => [{ path: 'C:\\U\\Pictures\\sunset.jpg', name: 'sunset.jpg', ext: 'jpg', isDirectory: false }] as FileEntry[],
  } as unknown as Platform;
  const skills = Object.fromEntries(createSettingsSkills(platform).map((s) => [s.id, s]));
  const run = (id: string, args: Record<string, unknown>) =>
    skills[id]!.run(args, {} as never) as Promise<{ ok: boolean; message?: string; error?: string }>;
  return { calls, run, skills };
}

test('wallpaper resolves the words, and refuses anything that is not a picture', async () => {
  const m = machine();
  const ok = await m.run('system.wallpaper', { target: 'sunset.jpg in pictures' });
  assert.equal(ok.ok, true);
  assert.deepEqual(m.calls, ['wallpaper C:\\U\\Pictures\\sunset.jpg']);
  const bad = await m.run('system.wallpaper', { target: 'D:\\notes.txt' });
  assert.equal(bad.ok, false);
  assert.equal(m.calls.length, 1, 'nothing was sent for the text file');
});

test('mouse speed: exact, nudged, bounded, readable', async () => {
  const m = machine();
  assert.match(String((await m.run('system.mouseSpeed', {})).message), /10 of 20/);
  await m.run('system.mouseSpeed', { direction: 'faster' });
  assert.deepEqual(m.calls, ['mouse 12']);
  assert.equal((await m.run('system.mouseSpeed', { speed: 40 })).ok, false);
  assert.equal(m.calls.length, 1);
  await m.run('system.mouseSpeed', { speed: 5 });
  assert.equal(m.calls.at(-1), 'mouse 5');
});

test('Explorer options say what changed and how to see it', async () => {
  const m = machine();
  const r = await m.run('system.explorerOption', { which: 'file-extensions', show: true });
  assert.match(String(r.message), /Showing file extensions.*F5/);
  assert.deepEqual(m.calls, ['explorer file-extensions true']);
});

test('only what takes something away asks: Wi-Fi/Bluetooth off, restarting Explorer', () => {
  const { skills } = machine();
  const radio = skills['system.radio']!;
  assert.equal(radio.riskFor?.({ kind: 'wifi', state: 'on' }), 'safe');
  assert.equal(radio.riskFor?.({ kind: 'wifi', state: 'status' }), 'safe');
  assert.equal(radio.riskFor?.({ kind: 'wifi', state: 'off' }), undefined, 'falls back to confirm');
  assert.equal(radio.risk, 'confirm');
  assert.equal(skills['system.restartExplorer']!.risk, 'confirm');
  for (const id of ['system.wallpaper', 'system.mouseSpeed', 'system.explorerOption', 'system.doNotDisturb', 'media.nowPlaying', 'media.shuffle']) {
    assert.equal(skills[id]!.risk, 'safe', id);
  }
});

test('airplane mode turns both off, and one missing radio does not hide the other', async () => {
  const m = machine({ noBluetooth: true });
  const r = await m.run('system.radio', { kind: 'airplane', state: 'off' });
  assert.equal(r.ok, true);
  assert.deepEqual(m.calls, ['radio wifi false', 'radio bluetooth false']);
  assert.match(String(r.message), /Wi-Fi off/);
  assert.match(String(r.message), /no Bluetooth radio/);
});

test('radio status reads, and a PC without one says so', async () => {
  const m = machine();
  const r = await m.run('system.radio', { kind: 'bluetooth', state: 'status' });
  assert.match(String(r.message), /Bluetooth is on/);
  assert.equal(m.calls.length, 0);
});

test("what's playing", async () => {
  assert.match(String((await machine().run('media.nowPlaying', {})).message), /Playing: Song — Band \(Spotify\)/);
  assert.match(String((await machine({ nothing: true }).run('media.nowPlaying', {})).message), /Nothing is playing/);
});

test('Do Not Disturb and shuffle', async () => {
  const m = machine();
  assert.match(String((await m.run('system.doNotDisturb', { on: true })).message), /Do Not Disturb is on/);
  await m.run('media.shuffle', { on: true });
  assert.deepEqual(m.calls, ['dnd true', 'shuffle true']);
});
