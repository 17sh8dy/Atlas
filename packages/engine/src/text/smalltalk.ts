/**
 * Reading ordinary social conversation out of a message.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Until this module, "hi" was answered with *"That one needs an external
 * model, which is optional and off by default (Settings → Developer)."* Every
 * word of that is true and none of it is an answer to a greeting. The message
 * fell past the grammar (no rule claims "hi"), past triage (not an
 * instruction), and landed in `Engine.converse()`, which correctly reported
 * that it had no model — as though saying hello were an unsupported feature.
 *
 * An assistant that cannot say hello back does not feel like an assistant, so
 * the small, closed set of things people say to be sociable gets answered
 * where every other certain thing in Atlas is answered: deterministically,
 * offline, with no model involved. The set of ways to say "thanks" is finite
 * and does not change, which is exactly the same argument the grammar makes
 * for "open Steam" and `affirmation.ts` makes for "yes".
 *
 * ── Only a whole utterance counts ───────────────────────────────────────────
 * The same discipline as `readAffirmation`, and for the same reason. "hi" is a
 * greeting; "hi, open Steam and find my invoices" is an instruction that
 * happens to begin politely, and answering it with "Hey — what do you need?"
 * would throw the request away. Anything this cannot read as *entirely*
 * social returns `null`, and the caller carries on down the pipeline.
 *
 * That safety is structural as well as textual: `Engine.ask` consults this
 * last of the deterministic tiers, after the grammar, the AI planner and the
 * unresolved-instruction reply have all had first refusal. Nothing that could
 * be an action can reach it.
 */

import { stripFiller } from './normalize';

/**
 * What kind of social message this is.
 *
 * Deliberately narrow. Each one has a genuinely different right answer —
 * "thanks" wants acknowledging, "who are you" wants describing — and a kind
 * that would be answered identically to another has no reason to exist.
 */
export type SmallTalkKind =
  'greeting' | 'howAreYou' | 'thanks' | 'goodbye' | 'identity' | 'joke' | 'praise';

/**
 * Whole-utterance greetings.
 *
 * Written out rather than matched on a prefix, because a prefix is how "hi"
 * comes to match "hide the window" and "yo" comes to match "your notes".
 */
const GREETING = new Set([
  'hi',
  'hi there',
  'hi atlas',
  'hey',
  'hey there',
  'hey atlas',
  'hey you',
  'hello',
  'hello there',
  'hello atlas',
  'yo',
  'yo atlas',
  'howdy',
  'hiya',
  'heya',
  'sup',
  'wassup',
  'whats up',
  'whats good',
  'good morning',
  'morning',
  'good afternoon',
  'afternoon',
  'good evening',
  'evening',
  'greetings',
  'atlas',
  'hello world',
]);

const HOW_ARE_YOU = new Set([
  'how are you',
  'how are you doing',
  'how are you today',
  'how are you feeling',
  'how you doing',
  'how you been',
  'how have you been',
  'hows it going',
  'how is it going',
  'hows things',
  'how are things',
  'hows life',
  'how goes it',
  'you good',
  'you ok',
  'you okay',
  'you alright',
  'are you ok',
  'are you okay',
  'are you alright',
  'are you good',
  'how do you feel',
  'how do you do',
]);

const THANKS = new Set([
  'thanks',
  'thank you',
  'thanks atlas',
  'thank you atlas',
  'thanks a lot',
  'thanks so much',
  'thank you so much',
  'thanks very much',
  'thank you very much',
  'many thanks',
  'thx',
  'ty',
  'tysm',
  'cheers',
  'cheers atlas',
  'much appreciated',
  'appreciate it',
  'i appreciate it',
  'appreciated',
  'ta',
]);

const GOODBYE = new Set([
  'bye',
  'byebye',
  'bye bye',
  'goodbye',
  'good bye',
  'bye atlas',
  'goodbye atlas',
  'see you',
  'see ya',
  'see you later',
  'see you soon',
  'catch you later',
  'talk later',
  'talk to you later',
  'ttyl',
  'later atlas',
  'im off',
  'i am off',
  'good night',
  'goodnight',
  'night',
  'nighty night',
  'peace out',
  'farewell',
  'adios',
  'cya',
]);

const IDENTITY = new Set([
  'who are you',
  'what are you',
  'who is atlas',
  'what is atlas',
  'whats your name',
  'what is your name',
  'do you have a name',
  'tell me about yourself',
  'introduce yourself',
  'what should i call you',
  'who am i talking to',
  'are you an ai',
  'are you a robot',
  'are you human',
  'are you real',
]);

const JOKE = new Set([
  'joke',
  'tell me a joke',
  'tell a joke',
  'tell me another joke',
  'another joke',
  'tell me something funny',
  'say something funny',
  'make me laugh',
  'got any jokes',
  'do you know any jokes',
  'know any jokes',
  'got a joke',
  'do you have a joke',
  'give me a joke',
  'be funny',
]);

const PRAISE = new Set([
  'good job',
  'great job',
  'nice job',
  'nice one',
  'nice work',
  'good work',
  'well done',
  'youre great',
  'youre the best',
  'youre awesome',
  'youre amazing',
  'youre brilliant',
  'youre clever',
  'you are great',
  'you are the best',
  'you are awesome',
  'you are amazing',
  'good bot',
  'good boy',
  'love it',
  'love you',
  'i love you',
  'legend',
  'brilliant',
  'awesome',
  'amazing',
]);

/**
 * The tables, in the order they are consulted.
 *
 * Order matters only where a phrase could plausibly sit in two tables, and
 * the tables are kept disjoint so that it never actually does — this array is
 * about having one place to add a table, not about precedence.
 */
const TABLES: ReadonlyArray<readonly [SmallTalkKind, ReadonlySet<string>]> = [
  ['greeting', GREETING],
  ['howAreYou', HOW_ARE_YOU],
  ['thanks', THANKS],
  ['goodbye', GOODBYE],
  ['identity', IDENTITY],
  ['joke', JOKE],
  ['praise', PRAISE],
];

/**
 * The kind of social message this is, or `null` when it is not one.
 *
 * Punctuation, capitalisation and apostrophes come off first, so "Hey!",
 * "hey" and "Hey…" are one entry rather than three, and "how's it going" and
 * "hows it going" are the same question typed by two different keyboards.
 */
export function readSmallTalk(text: string): SmallTalkKind | null {
  const cleaned = normalise(text);
  if (!cleaned) return null;

  const direct = lookup(cleaned);
  if (direct) return direct;

  // Filler is stripped only as a *second* attempt — the same rule
  // `readAffirmation` and `Engine.ask` both follow. It is what lets "hey, how
  // are you?" read as the question it is rather than as the greeting it opens
  // with, and "can you tell me a joke" reach the joke table. An utterance that
  // already matched is never reinterpreted.
  const stripped = normalise(stripFiller(cleaned));
  if (stripped && stripped !== cleaned) return lookup(stripped);

  return null;
}

function lookup(phrase: string): SmallTalkKind | null {
  for (const [kind, table] of TABLES) {
    if (table.has(phrase)) return kind;
  }
  return null;
}

/**
 * Down to bare words.
 *
 * Apostrophes are *removed* rather than replaced with a space — unlike
 * `readAffirmation`, which keeps them because "don't" is one of its answers.
 * Nothing here needs one, and dropping them collapses "what's your name",
 * "whats your name" and the curly-quote version a transcriber produces into a
 * single table entry.
 */
function normalise(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
