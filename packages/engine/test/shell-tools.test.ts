/**
 * Brightness, per-app volume, the power plan, projection, the Recycle Bin,
 * startup apps, Settings pages, printers, a speed test, holding a key.
 */

import { assert, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createShellSkills, SETTINGS_PAGES } from '../src/skills/shell-skills';

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

// ---- understanding -----------------------------------------------------------------------

test('brightness', () => {
  assert.deepEqual(plan('set the brightness to 60'), [['system.brightness', { level: 60 }]]);
  assert.deepEqual(plan('make the screen dimmer'), [['system.brightness', { direction: 'dimmer' }]]);
  assert.deepEqual(plan('brighten the screen'), [['system.brightness', { direction: 'brighter' }]]);
  assert.deepEqual(plan('what is the brightness'), [['system.brightness', {}]]);
});

test("an app's volume is not the main volume, the mic, or the sound", () => {
  assert.deepEqual(plan('set spotify volume to 30'), [['system.appVolume', { app: 'spotify', level: 30 }]]);
  assert.deepEqual(plan('mute chrome'), [['system.appVolume', { app: 'chrome', state: 'mute' }]]);
  assert.deepEqual(plan('which apps are playing sound'), [['system.appVolume', {}]]);
  assert.deepEqual(plan('mute'), [['system.mute', { state: 'mute' }]]);
  assert.deepEqual(plan('mute the sound'), [['system.mute', { state: 'mute' }]]);
  assert.deepEqual(plan('mute my mic'), [['system.micMute', { state: 'mute' }]]);
  assert.deepEqual(plan('set the volume to 30'), [['system.volumeSet', { level: 30 }]]);
});

test('power plan and projection', () => {
  assert.deepEqual(plan('switch to high performance'), [['system.powerPlan', { plan: 'high-performance' }]]);
  assert.deepEqual(plan('switch to power saver'), [['system.powerPlan', { plan: 'power-saver' }]]);
  assert.deepEqual(plan('which power plan am i on'), [['system.powerPlan', {}]]);
  assert.deepEqual(plan('extend my screens'), [['system.projectDisplay', { mode: 'extend' }]]);
  assert.deepEqual(plan('duplicate my screen'), [['system.projectDisplay', { mode: 'duplicate' }]]);
  assert.deepEqual(plan('second screen only'), [['system.projectDisplay', { mode: 'second-only' }]]);
});

test('the Recycle Bin: look, restore, and not a window', () => {
  assert.deepEqual(plan("what's in the recycle bin"), [['files.recycleBin', {}]]);
  assert.deepEqual(plan('restore notes.txt from the recycle bin'), [['files.restore', { name: 'notes.txt' }]]);
  assert.deepEqual(plan('undelete budget.xlsx'), [['files.restore', { name: 'budget.xlsx' }]]);
  assert.equal(grammar().parse('restore notepad')?.steps[0]?.skill, 'window.restore');
  assert.equal(grammar().parse('empty the recycle bin')?.steps[0]?.skill, 'system.emptyRecycleBin');
});

test('startup apps', () => {
  assert.deepEqual(plan('what apps start with windows'), [['system.startupApps', {}]]);
  assert.deepEqual(plan('stop discord starting with windows'), [['system.startupApps', { name: 'discord', enabled: false }]]);
  assert.deepEqual(plan('let discord start with windows'), [['system.startupApps', { name: 'discord', enabled: true }]]);
});

test('what only the person can change on Windows goes to the right Settings page', () => {
  assert.deepEqual(plan('change my default browser'), [['system.settingsPage', { page: 'default-apps' }]]);
  assert.deepEqual(plan('turn on night light'), [['system.settingsPage', { page: 'night-light' }]]);
  assert.deepEqual(plan('set the time zone'), [['system.settingsPage', { page: 'time-language' }]]);
  assert.deepEqual(plan('open the display settings'), [['system.settingsPage', { page: 'display' }]]);
  assert.deepEqual(plan('pin chrome to the taskbar'), [['system.settingsPage', { page: 'taskbar' }]]);
  // but things with a skill of their own are not sent to Settings
  assert.equal(grammar().parse('turn off wifi')?.steps[0]?.skill, 'system.radio');
});

