/**
 * The one place that owns how Atlas talks.
 *
 * Every response used to be a literal string sitting wherever it happened to
 * be said — a skill's success message, the executor's confirmation prompt.
 * That works until two things need to agree (a name, a tone), so this module
 * is the single source both the executor and the core skills read from
 * instead of writing their own copies.
 *
 * Named `phrasing` rather than `voice` on purpose — a future audio layer
 * (text-to-speech, speech recognition) is a different, unbuilt thing, and
 * reusing the word here would make that later feature impossible to name
 * without confusion.
 */

import type { AtlasRole, VoiceProfile } from '@atlas/core';
import { ATLAS_ROLE_META, DEFAULT_ATLAS_ROLE } from '@atlas/core';
import type { SmallTalkKind } from './text/smalltalk';

export interface Phrasing {
  opening(name: string): string;
  revealing(name: string): string;
  copied(): string;
  rightThen(stepLabels: string[]): string;
  declined(): string;
  failed(detail: string): string;
  /**
   * One consequential step, asked about immediately before it runs.
   *
   * `why` is the skill's own `description` — already written as a plain
   * sentence for exactly this — and `detail` is the concrete argument (a
   * path, a name), appended only when there is one worth showing.
   */
  confirmPrompt(why: string, detail?: string): { question: string; detail: string };
  /**
   * A whole plan, shown once before anything in it runs — Plan First's
   * approval gate. Each line is a step; `consequential` marks the ones that
   * would otherwise have stopped to ask on their own.
   */
  planApproval(steps: ReadonlyArray<{ label: string; consequential: boolean }>): {
    question: string;
    detail: string;
  };
  /** What Atlas says the first time a conversation opens. */
  greeting(): string;
  /**
   * The answer to an ordinary social message — see `text/smalltalk.ts` for
   * what counts as one and why it is answered here rather than by a model.
   *
   * `actionCount` is only read by the kinds that mention it ('identity',
   * and the greeting's occasional offer); passing it always keeps the caller
   * from having to know which those are.
   */
  smallTalk(kind: SmallTalkKind, actionCount: number): string;
}

/**
 * Jokes Atlas actually knows.
 *
 * Short, clean, and about computers where possible, because the joke is being
 * told by a program and a joke that ignores that is a joke told by nobody.
 * Exported so the tests can assert what a reply is drawn from without having
 * to reach into a closure.
 */
export const JOKES: readonly string[] = Object.freeze([
  'There are 10 kinds of people: those who understand binary, and those who don’t.',
  'I would tell you a UDP joke, but you might not get it.',
  'A SQL query walks into a bar, goes up to two tables and asks: "may I join you?"',
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'There are only two hard things in computing: cache invalidation, naming things, and off-by-one errors.',
  'I told my computer I needed a break — it said "why, what did you do?"',
  'A byte walks into a bar looking miserable. The barman asks what’s wrong. "Parity error." "Ah — I thought you looked a bit off."',
  'Why was the function sad after the party? It didn’t get called.',
]);

/**
 * Builds the phrasing table for a given personalization profile.
 *
 * Called with no profile (or an empty one), every string below is
 * byte-identical to what Atlas said before this module existed — that
 * constraint is deliberate, and the engine's tests hold it in place.
 */
export function createPhrasing(profile: VoiceProfile = {}): Phrasing {
  const atlasName = profile.atlasName?.trim() || 'Atlas';
  const userName = profile.userName?.trim();
  const turn = counters();

  return {
    opening: (name) => `Opening ${name}.`,
    revealing: (name) => `Showing ${name} in its folder.`,
    copied: () => '📋 Copied.',

    rightThen: (stepLabels) => {
      const names = [...stepLabels];
      const last = names.pop();
      return `Right — ${names.length ? `${names.join(', ')}, then ${last}` : last}.`;
    },
    declined: () => 'Okay — left alone.',
    failed: (detail) => `⚠️ ${detail}`,

    confirmPrompt: (why, detail) => ({
      question: '⚠️ Are you sure?',
      detail: `${atlasName} wants to ${lowerFirstSentence(why)}${detail ? ` — ${detail}` : ''}`,
    }),

    planApproval: (steps) => ({
      question: `⚠️ Run this plan?`,
      detail: steps
        .map((s, i) => `${i + 1}. ${s.consequential ? '⚠ ' : ''}${s.label}`)
        .join('\n'),
    }),

    greeting: () => {
      if (profile.greeting?.trim()) return profile.greeting.trim();
      const role = ATLAS_ROLE_META[profile.role ?? DEFAULT_ATLAS_ROLE] ?? ATLAS_ROLE_META[DEFAULT_ATLAS_ROLE];
      return role.greeting(atlasName, userName);
    },

    smallTalk: (kind, actionCount) => {
      const options = SMALL_TALK[kind]({ atlasName, userName, actionCount, role: profile.role });
      return options[turn(kind) % options.length] as string;
    },
  };
}

