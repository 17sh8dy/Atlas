/**
 * "in 10 minutes", "at 5", "tomorrow at 9:30am", "every day at 8" → a moment.
 *
 * Deliberately small and strict. A reminder that fires at the wrong time is
 * worse than one that is refused, so anything this does not recognise returns
 * `null` and the caller says so instead of guessing.
 *
 * A bare hour ("at 5") with no am/pm means the soonest of 5am and 5pm that is
 * still ahead: said at 3pm it is 5pm today, said at 6pm it is 5am tomorrow.
 */

export type Repeat = 'daily' | 'weekdays' | 'weekly';

export interface When {
  /** Epoch ms of the first firing. */
  at: number;
  repeat?: Repeat;
  /** The phrase that was understood, for echoing back. */
  matched: string;
}

const UNIT_MS: Array<[RegExp, number]> = [
  [/^(?:s|secs?|seconds?)$/, 1000],
  [/^(?:m|mins?|minutes?)$/, 60_000],
  [/^(?:h|hrs?|hours?)$/, 3_600_000],
  [/^(?:d|days?)$/, 86_400_000],
  [/^(?:w|weeks?)$/, 7 * 86_400_000],
];

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45, sixty: 60,
};

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "half an hour" / "an hour and a half" are common enough to be worth handling. */
export function durationMs(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^(?:half an hour|half hour|30 minutes)$/.test(t)) return 30 * 60_000;
  const m = /^(?:(an|a|one)\s+hour\s+and\s+a\s+half)$/.exec(t);
  if (m) return 90 * 60_000;
  const d = /^(\d+(?:\.\d+)?|[a-z]+)\s*([a-z]+)$/.exec(t);
  if (!d) return null;
  const n = /^\d/.test(d[1]!) ? Number(d[1]) : WORD_NUMBERS[d[1]!];
  if (!n || !Number.isFinite(n) || n <= 0) return null;
  const unit = UNIT_MS.find(([re]) => re.test(d[2]!));
  return unit ? Math.round(n * unit[1]) : null;
}

/** "5", "5pm", "9:30", "9:30 am", "17:45", "noon", "midnight" → [hour, minute, explicitMeridiem] */
function clock(text: string): { h: number; m: number; meridiem: boolean } | null {
  const t = text.trim().toLowerCase().replace(/\./g, '');
  if (t === 'noon' || t === 'midday') return { h: 12, m: 0, meridiem: true };
  if (t === 'midnight') return { h: 0, m: 0, meridiem: true };
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return { h, m: min, meridiem: Boolean(m[3]) || h > 12 };
}

function at(base: Date, h: number, m: number, addDays = 0): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + addDays);
  d.setHours(h, m, 0, 0);
  return d;
}

/** The soonest moment, after `now`, that the clock reads h:m (trying am and pm when unspecified). */
function nextClock(now: Date, h: number, m: number, explicit: boolean): Date {
  const candidates: Date[] = [];
  const hours = explicit || h === 0 || h >= 13 ? [h] : h === 12 ? [0, 12] : [h, h + 12];
  for (const hh of hours) {
    for (const addDays of [0, 1]) candidates.push(at(now, hh % 24, m, addDays));
  }
  return candidates.filter((c) => c.getTime() > now.getTime()).sort((a, b) => +a - +b)[0]!;
}

/**
 * Understand a time phrase. `now` is injectable so tests are not at the mercy
 * of the wall clock.
 */
