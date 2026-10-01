/**
 * Brightness, per-app volume, the power plan, projection, the Recycle Bin,
 * startup apps, printers, Windows Settings pages, and a speed test.
 *
 * Risk follows consequence. Things undone by saying so (brightness, an app's
 * volume, the power plan, restoring a deleted file — which never overwrites)
 * do not ask. Things that change what happens at the next boot, put the screen
 * on something else, or spend paper do.
 *
 * Where Windows will not let anyone but the person change a setting (the
 * default browser, night light, time zone), `system.settingsPage` opens the
 * right page and says so. It does not pretend.
 */

import type { Memory, Platform, ResultRow, Skill } from '@atlas/core';
import { resolveTarget } from './locate';

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

const fmtBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

export const SETTINGS_PAGES: Record<string, string> = {
  'default-apps': 'Default apps (where the default browser is set)',
  network: 'Network & internet (where an adapter can be reset)',
  'night-light': 'Night light',
  display: 'Display (resolution, scale, monitors)',
  hotspot: 'Mobile hotspot',
  'time-language': 'Date & time (time zone)',
  language: 'Language & region',
  printers: 'Printers & scanners',
  sound: 'Sound',
  bluetooth: 'Bluetooth & devices',
  wifi: 'Wi-Fi',
  'startup-apps': 'Startup apps',
  'installed-apps': 'Installed apps',
  storage: 'Storage',
  power: 'Power & sleep',
  notifications: 'Notifications',
  personalization: 'Personalization',
  'windows-update': 'Windows Update',
  taskbar: 'Taskbar',
  privacy: 'Privacy & security',
};

