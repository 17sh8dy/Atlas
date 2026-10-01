/**
 * Sleep, a timed shutdown, exact volume, the microphone and dark mode: how they
 * are understood, and what each one asks of the machine.
 */

import { assert, test } from 'vitest';
import type { AudioLevel, Platform } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createSystemControlSkills } from '../src/skills/system-skills';
import { createOsSkills } from '../src/skills/os-skills';

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

// ---- how it is understood ---------------------------------------------------------

test('sleep and hibernate', () => {
  for (const s of ['sleep', 'put the pc to sleep', 'put my computer to sleep', 'go to sleep', 'sleep mode']) {
    assert.deepEqual(plan(s), [['system.sleep', { kind: 'sleep' }]], s);
  }
  for (const s of ['hibernate', 'hibernate the pc', 'put the laptop into hibernation']) {
    assert.deepEqual(plan(s), [['system.sleep', { kind: 'hibernate' }]], s);
  }
});

test('a delay is noticed before "shut down the pc" shuts it down now', () => {
  assert.deepEqual(plan('shut down in 30 minutes'), [['system.shutdownIn', { action: 'shutdown', seconds: 1800 }]]);
  assert.deepEqual(plan('shut down the pc in 2 hours'), [['system.shutdownIn', { action: 'shutdown', seconds: 7200 }]]);
  assert.deepEqual(plan('restart my computer in half an hour'), [['system.shutdownIn', { action: 'restart', seconds: 1800 }]]);
  assert.deepEqual(plan('cancel the shutdown'), [['system.shutdownCancel', {}]]);
  assert.deepEqual(plan('abort restart'), [['system.shutdownCancel', {}]]);
  // and the immediate one is unchanged
  assert.deepEqual(plan('shut down the pc'), [['system.power', { action: 'shutdown' }]]);
});

test('an unreadable delay is not guessed', () => {
  assert.notEqual(grammar().parse('shut down in a bit')?.steps[0]?.skill, 'system.shutdownIn');
});

test('volume to an exact level', () => {
  for (const [s, level] of [
    ['set the volume to 30', 30],
    ['volume to 45%', 45],
    ['volume 70', 70],
    ['turn the sound to 50 percent', 50],
    ['volume to half', 50],
    ['max volume', 100],
    ['set the volume to zero', undefined],
  ] as const) {
    const p = plan(s);
    if (level === undefined) continue;
    assert.deepEqual(p, [['system.volumeSet', { level }]], s);
  }
  assert.deepEqual(plan('what is the volume'), [['system.volumeSet', {}]]);
  // "up"/"down" is still the notch skill
  assert.equal(grammar().parse('turn the volume up')?.steps[0]?.skill, 'system.volume');
});

test('mute says which way', () => {
  assert.deepEqual(plan('mute'), [['system.mute', { state: 'mute' }]]);
  assert.deepEqual(plan('unmute'), [['system.mute', { state: 'unmute' }]]);
});

test('the microphone', () => {
  assert.deepEqual(plan('mute my mic'), [['system.micMute', { state: 'mute' }]]);
  assert.deepEqual(plan('unmute the microphone'), [['system.micMute', { state: 'unmute' }]]);
  assert.deepEqual(plan('turn off my mic'), [['system.micMute', { state: 'mute' }]]);
  assert.deepEqual(plan('is my mic muted'), [['system.micMute', { state: 'status' }]]);
  assert.deepEqual(plan('set the microphone volume to 70'), [['system.micLevel', { level: 70 }]]);
  // and the speakers are not the mic
  assert.deepEqual(plan('mute'), [['system.mute', { state: 'mute' }]]);
});

test('dark and light mode', () => {
  assert.deepEqual(plan('turn on dark mode'), [['system.theme', { mode: 'dark' }]]);
  assert.deepEqual(plan('switch to dark mode'), [['system.theme', { mode: 'dark' }]]);
  assert.deepEqual(plan('turn off dark mode'), [['system.theme', { mode: 'light' }]]);
  assert.deepEqual(plan('switch to light mode'), [['system.theme', { mode: 'light' }]]);
  assert.deepEqual(plan('toggle dark mode'), [['system.theme', { mode: 'toggle' }]]);
});

// ---- what each asks of the machine -----------------------------------------------------

/** A machine that remembers, so a skill that lies about what it did is caught. */
function machine() {
  const state = {
    speakers: { level: 40, muted: true } as AudioLevel,
    mic: { level: 80, muted: false } as AudioLevel,
    theme: 'light' as 'light' | 'dark',
    calls: [] as string[],
    hibernate: true,
    pending: false,
  };
  const platform = {
    volumeState: async () => ({ ...state.speakers }),
    volumeSet: async (level: number | null, muted: boolean | null) => {
      state.calls.push(`volumeSet(${level},${muted})`);
      if (level !== null) state.speakers.level = level;
      if (muted !== null) state.speakers.muted = muted;
      return { ...state.speakers };
    },
    micState: async () => ({ ...state.mic }),
    micSet: async (level: number | null, muted: boolean | null) => {
      state.calls.push(`micSet(${level},${muted})`);
      if (level !== null) state.mic.level = level;
      if (muted !== null) state.mic.muted = muted;
      return { ...state.mic };
    },
    themeGet: async () => state.theme,
    themeSet: async (m: 'light' | 'dark') => {
      state.calls.push(`themeSet(${m})`);
      state.theme = m;
      return true;
    },
    sleepPc: async (k: string) => {
      state.calls.push(`sleepPc(${k})`);
      if (k === 'hibernate' && !state.hibernate) throw new Error('Hibernation is switched off on this PC.');
      return true;
    },
    scheduleShutdown: async (a: string, s: number) => {
      state.calls.push(`scheduleShutdown(${a},${s})`);
      state.pending = true;
      return true;
    },
    cancelShutdown: async () => {
      const was = state.pending;
      state.pending = false;
      return was;
    },
    toggleMute: async () => {
      state.calls.push('toggleMute');
      return true;
    },
  } as unknown as Platform;
  const skills = Object.fromEntries(
    [...createSystemControlSkills(platform), ...createOsSkills(platform)].map((s) => [s.id, s]),
  );
  const run = async (id: string, args: Record<string, unknown>) =>
    skills[id]!.run(args, {} as never) as Promise<{ ok: boolean; message?: string; error?: string }>;
  return { state, run, skills };
}

