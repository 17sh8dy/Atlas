/**
 * Checking a watch's condition against the machine.
 *
 * Every probe is a *read* through a Platform method Atlas already has —
 * `runningProcesses`, `listDir`, `pathInfo`, `networkReachable`. None of them
 * changes anything, so a probe can run every few seconds for a day without a
 * single side effect, and a probe that throws is treated as "not yet" rather
 * than as the condition holding.
 *
 * ── Reliability after a gap ────────────────────────────────────────────────
 * A watch restored after Atlas was closed may find its condition already true.
 * Whether it is safe to act on that depends on what kind of fact it is:
 *
 *  - A **state** can be read now and means the same as it would have then: the
 *    download's file is there and complete, the path exists, the network is up,
 *    the app is running. Acting on it late is still acting on the truth.
 *  - An **event** cannot: "cargo exited" read after a reboot is true because
 *    the reboot killed it, not because the build finished. Acting on that runs
 *    the tests against a build that never completed. So an event observed
 *    across a gap is put to the person instead of acted on.
 *
 * `after` is a time, and time passing is a state — but ten minutes that turned
 * into ten hours is not what "in ten minutes" meant, so it is only reliable
 * when it is barely late. See `reliableAfterGap`.
 */

import type { Platform, WatchBaseline, WatchCondition } from '@atlas/core';
import { imageKey, matchRunningProcess } from '../text/processes';

/** Extensions browsers give a download that has not finished yet. */
export const PARTIAL_DOWNLOAD_EXTENSIONS: readonly string[] = [
  'crdownload', // Chrome, Edge, Brave, Opera, Vivaldi
  'part', // Firefox
  'partial', // old Edge / IE
  'download', // Safari-style
  'opdownload', // old Opera
];

