/**
 * Reminders and alarms that are still there after a restart.
 *
 * `time.timer` is a plain `setTimeout` and says so: it lives as long as Atlas
 * does. A reminder for "tomorrow at 9" cannot work that way, so these are kept
 * in storage and checked against the clock once a second. A tick rather than
 * one long timeout because a computer that sleeps stops its timers but not the
 * clock — the next tick after waking sees that something is overdue.
 *
 * Something that came due while Atlas was not running fires when it next
 * starts, marked as missed. Never silently dropped: someone relying on "remind
 * me to take the tablet at 8" would rather hear it late than not at all.
 *
 * All a reminder ever does is show a notification (and optionally say it). It
 * carries no action, so nothing here acts on the machine when nobody is
 * looking — that is what the watch layer's approval model is for.
 */

import type { Storage } from '@atlas/core';
import { nextRepeat, type Repeat } from '../text/when';

export const REMINDERS_KEY = 'reminders.items';

export interface Reminder {
  id: string;
  text: string;
  /** When it next fires, epoch ms. */
  at: number;
  repeat?: Repeat;
  kind: 'reminder' | 'alarm';
}

export interface ReminderHost {
  storage: Storage;
  notify(title: string, body: string): void;
  /** Also say it aloud, when speech is on. Optional. */
  announce?(text: string): void;
  now?(): number;
}

/** Nothing further out than this — a typo in a year should not hide for ten. */
const HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 100;

export class ReminderScheduler {
  private items: Reminder[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private loaded = false;

  constructor(private readonly host: ReminderHost) {}

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  /** Load what was saved, fire anything overdue, and start ticking. Safe to call twice. */
  async start(): Promise<void> {
    if (!this.loaded) {
      const saved = await this.host.storage.get<Reminder[]>(REMINDERS_KEY).catch(() => undefined);
      this.items = Array.isArray(saved) ? saved.filter(isReminder) : [];
      this.loaded = true;
    }
    this.tick();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async add(input: Omit<Reminder, 'id'>): Promise<Reminder | { error: string }> {
    await this.ensureLoaded();
    const now = this.now();
    if (!Number.isFinite(input.at) || input.at <= now) {
      return { error: 'That time has already passed.' };
    }
    if (input.at - now > HORIZON_MS) return { error: "I won't hold a reminder more than a year out." };
    if (this.items.length >= MAX_ITEMS) return { error: 'That is a lot of reminders — cancel a few first.' };
    const reminder: Reminder = {
      ...input,
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    };
    this.items.push(reminder);
    await this.save();
    return reminder;
  }

  async list(): Promise<Reminder[]> {
    await this.ensureLoaded();
    return [...this.items].sort((a, b) => a.at - b.at);
  }

  /** Cancel by id, by "all", or by words that appear in exactly one reminder's text. */
  async cancel(which: string): Promise<{ removed: Reminder[] } | { error: string }> {
    await this.ensureLoaded();
    const q = which.trim().toLowerCase();
    if (!q) return { error: 'Which one?' };
    let hit: Reminder[];
    if (q === 'all' || q === 'everything') hit = [...this.items];
    else {
      hit = this.items.filter((r) => r.id === q);
      if (!hit.length) {
        hit = this.items.filter((r) => r.text.toLowerCase().includes(q));
        if (hit.length > 1) {
          return { error: `That matches ${hit.length} reminders — say a bit more, or "cancel all".` };
        }
      }
    }
    if (!hit.length) return { error: `I don't have a reminder matching "${which.trim()}".` };
    const gone = new Set(hit.map((r) => r.id));
    this.items = this.items.filter((r) => !gone.has(r.id));
    await this.save();
    return { removed: hit };
  }

  /** Exposed for tests; the interval calls it. */
  tick(): void {
    const now = this.now();
    const due = this.items.filter((r) => r.at <= now);
    if (!due.length) return;
    for (const r of due) {
      // More than a minute late means Atlas was not running (or the PC was asleep).
      const late = now - r.at > 60_000;
      const title = r.kind === 'alarm' ? 'Alarm' : 'Reminder';
      const body = late ? `${r.text} (missed — it was due ${ago(now - r.at)} ago)` : r.text;
      try {
        this.host.notify(title, body);
        this.host.announce?.(r.kind === 'alarm' ? `Alarm. ${r.text}` : `Reminder: ${r.text}`);
      } catch {
        // A failed notification must not stop the rest from firing.
      }
      if (r.repeat) {
        let next = nextRepeat(r.repeat, r.at);
        while (next <= now) next = nextRepeat(r.repeat, next);
        r.at = next;
      } else {
        this.items = this.items.filter((x) => x.id !== r.id);
      }
    }
    void this.save();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.host.storage.get<Reminder[]>(REMINDERS_KEY).catch(() => undefined);
    this.items = Array.isArray(saved) ? saved.filter(isReminder) : [];
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.host.storage.set(REMINDERS_KEY, this.items).catch(() => undefined);
  }
}

function isReminder(x: unknown): x is Reminder {
  const r = x as Reminder;
  return Boolean(r) && typeof r.id === 'string' && typeof r.text === 'string' && Number.isFinite(r.at);
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}