test('printers, printing, speed test, holding a key', () => {
  assert.deepEqual(plan('what printers do i have'), [['system.printers', {}]]);
  assert.deepEqual(plan('set my default printer to brother'), [['system.printers', { name: 'brother' }]]);
  assert.deepEqual(plan('print report.pdf in documents'), [['files.print', { target: 'report.pdf in documents' }]]);
  assert.equal(grammar().parse('print hello'), null, 'only something file-shaped is printed');
  assert.deepEqual(plan('run a speed test'), [['net.speedTest', {}]]);
  assert.deepEqual(plan('hold w for 3 seconds'), [['input.holdKey', { key: 'w', seconds: 3 }]]);
});

// ---- behaviour ------------------------------------------------------------------------------

function machine(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let level = 80;
  const platform = {
    brightnessGet: async () => {
      if (over.noDdc) throw new Error('None of your displays lets Windows change its brightness.');
      return { level, monitors: 2 };
    },
    brightnessSet: async (n: number) => {
      calls.push(`brightness ${n}`);
      level = n;
      return { level, monitors: 2 };
    },
    appVolumes: async () => (over.silent ? [] : [{ app: 'brave', pid: 1, level: 100, muted: false }, { app: 'brave', pid: 2, level: 100, muted: false }]),
    setAppVolume: async (a: string, l: number | null, m: boolean | null) => {
      calls.push(`app ${a} ${l} ${m}`);
      if (over.silent) throw new Error(`${a} isn't playing any sound right now`);
      return [{ app: 'brave', pid: 1, level: l ?? 100, muted: m ?? false }];
    },
    powerPlan: async () => 'balanced',
    setPowerPlan: async (p: string) => {
      calls.push(`plan ${p}`);
      return p;
    },
    projectDisplay: async (m: string) => {
      calls.push(`project ${m}`);
      return true;
    },
    recycleBinList: async () => [{ name: 'a.txt', original: 'C:\\U\\Documents\\a.txt', sizeBytes: 5, deletedAt: Date.now(), isDir: false }],
    recycleBinRestore: async (n: string) => {
      calls.push(`restore ${n}`);
      if (over.exists) throw new Error('Something with that name is already there, so I haven\'t restored it over it.');
      return { name: n, original: 'C:\\U\\Documents\\' + n, sizeBytes: 5, deletedAt: 0, isDir: false };
    },
    startupApps: async () => [
      { name: 'Discord', command: 'discord.exe', enabled: true, scope: 'user' },
      { name: 'Steam', command: 'steam.exe', enabled: false, scope: 'user' },
    ],
    setStartupApp: async (n: string, e: boolean) => {
      calls.push(`startup ${n} ${e}`);
      return { name: n, command: '', enabled: e, scope: 'user' };
    },
    openSettingsPage: async (p: string) => {
      calls.push(`page ${p}`);
      return true;
    },
    printers: async () => ({ default: 'Brother', names: ['Fax', 'Brother'] }),
    setDefaultPrinter: async (n: string) => {
      calls.push(`printer ${n}`);
      return { default: 'Brother', names: ['Fax', 'Brother'] };
    },
    printFile: async (p: string) => {
      calls.push(`print ${p}`);
      return true;
    },
    speedTest: async () => ({ downloadMbps: 312.4, latencyMs: 14, bytes: 25_000_000 }),
    knownFolder: async () => 'C:\\U\\Documents',
    listDir: async () => [{ path: 'C:\\U\\Documents\\report.pdf', name: 'report.pdf', ext: 'pdf', isDirectory: false }],
  } as unknown as Platform;
  const skills = Object.fromEntries(createShellSkills(platform).map((s) => [s.id, s]));
  const run = (id: string, args: Record<string, unknown> = {}) => {
    const shown: unknown[] = [];
    return skills[id]!.run(args, { showResults: (r: unknown) => shown.push(r) } as never).then((r) => ({ r: r as { ok: boolean; message?: string; error?: string }, shown }));
  };
  return { calls, run, skills };
}

test('brightness: exact, nudged, bounded, readable — and honest when no screen allows it', async () => {
  const m = machine();
  assert.match(String((await m.run('system.brightness')).r.message), /80% \(2 screens\)/);
  await m.run('system.brightness', { direction: 'dimmer' });
  assert.equal(m.calls.at(-1), 'brightness 65');
  assert.equal((await m.run('system.brightness', { level: 0 })).r.ok, false);
  assert.equal((await m.run('system.brightness', { level: 101 })).r.ok, false);
  assert.equal(m.calls.length, 1, 'out of range reaches nothing');
  const none = await machine({ noDdc: true }).run('system.brightness', { level: 50 });
  assert.equal(none.r.ok, false);
  assert.match(String(none.r.error), /lets Windows change its brightness/);
});

