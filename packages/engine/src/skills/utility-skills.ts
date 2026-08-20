/**
 * The pocket-knife pack: generators, converters and counters.
 *
 * These skills touch nothing outside the process — no disk, no network, no
 * clipboard — so unlike the core pack they declare no capabilities and are
 * therefore available everywhere Atlas runs, including the browser build and
 * tests. That is the point of keeping them in their own module: the core pack
 * is "what this machine can do", and this one is "what Atlas can do on its
 * own", which is a different thing to reason about when auditing risk.
 *
 * Randomness comes from `crypto.getRandomValues`, not `Math.random`. For dice
 * it makes no difference; for the password generator it is the difference
 * between a secret and a decoration, and one generator for both means the
 * weaker path doesn't exist to be picked by mistake.
 */

import type { Skill } from '@atlas/core';
import { resolveZone } from './zones';

// ---- randomness -------------------------------------------------------------

/** A uniform integer in [0, max) — rejection-sampled, so no modulo bias. */
function randomInt(max: number): number {
  if (max <= 0) return 0;
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const n = buf[0]!;
    if (n < limit) return n % max;
  }
}

function pick<T>(items: readonly T[]): T {
  return items[randomInt(items.length)]!;
}

const PASSWORD_ALPHABETS = {
  // Ambiguous glyphs (O/0, l/1/I) are left out: a password is usually read off
  // one screen and typed on another, and this costs about a third of a bit.
  letters: 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*-_=+?',
};

// ---- text -------------------------------------------------------------------

function toTitleCase(text: string): string {
  return text.replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

function toSentenceCase(text: string): string {
  return text.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w)/g, (c) => c.toUpperCase());
}

/** UTF-8 safe, because `btoa` alone throws on anything above U+00FF. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64(encoded: string): string | null {
  try {
    const binary = atob(encoded.trim());
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// ---- colour -----------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseColor(input: string): Rgb | null {
  const text = input.trim().toLowerCase();

  const hex = text.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }

  const rgb = text.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if ([r, g, b].every((n) => n >= 0 && n <= 255)) return { r: r!, g: g!, b: b! };
  }
  return null;
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function toHsl({ r, g, b }: Rgb): string {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255] as const;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

// ---- time -------------------------------------------------------------------

/** Fixed-date holidays and the two common floating ones, by year. */
function resolveOccasion(name: string, from: Date): Date | null {
  const key = name.trim().toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
  const year = from.getFullYear();

  const fixed: Record<string, [number, number]> = {
    christmas: [11, 25],
    'christmas day': [11, 25],
    'christmas eve': [11, 24],
    'new year': [0, 1],
    "new year's": [0, 1],
    "new year's day": [0, 1],
    halloween: [9, 31],
    "valentine's day": [1, 14],
    valentines: [1, 14],
    "valentine's": [1, 14],
    'april fools': [3, 1],
    'independence day': [6, 4],
    'july 4th': [6, 4],
    'boxing day': [11, 26],
  };

  const md = fixed[key];
  if (md) {
    const [month, day] = md;
    // Next occurrence, not this year's: "days until christmas" asked in
    // February and asked on Boxing Day are the same question.
    const candidate = new Date(year, month, day);
    return candidate >= startOfDay(from) ? candidate : new Date(year + 1, month, day);
  }

  if (key === 'thanksgiving') {
    const next = nthWeekdayOfMonth(year, 10, 4, 4); // 4th Thursday of November
    return next >= startOfDay(from) ? next : nthWeekdayOfMonth(year + 1, 10, 4, 4);
  }

  // A plain date: "2026-12-25", "25 December 2026", "December 25".
  const parsed = parseLooseDate(name, from);
  return parsed;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

/**
 * A date is only a date if it names a month or looks numeric.
 *
 * `Date.parse` is willing to read "twelfth of never 2026" as the 1st of
 * January — it keeps the year and discards everything it didn't understand.
 * Without this guard, `time.until` would confidently count the days to a date
 * the user never gave.
 */
const MONTH_NAME =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
const NUMERIC_DATE = /\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,4})?/;

