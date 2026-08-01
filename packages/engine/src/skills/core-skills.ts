/**
 * The skills Atlas ships with.
 *
 * Every one reaches the machine through the `Platform` port and declares the
 * capabilities it needs, so this exact pack works unchanged on the Tauri
 * desktop build (where most capabilities exist), in a browser tab (where
 * almost none do, and the impossible ones are simply invisible), and against a
 * test platform.
 *
 * Anything that touches the world outside Atlas is `risk: 'confirm'`. That is a
 * deliberately low bar — launching an app and opening a file both clear it —
 * because the cost of one extra click is trivial next to an assistant that
 * opens things you didn't ask for.
 */

import type { Platform, ResultRow, Skill } from '@atlas/core';

export function createCoreSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  // ---- files ---------------------------------------------------------------

  skills.push({
    id: 'files.find',
    label: 'Find files',
    icon: '🔍',
    domain: 'files',
    description: 'Search the file index by name and show matching files.',
    needs: ['files'],
    risk: 'safe',
    examples: ['find my tax pdf', 'where are my screenshots'],
    params: {
      query: { type: 'string', required: true, description: 'words from the file name' },
      kind: {
        type: 'string',
        required: false,
        description: 'narrow by type: document, image, video, audio, archive, folder',
      },
      limit: { type: 'number', default: 20, description: 'how many to show' },
    },
    async run(args, ctx) {
      const files = await platform.searchFiles!(String(args.query), {
        kind: args.kind ? String(args.kind) : undefined,
        limit: Number(args.limit ?? 20),
      });

      if (!files.length) {
        return { ok: true, message: `Nothing named like “${String(args.query)}”.` };
      }

      const rows: ResultRow[] = files.map((f) => ({
        title: f.name,
        subtitle: f.path,
        icon: f.isDirectory ? '📁' : '📄',
        payload: f,
        actions: [
          { label: 'Open', skill: 'files.open', args: { path: f.path } },
          { label: 'Show in folder', skill: 'files.reveal', args: { path: f.path } },
        ],
      }));

      ctx.showResults?.(rows, {
        title: `Files matching “${String(args.query)}”`,
        subtitle: `${files.length} found`,
      });
      return { ok: true, spoken: true, message: '', data: files };
    },
  });

  skills.push({
    id: 'files.open',
    label: 'Open a file',
    icon: '📄',
    domain: 'files',
    description: 'Open a file or folder with whatever the system uses for it.',
    needs: ['fs'],
    risk: 'confirm',
    params: { path: { type: 'string', required: true, description: 'full path' } },
    async run(args) {
      const ok = await platform.openPath!(String(args.path));
      return ok
        ? { ok: true, message: `Opening ${basename(String(args.path))}.` }
        : { ok: false, error: `I couldn't open ${String(args.path)}.` };
    },
  });

  skills.push({
    id: 'files.reveal',
    label: 'Show in folder',
    icon: '📁',
    domain: 'files',
    description: 'Reveal a file in the system file manager without opening it.',
    needs: ['fs'],
    risk: 'confirm',
    params: { path: { type: 'string', required: true, description: 'full path' } },
    async run(args) {
      const ok = await platform.revealPath!(String(args.path));
      return ok
        ? { ok: true, message: `Showing ${basename(String(args.path))} in its folder.` }
        : { ok: false, error: `I couldn't reveal ${String(args.path)}.` };
    },
  });

  // ---- applications --------------------------------------------------------

  skills.push({
    id: 'app.open',
    label: 'Open an app',
    icon: '🚀',
    domain: 'apps',
    description: 'Launch an installed application by name.',
    needs: ['apps'],
    risk: 'confirm',
    examples: ['open steam', 'launch spotify'],
    params: { name: { type: 'string', required: true, description: 'the application name' } },
    async run(args) {
      const wanted = String(args.name).toLowerCase().trim();
      const apps = await platform.listApps!();

      // Exact first, then prefix, then contains — so "code" doesn't lose to
      // "Visual Studio Code Insiders" on a substring technicality.
      const hit =
        apps.find((a) => a.name.toLowerCase() === wanted) ??
        apps.find((a) => a.name.toLowerCase().startsWith(wanted)) ??
        apps.find((a) => a.name.toLowerCase().includes(wanted));

      if (!hit) return { ok: false, error: `I can't find an app called “${String(args.name)}”.` };

      const ok = await platform.launchApp!(hit.id);
      return ok
        ? { ok: true, message: `Opening ${hit.name}.` }
        : { ok: false, error: `${hit.name} wouldn't start.` };
    },
  });

  skills.push({
    id: 'app.list',
    label: 'List apps',
    icon: '🗂️',
    domain: 'apps',
    description: 'Show the applications installed on this machine.',
    needs: ['apps'],
    risk: 'safe',
    params: { filter: { type: 'string', required: false, description: 'optional name filter' } },
    async run(args, ctx) {
      const filter = args.filter ? String(args.filter).toLowerCase() : '';
      const apps = (await platform.listApps!()).filter((a) =>
        filter ? a.name.toLowerCase().includes(filter) : true,
      );

      if (!apps.length) return { ok: true, message: 'No applications matched.' };

      ctx.showResults?.(
        apps.map((a) => ({
          title: a.name,
          icon: a.icon ?? '🚀',
          payload: a,
          actions: [{ label: 'Open', skill: 'app.open', args: { name: a.name } }],
        })),
        { title: 'Installed applications', subtitle: `${apps.length} found` },
      );
      return { ok: true, spoken: true, message: '', data: apps };
    },
  });

  // ---- the machine ---------------------------------------------------------

  skills.push({
    id: 'system.info',
    label: 'System status',
    icon: '📊',
    domain: 'system',
    description: 'Report CPU, memory, disk and battery for this machine.',
    needs: ['system'],
    risk: 'safe',
    examples: ['system status', 'how much memory am I using'],
    params: {},
    async run() {
      const s = await platform.systemInfo!();
      const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
      const parts = [
        `CPU ${Math.round(s.cpuPercent)}%`,
        `memory ${gb(s.memoryUsedBytes)}/${gb(s.memoryTotalBytes)} GB`,
        ...s.disks.map((d) => `${d.mount} ${gb(d.usedBytes)}/${gb(d.totalBytes)} GB`),
      ];
      if (s.battery) {
        parts.push(`battery ${s.battery.percent}%${s.battery.charging ? ' (charging)' : ''}`);
      }
      return { ok: true, message: `📊 ${parts.join(' · ')}.`, data: s };
    },
  });

  // ---- the web -------------------------------------------------------------

  skills.push({
    id: 'web.open',
    label: 'Open a link',
    icon: '🌐',
    domain: 'web',
    description: 'Open an http or https URL in the default browser.',
    needs: ['fs'],
    risk: 'confirm',
    params: { url: { type: 'string', required: true, description: 'the address' } },
    async run(args) {
      const url = String(args.url).trim();
      if (!/^https?:\/\//i.test(url)) {
        // The platform validates too; refusing here as well means the reason
        // reaches the user in words rather than as a silent failure.
        return { ok: false, error: 'I only open http and https links.' };
      }
      const ok = await platform.openUrl!(url);
      return ok ? { ok: true, message: `Opening ${url}.` } : { ok: false, error: `I couldn't open ${url}.` };
    },
  });

  // ---- clipboard -----------------------------------------------------------

  skills.push({
    id: 'clipboard.copy',
    label: 'Copy to clipboard',
    icon: '📋',
    domain: 'clipboard',
    description: 'Put some text on the clipboard.',
    needs: ['clipboard'],
    risk: 'safe',
    params: { text: { type: 'string', required: true, description: 'what to copy' } },
    async run(args) {
      const ok = await platform.writeClipboard!(String(args.text));
      return ok ? { ok: true, message: '📋 Copied.' } : { ok: false, error: "I couldn't reach the clipboard." };
    },
  });

  // ---- Atlas itself --------------------------------------------------------

  skills.push({
    id: 'atlas.hide',
    label: 'Hide Atlas',
    icon: '👋',
    domain: 'atlas',
    description: 'Put the Atlas window away.',
    needs: ['windows'],
    risk: 'safe',
    params: {},
    async run() {
      await platform.hideWindow!();
      return { ok: true, message: '' , spoken: true };
    },
  });

  return skills;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
