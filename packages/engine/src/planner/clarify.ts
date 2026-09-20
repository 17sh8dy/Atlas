/**
 * The mechanism behind "asking instead of guessing" — see
 * `@atlas/core`'s `models/clarify.ts` for what it is and when it applies.
 *
 * Everything here is pure: what to ask, in what words, and what an answer
 * means. Whether to ask at all is the skill's call (`Skill.clarify`) or, for
 * any action at all, `missingRequired`: a required detail that is absent, or is
 * only a placeholder ("a", "it", "something"), is a genuine gap. That one rule
 * covers every action with a required detail; `skills/asks.ts` only makes the
 * wording good. Nothing in this file mentions a particular app or skill.
 */

import type {
  Clarification,
  ClarifyAnswer,
  ClarifyChoice,
  ClarifyNeed,
  Skill,
  SkillArgs,
} from '@atlas/core';
import { askFor, readable } from '../skills/asks';

/** The options every free-form question has, in this order, so the numbers never move. */
export const CHOICE = {
  specific: 'specific',
  several: 'several',
  skip: 'skip',
  other: 'other',
} as const;

/** A fixed-set option's id: `value:up`. */
export const VALUE_PREFIX = 'value:';

/** A step, as a short phrase: what the skill says, or its label. */
export function summarizeStep(skill: Skill | null | undefined, args: SkillArgs): string {
  if (!skill) return 'that';
  try {
    const said = skill.summarize?.(args)?.trim();
    if (said) return said;
  } catch {
    // a summary that throws is not worth losing the question over
  }
  return skill.label.toLowerCase();
}