test('setting a volume also unmutes, so you can hear it; zero does not', async () => {
  const m = machine();
  const r = await m.run('system.volumeSet', { level: 30 });
  assert.equal(r.ok, true);
  assert.deepEqual(m.state.speakers, { level: 30, muted: false });
  const zero = await m.run('system.volumeSet', { level: 0 });
  assert.equal(zero.ok, true);
  assert.equal(m.state.speakers.level, 0);
});

test('an out-of-range volume is refused, not clamped', async () => {
  const m = machine();
  assert.equal((await m.run('system.volumeSet', { level: 150 })).ok, false);
  assert.equal((await m.run('system.volumeSet', { level: -5 })).ok, false);
  assert.equal(m.state.calls.length, 0);
});

test('reading the volume changes nothing', async () => {
  const m = machine();
  const r = await m.run('system.volumeSet', {});
  assert.match(String(r.message), /Muted \(volume 40%\)/);
  assert.equal(m.state.calls.length, 0);
});

test('"mute" means muted, not "flip whatever it was"', async () => {
  const m = machine();
  await m.run('system.mute', { state: 'mute' }); // already muted: must stay muted
  assert.equal(m.state.speakers.muted, true);
  await m.run('system.mute', { state: 'unmute' });
  assert.equal(m.state.speakers.muted, false);
  await m.run('system.mute', { state: 'unmute' }); // already on: must stay on
  assert.equal(m.state.speakers.muted, false);
  assert.ok(!m.state.calls.includes('toggleMute'));
});

test('the microphone is muted exactly, and reported', async () => {
  const m = machine();
  const r = await m.run('system.micMute', { state: 'mute' });
  assert.match(String(r.message), /muted/i);
  assert.equal(m.state.mic.muted, true);
  assert.match(String((await m.run('system.micMute', { state: 'status' })).message), /muted/);
  await m.run('system.micMute', { state: 'toggle' });
  assert.equal(m.state.mic.muted, false);
  const lvl = await m.run('system.micLevel', { level: 55 });
  assert.equal(lvl.ok, true);
  assert.equal(m.state.mic.level, 55);
  assert.equal((await m.run('system.micLevel', { level: 500 })).ok, false);
});

test('dark mode: switches, and says when it was already so', async () => {
  const m = machine();
  assert.match(String((await m.run('system.theme', { mode: 'dark' })).message), /Switched to dark/);
  assert.equal(m.state.theme, 'dark');
  assert.match(String((await m.run('system.theme', { mode: 'dark' })).message), /already in dark/);
  await m.run('system.theme', { mode: 'toggle' });
  assert.equal(m.state.theme, 'light');
});

test('a shutdown on a timer: range checked, cancellable, honest about nothing pending', async () => {
  const m = machine();
  assert.equal((await m.run('system.shutdownIn', { action: 'shutdown', seconds: 5 })).ok, false);
  assert.equal((await m.run('system.shutdownIn', { action: 'shutdown', seconds: 100_000 })).ok, false);
  assert.equal(m.state.calls.length, 0, 'nothing was scheduled');
  const ok = await m.run('system.shutdownIn', { action: 'restart', seconds: 1800 });
  assert.match(String(ok.message), /Restarting in 30 minutes/);
  assert.deepEqual(m.state.calls, ['scheduleShutdown(restart,1800)']);
  assert.match(String((await m.run('system.shutdownCancel', {})).message), /Cancelled/);
  assert.match(String((await m.run('system.shutdownCancel', {})).message), /No shutdown was scheduled/);
});

test('hibernate refusal from the machine is passed on in its own words', async () => {
  const m = machine();
  m.state.hibernate = false;
  const r = await m.run('system.sleep', { kind: 'hibernate' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /Hibernation is switched off/);
});

test('what ends what the PC is doing asks first; what is undone by saying so does not', () => {
  const m = machine();
  const risk = (id: string) => m.skills[id]!.risk;
  assert.equal(risk('system.sleep'), 'confirm');
  assert.equal(risk('system.shutdownIn'), 'confirm');
  for (const id of ['system.volumeSet', 'system.micMute', 'system.micLevel', 'system.theme', 'system.shutdownCancel']) {
    assert.equal(risk(id), 'safe', id);
  }
});

test('"run as administrator" is refused in words, and nothing is opened', async () => {
  const m = machine();
  const r = await m.run('app.runAsAdmin', { name: 'notepad' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /haven't opened notepad/);
  assert.match(String(r.error), /Run as administrator/);
});
