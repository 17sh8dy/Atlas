/**
 * The PC performance report: what was measured, what that points to, and what was NOT measured.
 *
 * Everything here is a pure function of readings that `pc-health-skills.ts` collected, so the same
 * numbers always give the same report and no model is involved. A finding is only ever made from
 * a number or an event that is quoted next to it ("evidence"); a reading that could not be taken
 * is listed as unavailable rather than guessed at. The suggestions name things the person can do
 * or ask Atlas for — the report itself changes nothing.
 *
 * One sample is one sample: CPU and GPU load are a moment, not a trend. The report says so, and
 * never states a cause with more certainty than the evidence carries.
 */

import type { AdapterUsage, DriverRow, EventRow, GpuLive, InstalledApp, LiveMetrics, StartupApp } from '@atlas/core';

export type Severity = 'high' | 'warn' | 'info';
export type Area = 'cpu' | 'memory' | 'gpu' | 'disk' | 'network' | 'errors' | 'drivers' | 'startup' | 'uptime';

export interface Finding {
  severity: Severity;
  area: Area;
  title: string;
  /** The numbers or events this is based on. */
  evidence: string;
  suggestion: string;
}

export interface PcEvidence {
  metrics: LiveMetrics | null;
  gpu: GpuLive | null;
  errors: EventRow[] | null;
  errorHours: number;
  drivers: DriverRow[] | null;
  startup: StartupApp[] | null;
  software: InstalledApp[] | null;
  network: AdapterUsage[] | null;
  /** Readings that could not be taken, in plain words. */
  unavailable: string[];
  /** For testing the age of drivers deterministically. */
  now?: number;
}

export interface PcReport {
  findings: Finding[];
  /** The resource that looks like the limit right now, or null when none does. */
  bottleneck: Area | null;
  verdict: string;
  unavailable: string[];
}

export const GB = 1024 ** 3;
export const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;
export const pct = (n: number) => `${Math.round(n)}%`;
export const rate = (bytesPerSec: number) =>
  bytesPerSec >= 1024 ** 2 ? `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s` : bytesPerSec >= 1024 ? `${Math.round(bytesPerSec / 1024)} KB/s` : `${bytesPerSec} B/s`;
export const bytesText = (b: number) =>
  b >= GB ? `${(b / GB).toFixed(1)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${Math.max(0, Math.round(b))} bytes`;

/** Sources whose errors point at hardware or a failing driver rather than at one program. */
const HARDWARE_SOURCES: Array<[RegExp, string]> = [
  [/^microsoft-windows-whea-logger$|^whea-logger$/i, 'Windows reported a hardware error (WHEA).'],
  [/^disk$|^ntfs$|^volmgr$|^storahci$|^stornvme$/i, 'Windows reported a storage problem.'],
  [/^kernel-power$/i, 'The PC restarted or lost power without a clean shutdown.'],
  [/^bugcheck$/i, 'Windows crashed with a blue screen.'],
  [/^nvlddmkm$|^amdkmdag$|^amdkmdap$|^display$|^igfx/i, 'The graphics driver reported a problem.'],
];