export function isPartialDownload(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return PARTIAL_DOWNLOAD_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** What one check of a condition found. */
export interface ProbeResult {
  met: boolean;
  /**
   * What was seen, in words — "cargo.exe is no longer running", "Setup.exe
   * finished downloading". Used in the notification and the report, so it is
   * always something observed, never something assumed.
   */
  detail: string;
  /**
   * The condition can never hold now — the download disappeared without a
   * finished file. The watch fails with this sentence rather than waiting out
   * its expiry for something that has already not happened.
   */
  failed?: string;
}

/** The condition in words, for the list and the approval card. */
export function describeCondition(condition: WatchCondition): string {
  switch (condition.kind) {
    case 'process-exits':
      return `${condition.label ?? condition.name} finishes (${condition.name} exits)`;
    case 'process-starts':
      return `${condition.label ?? condition.name} starts`;
    case 'downloads-finish':
      return condition.partials.length === 1
        ? `the download of ${stripPartial(condition.partials[0]!)} finishes`
        : `${condition.partials.length} downloads finish`;
    case 'path-exists':
      return `${condition.path} exists`;
    case 'online':
      return 'the internet is back';
    case 'after':
      return `${describeSeconds(condition.seconds)} pass`;
  }
}

export function describeSeconds(seconds: number): string {
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/** "Unconfirmed 123.crdownload" → "Unconfirmed 123"; "Setup.exe.part" → "Setup.exe". */
export function stripPartial(name: string): string {
  return isPartialDownload(name) ? name.slice(0, name.lastIndexOf('.')) : name;
}

/**
 * May a condition found already true on a watch's first check after a restart
 * be acted on without asking? See this file's header.
 */
export function reliableAfterGap(condition: WatchCondition, overdueMs: number): boolean {
  switch (condition.kind) {
    case 'process-exits':
      return false;
    case 'after':
      return overdueMs <= 5 * 60 * 1000;
    case 'process-starts':
    case 'downloads-finish':
    case 'path-exists':
    case 'online':
      return true;
  }
}

/** Check a condition once. Never throws: a failed read is "not yet". */
export async function probeCondition(
  condition: WatchCondition,
  platform: Platform,
  baseline: WatchBaseline,
  now: number,
): Promise<ProbeResult> {
  try {
    return await probe(condition, platform, baseline, now);
  } catch {
    return { met: false, detail: 'I couldn’t check just now; I’ll try again.' };
  }
}

async function probe(
  condition: WatchCondition,
  platform: Platform,
  baseline: WatchBaseline,
  now: number,
): Promise<ProbeResult> {
  switch (condition.kind) {
    case 'process-exits':
    case 'process-starts': {
      if (!platform.runningProcesses)
        return { met: false, detail: 'I can’t see running programs here.' };
      const processes = await platform.runningProcesses(2000);
      // An exit is watched on the exact image name resolved when the watch
      // began. A start cannot be — the app wasn't running, so its image name
      // was never seen — and is matched the way a person named it instead.
      const running =
        condition.kind === 'process-exits'
          ? processes.some((p) => imageKey(p.name) === imageKey(condition.name))
          : matchRunningProcess(condition.name, processes).kind !== 'none';
      const label = condition.label ?? condition.name;
      if (condition.kind === 'process-exits') {
        return running
          ? { met: false, detail: `${label} is still running.` }
          : { met: true, detail: `${label} is no longer running.` };
      }
      return running
        ? { met: true, detail: `${label} is running.` }
        : { met: false, detail: `${label} isn’t running yet.` };
    }

    case 'downloads-finish': {
      if (!platform.listDir) return { met: false, detail: 'I can’t read folders here.' };
      const entries = await platform.listDir(condition.folder, 500);
      const names = new Set(entries.map((e) => e.name.toLowerCase()));
      const waiting = condition.partials.filter((p) => names.has(p.toLowerCase()));
      if (waiting.length) {
        return {
          met: false,
          detail: `${waiting.length} download${waiting.length === 1 ? ' is' : 's are'} still in progress.`,
        };
      }
      // The partials are gone. Finished means a real file took their place;
      // gone with nothing new means the download was cancelled.
      const finished = entries
        .filter(
          (e) =>
            !e.isDirectory &&
            !isPartialDownload(e.name) &&
            (e.modifiedAt ?? 0) >= baseline.startedAt - 5_000,
        )
        .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
      const expected = condition.partials.map((p) => stripPartial(p).toLowerCase());
      const named = finished.filter((e) => expected.includes(e.name.toLowerCase()));
      const shown = (named.length ? named : finished).slice(0, 3).map((e) => e.name);
      if (!shown.length) {
        return {
          met: false,
          detail: 'The download is gone and no finished file replaced it.',
          failed:
            'The download disappeared without leaving a finished file — it looks like it was cancelled.',
        };
      }
      return { met: true, detail: `Finished downloading: ${shown.join(', ')}.` };
    }

    case 'path-exists': {
      if (!platform.pathInfo) return { met: false, detail: 'I can’t check paths here.' };
      try {
        const info = await platform.pathInfo(condition.path);
        return { met: true, detail: `${info.name || condition.path} is there.` };
      } catch {
        return { met: false, detail: `${condition.path} isn’t there yet.` };
      }
    }

    case 'online': {
      if (!platform.networkReachable)
        return { met: false, detail: 'I can’t check the network here.' };
      return (await platform.networkReachable())
        ? { met: true, detail: 'The internet is reachable again.' }
        : { met: false, detail: 'Still offline.' };
    }

    case 'after': {
      const due = baseline.startedAt + condition.seconds * 1000;
      return now >= due
        ? { met: true, detail: `${describeSeconds(condition.seconds)} have passed.` }
        : { met: false, detail: `Due ${new Date(due).toLocaleTimeString()}.` };
    }
  }
}

/** When a condition was due, for `reliableAfterGap` — only `after` has a due time. */
export function dueAt(condition: WatchCondition, baseline: WatchBaseline): number | null {
  return condition.kind === 'after' ? baseline.startedAt + condition.seconds * 1000 : null;
}

/**
 * A stable fingerprint of a watch's continuation — what the person approved.
 * FNV-1a over canonical JSON (keys sorted), so the same steps always hash the
 * same whichever order their arguments were built in.
 */
export function fingerprintSteps(
  steps: readonly { skill: string; args: Record<string, unknown> }[],
): string {
  const canonical = JSON.stringify(
    steps.map((s) => [
      s.skill,
      Object.keys(s.args)
        .sort()
        .map((k) => [k, s.args[k]]),
    ]),
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `w1-${hash.toString(16).padStart(8, '0')}-${canonical.length}`;
}