/**
 * A skill's `description` reads as its own sentence ("Send a file or folder
 * to the recycle bin.") but is being spliced after "Atlas wants to", so the
 * leading capital and the trailing full stop both have to go — a period
 * followed by " — D:\Dev\old.txt" reads as two sentences glued together.
 */
function lowerFirstSentence(text: string): string {
  const trimmed = text.trim().replace(/\.+$/, '');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * Which variation to use next, counted per kind.
 *
 * Saying exactly the same eleven words every time someone types "hi" is the
 * thing that makes a program feel like a program. A counter rather than
 * `Math.random()` because a reply Atlas gives has to be reproducible: a fresh
 * `Phrasing` always answers the first "hi" with the first variation, which is
 * what lets the tests assert on a literal instead of on a regex.
 *
 * Per kind rather than shared, so saying "thanks" does not advance the
 * greeting Atlas would have used next.
 */
function counters() {
  const seen = new Map<SmallTalkKind, number>();
  return (kind: SmallTalkKind) => {
    const n = seen.get(kind) ?? 0;
    seen.set(kind, n + 1);
    return n;
  };
}

interface SmallTalkContext {
  atlasName: string;
  userName: string | undefined;
  actionCount: number;
  role: AtlasRole | undefined;
}

/**
 * The answers themselves.
 *
 * Every one of them is short and hands the turn back. An assistant that
 * answers "how are you" with a paragraph about being a large language model
 * has changed the subject to itself, which is the opposite of what the
 * question was being polite about.
 */
const SMALL_TALK: Record<SmallTalkKind, (c: SmallTalkContext) => readonly string[]> = {
  greeting: ({ userName }) => {
    const you = userName ? ` ${userName}` : '';
    return [
      `Hey${you}! What can I do for you?`,
      `Hi${you} — what do you need?`,
      `Hey${you}. What are we doing?`,
    ];
  },

  // Honest rather than cheerful. Atlas has no feelings to report, so the
  // answer reports the thing it can actually vouch for — that it is working —
  // and gets out of the way.
  howAreYou: () => [
    'All good here, running away quietly on your machine. What do you need?',
    "Working fine, thanks — nothing's on fire. What can I do?",
    'Good. Ready when you are.',
  ],

  thanks: () => ['Any time.', "You're welcome.", 'No trouble at all.'],

  // A role's own farewell replaces the generic rotation entirely, the same
  // way `Phrasing.greeting()` replaces the opening line — `assistant` (and no
  // role at all) has none, so it keeps saying exactly what it always did.
  goodbye: ({ userName, role }) => {
    const farewell = role && role !== DEFAULT_ATLAS_ROLE ? ATLAS_ROLE_META[role].farewell : undefined;
    if (farewell) return [farewell(userName)];
    return ["See you — Ctrl+Space and I'm back.", 'Bye. I’ll be here.', 'See you.'];
  },

  identity: ({ atlasName, actionCount }) => [
    `I'm ${atlasName} — an assistant that runs entirely on this machine. I can ` +
      `do ${actionCount} things here: open apps and files, search the web, check ` +
      `what the system's doing, handle notes and maths. No account, no API key, ` +
      `nothing sent anywhere. Ask "what can you do?" to see the lot.`,
  ],

  joke: () => JOKES,

  praise: () => ['Thanks — glad that helped.', 'Appreciated.', 'Any time.'],
};
