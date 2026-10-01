/**
 * More of the machine: sleep, a shutdown on a timer, an exact volume, the
 * microphone, and light/dark mode.
 *
 * Same discipline as `os-skills.ts`. Each skill is one named native operation
 * with an enumerated or range-checked argument; nothing here takes a command
 * line. Risk follows consequence, not mechanism: putting the PC to sleep, or
 * scheduling it to shut down, stops whatever it is doing (a download, a
 * recording) and so asks first; turning the volume to 30, muting the mic or
 * switching to dark mode is undone by saying so, and does not.
 */

import type { AudioLevel, Platform, Skill } from '@atlas/core';

/** "in 10 minutes" for a delay given in seconds. */
function describeDelay(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = seconds / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`;
}

const speakerLine = (a: AudioLevel) => (a.muted ? `🔇 Muted (volume ${a.level}%).` : `🔊 Volume ${a.level}%.`);

export function createSystemControlSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'system.sleep',
    confirmAs: (a) => (a.kind === 'hibernate' ? 'hibernate this PC' : 'put this PC to sleep'),
    label: 'Sleep or hibernate',
    icon: '😴',
    domain: 'system',
    description: 'Put the PC to sleep, or hibernate it (save everything to disk and power off).',
    needs: ['os'],
    // Ends whatever the PC is doing — a download, a recording, a sync.
    risk: 'confirm',
    examples: ['put the pc to sleep', 'hibernate'],
    params: {
      kind: { type: 'string', required: true, enum: ['sleep', 'hibernate'], description: 'which' },
    },
    async run(args) {
      const kind = String(args.kind) === 'hibernate' ? 'hibernate' : 'sleep';
      try {
        await platform.sleepPc!(kind);
        return { ok: true, message: kind === 'sleep' ? '😴 Going to sleep…' : '😴 Hibernating…' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  skills.push({
    id: 'system.shutdownIn',
    confirmAs: (a) => `${a.action === 'restart' ? 'restart' : 'shut down'} this PC in ${describeDelay(Number(a.seconds))}`,
    label: 'Shut down or restart later',
    icon: '⏳',
    domain: 'system',
    description:
      'Shut down or restart after a delay (10 seconds to 24 hours). Windows shows its own countdown, and it can be cancelled.',
    needs: ['os'],
    risk: 'confirm',
    examples: ['shut down in 30 minutes', 'restart in an hour'],
    params: {
      action: { type: 'string', required: true, enum: ['shutdown', 'restart'], description: 'which' },
      seconds: { type: 'number', required: true, description: 'how long from now, in seconds' },
    },
    async run(args) {
      const action = String(args.action) === 'restart' ? 'restart' : 'shutdown';
      const seconds = Math.round(Number(args.seconds));
      if (!Number.isFinite(seconds) || seconds < 10 || seconds > 86_400) {
        return { ok: false, error: 'Pick a delay between 10 seconds and 24 hours.' };
      }
      try {
        await platform.scheduleShutdown!(action, seconds);
        return {
          ok: true,
          message: `⏳ ${action === 'restart' ? 'Restarting' : 'Shutting down'} in ${describeDelay(seconds)}. Say "cancel the shutdown" to stop it.`,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  skills.push({
    id: 'system.shutdownCancel',
    label: 'Cancel a scheduled shutdown',
    icon: '🛑',
    domain: 'system',
    description: 'Cancel a shutdown or restart that is counting down — whoever scheduled it.',
    needs: ['os'],
    risk: 'safe',
    examples: ['cancel the shutdown'],
    params: {},
    async run() {
      const cancelled = await platform.cancelShutdown!().catch(() => false);
      return cancelled
        ? { ok: true, message: '🛑 Cancelled — the PC will stay on.' }
        : { ok: true, message: 'No shutdown was scheduled.' };
    },
  });

  skills.push({
    id: 'system.volumeSet',
    label: 'Set the volume',
    icon: '🔊',
    domain: 'system',
    description: 'Set the speaker volume to an exact level (0–100), or say what it is now.',
    needs: ['os'],
    risk: 'safe',
    examples: ['set the volume to 30', 'what is the volume'],
    params: {
      level: { type: 'number', required: false, description: '0–100; leave out to just read it' },
    },
    async run(args) {
      try {
        if (args.level === undefined || args.level === null || args.level === '') {
          return { ok: true, message: speakerLine(await platform.volumeState!()) };
        }
        const level = Math.round(Number(args.level));
        if (!Number.isFinite(level) || level < 0 || level > 100) {
          return { ok: false, error: 'A volume is between 0 and 100.' };
        }
        // Setting a level means hearing it: a muted PC set to 30 is unmuted.
        const before = await platform.volumeState!();
        const now = await platform.volumeSet!(level, level > 0 ? false : null);
        return {
          ok: true,
          message: speakerLine(now),
          data: now,
          undo: { skill: 'system.volumeSet', args: { level: before.level }, label: `volume back to ${before.level}%` },
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  skills.push({
    id: 'system.micMute',
    label: 'Mute or unmute the microphone',
    icon: '🎙️',
    domain: 'system',
    description: 'Mute or unmute the default microphone, or say whether it is muted.',
    needs: ['os'],
    risk: 'safe',
    examples: ['mute my mic', 'unmute the microphone', 'is my mic muted'],
    params: {
      state: {
        type: 'string',
        required: true,
        enum: ['mute', 'unmute', 'toggle', 'status'],
        description: 'what to do',
      },
    },
    async run(args) {
      const state = String(args.state);
      try {
        const now = await platform.micState!();
        if (state === 'status') {
          return { ok: true, message: now.muted ? '🎙️ Your microphone is muted.' : `🎙️ Your microphone is on (level ${now.level}%).` };
        }
        const muted = state === 'toggle' ? !now.muted : state === 'mute';
        const after = await platform.micSet!(null, muted);
        return {
          ok: true,
          message: after.muted ? '🔇 Microphone muted.' : `🎙️ Microphone on (level ${after.level}%).`,
          data: after,
          undo: { skill: 'system.micMute', args: { state: now.muted ? 'mute' : 'unmute' }, label: now.muted ? 'mute the microphone again' : 'unmute the microphone' },
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  skills.push({
    id: 'system.micLevel',
    label: 'Set the microphone level',
    icon: '🎙️',
    domain: 'system',
    description: 'Set the default microphone input level (0–100).',
    needs: ['os'],
    risk: 'safe',
    examples: ['set the microphone volume to 70'],
    params: { level: { type: 'number', required: true, description: '0–100' } },
    async run(args) {
      const level = Math.round(Number(args.level));
      if (!Number.isFinite(level) || level < 0 || level > 100) {
        return { ok: false, error: 'A level is between 0 and 100.' };
      }
      try {
        const after = await platform.micSet!(level, null);
        return { ok: true, message: `🎙️ Microphone level ${after.level}%${after.muted ? ' (still muted)' : ''}.`, data: after };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  skills.push({
    id: 'system.theme',
    label: 'Dark or light mode',
    icon: '🌓',
    domain: 'system',
    description: 'Switch Windows (and apps that follow it) between dark and light mode.',
    needs: ['os'],
    risk: 'safe',
    examples: ['turn on dark mode', 'switch to light mode'],
    params: {
      mode: { type: 'string', required: true, enum: ['dark', 'light', 'toggle'], description: 'which' },
    },
    async run(args) {
      try {
        const current = await platform.themeGet!();
        const asked = String(args.mode);
        const mode = asked === 'toggle' ? (current === 'dark' ? 'light' : 'dark') : asked === 'light' ? 'light' : 'dark';
        if (mode === current) return { ok: true, message: `🌓 Windows is already in ${mode} mode.` };
        await platform.themeSet!(mode);
        return {
          ok: true,
          message: `🌓 Switched to ${mode} mode.`,
          undo: { skill: 'system.theme', args: { mode: current }, label: `${current} mode again` },
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  return skills;
}
