/**
 * Routines: "every night at 2am, do this" — a recurring plan, approved once.
 *
 * This is the one place Atlas acts when nobody is looking *repeatedly*, so it
 * follows the rules Watch set, and is stricter where it can be:
 *
 *  - **Approved when it is made**, as the exact steps, on a card that says when
 *    and how often. The approval is a fingerprint of those steps; a record
 *    edited on disk no longer matches it and does not run.
 *  - **Only things that never need asking.** A step whose skill is `confirm`
 *    risk (or can be, for these arguments), or that is on the "not unattended"
 *    list, is refused when the routine is made — not discovered at 2am.
 *  - **Stops on anything unexpected.** At run time a step that still wants a
 *    confirmation is *denied*, the routine stops there, and Atlas says so. It
 *    never answers a question for the person.
 *  - **The emergency stop pauses every routine**, and nothing resumes by itself.
 *  - **A late run is not run.** If the PC was off or asleep and the moment is
 *    more than half an hour gone, the run is skipped and reported as missed,
 *    then the next one is scheduled. Never a catch-up burst.
 */

import type { EngineIO } from '../engine';
import type { Plan, PlanOutcome, PlanStep, Storage } from '@atlas/core';
import { nextRepeat, type Repeat } from '../text/when';
import { fingerprintSteps } from '../watch/conditions';

export const ROUTINES_KEY = 'routines.items';
const LATE_MS = 30 * 60_000;
const MAX_ROUTINES = 20;

export interface Routine {
  id: string;
  /** What the person said, for the list. */
  request: string;
  steps: PlanStep[];
  labels: string[];
  /** Fingerprint of `steps` as approved. */
  approval: string;
  /** When it next runs, epoch ms. */
  at: number;
  repeat: Repeat;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastNote?: string;
}

export interface RoutineHost {
  storage: Storage;
  /** Run one step — the engine's `run`, in practice. */
  run(plan: Plan, io: EngineIO, extra: { approvedStep(step: PlanStep): boolean }): Promise<PlanOutcome>;
  announce(text: string): void;
  notify?(title: string, body: string): void;
  now?(): number;
}

function isRoutine(x: unknown): x is Routine {
  const r = x as Routine;
  return Boolean(r) && typeof r.id === 'string' && Array.isArray(r.steps) && Number.isFinite(r.at) && typeof r.approval === 'string';
}

export class RoutineScheduler {
  private items: Routine[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private loaded = false;
  private busy = new Set<string>();

  constructor(private readonly host: RoutineHost) {}

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  async start(): Promise<void> {
    await this.load();
    void this.tick();
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 5000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.host.storage.get<Routine[]>(ROUTINES_KEY).catch(() => undefined);
    this.items = Array.isArray(saved) ? saved.filter(isRoutine) : [];
    this.loaded = true;
  }

  async add(input: { request: string; steps: PlanStep[]; labels: string[]; at: number; repeat: Repeat }): Promise<Routine | { error: string }> {
    await this.load();
    if (!input.steps.length) return { error: 'A routine needs at least one step.' };
    if (this.items.length >= MAX_ROUTINES) return { error: 'That is a lot of routines — cancel a few first.' };
    const now = this.now();
    const r: Routine = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      request: input.request,
      steps: input.steps,
      labels: input.labels,
      approval: fingerprintSteps(input.steps),
      at: input.at,
      repeat: input.repeat,
      enabled: true,
      createdAt: now,
    };
    this.items.push(r);
    await this.save();
    return r;
  }

  async list(): Promise<Routine[]> {
    await this.load();
    return [...this.items].sort((a, b) => a.at - b.at);
  }

  async cancel(which: string): Promise<{ removed: Routine[] } | { error: string }> {
    await this.load();
    const q = which.trim().toLowerCase();
    if (!q) return { error: 'Which one?' };
    let hit = q === 'all' ? [...this.items] : this.items.filter((r) => r.id === q);
    if (!hit.length) {
      hit = this.items.filter((r) => r.request.toLowerCase().includes(q) || r.labels.some((l) => l.toLowerCase().includes(q)));
      if (hit.length > 1) return { error: `That matches ${hit.length} routines — say a bit more, or "cancel all routines".` };
    }
    if (!hit.length) return { error: `I don't have a routine matching "${which.trim()}".` };
    const gone = new Set(hit.map((r) => r.id));
    this.items = this.items.filter((r) => !gone.has(r.id));
    await this.save();
    return { removed: hit };
  }

