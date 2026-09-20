/**
 * Requests that name an action and leave out what it needs.
 *
 * "Create a folder." "Make a note." "Set a timer." Each is unmistakably a
 * request for one specific action — and each is missing the one thing the
 * action cannot run without. Before this, none of them matched any rule, so
 * they fell through to a generic "I didn't catch that", when the useful reply
 * is obvious: *which*, *what*, *how long*.
 *
 * ── How they reach the question ─────────────────────────────────────────────
 * Each rule builds the plan for the right action with the missing detail left
 * out. The executor's ordinary "is anything missing?" check then asks for it —
 * with the wording in `skills/asks.ts` — before anything runs. This file
 * decides only *which action was meant*; it never asks, guesses or fills in.
 *
 * ── Deliberately bare ───────────────────────────────────────────────────────
 * A rule matches only when *nothing more* was said: "create a folder called X
 * in Y" is not here, it carries its detail and is handled by the rules that
 * understand it. Everything below is anchored to the whole sentence, and runs
 * after every more specific rule (order 500), so it can only ever catch what
 * they declined.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

// ---- the sentence around the request --------------------------------------

/** "please", "can you", "hey" — everything polite before the request. */
const LEAD = String.raw`^\s*(?:(?:please|hey|ok(?:ay)?)[\s,]+)*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`;
/** "please", "for me", and the end of the sentence. */
const TAIL = String.raw`(?:\s+(?:please|for\s+me|thanks?|thank\s+you))?\s*[?.!]*$`;
/** "a", "a new", "the", "some" — the article before a noun. */
const A = String.raw`(?:(?:a|an|the|some)\s+)?(?:new\s+)?`;

interface Incomplete {
  name: string;
  /** The request itself, between the polite lead and the end. */
  body: string;
  skill: string;
  /** Whatever the request does say (rarely anything); the missing detail is left out. */
  args?: Record<string, string>;
}

const REQUESTS: Incomplete[] = [
  // ---- making things ----
  {
    name: 'folder',
    body: String.raw`(?:create|make|add)\s+${A}(?:folder|directory)`,
    skill: 'files.createFolder',
  },
  {
    name: 'file',
    body: String.raw`(?:create|make)\s+${A}(?:empty\s+)?(?:text\s+)?file`,
    skill: 'files.create',
  },
  {
    name: 'note',
    body: String.raw`(?:make|take|write|add|create|start)\s+${A}note`,
    skill: 'notes.add',
  },
  {
    name: 'todo',
    body: String.raw`(?:add|make|create)\s+${A}(?:to-?do|task|reminder)`,
    skill: 'todo.add',
  },
  { name: 'remind', body: String.raw`remind\s+me`, skill: 'todo.add' },
  {
    name: 'timer',
    body: String.raw`(?:set|start|make|create)\s+${A}(?:timer|countdown)`,
    skill: 'time.timer',
  },

  // ---- going somewhere ----
  {
    name: 'website',
    body: String.raw`(?:go\s+to|goto|visit|browse\s+to|open|navigate\s+to)\s+(?:(?:a|an|the|some|any)\s+)?(?:(?:web\s*)?site|web\s*page|website|page|link|url)`,
    skill: 'web.open',
  },

  // ---- looking things up ----
  {
    name: 'search-web',
    body: String.raw`(?:search|google|look)\s+(?:the\s+)?(?:web|internet|online)`,
    skill: 'web.search',
  },
  {
    name: 'search-something',
    body: String.raw`(?:(?:search|google)\s+(?:for\s+)?|look\s+)(?:something|anything)(?:\s+up)?`,
    skill: 'web.search',
  },
  {
    name: 'play',
    body: String.raw`play\s+(?:(?:some|a|an|any)\s+)?(?:music|songs?|tunes?|tracks?|videos?|something)`,
    skill: 'web.searchYoutube',
  },

  // ---- files ----
  {
    name: 'delete-file',
    body: String.raw`(?:delete|remove|trash)\s+${A}(?:file|document)`,
    skill: 'files.delete',
  },
  { name: 'rename-file', body: String.raw`rename\s+${A}file`, skill: 'files.rename' },
  { name: 'move-file', body: String.raw`move\s+${A}file`, skill: 'files.move' },
  { name: 'copy-file', body: String.raw`copy\s+${A}file`, skill: 'files.copy' },
  {
    name: 'find-file',
    body: String.raw`find\s+(?:${A}|my\s+)(?:files?|documents?)`,
    skill: 'files.find',
  },
  {
    name: 'open-file',
    body: String.raw`open\s+${A}(?:file|document|doc|pdf|spreadsheet|folder|directory)`,
    skill: 'files.find',
  },

  // "close it" with nothing earlier to mean by "it": ask which window. When
  // there IS something earlier, the more specific rules resolve it first.
  {
    name: 'close-it',
    body: String.raw`(?:close|quit|exit)\s+(?:it|that|this|the\s+(?:app|application|program|window))`,
    skill: 'window.close',
  },
  {
    name: 'delete-it',
    body: String.raw`(?:delete|remove|trash)\s+(?:it|this|that)`,
    skill: 'files.delete',
  },

  // ---- the machine ----
  {
    name: 'volume',
    body: String.raw`(?:turn|change|adjust|set|fix|control)\s+(?:the\s+)?(?:sound|volume)`,
    skill: 'system.volume',
  },
  { name: 'type', body: String.raw`type\s+(?:something|anything)`, skill: 'input.typeText' },
];

/** Whichever noun the person used for an app is kept: the question echoes it back. */
const APP_LAUNCH = new RegExp(
  `${LEAD}(?:start|launch|run)\\s+${A}(app|application|program|software)${TAIL}`,
  'i',
);

export function createIncompleteRules(): GrammarRule[] {
  const rules: GrammarRule[] = REQUESTS.map((r) => {
    const re = new RegExp(`${LEAD}${r.body}${TAIL}`, 'i');
    return {
      name: `incomplete-${r.name}`,
      // After every specific rule: this can only catch what they declined.
      order: 500,
      // "can you create a folder?" is a request, not a question.
      questionSafe: true as const,
      test(_lower: string, raw: string) {
        if (!re.test(raw)) return null;
        return plan(step(r.skill, { ...(r.args ?? {}) }), `incomplete-${r.name}`, 0.85);
      },
    };
  });

  rules.push({
    name: 'incomplete-app',
    order: 500,
    questionSafe: true as const,
    test(_lower: string, raw: string) {
      const m = APP_LAUNCH.exec(raw);
      if (!m) return null;
      return plan(step('app.open', { name: m[1]!.toLowerCase() }), 'incomplete-app', 0.85);
    },
  });

  return rules;
}
