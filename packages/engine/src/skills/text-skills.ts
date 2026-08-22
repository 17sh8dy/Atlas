/**
 * Text and encoding — the things you'd otherwise open a website to do.
 *
 * Every one of these is the kind of job people habitually paste into a random
 * "online JSON formatter" or "SHA-256 generator", which is to say: they paste
 * whatever they were working on into someone else's server. Doing them here,
 * in-process and offline, is the whole point — so, like the rest of the utility
 * pack, none of these declares a capability and none of them touches the disk,
 * the clipboard or the network.
 */

import type { Skill } from '@atlas/core';

/** Split on newlines without inventing a trailing empty line. */
function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

const LOREM_WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(
    ' ',
  );

/** Words people don't mean when they ask what a text is about. */
const STOP_WORDS = new Set(
  'the a an and or but of to in on at for with from by is are was were be been being it its this that these those as if then than so not no i you he she they we my your his her their our me him them us'.split(
    ' ',
  ),
);

const ROMAN_TABLE: Array<[number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

const ROMAN_VALUES: Record<string, number> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
};

function toRoman(value: number): string {
  let left = value;
  let out = '';
  for (const [amount, numeral] of ROMAN_TABLE) {
    while (left >= amount) {
      out += numeral;
      left -= amount;
    }
  }
  return out;
}

function fromRoman(text: string): number | null {
  const upper = text.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(upper)) return null;
  let total = 0;
  for (let i = 0; i < upper.length; i++) {
    const here = ROMAN_VALUES[upper[i]!]!;
    const next = i + 1 < upper.length ? ROMAN_VALUES[upper[i + 1]!]! : 0;
    total += here < next ? -here : here;
  }
  // Round-tripping is the only honest validation: "IIII" and "VX" parse to
  // numbers but aren't roman numerals.
  return toRoman(total) === upper ? total : null;
}