export function createShellSkills(platform: Platform, memory?: Memory): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'system.brightness',
    label: 'Screen brightness',
    icon: '🔆',
    domain: 'system',
    description: 'Set the brightness of your monitors (those that let Windows change it), nudge it, or say what it is.',
    needs: ['os'],
    risk: 'safe',
    examples: ['set the brightness to 60', 'make the screen dimmer'],
    params: {
      level: { type: 'number', required: false, description: '5–100' },
      direction: { type: 'string', required: false, enum: ['brighter', 'dimmer'], description: 'nudge by 15' },
    },
    async run(args) {
      try {
        const cur = await platform.brightnessGet!();
        let target: number | null = null;
        if (args.level !== undefined && args.level !== null && args.level !== '') target = Math.round(Number(args.level));
        else if (args.direction === 'brighter') target = Math.min(100, cur.level + 15);
        else if (args.direction === 'dimmer') target = Math.max(5, cur.level - 15);
        if (target === null) return { ok: true, message: `🔆 Brightness is ${cur.level}% (${cur.monitors} screen${cur.monitors === 1 ? '' : 's'}).` };
        if (!Number.isFinite(target) || target < 5 || target > 100) {
          return { ok: false, error: 'Brightness is between 5 and 100 — I won\'t turn a screen fully black.' };
        }
        const now = await platform.brightnessSet!(target);
        return {
          ok: true,
          message: `🔆 Brightness ${now.level}% on ${now.monitors} screen${now.monitors === 1 ? '' : 's'}.`,
          data: now,
          undo: { skill: 'system.brightness', args: { level: Math.max(5, cur.level) }, label: `brightness back to ${cur.level}%` },
        };
      } catch (e) {
        return fail(e, "I couldn't change the brightness.");
      }
    },
  });

  skills.push({
    id: 'system.appVolume',
    label: "An app's volume",
    icon: '🎚️',
    domain: 'system',
    description:
      'Set one app\'s volume, mute or unmute it, or list which apps are making sound — separately from the main volume. The app has to be playing sound.',
    needs: ['os'],
    risk: 'safe',
    examples: ['set spotify volume to 30', 'mute chrome', 'which apps are playing sound'],
    params: {
      app: { type: 'string', required: false, description: 'the app, e.g. "spotify"; leave out to list' },
      level: { type: 'number', required: false, description: '0–100' },
      state: { type: 'string', required: false, enum: ['mute', 'unmute'], description: 'mute or unmute it' },
    },
    async run(args) {
      try {
        const app = String(args.app ?? '').trim();
        if (!app) {
          const all = await platform.appVolumes!();
          if (!all.length) return { ok: true, message: '🎚️ No app is playing sound right now.' };
          const byApp = new Map<string, { level: number; muted: boolean }>();
          for (const a of all) byApp.set(a.app, { level: a.level, muted: a.muted });
          return {
            ok: true,
            message: `🎚️ ${[...byApp].map(([n, v]) => `${n} ${v.muted ? '(muted)' : `${v.level}%`}`).join(', ')}`,
            data: all,
          };
        }
        const level = args.level === undefined || args.level === null || args.level === '' ? null : Math.round(Number(args.level));
        if (level !== null && (!Number.isFinite(level) || level < 0 || level > 100)) {
          return { ok: false, error: 'A volume is between 0 and 100.' };
        }
        const muted = args.state === 'mute' ? true : args.state === 'unmute' ? false : level !== null && level > 0 ? false : null;
        if (level === null && muted === null) {
          const all = (await platform.appVolumes!()).filter((a) => a.app.toLowerCase().includes(app.toLowerCase()));
          if (!all.length) return { ok: true, message: `🎚️ ${app} isn't playing any sound right now.` };
          return { ok: true, message: `🎚️ ${all[0]!.app} is ${all[0]!.muted ? 'muted' : `at ${all[0]!.level}%`}.`, data: all };
        }
        const done = await platform.setAppVolume!(app, level, muted);
        const a = done[0]!;
        return { ok: true, message: `🎚️ ${a.app} ${a.muted ? 'muted' : `volume ${a.level}%`}.`, data: done };
      } catch (e) {
        return fail(e, "I couldn't change that app's volume.");
      }
    },
  });

  skills.push({
    id: 'system.powerPlan',
    label: 'Power plan',
    icon: '🔋',
    domain: 'system',
    description: 'Switch between Windows\' balanced, high performance and power saver plans, or say which is active.',
    needs: ['os'],
    risk: 'safe',
    examples: ['switch to high performance', 'which power plan am i on'],
    params: {
      plan: { type: 'string', required: false, enum: ['balanced', 'high-performance', 'power-saver'], description: 'leave out to read it' },
    },
    async run(args) {
      const words: Record<string, string> = { balanced: 'Balanced', 'high-performance': 'High performance', 'power-saver': 'Power saver', custom: 'a custom plan' };
      try {
        const prev = args.plan ? await platform.powerPlan!() : null;
        const now = args.plan ? await platform.setPowerPlan!(String(args.plan) as never) : await platform.powerPlan!();
        return {
          ok: true,
          message: `🔋 ${args.plan ? 'Switched to' : 'You are on'} ${words[now] ?? now}.`,
          data: now,
          ...(prev && prev !== 'custom' ? { undo: { skill: 'system.powerPlan', args: { plan: prev }, label: `the ${words[prev] ?? prev} plan again` } } : {}),
        };
      } catch (e) {
        return fail(e, "I couldn't change the power plan.");
      }
    },
  });

  skills.push({
    id: 'system.projectDisplay',
    label: 'Projection mode',
    icon: '🖥️',
    domain: 'system',
    description: 'Switch what the screens show, as Win+P does: PC screen only, duplicate, extend, or second screen only.',
    needs: ['os'],
    risk: 'confirm',
    // Duplicate and extend keep your screen; the other two can blank it.
    riskFor: (args) => (args.mode === 'duplicate' || args.mode === 'extend' ? 'safe' : undefined),
    confirmAs: (a) => ({ 'pc-only': 'show only on your PC screen', 'second-only': 'show only on the second screen', duplicate: 'duplicate your screens', extend: 'extend your screens' })[String(a.mode)] ?? 'change the screen mode',
    examples: ['extend my screens', 'duplicate my screen'],
    params: {
      mode: { type: 'string', required: true, enum: ['pc-only', 'duplicate', 'extend', 'second-only'], description: 'which mode' },
    },
    async run(args) {
      try {
        await platform.projectDisplay!(String(args.mode) as never);
        return { ok: true, message: `🖥️ Switching to ${String(args.mode).replace('-', ' ')}.` };
      } catch (e) {
        return fail(e, "I couldn't switch the display mode.");
      }
    },
  });

  // ---- the Recycle Bin ------------------------------------------------------------------

  skills.push({
    id: 'files.recycleBin',
    label: "What's in the Recycle Bin",
    icon: '🗑️',
    domain: 'files',
    description: 'List what was recently deleted, newest first, with a button to restore each.',
    needs: ['fs'],
    risk: 'safe',
    examples: ["what's in the recycle bin"],
    params: {},
    async run(_args, ctx) {
      try {
        const items = await platform.recycleBinList!(30);
        if (!items.length) return { ok: true, message: '🗑️ The Recycle Bin is empty.' };
        const rows: ResultRow[] = items.map((i) => ({
          title: i.name,
          subtitle: `${new Date(i.deletedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${i.isDir ? 'folder' : fmtBytes(i.sizeBytes)} · from ${i.original.replace(/[\\/][^\\/]*$/, '')}`,
          icon: i.isDir ? '📁' : '📄',
          payload: i,
          actions: [{ label: 'Restore', skill: 'files.restore', args: { name: i.name } }],
        }));
        ctx.showResults?.(rows, { title: 'Recycle Bin', subtitle: `${items.length} most recent` });
        return { ok: true, spoken: true, message: `🗑️ ${items.length} recent item${items.length === 1 ? '' : 's'} in the Recycle Bin.`, data: items };
      } catch (e) {
        return fail(e, "I couldn't read the Recycle Bin.");
      }
    },
  });

  skills.push({
    id: 'files.restore',
    label: 'Restore a deleted file',
    icon: '♻️',
    domain: 'files',
    description:
      'Put a file or folder back from the Recycle Bin, to where it came from. Never overwrites: if something is already there, it says so and leaves both alone.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['restore notes.txt from the recycle bin', 'undelete budget.xlsx'],
    params: { name: { type: 'string', required: true, description: 'the file or folder name' } },
    async run(args) {
      try {
        const r = await platform.recycleBinRestore!(String(args.name ?? ''));
        return { ok: true, message: `♻️ Restored ${r.name} to ${r.original.replace(/[\\/][^\\/]*$/, '')}.`, data: r };
      } catch (e) {
        return fail(e, "I couldn't restore that.");
      }
    },
  });

  // ---- startup apps -------------------------------------------------------------------------

  skills.push({
    id: 'system.startupApps',
    label: 'Startup apps',
    icon: '🚀',
    domain: 'system',
    description: 'List the apps that start with Windows, or turn one off or on for you. It only flips Windows\' own switch — nothing is uninstalled.',
    needs: ['os'],
    risk: 'confirm',
    riskFor: (args) => (args.enabled === undefined ? 'safe' : undefined),
    confirmAs: (a) => `${a.enabled === false ? 'stop' : 'let'} ${String(a.name)} ${a.enabled === false ? 'starting with Windows' : 'start with Windows'}`,
    examples: ['what apps start with windows', 'stop discord starting with windows'],
    params: {
      name: { type: 'string', required: false, description: 'the app; leave out to list' },
      enabled: { type: 'boolean', required: false, description: 'true to allow it at startup, false to stop it' },
    },
    async run(args, ctx) {
      try {
        if (args.enabled !== undefined && String(args.name ?? '').trim()) {
          const a = await platform.setStartupApp!(String(args.name), Boolean(args.enabled));
          return {
            ok: true,
            message: `🚀 ${a.name} ${a.enabled ? 'will start' : 'won\'t start'} with Windows.`,
            undo: { skill: 'system.startupApps', args: { name: a.name, enabled: !a.enabled }, label: `${a.name} ${a.enabled ? 'not starting' : 'starting'} with Windows again` },
          };
        }
        const all = await platform.startupApps!();
        const rows: ResultRow[] = all.map((a) => ({
          title: a.name,
          subtitle: `${a.enabled ? 'starts with Windows' : 'turned off'} · ${a.command.slice(0, 80)}`,
          icon: a.enabled ? '🟢' : '⚪',
          payload: a,
          actions: [a.enabled
            ? { label: 'Turn off', skill: 'system.startupApps', args: { name: a.name, enabled: false } }
            : { label: 'Turn on', skill: 'system.startupApps', args: { name: a.name, enabled: true } }],
        }));
        ctx.showResults?.(rows, { title: 'Startup apps', subtitle: `${all.filter((a) => a.enabled).length} of ${all.length} start with Windows` });
        return { ok: true, spoken: true, message: `🚀 ${all.filter((a) => a.enabled).length} of ${all.length} startup apps are on.`, data: all };
      } catch (e) {
        return fail(e, "I couldn't read the startup apps.");
      }
    },
  });

  // ---- Settings pages ---------------------------------------------------------------------------

  skills.push({
    id: 'system.settingsPage',
    label: 'Open a Settings page',
    icon: '⚙️',
    domain: 'system',
    description:
      'Open a page of Windows Settings. For things only you can change on Windows — the default browser, night light, mobile hotspot, time zone and language, screen resolution — this takes you to the right page.',
    needs: ['os'],
    risk: 'safe',
    examples: ['open the night light settings', 'change my default browser'],
    params: { page: { type: 'string', required: true, enum: Object.keys(SETTINGS_PAGES), description: 'which page' } },
    async run(args) {
      const page = String(args.page);
      try {
        await platform.openSettingsPage!(page);
        const why: Record<string, string> = {
          network: " Restarting a network adapter needs administrator rights, which I don't use — so I've opened Network settings, where you can pick the adapter and reset it.",
          'default-apps': " Windows only lets you pick the default browser yourself, so I've opened the page.",
          'night-light': " Windows keeps night light's schedule to itself, so I've opened its page.",
          hotspot: " I can't start a hotspot myself, so I've opened its page.",
          'time-language': " Changing the time zone needs administrator rights, so I've opened the page.",
          display: " Resolution is best changed where you can preview it, so I've opened Display settings.",
        };
        return { ok: true, message: `⚙️ Opened ${SETTINGS_PAGES[page] ?? page}.${why[page] ?? ''}` };
      } catch (e) {
        return fail(e, "I couldn't open Settings.");
      }
    },
  });

  // ---- printers --------------------------------------------------------------------------------------

  skills.push({
    id: 'system.printers',
    label: 'Printers',
    icon: '🖨️',
    domain: 'system',
    description: 'List your printers and the default one, or make a printer the default.',
    needs: ['os'],
    risk: 'safe',
    examples: ['what printers do i have', 'set my default printer to brother'],
    params: { name: { type: 'string', required: false, description: 'the printer to make the default; leave out to list' } },
    async run(args) {
      try {
        const p = args.name ? await platform.setDefaultPrinter!(String(args.name)) : await platform.printers!();
        const lines = p.names.map((n) => `${n === p.default ? '⭐' : '•'} ${n}`);
        return { ok: true, message: `🖨️ ${args.name ? `Default printer is now ${p.default}.` : 'Your printers:'}\n${lines.join('\n')}`, data: p };
      } catch (e) {
        return fail(e, "I couldn't reach the printers.");
      }
    },
  });

  skills.push({
    id: 'files.print',
    label: 'Print a file',
    icon: '🖨️',
    domain: 'files',
    description: 'Send a document or picture to the default printer.',
    needs: ['fs'],
    risk: 'confirm',
    confirmAs: (a) => `print ${String(a.target)} on your default printer`,
    examples: ['print report.pdf in documents'],
    params: { target: { type: 'string', required: true, description: 'the file, in words or a path' } },
    async run(args) {
      const t = await resolveTarget(platform, memory, String(args.target ?? ''));
      if (!t.ok) return { ok: false, error: t.error };
      try {
        await platform.printFile!(t.path);
        return { ok: true, message: `🖨️ Sent ${t.path.split(/[\\/]/).pop()} to the printer.` };
      } catch (e) {
        return fail(e, "I couldn't print that.");
      }
    },
  });

  skills.push({
    id: 'net.speedTest',
    label: 'Internet speed test',
    icon: '⚡',
    domain: 'system',
    description: 'Download 25 MB from Cloudflare and report the speed and latency. Only when asked; nothing is uploaded.',
    needs: ['network'],
    risk: 'safe',
    examples: ['run a speed test'],
    params: {},
    async run() {
      try {
        const r = await platform.speedTest!();
        return { ok: true, message: `⚡ Download about ${r.downloadMbps.toFixed(0)} Mbps, latency ${r.latencyMs} ms.`, data: r };
      } catch (e) {
        return fail(e, 'The speed test failed.');
      }
    },
  });

  return skills;
}