export function parseWhen(phrase: string, now: Date = new Date()): When | null {
  const p = phrase
    .trim()
    .toLowerCase()
    .replace(/[?.!,]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!p) return null;

  // "in 10 minutes", "in half an hour"
  const rel = /^in\s+(.+)$/.exec(p);
  if (rel) {
    const ms = durationMs(rel[1]!);
    return ms ? { at: now.getTime() + ms, matched: p } : null;
  }

  // "every day at 8", "every weekday at 7:30am", "every monday at 9"
  const every = /^every\s+(day|weekday|week|morning|evening|night|(?:mon|tues|wednes|thurs|fri|satur|sun)day)(?:\s+(?:at\s+)?(.+))?$/.exec(
    p,
  );
  if (every) {
    const what = every[1]!;
    const when = every[2] ? clock(every[2]) : null;
    if (every[2] && !when) return null;
    const defaults: Record<string, [number, number]> = {
      morning: [8, 0],
      evening: [18, 0],
      night: [21, 0],
    };
    const [h, m] = when ? [when.h, when.m] : (defaults[what] ?? [9, 0]);
    const repeat: Repeat = what === 'weekday' ? 'weekdays' : /day$/.test(what) && what !== 'day' ? 'weekly' : what === 'week' ? 'weekly' : 'daily';
    let first = nextClock(now, h, m, when?.meridiem ?? true);
    if (repeat === 'weekly' && DAYS.includes(what)) {
      const target = DAYS.indexOf(what);
      first = at(now, h, m);
      while (first.getDay() !== target || first.getTime() <= now.getTime()) first.setDate(first.getDate() + 1);
    } else if (repeat === 'weekdays') {
      while ([0, 6].includes(first.getDay())) first.setDate(first.getDate() + 1);
    }
    return { at: first.getTime(), repeat, matched: p };
  }

  // "tomorrow", "tomorrow at 9", "tomorrow morning", "tonight", "this evening"
  const day = /^(tomorrow|tonight|this (?:morning|afternoon|evening)|today)(?:\s+(?:at\s+)?(.+))?$/.exec(p);
  if (day) {
    const word = day[1]!;
    const rest = day[2];
    const offset = word === 'tomorrow' ? 1 : 0;
    const part: Record<string, [number, number]> = {
      morning: [9, 0], afternoon: [15, 0], evening: [18, 0], night: [21, 0],
    };
    let hm: [number, number] | null = null;
    if (rest) {
      const c = clock(rest);
      if (c) {
        // "tonight at 8" is 8pm; "tomorrow at 8" with no meridiem is 8am.
        const h = word === 'tonight' && c.h < 12 && !c.meridiem ? c.h + 12 : c.h;
        hm = [h, c.m];
      } else if (part[rest]) hm = part[rest]!;
      else return null;
    } else if (word === 'tonight') hm = part.night!;
    else if (word.startsWith('this ')) hm = part[word.slice(5)]!;
    else if (word === 'tomorrow') hm = [9, 0];
    else return null;
    const when = at(now, hm[0], hm[1], offset);
    if (when.getTime() <= now.getTime()) return null;
    return { at: when.getTime(), matched: p };
  }

  // "on monday", "on friday at 3pm", "next tuesday at noon"
  const weekday = /^(?:on\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:at\s+)?(.+))?$/.exec(
    p,
  );
  if (weekday) {
    const c = weekday[2] ? clock(weekday[2]) : { h: 9, m: 0, meridiem: true };
    if (!c) return null;
    const target = DAYS.indexOf(weekday[1]!);
    const when = at(now, c.h, c.m);
    while (when.getDay() !== target || when.getTime() <= now.getTime()) when.setDate(when.getDate() + 1);
    return { at: when.getTime(), matched: p };
  }

  // "at 5", "at 5:30pm", "5pm", "at noon"
  const clockText = p.replace(/^at\s+/, '');
  const c = clock(clockText);
  if (c) {
    return { at: nextClock(now, c.h, c.m, c.meridiem).getTime(), matched: p };
  }

  return null;
}

/** "in 10 minutes" / "at 5:30 PM" / "tomorrow at 9:00 AM" — how a moment reads back. */
export function describeMoment(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay) return `at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`;
}

/** Next firing after `from` for a repeating reminder. */
export function nextRepeat(repeat: Repeat, from: number): number {
  const d = new Date(from);
  do {
    d.setDate(d.getDate() + (repeat === 'weekly' ? 7 : 1));
  } while (repeat === 'weekdays' && [0, 6].includes(d.getDay()));
  return d.getTime();
}

/**
 * Split "call mom at 5" / "stretch in 10 minutes" / "take the bins out tomorrow at 7"
 * into what and when. The time phrase is the longest recognised suffix.
 */
export function splitWhen(text: string, now: Date = new Date()): { what: string; when: When } | null {
  const t = text.trim().replace(/[?.!]+$/g, '');
  const words = t.split(/\s+/);
  // Try suffixes from the longest that still leaves a subject, down to one word.
  for (let i = 1; i < words.length; i++) {
    const tail = words.slice(i).join(' ');
    // A time phrase has to start at one of these, or "call mom 5" would read as a time.
    const starts = /^(?:in|at|on|tomorrow|tonight|today|this|next|every)$/.test(words[i]!.toLowerCase()) ||
      /^(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)$/.test(words[i]!.toLowerCase());
    if (!starts) continue;
    const when = parseWhen(tail, now);
    if (when) {
      const what = words.slice(0, i).join(' ').replace(/\s+(?:at|on|in)$/i, '').trim();
      if (what) return { what, when };
    }
  }
  return null;
}
