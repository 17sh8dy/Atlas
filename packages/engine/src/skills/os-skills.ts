/**
 * The machine itself — lock it, quieten it, put it to sleep, shut it down.
 *
 * These are the first skills whose effect Atlas cannot undo, so the risk
 * levels here are load-bearing rather than decorative: anything that ends a
 * session or destroys something (`system.power`, `system.emptyRecycleBin`) is
 * `confirm`, and the reversible ones (volume, media, display) are not, because
 * a confirmation dialog for "turn it down a bit" trains people to click
 * through confirmations that matter.
 *
 * Each one calls a single named Win32 command in `os.rs`. There is no generic
 * "press this key" or "run this command" underneath them — the enumerated
 * argument is the whole vocabulary.
 */

import type { MediaKey, Platform, PowerAction, Skill } from '@atlas/core';

const POWER_WORDS: Record<PowerAction, string> = {
  shutdown: 'Shutting down',
  restart: 'Restarting',
  'sign-out': 'Signing out',
};

export function createOsSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'system.lock',
    label: 'Lock the PC',
    icon: '🔒',
    domain: 'system',
    description: 'Lock the computer, as Win+L does.',
    needs: ['os'],
    // Reversible with a password, and the whole point is that it happens
    // *now* — a confirmation step defeats "lock it, I'm walking away".
    risk: 'safe',
    examples: ['lock my pc', 'lock the computer'],
    params: {},
    async run() {
      const ok = await platform.lockWorkstation!();
      return ok ? { ok: true, message: '🔒 Locked.' } : { ok: false, error: "I couldn't lock it." };
    },
  });

  skills.push({
    id: 'system.power',
    label: 'Shut down or restart',
    icon: '⏻',
    domain: 'system',
    description: 'Shut down, restart, or sign out of Windows.',
    needs: ['os'],
    risk: 'confirm',
    examples: ['restart my pc', 'shut down the computer'],
    params: {
      action: {
        type: 'string',
        required: true,
        enum: ['shutdown', 'restart', 'sign-out'],
        description: 'what to do',
      },
    },
    async run(args) {
      const action = String(args.action) as PowerAction;
      if (!POWER_WORDS[action]) return { ok: false, error: `I can't "${action}".` };
      const ok = await platform.powerAction!(action);
      return ok
        ? { ok: true, message: `⏻ ${POWER_WORDS[action]}…` }
        : { ok: false, error: `${POWER_WORDS[action]} failed.` };
    },
  });

  skills.push({
    id: 'system.volume',
    label: 'Change the volume',
    icon: '🔊',
    domain: 'system',
    description: 'Turn the system volume up or down.',
    needs: ['os'],
    risk: 'safe',
    examples: ['volume up', 'turn it down a bit'],
    params: {
      direction: { type: 'string', required: true, enum: ['up', 'down'], description: 'which way' },
      steps: { type: 'number', default: 5, description: 'how many notches (about 2% each)' },
    },
    async run(args) {
      const direction = String(args.direction) === 'down' ? 'down' : 'up';
      const steps = Math.min(50, Math.max(1, Math.round(Number(args.steps ?? 5))));
      const ok = await platform.setVolume!(direction, steps);
      return ok
        ? { ok: true, message: `🔊 Volume ${direction}.` }
        : { ok: false, error: "I couldn't change the volume." };
    },
  });

  skills.push({
    id: 'system.mute',
    label: 'Mute or unmute',
    icon: '🔇',
    domain: 'system',
    description: 'Toggle the system mute.',
    needs: ['os'],
    risk: 'safe',
    examples: ['mute', 'unmute the sound'],
    params: {},
    async run() {
      // Windows exposes mute as a toggle, not a state, so this reports what it
      // did rather than claiming to know which way it went.
      const ok = await platform.toggleMute!();
      return ok
        ? { ok: true, message: '🔇 Mute toggled.' }
        : { ok: false, error: "I couldn't reach the volume." };
    },
  });

  skills.push({
    id: 'media.control',
    label: 'Control playback',
    icon: '⏯️',
    domain: 'system',
    description: 'Play, pause, skip or go back in whatever is playing.',
    needs: ['os'],
    risk: 'safe',
    examples: ['pause the music', 'skip this track'],
    params: {
      key: {
        type: 'string',
        default: 'play-pause',
        enum: ['play-pause', 'next', 'previous', 'stop'],
        description: 'which control',
      },
    },
    async run(args) {
      const key = String(args.key ?? 'play-pause') as MediaKey;
      const ok = await platform.mediaKey!(key);
      const said: Record<MediaKey, string> = {
        'play-pause': '⏯️ Play/pause.',
        next: '⏭️ Next track.',
        previous: '⏮️ Previous track.',
        stop: '⏹️ Stopped.',
      };
      return ok
        ? { ok: true, message: said[key] ?? '⏯️ Done.' }
        : { ok: false, error: 'Nothing responded to that.' };
    },
  });

  skills.push({
    id: 'system.displayOff',
    label: 'Turn the screen off',
    icon: '🌙',
    domain: 'system',
    description: 'Put the display to sleep without locking or suspending the machine.',
    needs: ['os'],
    risk: 'safe',
    examples: ['turn off the screen', 'display off'],
    params: {},
    async run() {
      const ok = await platform.displayOff!();
      return ok
        ? { ok: true, message: '🌙 Screen off — move the mouse to wake it.' }
        : { ok: false, error: "I couldn't turn the display off." };
    },
  });

  skills.push({
    id: 'system.emptyRecycleBin',
    label: 'Empty the recycle bin',
    icon: '🗑️',
    domain: 'system',
    description: 'Permanently delete everything in the recycle bin.',
    needs: ['os'],
    // The one action here that destroys data, and the recycle bin is where
    // `files.delete` puts things — so this is the end of the line for them.
    risk: 'confirm',
    examples: ['empty the recycle bin'],
    params: {},
    async run() {
      const ok = await platform.emptyRecycleBin!();
      return ok
        ? { ok: true, message: '🗑️ Recycle bin emptied.' }
        : { ok: false, error: "I couldn't empty it." };
    },
  });

  return skills;
}
