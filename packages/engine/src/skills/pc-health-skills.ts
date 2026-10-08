/**
 * PC health, read-only — 1.0.8. Live CPU / RAM / GPU / disk, recent Windows errors, installed
 * software, drivers, network usage, and one evidence-based report that puts them together.
 *
 * Every skill here is `safe` because every one only reads: the native side is `pc_health.rs`, whose
 * scripts are fixed constants and whose registry access is read-only. Nothing here can change a
 * driver, a startup entry or a setting — the report *suggests* those, in words, and the person asks
 * for them separately where Atlas has a tool for it.
 *
 * Text that comes from outside (an event-log message, a program's name) is shown as data. It is
 * never acted on, and never reaches a model as an instruction.
 *
 * It reuses `system.processes`, `system.startupApps` and `system.specs` instead of duplicating them:
 * the report reads the same platform calls those skills read.
 */

import type { Platform, Skill, SkillContext } from '@atlas/core';
import { analyzePc, bytesText, formatReport, gb, groupErrors, pct, rate, type PcEvidence } from './pc-report';

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

const STOPPED = 'Stopped before it finished.';
const stopped = (ctx: SkillContext) => ctx.signal?.aborted === true;

function clock(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d ? `${d}d` : '', h ? `${h}h` : '', !d && m ? `${m}m` : ''].filter(Boolean).join(' ') || 'under a minute';
}

const clampInt = (value: unknown, fallback: number, lo: number, hi: number): number => {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
};

const local = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

