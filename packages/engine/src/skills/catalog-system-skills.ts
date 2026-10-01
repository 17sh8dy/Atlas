/**
 * Read-only questions about this PC and the network (tool-catalog pass): DNS lookup,
 * trace route, where a running process's program lives, BIOS / board / names, and
 * whether the firewall and Defender are on.
 *
 * All `safe`. Changing a firewall rule, a permission or a security setting is a
 * different request, and not one Atlas takes — see docs/TOOL-CATALOG.md.
 */

import type { Platform, Skill } from '@atlas/core';
import { matchRunningProcess } from '../text/processes';

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d ? `${d}d` : '', h ? `${h}h` : '', !d && m ? `${m}m` : ''].filter(Boolean).join(' ') || 'under a minute';
}

function mb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const onOff = (v: boolean | null) => (v === null ? 'unknown' : v ? 'on' : 'off');

export function createCatalogSystemSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'net.dnsLookup',
    label: 'DNS lookup',
    icon: '🧭',
    domain: 'system',
    description: 'The addresses a website or host name resolves to.',
    needs: ['network'],
    risk: 'safe',
    examples: ['dns lookup github.com'],
    params: { host: { type: 'string', required: true, description: 'a host name, like github.com' } },
    async run(args) {
      const host = String(args.host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      try {
        const ips = await platform.dnsLookup!(host);
        if (!ips.length) return { ok: true, message: `🧭 ${host} didn’t resolve to anything.` };
        return { ok: true, message: `🧭 ${host} → ${ips.slice(0, 6).join(', ')}${ips.length > 6 ? ` …and ${ips.length - 6} more` : ''}`, data: ips };
      } catch (e) {
        return fail(e, `I couldn't look up ${host}.`);
      }
    },
  });

  skills.push({
    id: 'net.traceroute',
    label: 'Trace route',
    icon: '🛰️',
    domain: 'system',
    description: 'Show the hops between this PC and a host — where a slow or broken connection slows or breaks. Up to 20 hops; can take a minute or two.',
    needs: ['network'],
    risk: 'safe',
    examples: ['trace route to github.com'],
    params: { host: { type: 'string', required: true, description: 'a host name or address' } },
    async run(args, ctx) {
      const host = String(args.host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      ctx.say?.(`Tracing the route to ${host} — this can take a minute or two.`, { aloud: false });
      try {
        const lines = await platform.traceRoute!(host);
        const hops = lines.filter((l) => /^\d+\s/.test(l));
        ctx.showResults?.(
          hops.map((l) => ({ title: l, icon: '🛰️' })),
          { title: `Route to ${host}`, subtitle: `${hops.length} hops` },
        );
        return { ok: true, spoken: true, message: `🛰️ ${hops.length} hops to ${host}.`, data: lines };
      } catch (e) {
        return fail(e, `I couldn't trace the route to ${host}.`);
      }
    },
  });

  skills.push({
    id: 'system.processInfo',
    label: 'About a running process',
    icon: '🔬',
    domain: 'system',
    description: 'Where a running program lives on disk, how much memory it holds and how long it has been up. It never reads out the command line.',
    needs: ['processes'],
    risk: 'safe',
    examples: ['where is discord running from'],
    params: { name: { type: 'string', required: true, description: 'the program, or a process id' } },
    async run(args, ctx) {
      const query = String(args.name ?? '').trim();
      try {
        let pids: number[];
        if (/^\d+$/.test(query)) {
          pids = [Number(query)];
        } else {
          const [processes, windows] = await Promise.all([platform.runningProcesses!(2000), platform.listWindows ? platform.listWindows().catch(() => []) : Promise.resolve([])]);
          const m = matchRunningProcess(query, processes, windows, { includeProtected: true });
          if (m.kind === 'none') return { ok: false, error: `${query} isn't running.` };
          if (m.kind === 'many') return { ok: false, error: `More than one thing matches “${query}”: ${m.names.slice(0, 5).join(', ')}. Which one?` };
          pids = m.pids;
        }
        // Several processes of one program share a file; the first one that answers will do.
        const results = [];
        for (const pid of pids.slice(0, 3)) {
          try {
            results.push(await platform.processDetails!(pid));
          } catch {
            /* gone since the list was taken */
          }
        }
        const d = results[0];
        if (!d) return { ok: false, error: `${query} stopped running before I could look.` };
        ctx.showResults?.(
          [{ title: d.name, subtitle: d.path ?? 'path not available (a protected process)', icon: '🔬', actions: d.path ? [{ label: 'Show in folder', skill: 'files.reveal', args: { path: d.path } }] : [] }],
          { title: 'Process', subtitle: `${pids.length} running` },
        );
        return {
          ok: true,
          spoken: true,
          message: `🔬 ${d.name}${pids.length > 1 ? ` (${pids.length} processes)` : ''}: ${d.path ?? 'path not available'} · ${mb(d.memoryBytes)} · up ${duration(d.runningSeconds)}.`,
          data: results,
        };
      } catch (e) {
        return fail(e, "I couldn't look at that process.");
      }
    },
  });

  skills.push({
    id: 'system.firmware',
    label: 'BIOS, motherboard and names',
    icon: '🧬',
    domain: 'system',
    description: 'The BIOS version and date, the motherboard, this computer’s name and who is signed in.',
    needs: ['system'],
    risk: 'safe',
    examples: ['what is my bios version', 'what is my computer name'],
    params: {},
    async run() {
      try {
        const f = await platform.firmwareInfo!();
        const board = [f.boardMaker, f.boardModel].filter(Boolean).join(' ');
        const bios = [f.biosVendor, f.biosVersion].filter(Boolean).join(' ');
        return {
          ok: true,
          message: `🧬 ${f.computerName} (signed in as ${f.userName}) · motherboard ${board || 'unknown'} · BIOS ${bios || 'unknown'}${f.biosDate ? `, ${f.biosDate}` : ''}.`,
          data: f,
        };
      } catch (e) {
        return fail(e, "I couldn't read that.");
      }
    },
  });

  skills.push({
    id: 'security.status',
    label: 'Security status',
    icon: '🛡️',
    domain: 'system',
    description: 'Whether the Windows firewall and Defender real-time protection are on, and whether Atlas is running as administrator. It only reads.',
    needs: ['system'],
    risk: 'safe',
    examples: ['is the firewall on', 'is defender running'],
    params: {},
    async run() {
      try {
        const s = await platform.securityStatus!();
        const fw = [s.firewallDomain, s.firewallPrivate, s.firewallPublic];
        const fwText = fw.every((v) => v === true) ? 'on for every network type' : fw.every((v) => v === false) ? 'off' : `domain ${onOff(s.firewallDomain)}, private ${onOff(s.firewallPrivate)}, public ${onOff(s.firewallPublic)}`;
        const df = s.defenderRealtime === null ? 'Defender real-time protection: not readable (another antivirus may be in charge)' : `Defender real-time protection is ${s.defenderRealtime ? 'on' : 'off'}`;
        return { ok: true, message: `🛡️ Firewall ${fwText}. ${df}. Atlas ${s.atlasElevated ? 'is' : 'is not'} running as administrator.`, data: s };
      } catch (e) {
        return fail(e, "I couldn't read the security status.");
      }
    },
  });

  skills.push({
    id: 'app.restart',
    label: 'Restart an app',
    icon: '🔄',
    domain: 'apps',
    description: 'Close a running app and open the same one again. It reopens exactly the program it closed — an app with a similar name is never substituted.',
    needs: ['processes', 'window-control'],
    // Unsaved work in it is lost, the same as ending any process.
    risk: 'confirm',
    confirmAs: (a) => `close ${String(a.name)} and open it again (unsaved work in it is lost)`,
    examples: ['restart discord'],
    params: { name: { type: 'string', required: true, description: 'the app' } },
    async run(args) {
      const name = String(args.name ?? '').trim();
      try {
        const [processes, windows] = await Promise.all([platform.runningProcesses!(2000), platform.listWindows ? platform.listWindows().catch(() => []) : Promise.resolve([])]);
        const m = matchRunningProcess(name, processes, windows);
        if (m.kind === 'none') return { ok: false, error: `${name} isn't running, so there's nothing to restart. Say "open ${name}" to start it.` };
        if (m.kind === 'many') return { ok: false, error: `More than one thing matches “${name}”: ${m.names.slice(0, 5).join(', ')}. Which one?` };
        // Remember exactly which program it was before closing it.
        const before = await platform.processDetails!(m.pids[0]!).catch(() => null);
        for (const pid of m.pids) await platform.endProcess!(pid);
        await new Promise((r) => setTimeout(r, 1200));

        // 1. An installed app with exactly the name said, or exactly the process's own name.
        const wanted = [name, m.name.replace(/\.exe$/i, '')].map((x) => x.toLowerCase());
        const apps = (await platform.listApps?.().catch(() => [])) ?? [];
        const exact = apps.filter((a) => wanted.includes(a.name.toLowerCase()));
        if (exact.length === 1 && (await platform.launchApp?.(exact[0]!.id))) {
          return { ok: true, message: `🔄 Restarted ${exact[0]!.name}.` };
        }
        // 2. The very file that was running.
        if (before?.path && (await platform.openPath?.(before.path).catch(() => false))) {
          return { ok: true, message: `🔄 Restarted ${m.name}.` };
        }
        return { ok: true, message: `🔄 Closed ${m.name}, but I couldn't be sure which app to reopen. Say “open …” and the name.` };
      } catch (e) {
        return fail(e, `I couldn't restart ${name}.`);
      }
    },
  });

  return skills;
}