function decodeBase64Url(part: string): string | null {
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function createTextSkills(): Skill[] {
  const skills: Skill[] = [];

  // ---- reshaping text -----------------------------------------------------

  skills.push({
    id: 'text.replace',
    label: 'Find and replace',
    icon: '🔁',
    domain: 'text',
    description: 'Replace every occurrence of one string with another.',
    risk: 'safe',
    examples: ['in "a-b-c" replace - with +'],
    params: {
      text: { type: 'string', required: true, description: 'the text to work on' },
      find: { type: 'string', required: true, description: 'what to look for' },
      replace: { type: 'string', default: '', description: 'what to put there instead' },
    },
    run(args) {
      const text = String(args.text);
      const find = String(args.find);
      if (!find) return { ok: false, error: 'Tell me what to look for.' };
      const replacement = args.replace === undefined ? '' : String(args.replace);
      const count = text.split(find).length - 1;
      const out = text.split(find).join(replacement);
      return { ok: true, message: `🔁 ${out}\n\n(${count} replaced)`, data: out };
    },
  });

  skills.push({
    id: 'text.sortLines',
    label: 'Sort lines',
    icon: '🔤',
    domain: 'text',
    description: 'Sort lines alphabetically, forwards or backwards.',
    risk: 'safe',
    examples: ['sort these lines'],
    params: {
      text: { type: 'string', required: true, description: 'the lines to sort' },
      descending: { type: 'boolean', default: false, description: 'sort Z→A instead' },
    },
    run(args) {
      const sorted = lines(String(args.text))
        .filter((l) => l.trim())
        .sort((a, b) => a.localeCompare(b));
      if (args.descending) sorted.reverse();
      return { ok: true, message: `🔤 ${sorted.join('\n')}`, data: sorted };
    },
  });

  skills.push({
    id: 'text.dedupe',
    label: 'Remove duplicate lines',
    icon: '🧹',
    domain: 'text',
    description: 'Remove repeated lines, keeping the first of each.',
    risk: 'safe',
    examples: ['remove duplicate lines'],
    params: { text: { type: 'string', required: true, description: 'the lines to clean up' } },
    run(args) {
      const all = lines(String(args.text));
      const seen = new Set<string>();
      const kept = all.filter((line) => {
        const key = line.trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const removed = all.filter((l) => l.trim()).length - kept.length;
      return { ok: true, message: `🧹 ${kept.join('\n')}\n\n(${removed} removed)`, data: kept };
    },
  });

  skills.push({
    id: 'text.trim',
    label: 'Tidy up text',
    icon: '✂️',
    domain: 'text',
    description: 'Strip trailing spaces, collapse blank runs and trim the ends.',
    risk: 'safe',
    examples: ['tidy up this text'],
    params: { text: { type: 'string', required: true, description: 'the text to tidy' } },
    run(args) {
      const out = lines(String(args.text))
        .map((l) => l.replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return { ok: true, message: `✂️ ${out}`, data: out };
    },
  });

  skills.push({
    id: 'text.extract',
    label: 'Pull out emails and links',
    icon: '🪝',
    domain: 'text',
    description: 'Extract the email addresses, links or numbers from a piece of text.',
    risk: 'safe',
    examples: ['extract the emails from this'],
    params: {
      text: { type: 'string', required: true, description: 'the text to scan' },
      what: {
        type: 'string',
        default: 'links',
        enum: ['links', 'emails', 'numbers'],
        description: 'what to pull out',
      },
    },
    run(args) {
      const text = String(args.text);
      const what = String(args.what ?? 'links');
      const pattern =
        what === 'emails'
          ? /[\w.+-]+@[\w-]+\.[\w.-]+/g
          : what === 'numbers'
            ? /-?\d+(?:\.\d+)?/g
            : /https?:\/\/[^\s<>"')]+/g;

      const found = [...new Set(text.match(pattern) ?? [])];
      if (!found.length) return { ok: true, message: `No ${what} in there.` };
      return { ok: true, message: `🪝 ${found.join('\n')}`, data: found };
    },
  });

  skills.push({
    id: 'text.slug',
    label: 'Make a slug',
    icon: '🔗',
    domain: 'text',
    description: 'Turn a title into a url-safe slug.',
    risk: 'safe',
    examples: ['slugify "My First Post!"'],
    params: { text: { type: 'string', required: true, description: 'the title' } },
    run(args) {
      const slug = String(args.text)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!slug) return { ok: false, error: "There's nothing sluggable in there." };
      return { ok: true, message: `🔗 ${slug}`, data: slug };
    },
  });

  skills.push({
    id: 'text.frequency',
    label: 'Most used words',
    icon: '📊',
    domain: 'text',
    description: 'Count which words appear most often in a piece of text.',
    risk: 'safe',
    // For the eyes, not the ear — see SkillResult.aloud.
    aloud: false,
    examples: ['most common words in this'],
    params: {
      text: { type: 'string', required: true, description: 'the text to analyse' },
      limit: { type: 'number', default: 10, description: 'how many to show' },
    },
    run(args) {
      const words = String(args.text)
        .toLowerCase()
        .match(/[\p{L}'-]+/gu);
      if (!words?.length) return { ok: true, message: 'No words in there.' };

      const counts = new Map<string, number>();
      for (const word of words) {
        if (STOP_WORDS.has(word) || word.length < 2) continue;
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.max(1, Math.min(50, Number(args.limit ?? 10))));

      if (!top.length) return { ok: true, message: 'Nothing but filler words in there.' };
      return {
        ok: true,
        message: `📊 ${top.map(([word, n]) => `${word} ×${n}`).join(' · ')}`,
        data: top,
      };
    },
  });

  skills.push({
    id: 'text.lorem',
    label: 'Placeholder text',
    icon: '📄',
    domain: 'text',
    description: 'Generate lorem ipsum placeholder text.',
    risk: 'safe',
    examples: ['lorem ipsum 40 words'],
    params: { words: { type: 'number', default: 50, description: 'how many words' } },
    run(args) {
      const count = Math.min(500, Math.max(1, Math.round(Number(args.words ?? 50))));
      const out: string[] = [];
      for (let i = 0; i < count; i++) out.push(LOREM_WORDS[i % LOREM_WORDS.length]!);
      const text = `${out.join(' ').replace(/^./, (c) => c.toUpperCase())}.`;
      return { ok: true, message: `📄 ${text}`, data: text };
    },
  });

  // ---- encoding and formats -----------------------------------------------

  skills.push({
    id: 'util.urlEncode',
    label: 'URL encode or decode',
    icon: '🔗',
    domain: 'utility',
    description: 'Percent-encode text for a URL, or decode it back.',
    risk: 'safe',
    examples: ['url encode hello world & friends'],
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
      try {
        const out =
          String(args.mode ?? 'encode') === 'decode'
            ? decodeURIComponent(text)
            : encodeURIComponent(text);
        return { ok: true, message: `🔗 ${out}`, data: out };
      } catch {
        return { ok: false, error: "That isn't valid percent-encoded text." };
      }
    },
  });

  skills.push({
    id: 'util.hash',
    label: 'Hash some text',
    icon: '#️⃣',
    domain: 'utility',
    description: 'Take the SHA-256 (or SHA-1/SHA-512) hash of some text.',
    risk: 'safe',
    // For the eyes, not the ear — see SkillResult.aloud.
    aloud: false,
    examples: ['sha256 of hello world'],
    params: {
      text: { type: 'string', required: true, description: 'the text to hash' },
      algorithm: {
        type: 'string',
        default: 'SHA-256',
        enum: ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'],
        description: 'which hash',
      },
    },
    async run(args) {
      const algorithm = String(args.algorithm ?? 'SHA-256').toUpperCase();
      const bytes = new TextEncoder().encode(String(args.text));
      const digest = await crypto.subtle.digest(algorithm, bytes);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { ok: true, message: `#️⃣ ${hex}`, data: hex };
    },
  });

  skills.push({
    id: 'util.hex',
    label: 'Convert a number base',
    icon: '🔢',
    domain: 'utility',
    description: 'Convert a number between decimal, hexadecimal and binary.',
    risk: 'safe',
    examples: ['255 in hex', 'convert 0xff to decimal'],
    params: {
      value: {
        type: 'string',
        required: true,
        description: 'the number, in any of the three bases',
      },
      to: {
        type: 'string',
        default: 'all',
        enum: ['all', 'decimal', 'hex', 'binary'],
        description: 'target base',
      },
    },
    run(args) {
      const raw = String(args.value)
        .trim()
        .toLowerCase()
        .replace(/[_,\s]/g, '');
      const parsed = /^0x[0-9a-f]+$/.test(raw)
        ? parseInt(raw.slice(2), 16)
        : /^0b[01]+$/.test(raw)
          ? parseInt(raw.slice(2), 2)
          : /^-?\d+$/.test(raw)
            ? Number(raw)
            : NaN;

      if (!Number.isFinite(parsed)) {
        return { ok: false, error: `"${String(args.value)}" isn't a number I can read.` };
      }
      const to = String(args.to ?? 'all');
      const hex = `0x${Math.abs(parsed).toString(16)}`;
      const binary = `0b${Math.abs(parsed).toString(2)}`;
      const message =
        to === 'hex'
          ? hex
          : to === 'binary'
            ? binary
            : to === 'decimal'
              ? String(parsed)
              : `${parsed} · ${hex} · ${binary}`;
      return { ok: true, message: `🔢 ${message}`, data: { decimal: parsed, hex, binary } };
    },
  });

  skills.push({
    id: 'util.json',
    label: 'Format JSON',
    icon: '🧾',
    domain: 'utility',
    description: 'Pretty-print, minify or check a piece of JSON.',
    risk: 'safe',
    examples: ['format this json'],
    params: {
      text: { type: 'string', required: true, description: 'the JSON' },
      mode: {
        type: 'string',
        default: 'format',
        enum: ['format', 'minify'],
        description: 'which output',
      },
    },
    run(args) {
      const text = String(args.text).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // The parser's own message says *where* it went wrong, which is the
        // useful half of "invalid JSON".
        return {
          ok: false,
          error: `That isn't valid JSON — ${e instanceof Error ? e.message : 'unparseable'}.`,
        };
      }
      const out =
        String(args.mode ?? 'format') === 'minify'
          ? JSON.stringify(parsed)
          : JSON.stringify(parsed, null, 2);
      return { ok: true, message: `🧾 ${out}`, data: out };
    },
  });

  skills.push({
    id: 'util.jwt',
    label: 'Decode a JWT',
    icon: '🎫',
    domain: 'utility',
    description: 'Show what is inside a JSON web token, without verifying it.',
    risk: 'safe',
    // For the eyes, not the ear — see SkillResult.aloud.
    aloud: false,
    examples: ['decode this jwt'],
    params: { token: { type: 'string', required: true, description: 'the token' } },
    run(args) {
      const parts = String(args.token).trim().split('.');
      if (parts.length < 2) return { ok: false, error: "That doesn't look like a JWT." };

      const header = decodeBase64Url(parts[0]!);
      const payload = decodeBase64Url(parts[1]!);
      if (!header || !payload) return { ok: false, error: "I couldn't decode that token." };

      let pretty: string;
      try {
        pretty = JSON.stringify(JSON.parse(payload), null, 2);
      } catch {
        return { ok: false, error: "That token's payload isn't JSON." };
      }

      // Said plainly, because a decoded token looks verified and isn't: the
      // signature is the part that matters and this never checks it.
      return {
        ok: true,
        message: `🎫 ${pretty}\n\n(decoded only — the signature is not checked)`,
        data: pretty,
      };
    },
  });

  skills.push({
    id: 'util.roman',
    label: 'Roman numerals',
    icon: '🏛️',
    domain: 'utility',
    description: 'Convert a number to roman numerals, or roman numerals to a number.',
    risk: 'safe',
    examples: ['1994 in roman numerals', 'what is MCMXCIV'],
    params: {
      value: { type: 'string', required: true, description: 'a number or a roman numeral' },
    },
    run(args) {
      const raw = String(args.value).trim();
      if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        if (n < 1 || n > 3999) {
          return { ok: false, error: 'Roman numerals only run from 1 to 3999.' };
        }
        return { ok: true, message: `🏛️ ${toRoman(n)}`, data: toRoman(n) };
      }
      const value = fromRoman(raw);
      if (value === null) return { ok: false, error: `"${raw}" isn't a roman numeral.` };
      return { ok: true, message: `🏛️ ${value}`, data: value };
    },
  });

  return skills;
}
