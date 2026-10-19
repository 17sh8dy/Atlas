/**
 * What the engine does with a sentence before it ever asks a model, as one function a test can call.
 *
 * Mirrors `Engine.ask` steps 1 to 1d: the grammar on the raw text, then on the text with its
 * conversational wrapper stripped, then with a typo in the leading verb corrected, then (2.0.2) the
 * paraphrase layer. Keep in step with `engine.ts`; `engine-paraphrase.test.ts` checks the real engine
 * agrees with this on a sample so the two cannot drift silently.
 */
import type { Plan } from '@atlas/core';
import { Grammar } from '../../src/planner/grammar';
import { normalizeRequest } from '../../src/text/normalize';
import { correctLeadingVerb } from '../../src/text/verb-typo';
import { paraphraseCandidates } from '../../src/planner/paraphrase';

export interface Understood {
  plan: Plan | null;
  /** Which attempt got it: the raw grammar, the stripped text, the typo fix, or the paraphrase layer. */
  via: 'grammar' | 'filler-stripped' | 'typo-fixed' | 'paraphrase' | 'none';
  text: string;
}

export function understand(g: Grammar, raw: string, withParaphrase = true): Understood {
  let plan = g.parse(raw);
  const normalized = normalizeRequest(raw);
  const didNormalize = normalized.length > 0 && normalized !== raw;
  if (plan && didNormalize) {
    // Engine step 1a: the cleaner reading wins when it is a different skill.
    const cleaner = g.parse(normalized);
    if (cleaner && cleaner.steps[0]?.skill !== plan.steps[0]?.skill) return { plan: cleaner, via: 'filler-stripped', text: normalized };
  }
  if (plan) return { plan, via: 'grammar', text: raw };
  if (didNormalize) {
    plan = g.parse(normalized);
    if (plan) return { plan, via: 'filler-stripped', text: normalized };
  }
  const fixed = correctLeadingVerb(didNormalize ? normalized : raw);
  if (fixed) {
    plan = g.parse(fixed);
    if (plan) return { plan, via: 'typo-fixed', text: fixed };
  }
  if (withParaphrase) {
    for (const candidate of paraphraseCandidates(didNormalize ? normalized : raw)) {
      plan = g.parse(candidate);
      if (plan) return { plan, via: 'paraphrase', text: candidate };
    }
  }
  return { plan: null, via: 'none', text: raw };
}
