/**
 * What a typed message means while Atlas is waiting on a question.
 *
 * The card offers buttons, but the composer stays open, and typing is often
 * faster: a number picks that option, a few plain words back out, and anything
 * else is simply the answer ("Hades", or "Hades, Celeste"). Kept as a pure
 * function so what a person can say to a question — and what each thing means
 * — is tested, not discovered.
 *
 * Deliberately not clever. It does not try to tell whether a sentence is a new
 * instruction: if Atlas asked which game, whatever was typed is the game. The
 * ways out are explicit words (`cancel`, `never mind`) and the card's own
 * "Something else".
 */

import type { ClarifyAnswer, ClarifyChoice } from '@atlas/core';

export type ClarifyReading =
  | { kind: 'answer'; answer: ClarifyAnswer; label: string }
  /** Picked an option that needs typing, without typing anything yet. */
  | { kind: 'needs-text'; prompt: string };

const BACK_OUT = /^(?:cancel|never\s*mind|nevermind|forget\s+it|stop|no|nope|nothing)$/i;
const SKIP = /^(?:skip|skip\s+it|just\s+that|that'?s\s+all)$/i;

export function readClarifyReply(typed: string, choices: readonly ClarifyChoice[]): ClarifyReading {
  const text = typed.trim();

  if (BACK_OUT.test(text)) {
    return { kind: 'answer', answer: { kind: 'cancelled' }, label: 'Cancelled' };
  }

  const skip = choices.find((c) => c.id === 'skip');
  if (skip && SKIP.test(text)) {
    return { kind: 'answer', answer: { kind: 'choice', id: skip.id }, label: skip.label };
  }

  const picked = /^([1-9])[.)]?$/.exec(text);
  if (picked) {
    const choice = choices[Number(picked[1]) - 1];
    if (choice) {
      // An option that is the whole answer by itself.
      if (!choice.input) {
        return { kind: 'answer', answer: { kind: 'choice', id: choice.id }, label: choice.label };
      }
      // One that needs something typed: say what, and keep waiting.
      return { kind: 'needs-text', prompt: choice.input.placeholder };
    }
    // A number with no such option is not a game called "7": keep waiting.
    return { kind: 'needs-text', prompt: 'Pick one of the numbers above, or type your answer.' };
  }

  // Several things are separated by commas, semicolons or lines — never by "and".
  const many = /[,;\n]/.test(text);
  return { kind: 'answer', answer: { kind: 'text', text, many }, label: text };
}
