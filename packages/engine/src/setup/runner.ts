/**
 * Running a setup: act, then *check*, then report only what was checked.
 *
 * "Recording setup complete. OBS is running, SteelSeries Sonar is your
 * microphone, 347 GB free on D:, and Discord is on the left." Every clause of
 * that sentence is a reading taken after the action, not a record of having
 * clicked something — which is the whole difference between an assistant that
 * says it did a thing and one that knows it worked.
 *
 * ── Order ──────────────────────────────────────────────────────────────────
 *   1. close   what should not be running (asked about on the setup's card)
 *   2. open    what should be, then wait for each process to actually appear
 *   3. place   windows, once they exist, and re-read where they ended up
 *   4. check   microphone, free space, the internet
 *
 * Opening and placing go through the real executor as ordinary `app.open` /
 * `window.place` steps, so they resolve names and respect every gate exactly
 * as a typed request would. Closing is done here, window by window, because
 * the setup's card already listed exactly which apps would close and the
 * person approved that list — the same one-card-for-a-batch rule
 * `files.organize` follows (ARCHITECTURE §6.8).
 */

import type {
  AudioDevices,
  Platform,
  PlanStep,
  ProcessEntry,
  Setup,
  SetupCheck,
  SetupItem,
  SkillContext,
  StepOutcome,
  WindowEntry,
} from '@atlas/core';
import { HaltedError } from '@atlas/core';
import { imageKey, matchRunningProcess } from '../text/processes';
import { describeItem } from './spec';
import { describePosition, pickDisplay, placementBounds } from '../skills/window-skills';
import { fingerprintSteps } from '../watch/conditions';

export interface SetupRunDeps {
  platform: Platform;
  /** One step through the real executor. */
  runStep(step: PlanStep, ctx: SkillContext): Promise<StepOutcome | undefined>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** Games take a while. */
  openTimeoutMs?: number;
  closeTimeoutMs?: number;
  placeTimeoutMs?: number;
  pollMs?: number;
}

export interface MachineState {
  processes: ProcessEntry[];
  windows: WindowEntry[];
}

export async function readState(platform: Platform): Promise<MachineState> {
  const [processes, windows] = await Promise.all([
    platform.runningProcesses?.(2000).catch(() => []) ?? Promise.resolve([]),
    platform.listWindows?.().catch(() => []) ?? Promise.resolve([]),
  ]);
  return { processes: processes ?? [], windows: windows ?? [] };
}

/** What running this setup *now* would change, read off the machine. */
export interface SetupPlan {
  toOpen: string[];
  alreadyOpen: string[];
  toClose: Array<{ app: string; process: string; windows: number }>;
  notRunning: string[];
  places: string[];
  checks: string[];
}

export function planSetup(setup: Setup, state: MachineState): SetupPlan {
  const plan: SetupPlan = {
    toOpen: [],
    alreadyOpen: [],
    toClose: [],
    notRunning: [],
    places: [],
    checks: [],
  };
  for (const item of setup.items) {
    switch (item.kind) {
      case 'open':
        (runningAs(item.process ?? item.app, state) ? plan.alreadyOpen : plan.toOpen).push(
          item.app,
        );
        break;
      case 'close': {
        const hit = runningAs(item.process ?? item.app, state);
        if (hit) {
          const windows = state.windows.filter(
            (w) => imageKey(w.processName) === imageKey(hit),
          ).length;
          plan.toClose.push({ app: item.app, process: hit, windows });
        } else plan.notRunning.push(item.app);
        break;
      }
      case 'place':
        plan.places.push(describeItem(item));
        break;
      default:
        plan.checks.push(describeItem(item));
    }
  }
  return plan;
}

/**
 * What the card approves: which apps close, and which open. A different set
 * by the time `run` starts (someone opened Chrome in between) means a
 * different fingerprint, and `run` stops rather than close something the
 * person did not see listed.
 */
export function planFingerprint(setup: Setup, plan: SetupPlan): string {
  return fingerprintSteps([
    {
      skill: `setup:${setup.name}`,
      args: {
        close: plan.toClose
          .map((c) => imageKey(c.process))
          .sort()
          .join('|'),
        items: JSON.stringify(setup.items),
      },
    },
  ]);
}

