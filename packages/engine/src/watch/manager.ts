/**
 * The WatchManager — keeps watches, checks their conditions, runs what was
 * approved when one holds, and survives Atlas being closed in the middle.
 *
 * ── What it promises ───────────────────────────────────────────────────────
 *  1. **Only what was approved runs unattended.** A continuation step runs
 *     without a card only when the stored steps still hash to the approval
 *     the person gave (`fingerprintSteps`) and the step is one of them. A bulk
 *     skill whose card lists files read at run time (`Skill.preview`) always
 *     stops and asks, because nobody has seen that list yet.
 *  2. **Nothing is repeated blind.** Each step is marked `started` in storage
 *     *before* it runs and `done`/`failed` after. A restart that finds a step
 *     still `started` cannot know whether it happened, so it asks: retry it,
 *     treat it as done, or cancel.
 *  3. **An event seen across a gap is asked about, not acted on.** See
 *     `reliableAfterGap` in `conditions.ts`.
 *  4. **The emergency stop pauses everything**, and nothing resumes until the
 *     person resumes it.
 *
 * Everything the person might want to know — active, paused, running, waiting
 * for you, expired — is on the record and in the log, and the host is told
 * about every change through `subscribe`.
 *
 * ── Where it runs ──────────────────────────────────────────────────────────
 * Inside Atlas, on a timer. It needs no server and no account: storage is the
 * same local key/value store every other preference uses. A watch lives only
 * while Atlas is running, is restored when Atlas starts, and says so.
 */

import type {
  Plan,
  PlanOutcome,
  PlanStep,
  Platform,
  Storage,
  Watch,
  WatchCondition,
  WatchQuestion,
  WatchStatus,
} from '@atlas/core';
import { FINISHED_WATCH_STATUSES, WATCH_DEFAULT_TTL_MS, WATCH_MAX_TTL_MS } from '@atlas/core';
import type { EngineIO } from '../engine';
import {
  describeCondition,
  dueAt,
  fingerprintSteps,
  probeCondition,
  reliableAfterGap,
} from './conditions';

export const WATCHES_KEY = 'atlas.watches';
/** Finished watches kept for the list, newest first. */
const KEEP_FINISHED = 30;
const LOG_LIMIT = 40;

/** What the manager needs from the app around it. */
export interface WatchHost {
  /** Run a one-step plan. The engine's `run`, in practice. */
  run(
    plan: Plan,
    io: EngineIO,
    extra: { approvedStep(step: PlanStep): boolean },
  ): Promise<PlanOutcome>;
  /** A line for the conversation, so the person sees it next time they look. */
  announce(text: string): void;
  /** A Windows notification, for when they aren't looking. */
  notify?(title: string, body: string): void;
  /**
   * A watch has stopped to ask. A surface that can draw the question with its
   * answers next to it (Approve / Skip / Cancel) handles it here; without this,
   * the question is announced as a plain line like everything else.
   */
  needsYou?(watch: Watch): void;
}

export interface WatchManagerOptions {
  storage: Storage;
  platform: Platform;
  host: WatchHost;
  now?: () => number;
  /** How often active conditions are checked. */
  pollMs?: number;
}

export interface NewWatch {
  request: string;
  condition: WatchCondition;
  steps: PlanStep[];
  stepLabels: string[];
  /** Defaults to 24 hours; capped at 7 days. */
  ttlMs?: number;
  sawProcess?: boolean;
}

/** How the person answered a watch that was waiting for them. */
export type WatchAnswer = 'approve' | 'skip' | 'deny';

type Listener = (watches: readonly Watch[]) => void;

function sameStep(a: PlanStep, b: PlanStep): boolean {
  return fingerprintSteps([a]) === fingerprintSteps([b]);
}