/** "game" → "games". Regular plurals only; every noun in use is regular. */
function plural(noun: string): string {
  if (/(s|x|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/**
 * The question and its options.
 *
 * `earlier` is what the plan is *about to do first* ("open Steam"), because the
 * question comes before anything runs. When there is something, "Just <that>"
 * is offered: the person's way of saying "the rest was the part I meant". With
 * nothing earlier there is nothing to fall back to, so the same slot becomes a
 * plain way out.
 *
 * A need with fixed `options` (up or down; shut down, restart or sign out)
 * offers exactly those as buttons and no typing: an invented value would only be
 * refused later.
 */
export function buildClarification(need: ClarifyNeed, earlier: readonly string[]): Clarification {
  const tail: ClarifyChoice[] = [
    {
      id: CHOICE.skip,
      label: earlier.length ? `Just ${earlier.join(' and ')}` : 'Never mind',
    },
    { id: CHOICE.other, label: 'Something else' },
  ];

  if (need.options?.length) {
    return {
      question: need.question,
      choices: [
        ...need.options.map((o) => ({
          id: `${VALUE_PREFIX}${o.value}`,
          label: o.label,
          value: o.value,
        })),
        ...tail,
      ],
    };
  }

  const many = need.many !== false;
  const choices: ClarifyChoice[] = [
    {
      id: CHOICE.specific,
      label: need.tellLabel ?? `Tell me a specific ${need.noun}`,
      input: { placeholder: need.placeholder ?? `Which ${need.noun}?` },
    },
  ];
  if (many) {
    choices.push({
      id: CHOICE.several,
      label: `Tell me several ${plural(need.noun)}`,
      input: { placeholder: `${plural(need.noun)}, separated by commas`, many: true },
    });
  }
  return { question: need.question, choices: [...choices, ...tail] };
}

/** A question in words, for a surface that cannot show choices: never a guess. */
export function explainInText(c: Clarification): string {
  const lines = c.choices.map((choice, i) => `${i + 1}. ${choice.label}`);
  return `${c.question}\n${lines.join('\n')}\nTell me which, or just say what you meant.`;
}

/**
 * Typed values → a list. Commas, semicolons and line breaks separate several
 * things; the word "and" does not, because names contain it ("Ratchet and
 * Clank"). Quotes around a value are dropped. Empty pieces are dropped.
 */
export function parseValues(text: string, many: boolean): string[] {
  const clean = (s: string) =>
    s
      .trim()
      .replace(/^["'“‘]+|["'”’]+$/g, '')
      .trim();
  if (!many) {
    const one = clean(text);
    return one ? [one] : [];
  }
  const parts = text
    .split(/[,;\n]+/)
    .map(clean)
    .filter(Boolean);
  // de-duplicate, keeping order: asking for the same thing twice opens it twice
  return parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
}

export type Resolution =
  | { action: 'fill'; values: string[] }
  | { action: 'skip' }
  | { action: 'cancel'; because: 'cancelled' | 'other' }
  /** The answer could not be used as it stands: say why and ask again. */
  | { action: 'retry'; hint: string };

/** Which fixed option did a typed answer mean? Value or label, any case. */
function matchOption(need: ClarifyNeed, text: string): string | null {
  const t = text.trim().toLowerCase();
  const hit = need.options?.find((o) => o.value.toLowerCase() === t || o.label.toLowerCase() === t);
  return hit ? hit.value : null;
}

/** What a reply means for the step that asked. */
export function resolveAnswer(need: ClarifyNeed, answer: ClarifyAnswer): Resolution {
  if (answer.kind === 'cancelled') return { action: 'cancel', because: 'cancelled' };

  if (answer.kind === 'choice') {
    if (answer.id === CHOICE.skip) return { action: 'skip' };
    if (answer.id === CHOICE.other) return { action: 'cancel', because: 'other' };
    if (answer.id.startsWith(VALUE_PREFIX)) {
      const value = answer.id.slice(VALUE_PREFIX.length);
      // only a value that was actually offered
      if (need.options?.some((o) => o.value === value)) return { action: 'fill', values: [value] };
    }
    return { action: 'cancel', because: 'cancelled' };
  }

  // typed
  if (need.options?.length) {
    const value = matchOption(need, answer.text);
    if (value) return { action: 'fill', values: [value] };
    return {
      action: 'retry',
      hint: `Pick one of: ${need.options.map((o) => o.label).join(', ')}.`,
    };
  }

  const values = parseValues(answer.text, answer.many && need.many !== false);
  // Typing nothing is not an answer.
  if (!values.length) return { action: 'cancel', because: 'cancelled' };

  if (!need.normalize) return { action: 'fill', values };
  const usable: string[] = [];
  for (const v of values) {
    const fixed = need.normalize(v);
    if (fixed === null) {
      return {
        action: 'retry',
        hint: need.hint ?? 'That does not look right — could you say it another way?',
      };
    }
    usable.push(fixed);
  }
  return { action: 'fill', values: usable };
}

// ---------------------------------------------------------------------------
// what counts as a gap
// ---------------------------------------------------------------------------

/**
 * Free text: what the person wants written or said, which can legitimately be
 * any word at all. A placeholder check would be wrong here — a note may say
 * "it".
 */
const FREE_TEXT = /^(?:text|content|message|body|note|value|expression|subject|command|title)$/i;

/** Words that stand in for a name without saying anything about it. */
const STAND_INS = new Set([
  'a',
  'an',
  'the',
  'it',
  'this',
  'that',
  'them',
  'these',
  'those',
  'one',
  'some',
  'any',
  'something',
  'anything',
  'whatever',
  'stuff',
  'thing',
  'things',
  'someone',
  'somebody',
  'anyone',
]);

/** Kinds of thing: "a window" names no window. */
const KINDS = new Set([
  'window',
  'windows',
  'app',
  'apps',
  'application',
  'applications',
  'program',
  'programs',
  'file',
  'files',
  'folder',
  'folders',
  'directory',
  'document',
  'documents',
  'game',
  'games',
  'site',
  'sites',
  'website',
  'websites',
  'page',
  'item',
  'service',
  'process',
]);

const DETERMINER = /^(?:a|an|the|some|any|another|my|this|that)\s+/;

/** Does this value only *stand in* for a name — "a", "it", "something", "a window"? */
export function isPlaceholder(value: string): boolean {
  const t = value
    .trim()
    .toLowerCase()
    .replace(/[?!.]+$/, '');
  if (!t) return true;
  if (STAND_INS.has(t)) return true;
  const bare = t.replace(DETERMINER, '');
  return KINDS.has(bare);
}

/**
 * A required detail that is absent, or is only a placeholder. Any action can
 * have one; none has to opt in. Asking is better than the plain error the
 * registry would otherwise return — and much better than acting on "a".
 */
export function missingRequired(skill: Skill, args: SkillArgs): ClarifyNeed | null {
  for (const [name, param] of Object.entries(skill.params ?? {})) {
    if (!param.required || param.default !== undefined) continue;
    const value = args[name];
    const absent =
      value === undefined || value === null || (typeof value === 'string' && !value.trim());
    const standIn =
      typeof value === 'string' && !FREE_TEXT.test(name) && !param.enum && isPlaceholder(value);
    if (!absent && !standIn) continue;

    const ask = askFor(skill.id, name);
    const what = (param.description ?? name).trim();
    const options = param.enum?.map((v) => ({ value: v, label: ask?.labels?.[v] ?? readable(v) }));
    return {
      param: name,
      noun: ask?.noun ?? what,
      question:
        ask?.question ?? `I need one more detail for “${skill.label.toLowerCase()}”: what is ${what}?`,
      many: ask?.many ?? false,
      tellLabel: ask?.tellLabel ?? `Type ${what}`,
      placeholder: ask?.placeholder ?? what,
      ...(options?.length ? { options } : {}),
      ...(ask?.normalize ? { normalize: ask.normalize } : {}),
      ...(ask?.hint ? { hint: ask.hint } : {}),
    };
  }
  return null;
}
