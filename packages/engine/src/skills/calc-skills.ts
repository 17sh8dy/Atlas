/**
 * The sums and date arithmetic people do on paper, in a phone calculator, or
 * on an ad-covered website — tips, loan payments, aspect ratios, "how old is
 * someone born in March 1994", "how many days between these two dates".
 *
 * Pure like the rest of the utility pack: no capabilities, no I/O. The time
 * skills here read the clock and the host's time zone through `Intl`, which is
 * the same source `time.now` already trusts.
 */

import type { Skill } from '@atlas/core';
import { resolveZone } from './zones';

const DAY_MS = 24 * 60 * 60 * 1000;

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function money(value: number): string {
  return value.toFixed(2);
}

/** Greatest common divisor, for reducing fractions and aspect ratios. */
function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/** ISO date-only strings, built in local time. See `parseDate`. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_NAME =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

/**
 * A date from "1994-03-05", "March 5 1994" or "5 March 1994".
 *
 * The ISO branch is not redundant: `Date.parse('2026-12-25')` is midnight
 * *UTC*, which is Christmas Eve anywhere west of Greenwich — so a plain date
 * has to be built in local time or every answer here is a day out.
 */
function parseDate(text: string): Date | null {
  const trimmed = String(text).trim();
  if (!/\d/.test(trimmed)) return null;

  const iso = trimmed.match(ISO_DATE);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  // A bare number is not a date, however willing `Date.parse` is to read "0"
  // as the year 2000. A date names a month or has separators in it.
  if (!MONTH_NAME.test(trimmed) && !/\d[-/.]\d/.test(trimmed)) return null;

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const BYTE_UNITS: Record<string, number> = {
  b: 1 / 8,
  bit: 1 / 8,
  bits: 1 / 8,
  byte: 1,
  bytes: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

export function createCalcSkills(): Skill[] {
  const skills: Skill[] = [];

  // ---- money --------------------------------------------------------------

  skills.push({
    id: 'math.tip',
    label: 'Tip and split',
    icon: '🧾',
    domain: 'math',
    description: 'Work out a tip and split the bill.',
    risk: 'safe',
    examples: ['tip on 84.50', '20% tip on 120 split 4 ways'],
    params: {
      bill: { type: 'number', required: true, description: 'the bill total' },
      percent: { type: 'number', default: 18, description: 'tip percentage' },
      people: { type: 'number', default: 1, description: 'how many people are splitting it' },
    },
    run(args) {
      const bill = Number(args.bill);
      if (!Number.isFinite(bill) || bill <= 0)
        return { ok: false, error: 'Give me a bill amount.' };

      const percent = Number(args.percent ?? 18);
      const people = Math.max(1, Math.round(Number(args.people ?? 1)));
      const tip = round((bill * percent) / 100);
      const total = round(bill + tip);

      const message =
        people > 1
          ? `🧾 ${money(tip)} tip (${percent}%) · ${money(total)} total · ${money(total / people)} each across ${people}.`
          : `🧾 ${money(tip)} tip (${percent}%) · ${money(total)} total.`;
      return { ok: true, message, data: { tip, total, each: round(total / people) } };
    },
  });

  skills.push({
    id: 'math.interest',
    label: 'Loan or savings',
    icon: '🏦',
    domain: 'math',
    description: 'Work out a monthly loan payment, or what savings grow to with compound interest.',
    risk: 'safe',
    examples: ['monthly payment on 25000 at 6% over 5 years', 'compound 5000 at 4% for 10 years'],
    params: {
      amount: { type: 'number', required: true, description: 'the principal' },
      rate: { type: 'number', required: true, description: 'annual interest rate, in percent' },
      years: { type: 'number', required: true, description: 'how many years' },
      mode: {
        type: 'string',
        default: 'loan',
        enum: ['loan', 'savings'],
        description: '"loan" for a monthly payment, "savings" for growth',
      },
    },
    run(args) {
      const amount = Number(args.amount);
      const rate = Number(args.rate);
      const years = Number(args.years);
      if (![amount, rate, years].every(Number.isFinite) || amount <= 0 || years <= 0) {
        return { ok: false, error: 'I need an amount, a rate and a number of years.' };
      }

      if (String(args.mode ?? 'loan') === 'savings') {
        // Compounded monthly, the convention retail savings products quote.
        const final = amount * (1 + rate / 100 / 12) ** (years * 12);
        const interest = final - amount;
        return {
          ok: true,
          message: `🏦 ${money(final)} after ${years} years — ${money(interest)} of that is interest.`,
          data: { final: round(final), interest: round(interest) },
        };
      }

      const monthlyRate = rate / 100 / 12;
      const months = years * 12;
      const payment =
        monthlyRate === 0
          ? amount / months
          : (amount * monthlyRate) / (1 - (1 + monthlyRate) ** -months);
      const total = payment * months;
      return {
        ok: true,
        message: `🏦 ${money(payment)} a month for ${years} years — ${money(total)} paid in total, ${money(total - amount)} of it interest.`,
        data: { payment: round(payment), total: round(total), interest: round(total - amount) },
      };
    },
  });

  // ---- numbers ------------------------------------------------------------

  skills.push({
    id: 'math.aspect',
    label: 'Aspect ratio',
    icon: '🖼️',
    domain: 'math',
    description: 'Find the aspect ratio of a size, or scale a size to a new width or height.',
    risk: 'safe',
    examples: ['aspect ratio of 1920x1080', 'resize 1920x1080 to width 1280'],
    params: {
      width: { type: 'number', required: true, description: 'the original width' },
      height: { type: 'number', required: true, description: 'the original height' },
      toWidth: { type: 'number', required: false, description: 'scale to this width' },
      toHeight: { type: 'number', required: false, description: 'scale to this height' },
    },
    run(args) {
      const width = Number(args.width);
      const height = Number(args.height);
      if (!(width > 0) || !(height > 0))
        return { ok: false, error: 'Give me a width and a height.' };

      const divisor = gcd(width, height);
      const ratio = `${width / divisor}:${height / divisor}`;

      if (args.toWidth || args.toHeight) {
        const scaled = args.toWidth
          ? {
              width: Number(args.toWidth),
              height: Math.round((Number(args.toWidth) * height) / width),
            }
          : {
              width: Math.round((Number(args.toHeight) * width) / height),
              height: Number(args.toHeight),
            };
        return {
          ok: true,
          message: `🖼️ ${scaled.width}×${scaled.height} (${ratio}).`,
          data: scaled,
        };
      }
      return {
        ok: true,
        message: `🖼️ ${width}×${height} is ${ratio} (${round(width / height, 3)}:1).`,
        data: { ratio },
      };
    },
  });

  skills.push({
    id: 'math.bytes',
    label: 'Convert data sizes',
    icon: '💾',
    domain: 'math',
    description: 'Convert between bytes, KB, MB, GB and TB.',
    risk: 'safe',
    examples: ['how many mb in 4.7 gb', 'convert 1500 mb to gb'],
    params: {
      value: { type: 'number', required: true, description: 'the amount' },
      from: { type: 'string', required: true, description: 'the unit it is in' },
      to: { type: 'string', required: true, description: 'the unit to convert to' },
    },
    run(args) {
      const from = String(args.from).toLowerCase();
      const to = String(args.to).toLowerCase();
      const fromFactor = BYTE_UNITS[from];
      const toFactor = BYTE_UNITS[to];
      if (!fromFactor || !toFactor) {
        return { ok: false, error: `I can't convert between "${from}" and "${to}".` };
      }
      const value = Number(args.value);
      if (!Number.isFinite(value)) return { ok: false, error: 'Give me an amount.' };

      const result = (value * fromFactor) / toFactor;
      return {
        ok: true,
        message: `💾 ${value} ${from.toUpperCase()} is ${round(result, 3)} ${to.toUpperCase()}.`,
        data: round(result, 6),
      };
    },
  });

  skills.push({
    id: 'math.primes',
    label: 'Primes and factors',
    icon: '🔬',
    domain: 'math',
    description: 'Say whether a number is prime, and break it into its prime factors.',
    risk: 'safe',
    examples: ['is 97 prime', 'factor 360'],
    params: { value: { type: 'number', required: true, description: 'the number' } },
    run(args) {
      const n = Math.round(Number(args.value));
      if (!Number.isFinite(n) || n < 2 || n > 2 ** 48) {
        return { ok: false, error: 'Give me a whole number of two or more.' };
      }

      const factors: number[] = [];
      let left = n;
      for (let d = 2; d * d <= left; d++) {
        while (left % d === 0) {
          factors.push(d);
          left /= d;
        }
      }
      if (left > 1) factors.push(left);

      if (factors.length === 1)
        return { ok: true, message: `🔬 ${n} is prime.`, data: { prime: true } };
      return {
        ok: true,
        message: `🔬 ${n} is not prime — ${factors.join(' × ')}.`,
        data: { prime: false, factors },
      };
    },
  });

  skills.push({
    id: 'math.fraction',
    label: 'Fractions and decimals',
    icon: '➗',
    domain: 'math',
    description: 'Turn a decimal into a fraction, or a fraction into a decimal.',
    risk: 'safe',
    examples: ['0.375 as a fraction', '3/8 as a decimal'],
    params: { value: { type: 'string', required: true, description: 'a decimal or a fraction' } },
    run(args) {
      const raw = String(args.value).trim();

      const fraction = raw.match(/^(-?\d+)\s*\/\s*(\d+)$/);
      if (fraction) {
        const numerator = Number(fraction[1]);
        const denominator = Number(fraction[2]);
        if (denominator === 0) return { ok: false, error: "You can't divide by zero." };
        const decimal = numerator / denominator;
        return { ok: true, message: `➗ ${round(decimal, 6)}`, data: decimal };
      }

      const decimal = Number(raw);
      if (!Number.isFinite(decimal))
        return { ok: false, error: `"${raw}" isn't a number or a fraction.` };

      // Denominator from the written precision, then reduced — exact for the
      // decimals people actually type, without a continued-fraction search.
      const places = (raw.split('.')[1] ?? '').length;
      const denominator = 10 ** places;
      const numerator = Math.round(decimal * denominator);
      const divisor = gcd(numerator, denominator);
      const whole = `${numerator / divisor}/${denominator / divisor}`;
      return { ok: true, message: `➗ ${whole}`, data: whole };
    },
  });

  // ---- dates --------------------------------------------------------------

  skills.push({
    id: 'time.zoneDiff',
    label: 'Time difference',
    icon: '🌐',
    domain: 'time',
    description: 'The hour difference between two cities, and what time it is in each.',
    risk: 'safe',
    examples: ['time difference between london and tokyo'],
    params: {
      from: { type: 'string', required: true, description: 'the first city or zone' },
      to: { type: 'string', required: true, description: 'the second city or zone' },
    },
    run(args) {
      const fromZone = resolveZone(String(args.from));
      const toZone = resolveZone(String(args.to));
      if (!fromZone) return { ok: false, error: `I don't know where "${String(args.from)}" is.` };
      if (!toZone) return { ok: false, error: `I don't know where "${String(args.to)}" is.` };

      const now = new Date();
      const inZone = (zone: string) => new Date(now.toLocaleString('en-US', { timeZone: zone }));
      const hours = round(
        (inZone(toZone).getTime() - inZone(fromZone).getTime()) / (60 * 60 * 1000),
        1,
      );

      const clock = (zone: string) =>
        new Intl.DateTimeFormat(undefined, {
          timeZone: zone,
          hour: 'numeric',
          minute: '2-digit',
          weekday: 'short',
        }).format(now);

      const direction =
        hours === 0 ? 'the same time' : `${Math.abs(hours)}h ${hours > 0 ? 'ahead' : 'behind'}`;
      return {
        ok: true,
        message: `🌐 ${String(args.to).trim()} is ${direction} of ${String(args.from).trim()} — ${clock(fromZone)} vs ${clock(toZone)}.`,
        data: { hours },
      };
    },
  });

  skills.push({
    id: 'time.age',
    label: 'Work out an age',
    icon: '🎂',
    domain: 'time',
    description: 'How old someone born on a given date is today.',
    risk: 'safe',
    examples: ['how old is someone born 1994-03-05'],
    params: { date: { type: 'string', required: true, description: 'the date of birth' } },
    run(args) {
      const born = parseDate(String(args.date));
      if (!born) return { ok: false, error: `I couldn't read "${String(args.date)}" as a date.` };

      const now = new Date();
      if (born > now) return { ok: false, error: "That date hasn't happened yet." };

      let years = now.getFullYear() - born.getFullYear();
      const hadBirthday =
        now.getMonth() > born.getMonth() ||
        (now.getMonth() === born.getMonth() && now.getDate() >= born.getDate());
      if (!hadBirthday) years -= 1;

      const days = Math.floor((startOfDay(now).getTime() - startOfDay(born).getTime()) / DAY_MS);
      return {
        ok: true,
        message: `🎂 ${years} years old — ${days.toLocaleString()} days since ${born.toLocaleDateString()}.`,
        data: { years, days },
      };
    },
  });

  skills.push({
    id: 'time.between',
    label: 'Time between dates',
    icon: '📆',
    domain: 'time',
    description: 'How long there is between two dates.',
    risk: 'safe',
    examples: ['days between 2026-01-01 and 2026-08-17'],
    params: {
      from: { type: 'string', required: true, description: 'the first date' },
      to: { type: 'string', required: true, description: 'the second date' },
    },
    run(args) {
      const from = parseDate(String(args.from));
      const to = parseDate(String(args.to));
      if (!from) return { ok: false, error: `I couldn't read "${String(args.from)}" as a date.` };
      if (!to) return { ok: false, error: `I couldn't read "${String(args.to)}" as a date.` };

      const days = Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
      const weeks = round(Math.abs(days) / 7, 1);
      const direction = days < 0 ? 'before' : 'after';
      return {
        ok: true,
        message: `📆 ${Math.abs(days).toLocaleString()} days (${weeks} weeks) — ${to.toLocaleDateString()} is ${direction} ${from.toLocaleDateString()}.`,
        data: { days },
      };
    },
  });

  skills.push({
    id: 'time.weekday',
    label: 'What day was that',
    icon: '🗓️',
    domain: 'time',
    description: 'Which day of the week a date falls on.',
    risk: 'safe',
    examples: ['what day of the week is 2026-12-25'],
    params: { date: { type: 'string', required: true, description: 'the date' } },
    run(args) {
      const date = parseDate(String(args.date));
      if (!date) return { ok: false, error: `I couldn't read "${String(args.date)}" as a date.` };

      const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
      const full = date.toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
      const tense = startOfDay(date) < startOfDay(new Date()) ? 'was' : 'is';
      return { ok: true, message: `🗓️ ${full} ${tense} a ${weekday}.`, data: weekday };
    },
  });

  skills.push({
    id: 'time.unix',
    label: 'Unix timestamps',
    icon: '⏱️',
    domain: 'time',
    description: 'Convert a unix timestamp to a date, or a date to a timestamp.',
    risk: 'safe',
    examples: ['timestamp 1767225600', 'unix time for 2026-01-01'],
    params: { value: { type: 'string', required: true, description: 'a timestamp or a date' } },
    run(args) {
      const raw = String(args.value).trim();

      if (/^\d{9,13}$/.test(raw)) {
        // Ten digits is seconds, thirteen is milliseconds — the two forms in
        // the wild, told apart by length rather than by asking.
        const ms = raw.length <= 10 ? Number(raw) * 1000 : Number(raw);
        const date = new Date(ms);
        return {
          ok: true,
          message: `⏱️ ${date.toLocaleString()} (${date.toISOString()})`,
          data: date.toISOString(),
        };
      }

      const date = parseDate(raw);
      if (!date) return { ok: false, error: `"${raw}" isn't a timestamp or a date.` };
      const seconds = Math.floor(date.getTime() / 1000);
      return {
        ok: true,
        message: `⏱️ ${seconds} (seconds) · ${date.getTime()} (ms)`,
        data: seconds,
      };
    },
  });

  return skills;
}