export class WatchManager {
  private watches: Watch[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly storage: Storage;
  private readonly platform: Platform;
  private readonly host: WatchHost;
  private readonly now: () => number;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private writing: Promise<void> = Promise.resolve();
  /** Watches restored from storage whose first check has not happened yet. */
  private readonly restored = new Set<string>();
  /** Continuations running right now, so two ticks never run one twice. */
  private readonly runningIds = new Set<string>();
  /** A step waiting on the person, by watch id. */
  private readonly pending = new Map<string, (answer: WatchAnswer | 'halt') => void>();
  private loaded = false;
  private seq = 0;

  constructor(options: WatchManagerOptions) {
    this.storage = options.storage;
    this.platform = options.platform;
    this.host = options.host;
    this.now = options.now ?? (() => Date.now());
    this.pollMs = options.pollMs ?? 3000;
  }

  // ── reading ──────────────────────────────────────────────────────────────

  list(): readonly Watch[] {
    return this.watches;
  }

  get(id: string): Watch | undefined {
    return this.watches.find((w) => w.id === id);
  }

  /** Watches that are not finished, oldest first. */
  live(): Watch[] {
    return this.watches.filter((w) => !FINISHED_WATCH_STATUSES.includes(w.status));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.watches);
    return () => this.listeners.delete(listener);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Read watches back from storage and apply the recovery rules. Returns the
   * sentence announced to the person, or null when there was nothing to resume.
   */
  async load(): Promise<string | null> {
    if (this.loaded) return null;
    this.loaded = true;
    const stored = (await this.storage.get<Watch[]>(WATCHES_KEY).catch(() => undefined)) ?? [];
    this.watches = Array.isArray(stored) ? stored.filter((w) => w && typeof w.id === 'string') : [];
    const now = this.now();
    const lines: string[] = [];

    for (const w of this.watches) {
      if (FINISHED_WATCH_STATUSES.includes(w.status)) continue;

      if (fingerprintSteps(w.steps) !== w.approval) {
        this.finish(
          w,
          'failed',
          'Its steps no longer match what you approved, so I won’t run them.',
        );
        lines.push(`“${w.describe}” — stopped: its steps changed since you approved them.`);
        continue;
      }
      if (now >= w.expiresAt) {
        this.finish(w, 'expired', 'Expired while Atlas was closed.');
        lines.push(`“${w.describe}” — expired while I was closed.`);
        continue;
      }

      switch (w.status) {
        case 'active':
          this.restored.add(w.id);
          this.log(w, 'Resumed after Atlas restarted.');
          lines.push(`watching for ${w.describe}`);
          break;
        case 'paused':
          lines.push(`“${w.describe}” — still paused`);
          break;
        case 'running': {
          const started = w.stepStates.indexOf('started');
          if (started >= 0) {
            this.ask(w, {
              kind: 'uncertain-step',
              step: started,
              question: `Atlas closed while “${w.stepLabels[started]}” was running, so I can’t tell whether it finished. Run it again, treat it as done, or cancel?`,
            });
            lines.push(
              `“${w.describe}” — needs you: I can’t tell if “${w.stepLabels[started]}” finished`,
            );
          } else {
            this.log(w, 'Continuing after Atlas restarted.');
            lines.push(`“${w.describe}” — continuing where it left off`);
            queueMicrotask(() => void this.runFrom(w));
          }
          break;
        }
        case 'awaiting-approval':
          if (w.question?.kind === 'uncovered-step') {
            // The card it was waiting on went with the old window. Ask again,
            // and the step will show its *current* details when it runs.
            w.question = {
              ...w.question,
              question: `${w.question.question} (Atlas restarted — approve and I'll show you the current details.)`,
            };
          }
          lines.push(`“${w.describe}” — waiting for you`);
          break;
      }
    }
    await this.save();
    this.emit();
    this.ensureTimer();

    if (!lines.length) return null;
    const text = `👁 Picked up ${lines.length} watch${lines.length === 1 ? '' : 'es'} from before: ${lines.join('; ')}.`;
    this.host.announce(text);
    return text;
  }

  /** Stop the timer. Watches stay in storage. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── making ───────────────────────────────────────────────────────────────

  async create(input: NewWatch): Promise<Watch> {
    const now = this.now();
    const ttl = Math.min(Math.max(input.ttlMs ?? WATCH_DEFAULT_TTL_MS, 60_000), WATCH_MAX_TTL_MS);
    const watch: Watch = {
      id: `w${now.toString(36)}${(this.seq++).toString(36)}`,
      request: input.request,
      describe: describeCondition(input.condition),
      condition: input.condition,
      steps: input.steps,
      stepLabels: input.stepLabels,
      stepStates: input.steps.map(() => 'pending'),
      approval: fingerprintSteps(input.steps),
      status: 'active',
      createdAt: now,
      expiresAt: now + ttl,
      baseline: { startedAt: now, sawProcess: input.sawProcess },
      log: [{ at: now, text: 'Started watching.' }],
    };
    this.watches.unshift(watch);
    await this.save();
    this.emit();
    this.ensureTimer();
    return watch;
  }

  // ── the person's controls ────────────────────────────────────────────────

  async pause(id: string): Promise<boolean> {
    const w = this.get(id);
    if (!w || !['active', 'running'].includes(w.status)) return false;
    w.status = 'paused';
    this.log(w, 'Paused.');
    await this.commit();
    return true;
  }

  async resume(id: string): Promise<boolean> {
    const w = this.get(id);
    if (!w || w.status !== 'paused') return false;
    if (this.now() >= w.expiresAt) {
      this.finish(w, 'expired', 'Expired.');
      await this.commit();
      return false;
    }
    if (w.firedAt) {
      // It was part-way through its steps.
      w.status = 'running';
      this.log(w, 'Resumed.');
      await this.commit();
      void this.runFrom(w);
    } else {
      w.status = 'active';
      this.log(w, 'Resumed watching.');
      await this.commit();
      this.ensureTimer();
    }
    return true;
  }

  async cancel(id: string): Promise<boolean> {
    const w = this.get(id);
    if (!w || FINISHED_WATCH_STATUSES.includes(w.status)) return false;
    this.pending.get(id)?.('deny');
    this.pending.delete(id);
    this.finish(w, 'cancelled', 'Cancelled.');
    await this.commit();
    return true;
  }

  /** Delete a watch from the list entirely. A live one is cancelled first. */
  async remove(id: string): Promise<boolean> {
    const w = this.get(id);
    if (!w) return false;
    this.pending.get(id)?.('deny');
    this.pending.delete(id);
    this.watches = this.watches.filter((x) => x.id !== id);
    await this.commit();
    return true;
  }

  /** Answer a watch that is waiting for the person. See `WatchQuestion`. */
  async answer(id: string, answer: WatchAnswer): Promise<boolean> {
    const w = this.get(id);
    if (!w || w.status !== 'awaiting-approval' || !w.question) return false;
    const question = w.question;
    if (answer === 'deny') {
      this.pending.get(id)?.('deny');
      this.pending.delete(id);
      this.finish(w, 'cancelled', 'You said no.');
      await this.commit();
      return true;
    }

    const resolve = this.pending.get(id);
    w.question = undefined;
    w.status = 'running';

    switch (question.kind) {
      case 'uncovered-step':
        if (resolve) {
          this.pending.delete(id);
          if (question.step !== undefined) {
            w.stepStates[question.step] = answer === 'skip' ? 'pending' : 'started';
          }
          this.log(w, answer === 'skip' ? 'You skipped a step.' : 'You approved a step.');
          await this.commit();
          resolve(answer);
          return true;
        }
        // Waiting from before a restart: run it again, and it asks with fresh details.
        if (answer === 'skip' && question.step !== undefined)
          w.stepStates[question.step] = 'skipped';
        break;
      case 'uncertain-step':
        if (question.step !== undefined) {
          w.stepStates[question.step] = answer === 'skip' ? 'done' : 'pending';
          this.log(
            w,
            answer === 'skip'
              ? 'You said that step already happened.'
              : 'Running that step again, as you asked.',
          );
        }
        break;
      case 'met-while-offline':
        w.firedAt = this.now();
        this.log(w, 'You said to go ahead.');
        break;
    }
    await this.commit();
    void this.runFrom(w);
    return true;
  }

  /** The emergency stop: pause everything that could act. */
  async haltAll(): Promise<void> {
    let changed = false;
    for (const w of this.watches) {
      if (w.status === 'active' || w.status === 'running' || w.status === 'awaiting-approval') {
        this.pending.get(w.id)?.('halt');
        this.pending.delete(w.id);
        if (w.status === 'awaiting-approval') w.question = undefined;
        w.status = 'paused';
        this.log(w, 'Paused by the emergency stop.');
        changed = true;
      }
    }
    if (changed) await this.commit();
  }

  // ── checking ─────────────────────────────────────────────────────────────

  /** Check every active watch once. The timer calls this; tests call it directly. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const w of [...this.watches]) {
        if (w.status !== 'active') continue;
        if (now >= w.expiresAt) {
          this.finish(w, 'expired', 'Expired before it happened.');
          this.host.notify?.('Watch expired', w.describe);
          await this.commit();
          continue;
        }
        const firstAfterRestart = this.restored.delete(w.id);
        const result = await probeCondition(w.condition, this.platform, w.baseline, now);
        w.lastCheckedAt = now;
        if (w.status !== 'active') continue; // paused or cancelled while probing

        if (result.failed) {
          this.finish(w, 'failed', result.failed);
          this.host.announce(`👁 ${result.failed}`);
          this.host.notify?.('Watch stopped', result.failed);
          await this.commit();
          continue;
        }
        if (!result.met) continue;

        const due = dueAt(w.condition, w.baseline);
        const overdue = due === null ? 0 : Math.max(0, now - due);
        if (firstAfterRestart && !reliableAfterGap(w.condition, overdue)) {
          this.ask(w, {
            kind: 'met-while-offline',
            question: `${result.detail} It happened while Atlas was closed, so I can’t tell whether it finished properly. Carry on with the next steps?`,
          });
          await this.commit();
          continue;
        }

        w.status = 'running';
        w.firedAt = now;
        this.log(w, result.detail);
        const next = w.steps.length ? ` Now: ${w.stepLabels.join(', then ')}.` : '';
        this.host.announce(`👁 ${result.detail}${next}`);
        this.host.notify?.('Atlas Watch', `${result.detail}${next}`);
        await this.commit();
        void this.runFrom(w);
      }
    } finally {
      this.ticking = false;
      this.ensureTimer();
    }
  }

  /**
   * Run a watch's continuation from its first unfinished step. Each step is
   * its own one-step plan so progress is saved between them — see "Nothing is
   * repeated blind" in this file's header.
   */
  async runFrom(w: Watch): Promise<void> {
    if (this.runningIds.has(w.id)) return;
    this.runningIds.add(w.id);
    try {
      for (let i = 0; i < w.steps.length; i++) {
        if (w.status !== 'running') return;
        const state = w.stepStates[i];
        if (state === 'done' || state === 'skipped') continue;
        if (state === 'started') {
          this.ask(w, {
            kind: 'uncertain-step',
            step: i,
            question: `“${w.stepLabels[i]}” was interrupted, so I can’t tell whether it finished. Run it again, treat it as done, or cancel?`,
          });
          await this.commit();
          return;
        }
        if (state === 'failed') return;

        if (fingerprintSteps(w.steps) !== w.approval) {
          this.finish(w, 'failed', 'Its steps no longer match what you approved.');
          await this.commit();
          return;
        }

        const step = w.steps[i]!;
        w.stepStates[i] = 'started';
        this.log(w, `Starting: ${w.stepLabels[i]}.`);
        await this.commit();

        let answered: WatchAnswer | 'halt' | null = null;
        const io = this.stepIO(w, i, (a) => {
          answered = a;
        });
        const outcome = await this.host.run(
          { source: 'routine', intent: 'watch', steps: [step], confidence: 1 },
          io,
          { approvedStep: (s) => fingerprintSteps(w.steps) === w.approval && sameStep(s, step) },
        );

        // The step still reads `started` if the stop landed in the middle of
        // it — which is exactly what a later resume needs to see.
        if (outcome.halted) {
          if (w.status === 'running') {
            w.status = 'paused';
            this.log(w, 'Paused by the emergency stop.');
          }
          await this.commit();
          return;
        }

        const result = outcome.outcomes[0];
        const denied = (answered as WatchAnswer | 'halt' | null) === 'deny';
        if ((answered as WatchAnswer | 'halt' | null) === 'skip') {
          w.stepStates[i] = 'skipped';
          this.log(w, `Skipped: ${w.stepLabels[i]}.`);
          await this.commit();
          continue;
        }
        if (result?.ok) {
          w.stepStates[i] = 'done';
          this.log(w, `Done: ${w.stepLabels[i]}.`);
          await this.commit();
          continue;
        }
        if (w.status !== 'running') return; // cancelled while it ran
        w.stepStates[i] = result?.skipped ? 'skipped' : 'failed';
        const why = denied
          ? 'You said no to a step.'
          : result?.error && result.error !== 'Cancelled.'
            ? result.error
            : 'That step needed something I couldn’t ask about while you were away.';
        this.finish(w, denied ? 'cancelled' : 'failed', `Stopped at “${w.stepLabels[i]}”: ${why}`);
        this.host.announce(`👁 Watch stopped at “${w.stepLabels[i]}”: ${why}`);
        this.host.notify?.('Watch stopped', `${w.stepLabels[i]}: ${why}`);
        await this.commit();
        return;
      }

      if (w.status !== 'running') return;
      const n = w.steps.length;
      const summary = n
        ? `That watch is finished — ${n === 1 ? 'its step' : `all ${n} steps`} worked.`
        : 'Done — that’s all you asked me to watch for.';
      this.finish(w, 'done', summary);
      if (n) {
        this.host.announce(`👁 ${summary}`);
        this.host.notify?.('Atlas Watch finished', summary);
      }
      await this.commit();
    } finally {
      this.runningIds.delete(w.id);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The io a continuation step runs with. Messages go to the conversation.
   * A card — only ever for a step the approval did not cover — becomes a
   * question on the watch, a notification, and a pause until it is answered.
   * No `clarify`: a step that needs a choice made cannot be made while the
   * person is away, so it stops and says so rather than guessing.
   */
  private stepIO(w: Watch, index: number, onAnswer: (a: WatchAnswer | 'halt') => void): EngineIO {
    return {
      say: (text) => this.host.announce(`👁 ${text}`),
      showResults: (rows, meta) =>
        this.host.announce(
          `👁 ${meta?.title ?? 'Results'}: ${rows
            .slice(0, 5)
            .map((r) => r.title)
            .join(', ')}`,
        ),
      confirm: (question, detail) =>
        new Promise<boolean>((resolve) => {
          w.stepStates[index] = 'pending';
          this.ask(w, { kind: 'uncovered-step', step: index, question, detail });
          this.pending.set(w.id, (answer) => {
            onAnswer(answer);
            resolve(answer === 'approve');
          });
          void this.commit();
        }),
    };
  }

  private ask(w: Watch, question: WatchQuestion): void {
    w.status = 'awaiting-approval';
    w.question = question;
    this.log(w, `Waiting for you: ${question.question}`);
    if (this.host.needsYou) this.host.needsYou(w);
    else this.host.announce(`👁 A watch needs you: ${question.question}`);
    this.host.notify?.('Atlas Watch needs you', question.question);
  }

  private finish(w: Watch, status: WatchStatus, text: string): void {
    w.status = status;
    w.question = undefined;
    w.finishedAt = this.now();
    this.log(w, text);
  }

  private log(w: Watch, text: string): void {
    w.log.push({ at: this.now(), text });
    if (w.log.length > LOG_LIMIT) w.log.splice(0, w.log.length - LOG_LIMIT);
  }

  private async commit(): Promise<void> {
    await this.save();
    this.emit();
  }

  private save(): Promise<void> {
    // Oldest finished ones fall off; live ones never do.
    const finished = this.watches.filter((w) => FINISHED_WATCH_STATUSES.includes(w.status));
    if (finished.length > KEEP_FINISHED) {
      const drop = new Set(finished.slice(KEEP_FINISHED).map((w) => w.id));
      this.watches = this.watches.filter((w) => !drop.has(w.id));
    }
    const snapshot = JSON.parse(JSON.stringify(this.watches)) as Watch[];
    this.writing = this.writing
      .then(() => this.storage.set(WATCHES_KEY, snapshot))
      .catch(() => undefined);
    return this.writing;
  }

  private emit(): void {
    const view = [...this.watches];
    for (const l of this.listeners) l(view);
  }

  private ensureTimer(): void {
    const needed = this.watches.some((w) => w.status === 'active');
    if (needed && !this.timer) {
      this.timer = setInterval(() => void this.tick(), this.pollMs);
    } else if (!needed && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
