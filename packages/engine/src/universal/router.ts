/**
 * Does this request need the universal agent?
 *
 * Asked only AFTER every deterministic route and the one-shot model planner have declined, so it never
 * competes with a request Atlas understands. The question is narrow: is this a job to DO on this PC, made of
 * things Atlas can do, rather than something to write, explain, or answer?
 *
 * It does not decide that anything runs. A "yes" only earns the person a card asking whether Atlas should
 * try to work it out, and everything the agent then does is confirmed per action. So the failure modes are
 * ordered by cost: a false "no" costs one more sentence from the person (they can say "figure out how to…");
 * a false "yes" costs one declined card. Both are cheap, which is why this is a heuristic and not a model call.
 *
 * Signals (all deterministic, no model):
 *   · generative / conversational asks are excluded outright (write, draft, explain, translate, plan a trip…);
 *   · the request must read like a task: an imperative verb, or a connective that chains actions;
 *   · the capability index must find real matches: the best hit has to clear a score floor, and a chained
 *     request needs matches in at least two capability families, so "write me a haiku and then open steam"
 *     is not read as a pure task, and "tidy my life" matches nothing and is left alone.
 */

import type { CapabilityIndex } from '../capabilities';

export interface RouteDecision {
  route: boolean;
  /** Why, in a few words: for the log and the tests. */
  reason: string;
}

/** Asks for text, an explanation, a plan on paper, or a creative piece: not a job for tools. */
const GENERATIVE =
  /^(?:please\s+)?(?:write|draft|compose|translate|summari[sz]e|explain|describe|brainstorm|tell\s+me|give\s+me\s+(?:a|an|some)\s+(?:poem|story|joke|idea|summary|essay|recipe)|plan\s+(?:a|an|my)\s+(?:trip|vacation|holiday|party|week|day|schedule|route)|suggest|recommend|rewrite|proofread|paraphrase|imagine|pretend|act\s+as|teach\s+me|help\s+me\s+(?:understand|think|decide|write))\b/i;

/** Verbs that begin a job on the PC. Broader than the grammar's list on purpose: this only nominates. */
const TASK_VERB =
  /^(?:please\s+)?(?:open|launch|start|run|show|find|search|look\s+for|go|take|close|hide|set|turn|enable|disable|make|create|build|delete|remove|move|copy|rename|play|stop|save|organi[sz]e|tidy|clean|sort|zip|unzip|extract|compress|compare|check|list|count|install|uninstall|update|download|upload|backup|back\s+up|restore|free\s+up|get\s+rid\s+of|clear|empty|kill|restart|reboot|mute|unmute|lock|print|scan|export|import|convert|merge|split|rename|archive|collect|gather|combine|clone|commit|push|pull|deploy|test|fix|find\s+out|figure\s+out|work\s+out|see\s+(?:which|what|how\s+much)|get|bring|put|send|look\s+(?:through|for|in|at)|hash|write\s+(?:the|a|this)\s+\w+\s+to)\b/i;

/** Words that chain actions: the sign of a multi-step request. */
const CHAIN = /\b(?:and\s+then|then|after\s+that|afterwards|once\s+(?:that(?:'s|\s+is)|it(?:'s|\s+is))\s+done|and\s+(?:also\s+)?(?:tell|show|let)\s+me|before\s+(?:you|that)|,\s*and)\b|;\s*\w/i;

/** The best capability hit must reach this much BM25 score to count as a real match. */
export const SCORE_FLOOR = 7;

/** Concrete things on a PC. A task with none of these ("organize my thoughts") is not a job for tools. */
const PC_THING =
  /\b(?:files?|folders?|director(?:y|ies)|documents?|downloads?|desktop|pictures?|photos?|videos?|music|drive|disk|storage|space|recycle|trash|zip|archive|backup|windows?|apps?|programs?|process(?:es)?|startup|screenshots?|screen|clipboard|project|repo|repository|branch|commit|git|tests?|build|packages?|dependencies|installers?|logs?|exe|pdf|txt|docx?|xlsx?|png|jpe?g|mp[34]|network|wifi|ip|ping|dns|volume|brightness|battery|printer|settings|terminal|powershell|command|script|server|memory|cpu|ram|todos?|notes?|reminders?|calendar)\b/i;