/** The card: what will change now, then what will be checked. */
export function planCard(setup: Setup, plan: SetupPlan, isNew: boolean): string {
  const lines: string[] = [];
  if (isNew)
    lines.push(
      `Here’s what “ready for ${setup.name}” will mean — I’ll save it, and you can change it any time in Settings → Setups.`,
      '',
    );
  if (plan.toClose.length) {
    lines.push(
      `Close: ${plan.toClose
        .map((c) => `${c.app}${c.windows > 1 ? ` (${c.windows} windows)` : ''}`)
        .join(', ')} — anything unsaved there will ask first, the way closing it yourself would.`,
    );
  }
  if (plan.toOpen.length) lines.push(`Open: ${plan.toOpen.join(', ')}`);
  if (plan.alreadyOpen.length) lines.push(`Already open: ${plan.alreadyOpen.join(', ')}`);
  if (plan.notRunning.length)
    lines.push(`Not running, nothing to close: ${plan.notRunning.join(', ')}`);
  if (plan.places.length) lines.push(`Arrange: ${plan.places.join('; ')}`);
  if (plan.checks.length) {
    // describeItem reads "Check which microphone…" on its own; under a "Check:" heading
    // that would say it twice.
    lines.push(`Check: ${plan.checks.map((c) => c.replace(/^Check (?:that )?/, '')).join('; ')}`);
  }
  lines.push('', 'Then I’ll check each one actually worked and tell you what I found.');
  return lines.join('\n');
}

function runningAs(name: string, state: MachineState): string | null {
  const match = matchRunningProcess(name, state.processes, state.windows);
  return match.kind === 'one' ? match.name : match.kind === 'many' ? match.names[0]! : null;
}

// ── running ────────────────────────────────────────────────────────────────

export interface SetupOutcome {
  ok: boolean;
  checks: SetupCheck[];
  report: string;
}

export async function runSetup(
  setup: Setup,
  deps: SetupRunDeps,
  ctx: SkillContext,
): Promise<SetupOutcome> {
  const { platform } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const poll = deps.pollMs ?? 1000;
  const halted = () => {
    if (ctx.signal?.aborted) throw new HaltedError();
  };
  const checks: SetupCheck[] = [];
  const say = (item: SetupItem, ok: boolean, observed: string, skipped?: boolean) =>
    checks.push(skipped ? { item, ok, observed, skipped } : { item, ok, observed });
  const activity = ctx.activity;

  /** Poll until `done` or the deadline. */
  async function waitFor(ms: number, done: (s: MachineState) => boolean): Promise<MachineState> {
    const deadline = now() + ms;
    let state = await readState(platform);
    while (!done(state) && now() < deadline) {
      halted();
      await sleep(poll);
      state = await readState(platform);
    }
    return state;
  }

  const items = setup.items;
  const closes = items.filter(
    (i): i is Extract<SetupItem, { kind: 'close' }> => i.kind === 'close',
  );
  const opens = items.filter((i): i is Extract<SetupItem, { kind: 'open' }> => i.kind === 'open');
  const places = items.filter(
    (i): i is Extract<SetupItem, { kind: 'place' }> => i.kind === 'place',
  );

  // 1. Close.
  let state = await readState(platform);
  for (const item of closes) {
    halted();
    const process = runningAs(item.process ?? item.app, state);
    if (!process) {
      say(item, true, `${item.app} wasn’t running`, true);
      continue;
    }
    const handle = activity?.step(`Closing ${item.app}`);
    const windows = state.windows.filter((w) => imageKey(w.processName) === imageKey(process));
    if (!windows.length) {
      handle?.failed('no window to close');
      say(item, false, `${item.app} is running in the background with no window to close`);
      continue;
    }
    for (const w of windows) await platform.closeWindow?.(w.id).catch(() => false);
    state = await waitFor(deps.closeTimeoutMs ?? 12_000, (s) => !runningAs(process, s));
    const gone = !runningAs(process, state);
    handle?.[gone ? 'done' : 'failed'](gone ? 'closed' : 'still open');
    say(
      item,
      gone,
      gone
        ? `${item.app} is closed`
        : `${item.app} is still open — it may be asking about unsaved work`,
    );
  }

  // 2. Open, then wait for every one of them together.
  const waiting: Array<Extract<SetupItem, { kind: 'open' }>> = [];
  state = await readState(platform);
  for (const item of opens) {
    halted();
    if (runningAs(item.process ?? item.app, state)) {
      say(item, true, `${item.app} was already running`);
      continue;
    }
    const outcome = await deps.runStep({ skill: 'app.open', args: { name: item.app } }, ctx);
    if (!outcome?.ok) {
      say(item, false, `I couldn’t open ${item.app}${outcome?.error ? `: ${outcome.error}` : ''}`);
      continue;
    }
    waiting.push(item);
  }
  if (waiting.length) {
    const handle = activity?.step(
      'Waiting for apps to start',
      waiting.map((i) => i.app).join(', '),
    );
    const openMs = deps.openTimeoutMs ?? 90_000;
    state = await waitFor(openMs, (s) => waiting.every((i) => runningAs(i.process ?? i.app, s)));
    for (const item of waiting) {
      const up = runningAs(item.process ?? item.app, state);
      say(
        item,
        Boolean(up),
        up
          ? `${item.app} is running`
          : `${item.app} didn’t start within ${Math.round(openMs / 1000)} seconds`,
      );
    }
    handle?.done();
  }

  // 3. Place, once there is a window to place.
  const displays = places.length ? ((await platform.listDisplays?.().catch(() => [])) ?? []) : [];
  for (const item of places) {
    halted();
    const process = runningAs(item.app, await readState(platform));
    const find = (s: MachineState) =>
      s.windows
        .filter(
          (w) =>
            w.title.trim() &&
            !w.minimized &&
            process &&
            imageKey(w.processName) === imageKey(process),
        )
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const found = find(await waitFor(deps.placeTimeoutMs ?? 20_000, (s) => Boolean(find(s))));
    if (!found) {
      say(item, false, `I couldn’t find a ${item.app} window to move`);
      continue;
    }
    const args: Record<string, string | number> = { name: found.id, position: item.position };
    if (item.display) args.display = item.display;
    const outcome = await deps.runStep({ skill: 'window.place', args }, ctx);
    if (!outcome?.ok) {
      say(item, false, `I couldn’t move ${item.app}${outcome?.error ? `: ${outcome.error}` : ''}`);
      continue;
    }
    await sleep(Math.min(poll, 400));
    const after = (await readState(platform)).windows.find((w) => w.id === found.id);
    const display = pickDisplay(displays, found, item.display);
    const landed = after && display ? isPlaced(after, item.position, display) : Boolean(after);
    say(
      item,
      landed,
      landed
        ? `${item.app} is ${describePosition(item.position)}`
        : `${item.app} didn’t stay where I put it`,
    );
  }

  // 4. Checks.
  let audio: AudioDevices | null | undefined;
  for (const item of items) {
    halted();
    if (item.kind === 'mic') {
      audio ??= await platform.audioDevices?.().catch(() => null);
      const name = audio?.input ?? null;
      if (!platform.audioDevices) say(item, false, 'I can’t read audio devices in this build');
      else if (!name) say(item, false, 'No microphone is set as the default');
      else if (item.expect && !name.toLowerCase().includes(item.expect.toLowerCase())) {
        say(
          item,
          false,
          `Your microphone is ${name}, not ${item.expect} — change it in Sound settings`,
        );
      } else say(item, true, `${name} is your microphone`);
    } else if (item.kind === 'storage') {
      const info = await platform.systemInfo?.().catch(() => null);
      const letter = item.drive.replace(/[:\\/]+$/, '').toUpperCase();
      const disk = info?.disks.find((d) => d.mount.toUpperCase().startsWith(`${letter}:`));
      if (!disk) say(item, false, `There’s no ${letter}: drive`);
      else {
        const freeGb = Math.floor((disk.totalBytes - disk.usedBytes) / 1024 ** 3);
        say(
          item,
          freeGb >= item.minGb,
          freeGb >= item.minGb
            ? `${freeGb} GB free on ${letter}:`
            : `Only ${freeGb} GB free on ${letter}: (you wanted at least ${item.minGb})`,
        );
      }
    } else if (item.kind === 'online') {
      const up = await platform.networkReachable?.().catch(() => false);
      say(item, Boolean(up), up ? 'The internet is working' : 'The internet isn’t reachable');
    }
  }

  return { ok: checks.every((c) => c.ok), checks, report: reportFor(setup, checks) };
}