export function createPcHealthSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'system.metrics',
    label: 'Live PC metrics',
    icon: '📈',
    domain: 'system',
    description:
      'A live reading of CPU, memory, GPU, disks and network speed, plus the programs using the most CPU and memory. Takes about a second. It only reads.',
    needs: ['system'],
    risk: 'safe',
    examples: ['how is my PC doing', 'live cpu and ram usage', 'which programs use the most cpu and memory', 'how much gpu am i using'],
    params: {},
    async run(_args, ctx) {
      if (!platform.liveMetrics) return { ok: false, error: "I can't read live metrics in this build." };
      try {
        const [m, gpu, net] = await Promise.all([
          platform.liveMetrics(),
          platform.gpuLive ? platform.gpuLive().catch(() => null) : Promise.resolve(null),
          platform.networkUsage ? platform.networkUsage().catch(() => null) : Promise.resolve(null),
        ]);
        if (stopped(ctx)) return { ok: false, error: STOPPED };
        const memPct = m.memoryTotalBytes ? (m.memoryUsedBytes / m.memoryTotalBytes) * 100 : 0;
        const lines = [
          `📈 CPU ${pct(m.cpuPercent)} (${m.cpuCores} threads) · memory ${pct(memPct)} — ${gb(m.memoryUsedBytes)} of ${gb(m.memoryTotalBytes)}`,
        ];
        if (gpu && (gpu.utilizationPercent !== null || gpu.names.length)) {
          lines.push(`GPU ${gpu.utilizationPercent !== null ? pct(gpu.utilizationPercent) : 'load not available'}${gpu.dedicatedUsedBytes !== null ? ` · ${gb(gpu.dedicatedUsedBytes)} of its memory in use` : ''}${gpu.names[0] ? ` · ${gpu.names.join(', ')}` : ''}`);
        } else {
          lines.push('GPU: Windows gave no load reading.');
        }
        lines.push(`Disks: ${m.disks.map((d) => `${d.mount.replace(/\\$/, '')} ${gb(d.usedBytes)}/${gb(d.totalBytes)}`).join(' · ') || 'none read'}`);
        const live = (net ?? []).filter((n) => n.receivedPerSec + n.sentPerSec > 0).slice(0, 2);
        if (live.length) lines.push(`Network: ${live.map((n) => `${n.name} ↓${rate(n.receivedPerSec)} ↑${rate(n.sentPerSec)}`).join(' · ')}`);
        if (m.topByCpu.length) lines.push('', 'Using the most CPU:', ...m.topByCpu.slice(0, 3).map((p) => `• ${p.name}${p.instances > 1 ? ` (${p.instances})` : ''} — ${pct(p.cpuPercent)}`));
        if (m.topByMemory.length) lines.push('', 'Using the most memory:', ...m.topByMemory.slice(0, 3).map((p) => `• ${p.name}${p.instances > 1 ? ` (${p.instances})` : ''} — ${bytesText(p.memoryBytes)}`));
        lines.push('', `Up for ${clock(m.uptimeSeconds)}. This is one reading (${m.sampledMs} ms), not a trend.`);
        return { ok: true, message: lines.join('\n'), aloud: false, data: { metrics: m, gpu, network: net } };
      } catch (e) {
        return fail(e, "I couldn't read the live metrics.");
      }
    },
  });

  skills.push({
    id: 'system.errors',
    label: 'Recent Windows errors',
    icon: '🚨',
    domain: 'system',
    description:
      'The critical and error events Windows logged recently (System and Application logs), grouped by source with counts. Default the last 24 hours. It only reads the logs.',
    needs: ['system'],
    risk: 'safe',
    examples: ['show recent windows errors', 'any errors in the event log', 'what crashed in the last 3 days'],
    params: {
      hours: { type: 'number', required: false, description: 'how far back, in hours (1–168, default 24)' },
      limit: { type: 'number', required: false, description: 'the most events to read (1–200, default 100)' },
    },
    async run(args, ctx) {
      if (!platform.recentErrors) return { ok: false, error: "I can't read the Windows event log in this build." };
      const hours = clampInt(args.hours, 24, 1, 168);
      const limit = clampInt(args.limit, 100, 1, 200);
      try {
        const rows = await platform.recentErrors(hours, limit);
        if (stopped(ctx)) return { ok: false, error: STOPPED };
        const span = hours % 24 === 0 && hours >= 24 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
        if (!rows.length) return { ok: true, message: `🚨 No critical or error events in the last ${span}.`, data: { rows, groups: [] } };
        const groups = groupErrors(rows);
        const lines = [
          `🚨 ${rows.length} error event${rows.length === 1 ? '' : 's'} in the last ${span}, from ${groups.length} source${groups.length === 1 ? '' : 's'}:`,
          ...groups.slice(0, 10).map((g) => `• ${g.source} (event ${g.id}) — ${g.count}×, latest ${local(g.last)}${g.sample ? `\n    “${g.sample}”` : ''}`),
        ];
        if (groups.length > 10) lines.push(`• …and ${groups.length - 10} more sources`);
        if (rows.length >= limit) lines.push('', `That is the ${limit} most recent; there may be more.`);
        return { ok: true, message: lines.join('\n'), aloud: false, data: { rows, groups } };
      } catch (e) {
        return fail(e, "I couldn't read the Windows event log.");
      }
    },
  });

  skills.push({
    id: 'system.software',
    label: 'Installed software',
    icon: '📦',
    domain: 'system',
    description: 'The programs installed on this PC (name, version, publisher, size), optionally filtered by a word in the name. It only reads the list Windows keeps.',
    needs: ['system'],
    risk: 'safe',
    examples: ['what software is installed', 'list installed programs', 'what are my biggest programs'],
    params: {
      query: { type: 'string', required: false, description: 'only programs whose name contains this' },
      sort: { type: 'string', required: false, description: "'size' to list the biggest first" },
    },
    async run(args) {
      if (!platform.installedSoftware) return { ok: false, error: "I can't read the installed-software list in this build." };
      try {
        const all = await platform.installedSoftware();
        const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        let rows = q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.publisher.toLowerCase().includes(q)) : all;
        if (args.sort === 'size') rows = [...rows].sort((a, b) => b.sizeKb - a.sizeKb);
        if (!rows.length) return { ok: true, message: q ? `📦 Nothing installed matches “${q}”.` : '📦 I found no installed programs.', data: { apps: [] } };
        const shown = rows.slice(0, 40);
        const lines = [
          q ? `📦 ${rows.length} installed program${rows.length === 1 ? '' : 's'} match “${q}”:` : `📦 ${rows.length} programs installed:`,
          ...shown.map((a) => `• ${a.name}${a.version && !a.name.includes(a.version) ? ` ${a.version}` : ''}${a.publisher ? ` — ${a.publisher}` : ''}${a.sizeKb ? ` · ${bytesText(a.sizeKb * 1024)}` : ''}`),
        ];
        if (rows.length > shown.length) lines.push(`• …and ${rows.length - shown.length} more (add a word to narrow it)`);
        return { ok: true, message: lines.join('\n'), aloud: false, data: { apps: rows } };
      } catch (e) {
        return fail(e, "I couldn't read the installed software.");
      }
    },
  });

  skills.push({
    id: 'system.drivers',
    label: 'Device drivers',
    icon: '🧩',
    domain: 'system',
    description: 'The device drivers installed on this PC (device, maker, version, date), optionally for one kind of device such as display, network or audio. Flags unsigned ones. It only reads.',
    needs: ['system'],
    risk: 'safe',
    examples: ['list my drivers', 'what graphics driver do i have', 'are any drivers unsigned', 'show network drivers'],
    params: { query: { type: 'string', required: false, description: 'a device class or name to filter by, like display or bluetooth' } },
    async run(args, ctx) {
      if (!platform.driverList) return { ok: false, error: "I can't read the driver list in this build." };
      try {
        const all = await platform.driverList();
        if (stopped(ctx)) return { ok: false, error: STOPPED };
        const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const rows = q ? all.filter((d) => d.class.toLowerCase().includes(q) || d.device.toLowerCase().includes(q) || d.manufacturer.toLowerCase().includes(q)) : all;
        if (!rows.length) return { ok: true, message: q ? `🧩 No drivers match “${q}”.` : '🧩 I found no drivers.', data: { drivers: [] } };
        const unsigned = rows.filter((d) => d.signed === false);
        const lines: string[] = [];
        if (q) {
          lines.push(`🧩 ${rows.length} driver${rows.length === 1 ? '' : 's'} match “${q}”:`, ...rows.slice(0, 25).map((d) => `• ${d.device} — ${d.manufacturer || 'unknown maker'} · ${d.version || 'no version'}${d.date ? ` · ${d.date}` : ''}${d.signed === false ? ' · ⚠ unsigned' : ''}`));
          if (rows.length > 25) lines.push(`• …and ${rows.length - 25} more`);
        } else {
          const byClass = new Map<string, number>();
          for (const d of rows) byClass.set(d.class || 'Other', (byClass.get(d.class || 'Other') ?? 0) + 1);
          lines.push(`🧩 ${rows.length} drivers in ${byClass.size} categories: ${[...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, n]) => `${c} ${n}`).join(', ')}.`);
          lines.push('Ask about one kind (“show display drivers”) for versions and dates.');
        }
        lines.push(unsigned.length ? `\n⚠ ${unsigned.length} unsigned: ${unsigned.slice(0, 5).map((d) => d.device).join('; ')}${unsigned.length > 5 ? '…' : ''}` : '\nNone of these is reported as unsigned.');
        return { ok: true, message: lines.join('\n'), aloud: false, data: { drivers: rows } };
      } catch (e) {
        return fail(e, "I couldn't read the drivers.");
      }
    },
  });

  skills.push({
    id: 'net.usage',
    label: 'Network usage',
    icon: '📡',
    domain: 'system',
    description: 'How much data each network adapter has sent and received, and its speed right now (one-second sample). Counters only; it never looks at what the traffic is.',
    needs: ['network'],
    risk: 'safe',
    examples: ['how much data have i used', 'network usage', 'how fast is my network right now'],
    params: {},
    async run(_args, ctx) {
      if (!platform.networkUsage) return { ok: false, error: "I can't read network usage in this build." };
      try {
        const rows = await platform.networkUsage();
        if (stopped(ctx)) return { ok: false, error: STOPPED };
        if (!rows.length) return { ok: true, message: '📡 No network adapter has moved any data.', data: { adapters: [] } };
        const lines = ['📡 Network usage (totals are since the adapter came up):', ...rows.slice(0, 6).map((n) => `• ${n.name} — ↓ ${bytesText(n.receivedBytes)} · ↑ ${bytesText(n.sentBytes)} · now ↓ ${rate(n.receivedPerSec)} ↑ ${rate(n.sentPerSec)}`)];
        return { ok: true, message: lines.join('\n'), aloud: false, data: { adapters: rows } };
      } catch (e) {
        return fail(e, "I couldn't read network usage.");
      }
    },
  });

  skills.push({
    id: 'system.report',
    label: 'PC performance report',
    icon: '🩺',
    domain: 'system',
    description:
      'An evidence-based report on how the PC is performing: live CPU, memory, GPU and disk readings, recent Windows errors, drivers, startup programs and network use, with what each points to and what to do. Every finding quotes its evidence, and anything it could not measure is listed. It only reads; it changes nothing.',
    needs: ['system'],
    risk: 'safe',
    examples: ['why is my pc slow', 'pc performance report', 'diagnose my computer', 'is anything wrong with my pc'],
    params: { hours: { type: 'number', required: false, description: 'how far back to look for errors (1–168, default 24)' } },
    async run(args, ctx) {
      const hours = clampInt(args.hours, 24, 1, 168);
      const unavailable: string[] = [];
      const take = async <T>(label: string, available: boolean, fn: () => Promise<T>): Promise<T | null> => {
        if (!available) {
          unavailable.push(`${label} (not supported in this build)`);
          return null;
        }
        try {
          return await fn();
        } catch (e) {
          unavailable.push(`${label} (${e instanceof Error ? e.message : 'failed'})`);
          return null;
        }
      };
      const [metrics, gpu, errors, drivers, startup, network] = await Promise.all([
        take('CPU, memory and disks', !!platform.liveMetrics, () => platform.liveMetrics!()),
        take('GPU', !!platform.gpuLive, () => platform.gpuLive!()),
        take('Windows errors', !!platform.recentErrors, () => platform.recentErrors!(hours, 150)),
        take('drivers', !!platform.driverList, () => platform.driverList!()),
        take('startup programs', !!platform.startupApps, () => platform.startupApps!()),
        take('network', !!platform.networkUsage, () => platform.networkUsage!()),
      ]);
      if (stopped(ctx)) return { ok: false, error: STOPPED };
      if (!metrics && !errors && !drivers && !startup) return { ok: false, error: `I couldn't take any readings, so there's nothing to report. ${unavailable.join('; ')}.` };
      if (gpu && gpu.utilizationPercent === null) unavailable.push('GPU load (Windows has no counters for it here)');
      const evidence: PcEvidence = { metrics, gpu, errors, errorHours: hours, drivers, startup, software: null, network, unavailable };
      const report = analyzePc(evidence);
      return { ok: true, message: formatReport(report, evidence), aloud: false, data: { report, evidence } };
    },
  });

  return skills;
}
