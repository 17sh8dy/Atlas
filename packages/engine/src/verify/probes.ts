/**
 * The probe runner: answers `Probe` questions with the platform's read-only calls.
 *
 * It can only read. Every probe maps to something Atlas already does to *look* at the machine
 * (a path probe, the process list, the window list); nothing here can change anything, which
 * is what makes it safe to run after any skill in any execution mode.
 *
 * Two kinds of fact are treated differently on purpose:
 *  - a path either is or is not there the moment a file operation returns, so a path probe is
 *    read once;
 *  - a program takes time to appear or to exit, so a process or window probe polls until it
 *    reads as expected or a short deadline passes. Missing the deadline means "not seen yet",
 *    which the caller records as unconfirmed rather than announcing as a failure.
 */

import type { Platform, ProbeResult, ProbeSpec, ProcessEntry, WindowEntry } from '@atlas/core';
import { imageKey, matchRunningProcess } from '../text/processes';

export type ProbeRunner = (
  probes: readonly ProbeSpec[],
  signal?: { aborted: boolean },
) => Promise<ProbeResult[]>;

export interface ProbeRunnerOptions {
  /** How long a process or window probe keeps looking. */
  waitMs?: number;
  pollMs?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

type ReadablePlatform = Pick<Platform, 'probePath' | 'runningProcesses' | 'listWindows'>;
type Snapshot = { processes: ProcessEntry[]; windows: WindowEntry[] };

const NO_SUCH_PATH = /no such path|not found|doesn[’']?t exist|does not exist|cannot find/i;

function short(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

export function createProbeRunner(
  platform: ReadablePlatform,
  options: ProbeRunnerOptions = {},
): ProbeRunner {
  const waitMs = options.waitMs ?? 4000;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  async function readPath(
    path: string,
  ): Promise<{ exists: true; isDirectory: boolean } | { exists: false } | null> {
    if (!platform.probePath) return null;
    try {
      const info = await platform.probePath(path);
      return { exists: true, isDirectory: info.isDirectory };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      // Only a clear "nothing there" is an answer; a refusal or an I/O error is "could not read".
      return NO_SUCH_PATH.test(text) ? { exists: false } : null;
    }
  }

  async function readState(): Promise<Snapshot | null> {
    if (!platform.runningProcesses && !platform.listWindows) return null;
    try {
      const [processes, windows] = await Promise.all([
        platform.runningProcesses?.(2000) ?? Promise.resolve([]),
        platform.listWindows?.() ?? Promise.resolve([]),
      ]);
      return { processes, windows };
    } catch {
      return null;
    }
  }

  /** Poll until `done` or the deadline; the last reading, or null if it could never be read. */
  async function poll(done: (s: Snapshot) => boolean, signal?: { aborted: boolean }) {
    const deadline = now() + waitMs;
    let state = await readState();
    while (state && !done(state) && now() < deadline && !signal?.aborted) {
      await sleep(pollMs);
      state = await readState();
    }
    return state;
  }

  const running = (name: string, s: Snapshot) =>
    matchRunningProcess(name, s.processes, s.windows).kind !== 'none';

  async function one(spec: ProbeSpec, signal?: { aborted: boolean }): Promise<ProbeResult> {
    const unknown = (evidence: string): ProbeResult => ({ probe: spec, state: 'unknown', evidence });
    const confirmed = (evidence: string): ProbeResult => ({ probe: spec, state: 'confirmed', evidence });
    const contradicted = (evidence: string): ProbeResult => ({ probe: spec, state: 'contradicted', evidence });

    switch (spec.kind) {
      case 'path-exists':
      case 'path-is-folder':
      case 'path-is-file': {
        const found = await readPath(spec.path);
        if (!found) return unknown(`couldn’t check ${short(spec.path)}`);
        if (!found.exists) return contradicted(`nothing is at ${short(spec.path)}`);
        if (spec.kind === 'path-is-folder' && !found.isDirectory)
          return contradicted(`${short(spec.path)} is a file, not a folder`);
        if (spec.kind === 'path-is-file' && found.isDirectory)
          return contradicted(`${short(spec.path)} is a folder, not a file`);
        return confirmed(`${short(spec.path)} is there`);
      }
      case 'path-absent': {
        const found = await readPath(spec.path);
        if (!found) return unknown(`couldn’t check ${short(spec.path)}`);
        return found.exists
          ? contradicted(`${short(spec.path)} is still there`)
          : confirmed(`${short(spec.path)} is gone`);
      }
      case 'process-running': {
        const s = await poll((st) => running(spec.name, st), signal);
        if (!s) return unknown('couldn’t read the running programs');
        return running(spec.name, s)
          ? confirmed(`${spec.name} is running`)
          : contradicted(`I haven’t seen ${spec.name} running yet`);
      }
      case 'process-stopped': {
        const s = await poll((st) => !running(spec.name, st), signal);
        if (!s) return unknown('couldn’t read the running programs');
        return running(spec.name, s)
          ? contradicted(`${spec.name} is still running`)
          : confirmed(`${spec.name} is not running`);
      }
      case 'window-open': {
        const key = imageKey(spec.match);
        const wanted = spec.match.toLowerCase();
        const open = (st: Snapshot) =>
          st.windows.some((w) => imageKey(w.processName) === key || w.title.toLowerCase().includes(wanted));
        const s = await poll(open, signal);
        if (!s) return unknown('couldn’t read the open windows');
        return open(s) ? confirmed(`a ${spec.match} window is open`) : contradicted(`no ${spec.match} window is open`);
      }
    }
  }

  return async (probes, signal) => {
    const out: ProbeResult[] = [];
    for (const spec of probes) {
      if (signal?.aborted) {
        out.push({ probe: spec, state: 'unknown', evidence: 'stopped before it could be checked' });
      } else {
        out.push(await one(spec, signal));
      }
    }
    return out;
  };
}