/** Center of the window inside the region the position describes. */
function isPlaced(
  w: WindowEntry,
  position: Extract<SetupItem, { kind: 'place' }>['position'],
  display: Parameters<typeof placementBounds>[1],
): boolean {
  if (position === 'maximize') return w.maximized;
  const r = placementBounds(position, display);
  const cx = w.x + w.width / 2;
  const cy = w.y + w.height / 2;
  return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height;
}

/** "Recording setup complete. OBS is running, …, and Discord is on the left." */
export function reportFor(setup: Setup, checks: readonly SetupCheck[]): string {
  const title = setup.name[0]!.toUpperCase() + setup.name.slice(1);
  if (!checks.length)
    return `${title} setup has nothing in it yet — add something in Settings → Setups.`;
  const good = checks.filter((c) => c.ok).map((c) => c.observed);
  const bad = checks.filter((c) => !c.ok).map((c) => c.observed);
  const sentence = (parts: string[]) =>
    parts.length <= 1
      ? (parts[0] ?? '')
      : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
  if (!bad.length) return `${title} setup complete. ${capitalize(sentence(good))}.`;
  const lines = [`${title} setup: ${good.length} of ${checks.length} ready.`];
  for (const b of bad) lines.push(`⚠️ ${capitalize(b)}.`);
  if (good.length) lines.push(`✅ ${capitalize(sentence(good))}.`);
  return lines.join('\n');
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
