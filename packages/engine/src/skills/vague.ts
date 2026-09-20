/**
 * Telling "open Steam" from "open a game".
 *
 * A name is *vague* when it is only a kind of thing — "a game", "an app",
 * "something" — so no single answer follows from it. Launching whichever
 * installed program's name happens to contain the word would be a guess
 * (there is a "Game Bar" on most Windows machines), and a guess that opens the
 * wrong thing is worse than a question.
 *
 * Deliberately narrow. A vague name is *only* a determiner followed by one of
 * these generic words, and nothing else: "a game called Hades" is not vague,
 * "a random game" is not vague (the person asked for any one), and "steam" is
 * not vague. When in doubt this says no — asking when Atlas could have simply
 * done it is the failure to avoid.
 */

/** Words that are a kind of thing, mapped to the singular noun the question uses. */
const KINDS: Record<string, string> = {
  game: 'game',
  games: 'game',
  app: 'app',
  apps: 'app',
  application: 'app',
  applications: 'app',
  program: 'app',
  programs: 'app',
  software: 'app',
  tool: 'app',
  tools: 'app',
  website: 'website',
  websites: 'website',
  site: 'website',
  sites: 'website',
  webpage: 'website',
};

/** Words that stand in for a name without saying anything about it. */
const PLACEHOLDERS = new Set(['something', 'anything', 'whatever', 'stuff', 'thing', 'things']);

const DETERMINER = /^(?:a|an|the|some|any|another|my|one)\s+/;

export interface VagueTarget {
  /** The singular noun: "game", "app". */
  noun: string;
  /** The question, in the person's own terms. */
  question: string;
}

const article = (noun: string) => (/^[aeiou]/i.test(noun) ? 'an' : 'a');

/** Is this name only a kind of thing? Returns what to ask, or `null` if it names something. */
export function readVagueTarget(name: string): VagueTarget | null {
  const text = name
    .trim()
    .toLowerCase()
    .replace(/[?!.]+$/, '');
  if (!text) return null;

  if (PLACEHOLDERS.has(text)) {
    return { noun: 'app', question: 'What would you like me to open?' };
  }

  const bare = text.replace(DETERMINER, '');
  const noun = KINDS[bare];
  if (!noun) return null;

  // The question echoes the person's own word ("program", not our "app"):
  // asking about something they never said reads as though it was not listened to.
  const mass = bare === 'software';
  const plural = !mass && bare.endsWith('s');
  const phrase = mass || plural ? bare : `${article(bare)} ${bare}`;
  return { noun, question: `What do you mean by “open ${phrase}”?` };
}