function parseLooseDate(text: string, from: Date): Date | null {
  const trimmed = text.trim().replace(/^(the)\s+/i, '');

  // Built in local time on purpose: `Date.parse('2026-12-25')` is midnight UTC,
  // which lands on the 24th for anyone west of Greenwich.
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  if (!MONTH_NAME.test(trimmed) && !NUMERIC_DATE.test(trimmed)) return null;
  const withYear = Date.parse(trimmed);
  if (Number.isFinite(withYear)) return startOfDay(new Date(withYear));

  // "December 25" / "25 December" — no year given, so take the next one.
  const yearless = Date.parse(`${trimmed} ${from.getFullYear()}`);
  if (!Number.isFinite(yearless)) return null;
  const candidate = startOfDay(new Date(yearless));
  return candidate >= startOfDay(from)
    ? candidate
    : startOfDay(new Date(Date.parse(`${trimmed} ${from.getFullYear() + 1}`)));
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- the pack ---------------------------------------------------------------

export function createUtilitySkills(): Skill[] {
  const skills: Skill[] = [];

  // ---- generators ---------------------------------------------------------

  skills.push({
    id: 'util.password',
    label: 'Generate a password',
    icon: '🔐',
    domain: 'utility',
    description: 'Generate strong random passwords, with a length you choose.',
    risk: 'safe',
    examples: ['generate a password', 'make me a 32 character password', 'generate 5 passwords'],
    params: {
      length: { type: 'number', default: 20, description: 'how many characters (8–128)' },
      count: { type: 'number', default: 1, description: 'how many passwords (up to 20)' },
      symbols: { type: 'boolean', default: true, description: 'include punctuation' },
    },
    run(args) {
      const length = Math.min(128, Math.max(8, Math.round(Number(args.length ?? 20))));
      const count = Math.min(20, Math.max(1, Math.round(Number(args.count ?? 1))));
      const useSymbols = args.symbols !== false;
      const alphabet =
        PASSWORD_ALPHABETS.letters +
        PASSWORD_ALPHABETS.digits +
        (useSymbols ? PASSWORD_ALPHABETS.symbols : '');

      const generate = () => {
        // Guarantee one of each class rather than trusting the draw, then
        // shuffle — a password that happens to contain no digit still has to
        // satisfy the policy of whatever it's being pasted into.
        const required = [
          pick([...PASSWORD_ALPHABETS.letters.toLowerCase()]),
          pick([...PASSWORD_ALPHABETS.letters.toUpperCase()]),
          pick([...PASSWORD_ALPHABETS.digits]),
          ...(useSymbols ? [pick([...PASSWORD_ALPHABETS.symbols])] : []),
        ];
        const rest = Array.from({ length: length - required.length }, () => pick([...alphabet]));
        const chars = [...required, ...rest];
        for (let i = chars.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [chars[i], chars[j]] = [chars[j]!, chars[i]!];
        }
        return chars.join('');
      };

      const passwords = Array.from({ length: count }, generate);
      return {
        ok: true,
        message: passwords.map((p) => `🔐 ${p}`).join('\n'),
        // One password answers with a string, several with a list: callers
        // shouldn't have to unwrap an array to use the common case.
        data: count === 1 ? passwords[0] : passwords,
      };
    },
  });

  skills.push({
    id: 'util.uuid',
    label: 'Generate a UUID',
    icon: '🆔',
    domain: 'utility',
    description: 'Generate a random UUID (version 4).',
    risk: 'safe',
    examples: ['generate a uuid', 'new guid'],
    params: {},
    run() {
      const uuid = crypto.randomUUID();
      return { ok: true, message: `🆔 ${uuid}`, data: uuid };
    },
  });

  skills.push({
    id: 'util.random',
    label: 'Random number',
    icon: '🎲',
    domain: 'utility',
    description: 'Pick a random whole number in a range.',
    risk: 'safe',
    examples: ['random number between 1 and 100', 'pick a number from 1 to 6'],
    params: {
      min: { type: 'number', default: 1, description: 'lowest possible value' },
      max: { type: 'number', default: 100, description: 'highest possible value' },
    },
    run(args) {
      let min = Math.round(Number(args.min ?? 1));
      let max = Math.round(Number(args.max ?? 100));
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { ok: false, error: 'Give me two numbers to pick between.' };
      }
      if (min > max) [min, max] = [max, min];
      const value = min + randomInt(max - min + 1);
      return { ok: true, message: `🎲 ${value} (${min}–${max}).`, data: value };
    },
  });

  skills.push({
    id: 'util.coin',
    label: 'Flip a coin',
    icon: '🪙',
    domain: 'utility',
    description: 'Flip a coin.',
    risk: 'safe',
    examples: ['flip a coin', 'toss a coin'],
    params: {},
    run() {
      const side = randomInt(2) === 0 ? 'Heads' : 'Tails';
      return { ok: true, message: `🪙 ${side}.`, data: side };
    },
  });

  skills.push({
    id: 'util.dice',
    label: 'Roll dice',
    icon: '🎲',
    domain: 'utility',
    description: 'Roll dice — any number of them, with any number of sides.',
    risk: 'safe',
    examples: ['roll a dice', 'roll 2d20'],
    params: {
      count: { type: 'number', default: 1, description: 'how many dice' },
      sides: { type: 'number', default: 6, description: 'sides per die' },
    },
    run(args) {
      const count = Math.min(50, Math.max(1, Math.round(Number(args.count ?? 1))));
      const sides = Math.min(1000, Math.max(2, Math.round(Number(args.sides ?? 6))));
      const rolls = Array.from({ length: count }, () => 1 + randomInt(sides));
      const total = rolls.reduce((a, b) => a + b, 0);
      const message =
        count === 1
          ? `🎲 ${total} (d${sides}).`
          : `🎲 ${rolls.join(' + ')} = ${total} (${count}d${sides}).`;
      return { ok: true, message, data: { rolls, total } };
    },
  });

  // ---- converters ---------------------------------------------------------

  skills.push({
    id: 'util.base64',
    label: 'Base64 encode or decode',
    icon: '🔠',
    domain: 'utility',
    description: 'Encode text to Base64, or decode Base64 back to text.',
    risk: 'safe',
    examples: ['encode hello world in base64', 'decode aGVsbG8= from base64'],
    params: {
      text: { type: 'string', required: true, description: 'the text to convert' },
      mode: {
        type: 'string',
        default: 'encode',
        enum: ['encode', 'decode'],
        description: 'which direction',
      },
    },
    run(args) {
      const text = String(args.text);
      if (String(args.mode ?? 'encode') === 'decode') {
        const decoded = decodeBase64(text);
        if (decoded === null) return { ok: false, error: "That isn't valid Base64." };
        return { ok: true, message: `🔠 ${decoded}`, data: decoded };
      }
      const encoded = encodeBase64(text);
      return { ok: true, message: `🔠 ${encoded}`, data: encoded };
    },
  });

  skills.push({
    id: 'util.color',
    label: 'Convert a colour',
    icon: '🎨',
    domain: 'utility',
    description: 'Convert a colour between hex, RGB and HSL.',
    risk: 'safe',
    examples: ['convert #7c5cff to rgb', 'what is rgb(124, 92, 255) in hex'],
    params: { color: { type: 'string', required: true, description: 'a hex or rgb() colour' } },
    run(args) {
      const rgb = parseColor(String(args.color));
      if (!rgb)
        return { ok: false, error: `I don't recognise "${String(args.color)}" as a colour.` };
      const hex = toHex(rgb);
      const message = `🎨 ${hex} · rgb(${rgb.r}, ${rgb.g}, ${rgb.b}) · ${toHsl(rgb)}`;
      return { ok: true, message, data: { hex, ...rgb } };
    },
  });

  // ---- text ---------------------------------------------------------------

  skills.push({
    id: 'text.count',
    label: 'Count words',
    icon: '🔢',
    domain: 'text',
    description: 'Count the words, characters and lines in a piece of text.',
    risk: 'safe',
    examples: ['how many words are in "the quick brown fox"'],
    params: { text: { type: 'string', required: true, description: 'the text to measure' } },
    run(args) {
      const text = String(args.text);
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const characters = text.length;
      const withoutSpaces = text.replace(/\s/g, '').length;
      const lines = text ? text.split(/\r?\n/).length : 0;
      return {
        ok: true,
        message: `🔢 ${words} words · ${characters} characters (${withoutSpaces} without spaces) · ${lines} lines.`,
        data: { words, characters, withoutSpaces, lines },
      };
    },
  });

  skills.push({
    id: 'text.case',
    label: 'Change case',
    icon: '🔡',
    domain: 'text',
    description: 'Rewrite text in upper case, lower case, Title Case or Sentence case.',
    risk: 'safe',
    examples: ['uppercase "hello world"', 'title case "the great escape"'],
    params: {
      text: { type: 'string', required: true, description: 'the text to rewrite' },
      style: {
        type: 'string',
        required: true,
        enum: ['upper', 'lower', 'title', 'sentence'],
        description: 'which casing',
      },
    },
    run(args) {
      const text = String(args.text);
      const style = String(args.style);
      const out =
        style === 'upper'
          ? text.toUpperCase()
          : style === 'lower'
            ? text.toLowerCase()
            : style === 'title'
              ? toTitleCase(text)
              : toSentenceCase(text);
      return { ok: true, message: `🔡 ${out}`, data: out };
    },
  });

  // ---- arithmetic people ask in words -------------------------------------

  skills.push({
    id: 'math.percent',
    label: 'Percentages',
    icon: '💯',
    domain: 'math',
    description:
      'Work out a percentage of a number, what percent one number is of another, or a percentage change.',
    risk: 'safe',
    examples: ["what's 15% of 240", '20 is what percent of 80', 'percent change from 50 to 75'],
    params: {
      a: { type: 'number', required: true, description: 'the first number' },
      b: { type: 'number', required: true, description: 'the second number' },
      mode: {
        type: 'string',
        default: 'of',
        enum: ['of', 'is', 'change'],
        description: '"of" = a% of b, "is" = a is what % of b, "change" = a → b',
      },
    },
    run(args) {
      const a = Number(args.a);
      const b = Number(args.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return { ok: false, error: 'I need two numbers for that.' };
      }
      const round = (n: number) => Math.round(n * 100) / 100;

      switch (String(args.mode ?? 'of')) {
        case 'is': {
          if (b === 0) return { ok: false, error: "I can't take a percentage of zero." };
          const pct = round((a / b) * 100);
          return { ok: true, message: `💯 ${a} is ${pct}% of ${b}.`, data: pct };
        }
        case 'change': {
          if (a === 0) return { ok: false, error: "I can't measure a change from zero." };
          const pct = round(((b - a) / Math.abs(a)) * 100);
          const direction = pct >= 0 ? 'increase' : 'decrease';
          return {
            ok: true,
            message: `💯 ${a} → ${b} is a ${Math.abs(pct)}% ${direction}.`,
            data: pct,
          };
        }
        default: {
          const value = round((a / 100) * b);
          return { ok: true, message: `💯 ${a}% of ${b} is ${value}.`, data: value };
        }
      }
    },
  });

  skills.push({
    id: 'math.average',
    label: 'Average a list',
    icon: '📈',
    domain: 'math',
    description: 'Average a list of numbers, with their total, smallest and largest.',
    risk: 'safe',
    examples: ['average of 3, 7 and 11', 'mean of 10 20 30'],
    params: {
      numbers: {
        type: 'string',
        required: true,
        description: 'the numbers, separated by commas or spaces',
      },
    },
    run(args) {
      // Strip the non-numeric fragments *before* converting: `Number('')` is
      // 0, so a stray "and" would otherwise join the list as a real value and
      // drag the mean down.
      const numbers = String(args.numbers)
        .split(/[,\s]+/)
        .map((part) => part.replace(/[^\d.-]/g, ''))
        .filter((part) => part !== '' && part !== '-' && part !== '.')
        .map(Number)
        .filter((n) => Number.isFinite(n));

      if (!numbers.length) return { ok: false, error: 'I couldn’t find any numbers in that.' };

      const sum = numbers.reduce((a, b) => a + b, 0);
      const mean = Math.round((sum / numbers.length) * 1000) / 1000;
      return {
        ok: true,
        message: `📈 Average ${mean} · total ${sum} · low ${Math.min(...numbers)} · high ${Math.max(...numbers)} (${numbers.length} numbers).`,
        data: { mean, sum, count: numbers.length },
      };
    },
  });

  // ---- time ---------------------------------------------------------------

  skills.push({
    id: 'time.inZone',
    label: 'Time somewhere else',
    icon: '🌍',
    domain: 'time',
    description: 'Tell the time in another city or time zone.',
    risk: 'safe',
    examples: ['what time is it in tokyo', 'time in london'],
    params: {
      place: { type: 'string', required: true, description: 'a city name or IANA time zone' },
    },
    run(args) {
      const place = String(args.place);
      const zone = resolveZone(place);
      if (!zone) return { ok: false, error: `I don't know what time zone "${place}" is in.` };

      const now = new Date();
      const time = new Intl.DateTimeFormat(undefined, {
        timeZone: zone,
        hour: 'numeric',
        minute: '2-digit',
        weekday: 'short',
      }).format(now);
      return { ok: true, message: `🌍 ${time} in ${place.trim()}.`, data: { zone, time } };
    },
  });

  skills.push({
    id: 'time.until',
    label: 'Days until a date',
    icon: '📅',
    domain: 'time',
    description: 'Count the days until a date or a holiday.',
    risk: 'safe',
    examples: ['how many days until christmas', 'days until 2027-01-01'],
    params: {
      occasion: { type: 'string', required: true, description: 'a date or the name of a holiday' },
    },
    run(args) {
      const occasion = String(args.occasion);
      const now = new Date();
      const target = resolveOccasion(occasion, now);
      if (!target || Number.isNaN(target.getTime())) {
        return { ok: false, error: `I couldn't work out when "${occasion}" is.` };
      }

      const days = Math.round((startOfDay(target).getTime() - startOfDay(now).getTime()) / DAY_MS);
      const when = target.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
      const message =
        days === 0
          ? `📅 ${occasion.trim()} is today (${when}).`
          : days === 1
            ? `📅 1 day until ${occasion.trim()} — ${when}.`
            : days > 0
              ? `📅 ${days} days until ${occasion.trim()} — ${when}.`
              : `📅 ${Math.abs(days)} days since ${occasion.trim()} — ${when}.`;
      return { ok: true, message, data: { days, date: target.toISOString() } };
    },
  });

  return skills;
}
