/**
 * Reminders, alarms and a stopwatch — the time skills that outlive a sentence.
 *
 * Reminders and alarms are the same thing underneath (`ReminderScheduler`): a
 * moment and some words, kept across restarts. They differ only in what the
 * notification is called. Both are `safe` — the only thing either ever does is
 * show a notification, and cancelling one is something the person just asked
 * for by name.
 *
 * The stopwatch is in memory and says so: it is a thing you glance at, not a
 * thing you need to survive a restart.
 */

import type { Skill } from '@atlas/core';
import type { ReminderScheduler } from '../reminders/scheduler';
import { describeMoment, parseWhen, type Repeat } from '../text/when';

const REPEAT_WORDS: Record<Repeat, string> = {
  daily: 'every day',
  weekdays: 'every weekday',
  weekly: 'every week',
};

function clockText(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

export function createReminderSkills(scheduler: ReminderScheduler, now: () => number = Date.now): Skill[] {
  const skills: Skill[] = [];

  async function set(kind: 'reminder' | 'alarm', text: string, whenPhrase: string) {
    const when = parseWhen(whenPhrase, new Date(now()));
    if (!when) {
      return {
        ok: false as const,
        error: `I couldn't tell when "${whenPhrase}" is. Try "in 10 minutes", "at 5pm", "tomorrow at 9" or "every day at 8".`,
      };
    }
    const added = await scheduler.add({ text, at: when.at, repeat: when.repeat, kind });
    if ('error' in added) return { ok: false as const, error: added.error };
    const repeat = when.repeat ? `, ${REPEAT_WORDS[when.repeat]}` : '';
    const icon = kind === 'alarm' ? '⏰' : '🔔';
    return {
      ok: true as const,
      message: `${icon} ${kind === 'alarm' ? 'Alarm' : "I'll remind you"} ${describeMoment(when.at, new Date(now()))}${repeat}: ${text}`,
      data: added,
      undo: { skill: 'reminder.cancel', args: { which: added.id }, label: `cancel that ${kind}` },
    };
  }

  skills.push({
    id: 'reminder.set',
    label: 'Remind me',
    icon: '🔔',
    domain: 'time',
    description:
      'Remind you of something at a time — in 10 minutes, at 5pm, tomorrow at 9, every day at 8. Kept across restarts.',
    needs: ['notifications'],
    risk: 'safe',
    examples: ['remind me to call mom at 5', 'remind me to stretch every day at 3pm'],
    params: {
      text: { type: 'string', required: true, description: 'what to remind you of' },
      when: { type: 'string', required: true, description: 'when, in words: "in 10 minutes", "at 5pm", "tomorrow at 9"' },
    },
    async run(args) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, error: 'What should I remind you about?' };
      return set('reminder', text, String(args.when ?? ''));
    },
  });

  skills.push({
    id: 'alarm.set',
    label: 'Set an alarm',
    icon: '⏰',
    domain: 'time',
    description: 'Set an alarm for a time of day. Kept across restarts.',
    needs: ['notifications'],
    risk: 'safe',
    examples: ['set an alarm for 7am', 'wake me up at 6:30'],
    params: {
      when: { type: 'string', required: true, description: 'the time: "7am", "tomorrow at 6:30"' },
      label: { type: 'string', required: false, description: 'what it is for' },
    },
    async run(args) {
      const label = String(args.label ?? '').trim();
      return set('alarm', label || 'Time is up.', String(args.when ?? ''));
    },
  });

  skills.push({
    id: 'reminder.list',
    label: 'My reminders',
    icon: '📋',
    domain: 'time',
    description: 'List the reminders and alarms that are waiting.',
    risk: 'safe',
    examples: ['what are my reminders', 'list my alarms'],
    params: {},
    async run() {
      const items = await scheduler.list();
      if (!items.length) return { ok: true, message: 'You have no reminders or alarms set.' };
      const lines = items.map(
        (r) =>
          `${r.kind === 'alarm' ? '⏰' : '🔔'} ${describeMoment(r.at, new Date(now()))}${r.repeat ? ` (${REPEAT_WORDS[r.repeat]})` : ''} — ${r.text}`,
      );
      return { ok: true, message: lines.join('\n'), data: items };
    },
  });

  skills.push({
    id: 'reminder.cancel',
    label: 'Cancel a reminder',
    icon: '🔕',
    domain: 'time',
    description: 'Cancel a reminder or alarm by a word from it, or all of them.',
    risk: 'safe',
    examples: ['cancel my reminder about mom', 'cancel all alarms'],
    params: { which: { type: 'string', required: true, description: 'words from the reminder, or "all"' } },
    async run(args) {
      const out = await scheduler.cancel(String(args.which ?? ''));
      if ('error' in out) return { ok: false, error: out.error };
      const n = out.removed.length;
      return {
        ok: true,
        message: n === 1 ? `🔕 Cancelled: ${out.removed[0]!.text}` : `🔕 Cancelled ${n} reminders.`,
      };
    },
  });

  // ---- stopwatch -------------------------------------------------------------

  let startedAt: number | null = null;
  let banked = 0;

  const elapsed = () => banked + (startedAt === null ? 0 : now() - startedAt);

  skills.push({
    id: 'stopwatch',
    label: 'Stopwatch',
    icon: '⏱️',
    domain: 'time',
    description: 'Start, stop, check or reset a stopwatch. It lives as long as Atlas is running.',
    risk: 'safe',
    examples: ['start a stopwatch', 'stop the stopwatch', 'how long on the stopwatch', 'reset the stopwatch'],
    params: {
      action: { type: 'string', required: true, enum: ['start', 'stop', 'check', 'reset'], description: 'what to do' },
    },
    run(args) {
      const action = String(args.action);
      if (action === 'start') {
        if (startedAt !== null) return { ok: true, message: `⏱️ Already running — ${clockText(elapsed())} so far.` };
        startedAt = now();
        return { ok: true, message: banked ? `⏱️ Resumed from ${clockText(banked)}.` : '⏱️ Stopwatch started.' };
      }
      if (action === 'stop') {
        if (startedAt === null) return { ok: true, message: banked ? `⏱️ Stopped at ${clockText(banked)}.` : '⏱️ The stopwatch is not running.' };
        banked = elapsed();
        startedAt = null;
        return { ok: true, message: `⏱️ Stopped at ${clockText(banked)}.`, data: banked };
      }
      if (action === 'reset') {
        startedAt = null;
        banked = 0;
        return { ok: true, message: '⏱️ Stopwatch reset.' };
      }
      const t = elapsed();
      if (startedAt === null && !banked) return { ok: true, message: '⏱️ The stopwatch has not been started.' };
      return { ok: true, message: `⏱️ ${clockText(t)}${startedAt === null ? ' (stopped)' : ''}`, data: t };
    },
  });

  return skills;
}