  /** Pause or resume every routine. The emergency stop calls `pauseAll`. */
  async setEnabled(enabled: boolean): Promise<number> {
    await this.load();
    let n = 0;
    for (const r of this.items) {
      if (r.enabled !== enabled) {
        r.enabled = enabled;
        // Resuming does not run what was missed in between; it picks the next slot.
        if (enabled) while (r.at <= this.now()) r.at = nextRepeat(r.repeat, r.at);
        n++;
      }
    }
    if (n) await this.save();
    return n;
  }

  pauseAll(): Promise<number> {
    return this.setEnabled(false);
  }

  /** Exposed for tests; the interval calls it. */
  async tick(): Promise<void> {
    const now = this.now();
    const due = this.items.filter((r) => r.enabled && r.at <= now && !this.busy.has(r.id));
    for (const r of due) {
      this.busy.add(r.id);
      try {
        await this.fire(r, now);
      } finally {
        this.busy.delete(r.id);
      }
    }
  }

  private async fire(r: Routine, now: number): Promise<void> {
    const late = now - r.at;
    // Move on first, so a run that takes a while or fails is never retried in a tight loop.
    const scheduled = r.at;
    do r.at = nextRepeat(r.repeat, r.at);
    while (r.at <= now);
    r.lastRunAt = now;

    if (late > LATE_MS) {
      r.lastNote = 'missed (the PC was off or asleep)';
      this.host.announce(`🔁 Missed the routine "${r.request}" — it was due ${new Date(scheduled).toLocaleString()}. Next run: ${new Date(r.at).toLocaleString()}.`);
      this.host.notify?.('Routine missed', r.request);
      await this.save();
      return;
    }
    if (fingerprintSteps(r.steps) !== r.approval) {
      r.enabled = false;
      r.lastNote = 'stopped: its steps no longer match what you approved';
      this.host.announce(`🔁 I stopped the routine "${r.request}": its steps no longer match what you approved.`);
      await this.save();
      return;
    }

    const notes: string[] = [];
    let stoppedAt: string | null = null;
    for (let i = 0; i < r.steps.length; i++) {
      const step = r.steps[i]!;
      let asked: string | null = null;
      const io: EngineIO = {
        say: () => {},
        // A routine never answers a question for the person: it stops and says so.
        confirm: async (question) => {
          asked = question;
          return false;
        },
      };
      const outcome = await this.host.run(
        { source: 'routine', intent: 'routine', steps: [step], confidence: 1 },
        io,
        { approvedStep: () => false },
      );
      if (outcome.halted) {
        r.enabled = false;
        stoppedAt = 'the emergency stop';
        break;
      }
      const result = outcome.outcomes[0];
      if (asked) {
        stoppedAt = `"${r.labels[i] ?? step.skill}" wanted to ask: ${asked}`;
        break;
      }
      if (!result?.ok) {
        stoppedAt = `"${r.labels[i] ?? step.skill}" failed${result?.error ? ` (${result.error})` : ''}`;
        break;
      }
      notes.push(r.labels[i] ?? step.skill);
    }
    r.lastNote = stoppedAt ? `stopped — ${stoppedAt}` : `ran: ${notes.join(', ')}`;
    this.host.announce(stoppedAt ? `🔁 Routine "${r.request}" stopped — ${stoppedAt}.` : `🔁 Routine "${r.request}" ran: ${notes.join(', ')}.`);
    if (stoppedAt) this.host.notify?.('Routine stopped', `${r.request} — ${stoppedAt}`);
    await this.save();
  }

  private async save(): Promise<void> {
    await this.host.storage.set(ROUTINES_KEY, JSON.parse(JSON.stringify(this.items))).catch(() => undefined);
  }
}
