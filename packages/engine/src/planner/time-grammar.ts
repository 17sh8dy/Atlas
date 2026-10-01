/**
 * Phrasings for reminders, alarms and the stopwatch.
 *
 * The time itself is not parsed here: the rule splits "what" from "when" and
 * hands the `when` to `reminder.set` as words, so the skill is the one place a
 * time is understood (and the one place that can say it was not). That is also
 * what lets a model-written plan use the same skill without re-implementing it.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';
import { parseWhen, splitWhen } from '../text/when';

function tidy0(s: string): string {
  return s.trim().replace(/^["'“‘]|["'”’]$/g, '').trim();
}

function unquote(s: string): string {
  return s.trim().replace(/^["'“‘]|["'”’]$/g, '');
}

export function createTimeGrammar(): GrammarRule[] {
  return [
    {
      // Ahead of `todoAdd` (-9.57): "remind me to call mom at 5" is a reminder,
      // not a to-do that never fires. Without a time it stays a to-do.
      name: 'reminderSet',
      order: -9.6,
      test(_lower, raw) {
        // "remind me in 10 minutes to stretch" / "remind me at 5 to call mom"
        const lead = raw.match(
          /^\s*(?:please\s+)?remind me\s+((?:in|at|on|tomorrow|tonight|today|this|next|every)\b[\s\S]*?)\s+(?:to|about|that)\s+([\s\S]+?)\s*[?.!]*$/i,
        );
        if (lead) {
          return plan(step('reminder.set', { text: unquote(lead[2]!), when: lead[1]!.trim() }), 'reminder');
        }
        // "remind me in 10 minutes" with nothing to say — a plain timer's sentence.
        // "remind me to call mom at 5" / "remind me to stretch every day at 3pm"
        const tail = raw.match(/^\s*(?:please\s+)?remind me\s+(?:to|about|that)\s+([\s\S]+?)\s*[?.!]*$/i);
        if (tail) {
          const split = splitWhen(tail[1]!);
          if (!split) return null; // no time: the to-do rule keeps it
          return plan(step('reminder.set', { text: unquote(split.what), when: split.when.matched }), 'reminder');
        }
        return null;
      },
    },

    {
      name: 'alarmSet',
      order: -9.59,
      test(_lower, raw) {
        const m =
          raw.match(
            /^\s*(?:please\s+)?(?:set|make|create|add)\s+(?:me\s+)?(?:an?\s+)?alarm\s+(?:for|at)\s+([\s\S]+?)(?:\s+(?:called|named|labell?ed|to|for)\s+([\s\S]+?))?\s*[?.!]*$/i,
          ) ??
          raw.match(/^\s*(?:please\s+)?wake me(?:\s+up)?\s+(?:at\s+|in\s+|tomorrow\s+at\s+)?([\s\S]+?)\s*[?.!]*$/i);
        if (!m) return null;
        let when = m[1]!.trim();
        // "wake me up tomorrow at 7": the regex ate the lead-in word, restore it.
        if (/^wake\b/i.test(raw.trim()) && /tomorrow at/i.test(raw)) when = `tomorrow at ${when}`;
        else if (/^wake\b/i.test(raw.trim()) && /\bin\s/i.test(raw) && /^\d|^(?:half|an?|one)/i.test(when)) when = `in ${when}`;
        else if (!/^(?:in|at|on|tomorrow|tonight|today|this|next|every)\b/i.test(when)) when = `at ${when}`;
        const args: Record<string, string> = { when };
        if (m[2]) args.label = unquote(m[2]);
        return plan(step('alarm.set', args), 'alarm');
      },
    },

    {
      // "every day at 8 open spotify" / "run backup every night at 2am": a repeating time, and
      // what to do. Reminders and alarms have their own rules and keep their sentences.
      name: 'routineCreate',
      order: -9.62,
      test(_lower, raw) {
        const words = raw.trim().replace(/[.!]+$/g, '').split(/\s+/);
        if (/^(?:please\s+)?(?:remind|wake|set\s+an?\s+alarm|alarm)\b/i.test(raw.trim())) return null;
        const i = words.findIndex((w) => w.toLowerCase() === 'every');
        if (i < 0) return null;
        for (let j = words.length; j >= i + 2; j--) {
          const phrase = words.slice(i, j).join(' ');
          const when = parseWhen(phrase);
          if (!when?.repeat) continue;
          const then = [...words.slice(0, i), ...words.slice(j)]
            .join(' ')
            .replace(/^(?:please\s+)?(?:and\s+|then\s+|to\s+)/i, '')
            .replace(/[\s,]+$/g, '')
            .trim();
          if (!then) return null;
          return plan(step('routine.create', { when: phrase, then }), 'routine-create');
        }
        return null;
      },
    },

    {
      name: 'routineList',
      order: -9.615,
      questionSafe: ['routine-list'],
      test(lower) {
        // "routines" alone belongs to setups ("my routines" = saved setups); a schedule says so.
        const SCHED = String.raw`(?:(?:scheduled|recurring|repeating|automatic)\s+(?:routines?|tasks?|jobs?|actions?)|schedules?)`;
        if (new RegExp(String.raw`^\s*(?:what\s+(?:are|is)\s+)?(?:show\s+|list\s+|see\s+)?(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?${SCHED}(?:\s+(?:do\s+i\s+have|i\s+have|are\s+set|set))?\s*[?.!]*$`).test(lower)) {
          return plan(step('routine.list', {}), 'routine-list');
        }
        if (new RegExp(String.raw`^\s*(?:please\s+)?(?:resume|restart|turn\s+(?:back\s+)?on|unpause)\s+(?:all\s+)?(?:my\s+|the\s+)?${SCHED}\s*[?.!]*$`).test(lower)) {
          return plan(step('routine.resume', {}), 'routine-resume');
        }
        return null;
      },
    },

    {
      name: 'routineCancel',
      order: -9.614,
      test(_lower, raw) {
        const m = raw.match(/^\s*(?:please\s+)?(?:cancel|delete|remove|stop)\s+(?:all\s+)?(?:my\s+|the\s+)?(?:(.+?)\s+)?(?:scheduled|recurring|repeating)\s+(?:routines?|tasks?|jobs?|actions?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:cancel|delete|remove|stop)\s+(?:all\s+)?(?:my\s+|the\s+)?(?:(.+?)\s+)?schedules?\s*[?.!]*$/i);
        if (!m) return null;
        const which = m[1] ? tidy0(m[1]) : 'all';
        return plan(step('routine.cancel', { which: /^(?:all|every|my)$/i.test(which) ? 'all' : which }), 'routine-cancel');
      },
    },

    {
      name: 'reminderList',
      order: -9.58,
      questionSafe: ['reminder-list'],
      test(lower) {
        if (
          /^\s*(?:what\s+(?:are|is)\s+)?(?:show\s+|list\s+|see\s+)?(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?(?:reminders?|alarms?)(?:\s+(?:do\s+i\s+have|i\s+have|are\s+set|set))?\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return plan(step('reminder.list', {}), 'reminder-list');
        }
        return null;
      },
    },

    {
      name: 'reminderCancel',
      order: -9.585,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:cancel|delete|remove|clear|turn off|stop)\s+(?:all\s+)?(?:my\s+|the\s+)?(?:(all)\s+)?(?:reminders?|alarms?)(?:\s+(?:about|for|to|called|named)\s+([\s\S]+?))?\s*[?.!]*$/i,
        );
        if (!m) return null;
        const all = /\ball\b/i.test(raw.split(/reminders?|alarms?/i)[0] ?? '') || Boolean(m[1]);
        const which = m[2] ? unquote(m[2]) : all ? 'all' : '';
        // "cancel the alarm" with one alarm set is unambiguous; with none named, ask.
        return plan(step('reminder.cancel', which ? { which } : { which: 'all' }), 'reminder-cancel', which ? 0.95 : 0.8);
      },
    },

    {
      name: 'stopwatch',
      order: -9.575,
      questionSafe: ['stopwatch'],
      test(lower) {
        if (!/\bstop\s?watch\b/.test(lower)) return null;
        let action: string | null = null;
        if (/^\s*(?:please\s+)?(?:start|begin|run|begin|resume)\b/.test(lower)) action = 'start';
        else if (/\b(?:stop|pause|end)\b/.test(lower)) action = 'stop';
        else if (/\b(?:reset|clear|zero)\b/.test(lower)) action = 'reset';
        else if (/\b(?:check|how long|what|show|read|time)\b/.test(lower)) action = 'check';
        else if (/^\s*(?:a\s+|the\s+)?stop\s?watch\s*[?.!]*$/.test(lower)) action = 'check';
        return action ? plan(step('stopwatch', { action }), 'stopwatch') : null;
      },
    },
  ];
}