export function shouldRouteToAgent(text: string, index: CapabilityIndex): RouteDecision {
  const t = String(text ?? '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 4) return { route: false, reason: 'too short to be a multi-part job' };
  if (t.length > 600) return { route: false, reason: 'too long to judge safely' };
  if (t.endsWith('?')) return { route: false, reason: 'a question' };
  if (GENERATIVE.test(t)) return { route: false, reason: 'asks for text or an explanation, not an action' };
  const chained = CHAIN.test(t) || chainClauses(t).length >= 2;
  if (!TASK_VERB.test(t) && !chained) return { route: false, reason: 'does not read as a task' };
  if (!PC_THING.test(t)) return { route: false, reason: 'names nothing on this PC to act on' };

  const hits = index.search(t, { limit: 12 });
  const best = hits[0]?.score ?? 0;
  if (best < SCORE_FLOOR) return { route: false, reason: `no capability matches well enough (best ${best.toFixed(1)})` };
  const families = new Set(hits.filter((h) => h.score >= best * 0.45).map((h) => h.family));
  if (chained) {
    // Every part has to be a job of its own: "write me a haiku and then open steam" has one real part only.
    const weak = chainClauses(t).find((c) => (index.search(c, { limit: 1 })[0]?.score ?? 0) < SCORE_FLOOR * 0.8);
    if (weak) return { route: false, reason: `part of it matches no capability: "${weak}"` };
  }
  return { route: true, reason: `${chained ? 'chained' : 'single'} task, ${families.size} capability ${families.size === 1 ? 'family' : 'families'}, best ${best.toFixed(1)}` };
}

/** Verbs that, right after "and", begin a second action ("find X and open its folder"). */
const SECOND_ACTION = /\s+and\s+(?=(?:open|show|list|copy|move|delete|remove|zip|unzip|run|check|tell|close|rename|install|start|create|clean|count|compare|find|take|send|save|print|reveal|sort|restart|stop|build|test|push|pull|commit)\b)/gi;

/** Definite chain markers between actions. */
const HARD_CHAIN = /\s*(?:;|,?\s+and\s+then\s+|,?\s+then\s+|,?\s+after\s+that,?\s+|,?\s+afterwards,?\s+)\s*/gi;

/**
 * The separate jobs a request asks for, split only at words that clearly start a new action. A plain "and"
 * ("salt and pepper", "cats and dogs") is never a split; "and" followed by a verb is ("find it and open it").
 * Clauses of fewer than two words are dropped, so "yes, then" is not a second job.
 */
export function chainClauses(text: string): string[] {
  const t = String(text ?? '').trim().replace(/[.!]+$/, '');
  if (!t) return [];
  const parts = t
    .replace(HARD_CHAIN, '\u0001')
    .replace(SECOND_ACTION, '\u0001')
    .split('\u0001')
    .map((p) => p.trim().replace(/^,\s*/, ''))
    .filter((p) => p.split(/\s+/).length >= 2);
  return parts.length ? parts : [t];
}

/** Single-target file skills: a request for "all" or "every" of something is not what they do. */
const ONE_AT_A_TIME = new Set(['files.rename', 'files.move', 'files.copy', 'files.delete']);
const MANY = /\b(?:all|every|each|everything|all\s+of)\b/i;

export interface Trust {
  trust: boolean;
  reason: string;
}

/**
 * Should the deterministic reading of this request be believed?
 *
 * A single-clause request that a rule matched is trusted: that is the reliable path and is not touched.
 * A request that chains several jobs is trusted only when the plan has a step for each AND each step's
 * skill is one the capability index also finds for that part of the sentence. This is what catches
 * "check how much space downloads uses and then clean the temp files" being answered with just the first
 * half, and "install the dependencies and then run the build" ending in "open an app called the build".
 */
export function trustPlan(plan: { steps: Array<{ skill: string }> }, text: string, index: CapabilityIndex): Trust {
  const clauses = chainClauses(text);
  if (clauses.length < 2) {
    if (plan.steps.length === 1 && ONE_AT_A_TIME.has(plan.steps[0]!.skill) && MANY.test(text)) {
      return { trust: false, reason: `asks for many, but ${plan.steps[0]!.skill} does one at a time` };
    }
    return { trust: true, reason: 'single request' };
  }
  if (plan.steps.length < clauses.length) {
    return { trust: false, reason: `covers ${plan.steps.length} of ${clauses.length} parts` };
  }
  for (let i = 0; i < clauses.length; i++) {
    const step = plan.steps[i]!;
    const found = index.search(clauses[i]!, { limit: 8 }).some((h) => h.skill.id === step.skill);
    if (!found) return { trust: false, reason: `"${clauses[i]}" does not look like ${step.skill}` };
  }
  return { trust: true, reason: 'every part agrees with the capability index' };
}
