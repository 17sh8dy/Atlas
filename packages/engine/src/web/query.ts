/**
 * Turn a spoken question into a search query.
 *
 * "What season of Fortnite is it?" is a fine question and a poor query: a
 * search engine wants "Fortnite current season". The rewrite is deliberately
 * small and mechanical — strip conversational filler, keep the subject, add
 * the word that carries the intent ("current", "latest") and, for questions
 * that are about *now*, the month and year so an old article does not win on
 * keyword overlap alone.
 *
 * It never invents a subject. If the text does not reduce to something
 * sensible, the caller gets the original back and searches with that.
 */

import type { ResearchCategory } from './router';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const LEADING_FILLER =
  /^\s*(?:(?:hey|hi|ok(?:ay)?|please|so|um|uh)[\s,]+)*(?:(?:atlas|nova)[\s,]+)?(?:(?:can|could|would|will) you\s+)?(?:(?:please|just)\s+)?(?:tell me|let me know|find out|find|check|look up|search(?: the (?:web|internet))? for|google|research|do you know|i (?:want|need) to know|i'?m curious|i was wondering)?\s*/i;

/** "what season of X is it" → subject X, noun season. */
const NOUN_OF_SUBJECT =
  /^(?:what|which)(?:'s| is| are)?\s+(?:the\s+)?(season|chapter|version|patch|update|episode|build|edition|generation)\s+(?:of|is|for|on)\s+(.+?)(?:\s+(?:is it|are we|on|now|out|at)(?:\s+(?:now|currently|right now))?)?[?.!]*$/i;

/** "what season is Fortnite on" → noun season, subject Fortnite. */
const NOUN_IS_SUBJECT_ON =
  /^(?:what|which)\s+(season|chapter|version|patch|update|episode|build|edition|generation)\s+(?:is|are)\s+(.+?)\s+(?:on|at|in|up to)(?:\s+(?:now|currently|right now))?[?.!]*$/i;

const QUESTION_LEAD =
  /^(?:what(?:'s| is| are| was| were)?|who(?:'s| is| are)?|when(?:'s| is| does| did| will)?|where(?:'s| is)?|which|how (?:much|many)(?: is| are| does| do)?|is|are|does|do|did|has|have)\s+(?:the\s+)?/i;

const TRAILING_FILLER =
  /\s*(?:right now|at the moment|currently|these days|please|for me|thanks?|thank you)?[?.!\s]*$/i;

export function rewriteQuery(
  text: string,
  category: ResearchCategory | null,
  now: Date = new Date(),
): string {
  const original = text.trim();
  if (!original) return original;

  let t = original
    .replace(LEADING_FILLER, '')
    .replace(/^the\s+/i, '')
    .trim();
  if (!t) return original;

  let core: string | null = null;

  const a = NOUN_OF_SUBJECT.exec(t);
  if (a) core = `${a[2]} current ${a[1]}`;
  const b = core ? null : NOUN_IS_SUBJECT_ON.exec(t);
  if (b) core = `${b[2]} current ${b[1]}`;

  if (!core) {
    t = t.replace(TRAILING_FILLER, '').trim();
    t = t.replace(QUESTION_LEAD, '').trim();
    core = t.replace(/\s+/g, ' ');
  }
  core = core.replace(/\s+/g, ' ').trim();

  // Nothing usable left: search with what the person actually said.
  if (core.length < 3) return original;

  // The intent word: a release/recency question is about the newest state of something.
  if (
    (category === 'release' || category === 'recency') &&
    !/\b(?:current|latest|newest|today|now)\b/i.test(core)
  ) {
    core = `${core} latest`;
  }
  // The date: anything about *now* gets the month and year, so an old page
  // does not win on keyword overlap alone.
  const aboutNow =
    category === 'release' || category === 'recency' || category === 'news' || category === 'live';
  if (aboutNow && !/\b20\d\d\b/.test(core)) {
    core = `${core} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  }
  return core;
}
