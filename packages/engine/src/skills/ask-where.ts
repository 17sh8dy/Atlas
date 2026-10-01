/**
 * "I couldn't find it" is the start of a conversation, not the end of one.
 *
 * When Atlas has tried everything it can think of for an app or a file and
 * found nothing, it asks the questions a person would: do you know the exact
 * name, or where it is? Or should I search the web for it? The answers are
 * things it can act on without any model: a typed name goes round the ladder
 * again, a typed path is opened, "search the web" does that.
 *
 * Surfaces that cannot ask (voice-only, a test) get the same options in words.
 */

import type { Clarification, SkillContext } from '@atlas/core';

export type WhereAnswer =
  | { kind: 'web' }
  | { kind: 'list' }
  | { kind: 'name'; text: string }
  | { kind: 'path'; text: string }
  | { kind: 'none' };

const PATHISH = /^(?:[a-z]:[\\/]|\\\\|~[\\/])/i;

/** What the person typed, as a name or as a place. */
export function classifyTyped(text: string): WhereAnswer {
  const t = text.trim().replace(/^["'“‘]|["'”’]$/g, '').trim();
  if (!t) return { kind: 'none' };
  return PATHISH.test(t) ? { kind: 'path', text: t } : { kind: 'name', text: t };
}

/** The same question, as a sentence — for a surface that cannot show choices. */
export function whereInWords(what: string, noun: string): string {
  return `I tried the installed ${noun}s, what's already open, and a search of this PC, and couldn't find “${what}”. Do you know the exact name, or where it is? Tell me (“open Notepad++”, or paste the path), or say “search the web for ${what}”.`;
}

export async function askWhereItIs(
  ctx: SkillContext,
  what: string,
  noun: 'app' | 'file' | 'folder',
  options: { offerList?: boolean } = {},
): Promise<WhereAnswer> {
  if (!ctx.clarify) return { kind: 'none' };
  const question: Clarification = {
    question: `I couldn't find ${noun === 'app' ? 'an app' : `a ${noun}`} called “${what}”. I looked at the installed apps, what's already open, and searched this PC. What would you like to do?`,
    choices: [
      { id: 'type', label: 'I know the exact name, or where it is', input: { placeholder: 'e.g. Notepad++ — or C:\\Program Files\\App\\app.exe' } },
      { id: 'web', label: `Search the web for “${what}”` },
      ...(options.offerList ? [{ id: 'list', label: 'Show me my installed apps' }] : []),
      { id: 'never', label: 'Never mind' },
    ],
  };
  const answer = await ctx.clarify(question);
  if (answer.kind === 'text') return classifyTyped(answer.text);
  if (answer.kind === 'choice') {
    if (answer.id === 'web') return { kind: 'web' };
    if (answer.id === 'list') return { kind: 'list' };
  }
  return { kind: 'none' };
}