export function groupErrors(errors: ReadonlyArray<EventRow>): Array<{ source: string; id: number; count: number; level: string; sample: string; last: string }> {
  const by = new Map<string, { source: string; id: number; count: number; level: string; sample: string; last: string }>();
  for (const e of errors) {
    const key = `${e.source}|${e.id}`;
    const g = by.get(key) ?? { source: e.source, id: e.id, count: 0, level: e.level, sample: e.message, last: e.time };
    g.count += 1;
    if (e.time > g.last) g.last = e.time;
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

export function analyzePc(e: PcEvidence): PcReport {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const m = e.metrics;

  if (m) {
    const topCpu = m.topByCpu[0];
    if (m.cpuPercent >= 85) {
      add({
        severity: 'high',
        area: 'cpu',
        title: 'The processor is close to its limit',
        evidence: `CPU at ${pct(m.cpuPercent)} over ${m.sampledMs} ms${topCpu ? `; ${topCpu.name} is using about ${pct(topCpu.cpuPercent)} of it` : ''}.`,
        suggestion: topCpu ? `If ${topCpu.name} isn't something you're using, you can close it ("end process ${topCpu.name.replace(/\.exe$/i, '')}").` : 'Check what is running ("what is using my CPU").',
      });
    } else if (m.cpuPercent >= 60) {
      add({ severity: 'warn', area: 'cpu', title: 'The processor is fairly busy', evidence: `CPU at ${pct(m.cpuPercent)}${topCpu ? `, mostly ${topCpu.name}` : ''}.`, suggestion: 'One reading is a moment, not a trend — ask again while the slowness is happening.' });
    }

    const memPct = m.memoryTotalBytes ? (m.memoryUsedBytes / m.memoryTotalBytes) * 100 : 0;
    const topMem = m.topByMemory[0];
    if (memPct >= 90) {
      add({
        severity: 'high',
        area: 'memory',
        title: 'Memory is nearly full',
        evidence: `${gb(m.memoryUsedBytes)} of ${gb(m.memoryTotalBytes)} in use (${pct(memPct)})${topMem ? `; the biggest user is ${topMem.name} at ${bytesText(topMem.memoryBytes)}` : ''}.`,
        suggestion: 'Close programs you are not using, or restart the biggest one. Windows slows down sharply once memory runs out and it starts using the disk instead.',
      });
    } else if (memPct >= 80) {
      add({ severity: 'warn', area: 'memory', title: 'Memory use is high', evidence: `${gb(m.memoryUsedBytes)} of ${gb(m.memoryTotalBytes)} in use (${pct(memPct)}).`, suggestion: topMem ? `${topMem.name} is the biggest user (${bytesText(topMem.memoryBytes)}).` : 'Close what you are not using.' });
    }
    if (m.swapTotalBytes > 0 && m.swapUsedBytes / m.swapTotalBytes >= 0.6 && memPct >= 70) {
      add({ severity: 'warn', area: 'memory', title: 'Windows is leaning on the page file', evidence: `${gb(m.swapUsedBytes)} of ${gb(m.swapTotalBytes)} page file in use alongside ${pct(memPct)} memory.`, suggestion: 'That points at not enough memory for what is open.' });
    }

    for (const d of m.disks) {
      const used = d.totalBytes ? (d.usedBytes / d.totalBytes) * 100 : 0;
      const label = d.mount || d.name || 'a drive';
      if (used >= 95) {
        add({ severity: 'high', area: 'disk', title: `${label} is almost full`, evidence: `${gb(d.usedBytes)} of ${gb(d.totalBytes)} used (${pct(used)}).`, suggestion: 'Free space: "what is using space on ' + label.replace(/\\$/, '') + '" or "review cleanup".' });
      } else if (used >= 88) {
        add({ severity: 'warn', area: 'disk', title: `${label} is getting full`, evidence: `${gb(d.usedBytes)} of ${gb(d.totalBytes)} used (${pct(used)}).`, suggestion: 'Windows and SSDs work best with 10–15% free. "review cleanup" lists what can go.' });
      }
    }

    const days = m.uptimeSeconds / 86400;
    if (days >= 14) {
      add({ severity: 'info', area: 'uptime', title: 'The PC has been on for a long time', evidence: `Up for ${Math.floor(days)} days.`, suggestion: 'A restart clears leaks and finishes pending updates.' });
    }
  }

  if (e.gpu && e.gpu.utilizationPercent !== null) {
    const u = e.gpu.utilizationPercent;
    if (u >= 90) {
      add({ severity: 'warn', area: 'gpu', title: 'The graphics card is working flat out', evidence: `GPU load ${pct(u)}${e.gpu.names[0] ? ` on ${e.gpu.names[0]}` : ''}${e.gpu.dedicatedUsedBytes !== null ? `, ${gb(e.gpu.dedicatedUsedBytes)} of its own memory in use` : ''}.`, suggestion: 'Expected in a game or video export; if nothing like that is running, check what is using the GPU in Task Manager.' });
    }
  }

  if (e.errors) {
    const groups = groupErrors(e.errors);
    const handled = new Set<string>();
    for (const g of groups) {
      const hw = HARDWARE_SOURCES.find(([re]) => re.test(g.source));
      if (hw && !handled.has(hw[1])) {
        handled.add(hw[1]);
        add({ severity: g.level.toLowerCase() === 'critical' || /whea|bugcheck|kernel-power/i.test(g.source) ? 'high' : 'warn', area: 'errors', title: hw[1], evidence: `${g.source} (event ${g.id}) ${g.count}× in the last ${e.errorHours} h, most recently ${g.last.slice(0, 16).replace('T', ' ')}.`, suggestion: 'A repeated hardware-level event is worth taking seriously: back up what matters and look at that device.' });
      }
    }
    const repeated = groups.filter((g) => g.count >= 5 && !HARDWARE_SOURCES.some(([re]) => re.test(g.source))).slice(0, 3);
    for (const g of repeated) {
      add({ severity: 'warn', area: 'errors', title: `${g.source} keeps reporting errors`, evidence: `Event ${g.id} ${g.count}× in the last ${e.errorHours} h: “${g.sample}”`, suggestion: `Search for “${g.source} event ${g.id}” — a repeating event usually has a known cause.` });
    }
    if (!findings.some((f) => f.area === 'errors') && e.errors.length) {
      add({ severity: 'info', area: 'errors', title: 'A few errors in the Windows logs', evidence: `${e.errors.length} error${e.errors.length === 1 ? '' : 's'} in ${e.errorHours} h, none repeating.`, suggestion: 'Occasional single errors are normal. Ask "show recent errors" for the list.' });
    }
  }

  if (e.drivers) {
    const unsigned = e.drivers.filter((d) => d.signed === false);
    if (unsigned.length) {
      add({ severity: 'warn', area: 'drivers', title: `${unsigned.length} driver${unsigned.length === 1 ? ' is' : 's are'} not signed`, evidence: unsigned.slice(0, 4).map((d) => `${d.device} ${d.version}`).join('; ') + (unsigned.length > 4 ? ` …and ${unsigned.length - 4} more` : ''), suggestion: 'Unsigned drivers are not always a problem (some hardware tools ship them), but check that you recognise them.' });
    }
    const now = e.now ?? Date.now();
    // Only the drivers a person can actually update from the maker: graphics, network, Bluetooth, audio.
    // Windows' own in-box drivers ("(Standard system devices)", Microsoft) are dated 2006 by design.
    const core = new Set(['display', 'net', 'bluetooth', 'media']);
    const old = e.drivers.filter((d) => core.has(d.class.toLowerCase()) && d.date && now - Date.parse(d.date) > 4 * 365 * 86400000 && !/microsoft|^\(standard/i.test(d.manufacturer));
    if (old.length) {
      add({ severity: 'info', area: 'drivers', title: `${old.length} driver${old.length === 1 ? ' is' : 's are'} over four years old`, evidence: old.slice(0, 4).map((d) => `${d.device} (${d.date})`).join('; ') + (old.length > 4 ? ` …and ${old.length - 4} more` : ''), suggestion: 'An old driver is only a problem if something is misbehaving; the maker\'s site has newer ones.' });
    }
  }

  if (e.startup) {
    const on = e.startup.filter((s) => s.enabled);
    if (on.length >= 12) {
      add({ severity: 'warn', area: 'startup', title: 'Many programs start with Windows', evidence: `${on.length} startup items are on.`, suggestion: 'Slow boots and sluggish first minutes come from this. "list startup apps" and turn off what you do not need straight away.' });
    } else if (on.length >= 8) {
      add({ severity: 'info', area: 'startup', title: 'A fair number of startup programs', evidence: `${on.length} startup items are on.`, suggestion: 'Worth a look if boot feels slow: "list startup apps".' });
    }
  }

  if (e.network) {
    const busy = e.network.find((n) => n.receivedPerSec + n.sentPerSec >= 5 * 1024 ** 2);
    if (busy) {
      add({ severity: 'info', area: 'network', title: 'Heavy network traffic right now', evidence: `${busy.name}: ${rate(busy.receivedPerSec)} down, ${rate(busy.sentPerSec)} up.`, suggestion: 'A download, update or upload is likely running; if not, check which program is using the network.' });
    }
  }

  const order: Record<Severity, number> = { high: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const resource = findings.find((f) => (f.area === 'cpu' || f.area === 'memory' || f.area === 'gpu' || f.area === 'disk') && f.severity !== 'info');
  const bottleneck = resource ? resource.area : null;
  const high = findings.filter((f) => f.severity === 'high').length;
  const verdict = bottleneck
    ? `The limit right now looks like ${bottleneck === 'cpu' ? 'the processor' : bottleneck === 'memory' ? 'memory' : bottleneck === 'gpu' ? 'the graphics card' : 'disk space'}.`
    : high
      ? 'Nothing is maxed out, but there are signs of a problem below.'
      : findings.length
        ? 'Nothing is limiting the PC right now; a few things are worth knowing.'
        : 'Nothing is limiting the PC right now, and I found no warning signs.';

  return { findings, bottleneck, verdict, unavailable: e.unavailable };
}

export function formatReport(r: PcReport, e: PcEvidence): string {
  const m = e.metrics;
  const lines: string[] = ['🩺 PC performance report', r.verdict, ''];
  if (m) {
    const memPct = m.memoryTotalBytes ? (m.memoryUsedBytes / m.memoryTotalBytes) * 100 : 0;
    const gpu = e.gpu && e.gpu.utilizationPercent !== null ? ` · GPU ${pct(e.gpu.utilizationPercent)}` : '';
    lines.push(`Right now: CPU ${pct(m.cpuPercent)} · memory ${pct(memPct)} (${gb(m.memoryUsedBytes)} of ${gb(m.memoryTotalBytes)})${gpu} · ${m.disks.map((d) => `${d.mount.replace(/\\$/, '')} ${pct(d.totalBytes ? (d.usedBytes / d.totalBytes) * 100 : 0)} full`).join(', ') || 'no drives read'}`);
    lines.push('');
  }
  if (r.findings.length) {
    const mark = { high: '🔴', warn: '🟠', info: '🔵' } as const;
    for (const f of r.findings) lines.push(`${mark[f.severity]} ${f.title}`, `   Evidence: ${f.evidence}`, `   What to do: ${f.suggestion}`);
    lines.push('');
  }
  if (r.unavailable.length) lines.push(`Not measured: ${r.unavailable.join('; ')}.`);
  lines.push('This is one reading taken just now, not a trend. If the slowness comes and goes, ask me again while it is happening.');
  return lines.join('\n');
}