test('an app that is not playing sound is said so plainly', async () => {
  const m = machine({ silent: true });
  const r = await m.run('system.appVolume', { app: 'spotify', level: 30 });
  assert.equal(r.r.ok, false);
  assert.match(String(r.r.error), /isn't playing any sound/);
  assert.match(String((await m.run('system.appVolume')).r.message), /No app is playing sound/);
});

test('an app level also unmutes it; mute is exact; the list names each app once', async () => {
  const m = machine();
  await m.run('system.appVolume', { app: 'brave', level: 30 });
  assert.equal(m.calls.at(-1), 'app brave 30 false');
  await m.run('system.appVolume', { app: 'brave', state: 'mute' });
  assert.equal(m.calls.at(-1), 'app brave null true');
  const list = await m.run('system.appVolume');
  assert.equal(String(list.r.message).match(/brave/g)?.length, 1);
});

test('what asks and what does not', () => {
  const { skills } = machine();
  const proj = skills['system.projectDisplay']!;
  assert.equal(proj.riskFor?.({ mode: 'extend' }), 'safe');
  assert.equal(proj.riskFor?.({ mode: 'duplicate' }), 'safe');
  assert.equal(proj.riskFor?.({ mode: 'second-only' }), undefined);
  assert.equal(proj.risk, 'confirm');
  const startup = skills['system.startupApps']!;
  assert.equal(startup.riskFor?.({}), 'safe');
  assert.equal(startup.riskFor?.({ name: 'Discord', enabled: false }), undefined);
  assert.equal(skills['files.print']!.risk, 'confirm');
  for (const id of ['system.brightness', 'system.appVolume', 'system.powerPlan', 'files.restore', 'files.recycleBin', 'system.settingsPage', 'system.printers', 'net.speedTest']) {
    assert.equal(skills[id]!.risk, 'safe', id);
  }
  // the cards say what will happen
  assert.equal(startup.confirmAs?.({ name: 'Discord', enabled: false }), 'stop Discord starting with Windows');
  assert.equal(skills['files.print']!.confirmAs?.({ target: 'report.pdf in documents' }), 'print report.pdf in documents on your default printer');
});

test('restore says where it went, and never overwrites', async () => {
  const ok = await machine().run('files.restore', { name: 'a.txt' });
  assert.match(String(ok.r.message), /Restored a\.txt to C:\\U\\Documents/);
  const clash = await machine({ exists: true }).run('files.restore', { name: 'a.txt' });
  assert.equal(clash.r.ok, false);
  assert.match(String(clash.r.error), /already there/);
});

test('the Recycle Bin and startup lists give a button for each row', async () => {
  const bin = await machine().run('files.recycleBin');
  assert.equal(bin.shown.length, 1);
  const startup = await machine().run('system.startupApps');
  assert.match(String(startup.r.message), /1 of 2 startup apps are on/);
});

test('startup: turning one off goes through, and says so', async () => {
  const m = machine();
  const r = await m.run('system.startupApps', { name: 'Discord', enabled: false });
  assert.match(String(r.r.message), /Discord won't start with Windows/);
  assert.deepEqual(m.calls, ['startup Discord false']);
});

test('Settings pages say why Atlas opened one instead of doing it', async () => {
  const m = machine();
  const r = await m.run('system.settingsPage', { page: 'default-apps' });
  assert.match(String(r.r.message), /only lets you pick the default browser yourself/);
  assert.deepEqual(m.calls, ['page default-apps']);
  assert.ok(Object.keys(SETTINGS_PAGES).includes('night-light'));
});

test('printing resolves the file, asks the machine once, and the printer list marks the default', async () => {
  const m = machine();
  await m.run('files.print', { target: 'report.pdf in documents' });
  assert.deepEqual(m.calls, ['print C:\\U\\Documents\\report.pdf']);
  assert.match(String((await m.run('system.printers')).r.message), /⭐ Brother/);
});

test('speed test reports speed and latency', async () => {
  assert.match(String((await machine().run('net.speedTest')).r.message), /about 312 Mbps, latency 14 ms/);
});
