/**
 * Everyday Windows settings: wallpaper, mouse speed, file extensions and hidden
 * files, Do Not Disturb, restarting Explorer, Wi-Fi and Bluetooth, and what is
 * playing.
 *
 * Risk follows consequence. A setting that is undone by saying so (wallpaper,
 * mouse speed, Do Not Disturb, showing extensions) does not ask. Things that
 * *take something away* do: switching Wi-Fi off cuts the connection Atlas
 * itself may be using, switching Bluetooth off drops the headphones, and
 * restarting Explorer closes every open File Explorer window.
 */

import type { Memory, Platform, Skill } from '@atlas/core';
import { resolveTarget } from './locate';

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

const IMAGE = /\.(?:jpe?g|png|bmp)$/i;

export function createSettingsSkills(platform: Platform, memory?: Memory): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'system.wallpaper',
    label: 'Set the wallpaper',
    icon: '🖼️',
    domain: 'system',
    description: 'Set the desktop wallpaper to a picture (.jpg, .png or .bmp) in your folders.',
    needs: ['os'],
    risk: 'safe',
    examples: ['set my wallpaper to sunset.jpg in pictures'],
    params: { target: { type: 'string', required: true, description: 'the picture, in words or a path' } },
    async run(args) {
      const t = await resolveTarget(platform, memory, String(args.target ?? ''));
      if (!t.ok) return { ok: false, error: t.error };
      if (!IMAGE.test(t.path)) return { ok: false, error: 'A wallpaper has to be a .jpg, .png or .bmp picture.' };
      try {
        await platform.setWallpaper!(t.path);
        return { ok: true, message: `🖼️ Wallpaper set to ${t.path.split(/[\\/]/).pop()}.` };
      } catch (e) {
        return fail(e, "I couldn't set that as the wallpaper.");
      }
    },
  });

  skills.push({
    id: 'system.mouseSpeed',
    label: 'Mouse speed',
    icon: '🖱️',
    domain: 'system',
    description: 'Set the pointer speed (1–20, default 10), nudge it faster or slower, or say what it is.',
    needs: ['os'],
    risk: 'safe',
    examples: ['set the mouse speed to 12', 'make the mouse faster'],
    params: {
      speed: { type: 'number', required: false, description: '1–20' },
      direction: { type: 'string', required: false, enum: ['faster', 'slower'], description: 'nudge by 2' },
    },
    async run(args) {
      try {
        const current = await platform.mouseSpeed!();
        let target: number | null = null;
        if (args.speed !== undefined && args.speed !== null && args.speed !== '') target = Math.round(Number(args.speed));
        else if (args.direction === 'faster') target = current + 2;
        else if (args.direction === 'slower') target = current - 2;
        if (target === null) return { ok: true, message: `🖱️ Mouse speed is ${current} of 20 (10 is the default).` };
        if (!Number.isFinite(target) || target < 1 || target > 20) {
          return { ok: false, error: args.speed !== undefined ? 'Mouse speed is between 1 and 20.' : `It's already at ${current} — that's as ${args.direction} as it goes.` };
        }
        const now = await platform.setMouseSpeed!(target);
        return {
          ok: true,
          message: `🖱️ Mouse speed ${now} of 20.`,
          data: now,
          undo: { skill: 'system.mouseSpeed', args: { speed: current }, label: `mouse speed back to ${current}` },
        };
      } catch (e) {
        return fail(e, "I couldn't change the mouse speed.");
      }
    },
  });

  skills.push({
    id: 'system.explorerOption',
    label: 'File extensions and hidden files',
    icon: '📁',
    domain: 'system',
    description: 'Show or hide file extensions (.txt) and hidden files in File Explorer, or say which it is.',
    needs: ['os'],
    risk: 'safe',
    examples: ['show file extensions', 'hide hidden files'],
    params: {
      which: { type: 'string', required: true, enum: ['file-extensions', 'hidden-files'], description: 'which option' },
      show: { type: 'boolean', required: false, description: 'true to show, false to hide; leave out to just read it' },
    },
    async run(args) {
      const which = String(args.which) === 'hidden-files' ? 'hidden-files' : 'file-extensions';
      const noun = which === 'hidden-files' ? 'hidden files' : 'file extensions';
      try {
        const prior = args.show === undefined ? null : await platform.explorerOptions!();
        const now =
          args.show === undefined
            ? await platform.explorerOptions!()
            : await platform.setExplorerOption!(which, Boolean(args.show));
        const shown = which === 'hidden-files' ? now.hiddenFiles : now.fileExtensions;
        const wasShown = prior ? (which === 'hidden-files' ? prior.hiddenFiles : prior.fileExtensions) : null;
        return {
          ok: true,
          message: `📁 ${shown ? 'Showing' : 'Hiding'} ${noun}.${args.show === undefined ? '' : ' Press F5 in an open folder to see it.'}`,
          data: now,
          ...(wasShown === null ? {} : { undo: { skill: 'system.explorerOption', args: { which, show: wasShown }, label: `${wasShown ? 'show' : 'hide'} ${noun} again` } }),
        };
      } catch (e) {
        return fail(e, "I couldn't change that.");
      }
    },
  });

  skills.push({
    id: 'system.restartExplorer',
    confirmAs: () => 'restart Explorer (open File Explorer windows will close)',
    label: 'Restart Explorer',
    icon: '🔄',
    domain: 'system',
    description:
      'Restart Windows Explorer — the taskbar, Start menu and file windows — to fix a stuck taskbar. Open File Explorer windows close.',
    needs: ['os'],
    risk: 'confirm',
    examples: ['restart explorer'],
    params: {},
    async run() {
      try {
        await platform.restartExplorer!();
        return { ok: true, message: '🔄 Explorer restarted — the taskbar will be back in a moment.' };
      } catch (e) {
        return fail(e, "I couldn't restart Explorer.");
      }
    },
  });

  skills.push({
    id: 'system.doNotDisturb',
    label: 'Do Not Disturb',
    icon: '🔕',
    domain: 'system',
    description: 'Turn Do Not Disturb (notification banners) on or off, or say which it is.',
    needs: ['os'],
    risk: 'safe',
    examples: ['turn on do not disturb', 'turn off do not disturb'],
    params: { on: { type: 'boolean', required: false, description: 'true for on, false for off; leave out to read it' } },
    async run(args) {
      try {
        const was = args.on === undefined ? null : await platform.doNotDisturb!();
        const now = args.on === undefined ? await platform.doNotDisturb!() : await platform.setDoNotDisturb!(Boolean(args.on));
        return {
          ok: true,
          message: now ? '🔕 Do Not Disturb is on — notification banners are off.' : '🔔 Do Not Disturb is off.',
          data: now,
          ...(was === null ? {} : { undo: { skill: 'system.doNotDisturb', args: { on: was }, label: `Do Not Disturb ${was ? 'on' : 'off'} again` } }),
        };
      } catch (e) {
        return fail(e, "I couldn't change Do Not Disturb.");
      }
    },
  });

  skills.push({
    id: 'system.radio',
    confirmAs: (a) => `turn ${String(a.kind) === 'airplane' ? 'airplane mode' : String(a.kind) === 'wifi' ? 'Wi-Fi' : 'Bluetooth'} ${a.state === 'on' ? 'on' : 'off'}`,
    label: 'Wi-Fi and Bluetooth',
    icon: '📶',
    domain: 'system',
    description: 'Turn Wi-Fi or Bluetooth on or off, or say which are on. "Airplane mode" is both.',
    needs: ['os'],
    // Turning one on adds something; turning one off takes a connection away.
    risk: 'confirm',
    riskFor: (args) => (args.state === 'off' ? undefined : 'safe'),
    examples: ['turn off bluetooth', 'turn on wifi', 'is bluetooth on'],
    params: {
      kind: { type: 'string', required: true, enum: ['wifi', 'bluetooth', 'airplane'], description: 'which radio' },
      state: { type: 'string', required: true, enum: ['on', 'off', 'status'], description: 'what to do' },
    },
    async run(args) {
      const kind = String(args.kind);
      const state = String(args.state);
      const kinds: Array<'wifi' | 'bluetooth'> = kind === 'airplane' ? ['wifi', 'bluetooth'] : kind === 'wifi' ? ['wifi'] : ['bluetooth'];
      const label = (k: string) => (k === 'wifi' ? 'Wi-Fi' : 'Bluetooth');
      try {
        if (state === 'status') {
          const all = await platform.radios!();
          const lines = kinds.map((k) => {
            const r = all.filter((x) => x.kind === k);
            return r.length ? `${label(k)} is ${r.some((x) => x.on) ? 'on' : 'off'}.` : `This PC has no ${label(k)}.`;
          });
          return { ok: true, message: `📶 ${lines.join(' ')}`, data: all };
        }
        const on = state === 'on';
        // Airplane mode is "everything off"; turning it *off* turns both back on.
        const results: string[] = [];
        for (const k of kinds) {
          try {
            await platform.setRadio!(k, on);
            results.push(`${label(k)} ${on ? 'on' : 'off'}`);
          } catch (e) {
            // One missing radio must not hide that the other was changed.
            results.push(e instanceof Error ? e.message : String(e));
          }
        }
        return { ok: true, message: `📶 ${results.join('. ')}.` };
      } catch (e) {
        return fail(e, "I couldn't reach the radios.");
      }
    },
  });

  skills.push({
    id: 'media.nowPlaying',
    label: "What's playing",
    icon: '🎵',
    domain: 'system',
    description: 'Say what song or video is playing right now, in whatever app is playing it.',
    needs: ['os'],
    risk: 'safe',
    examples: ["what's playing", 'what song is this'],
    params: {},
    async run() {
      try {
        const n = await platform.nowPlaying!();
        if (!n || (!n.title && n.status === 'other')) return { ok: true, message: '🎵 Nothing is playing.' };
        const by = n.artist ? ` — ${n.artist}` : '';
        const app = n.app ? ` (${n.app.replace(/\.exe$/i, '')})` : '';
        const verb = n.status === 'playing' ? 'Playing' : n.status === 'paused' ? 'Paused' : 'Stopped';
        return { ok: true, message: `🎵 ${verb}: ${n.title || 'something'}${by}${app}`, data: n };
      } catch (e) {
        return fail(e, "I couldn't see what's playing.");
      }
    },
  });

  skills.push({
    id: 'media.shuffle',
    label: 'Shuffle',
    icon: '🔀',
    domain: 'system',
    description: 'Turn shuffle on or off in whatever is playing (if the app supports it).',
    needs: ['os'],
    risk: 'safe',
    examples: ['turn on shuffle', 'turn off shuffle'],
    params: { on: { type: 'boolean', required: true, description: 'true for on, false for off' } },
    async run(args) {
      try {
        const ok = await platform.setShuffle!(Boolean(args.on));
        return ok
          ? { ok: true, message: `🔀 Shuffle ${args.on ? 'on' : 'off'}.` }
          : { ok: false, error: "That app didn't accept the change — it may not support shuffle from outside." };
      } catch (e) {
        return fail(e, "I couldn't change shuffle.");
      }
    },
  });

  return skills;
}
