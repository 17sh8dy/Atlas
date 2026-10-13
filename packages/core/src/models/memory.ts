/**
 * What Atlas remembers.
 *
 * Three kinds, because they answer three different questions and have three
 * different lifetimes. Collapsing them into one store is the mistake that makes
 * assistants feel simultaneously forgetful and creepy — forgetting what you
 * said two seconds ago while hoarding everything you did last month.
 *
 *   episodic — what happened, in order. Rolling and capped.
 *   semantic — what's true. Facts, preferences, and the names you use for
 *              things. Kept until you change it.
 *   working  — what we're talking about *now*. Expires on its own.
 */

/** One thing that happened. */
export interface EpisodicEvent {
  /** Dotted, e.g. `app.launched`, `file.opened`, `place.visited`. */
  type: string;
  /** How it reads in a timeline. */
  label: string;
  at: number;
  /**
   * Repeats collapse into a count rather than filling the timeline with
   * fifty identical lines — the fact that you did something forty times is
   * more interesting than forty records of it.
   */
  count?: number;
  data?: Record<string, unknown>;
}

/**
 * What became of an action, as far as Atlas can honestly say.
 *
 *   done     — the action reported success.
 *   failed   — it was attempted and reported an error.
 *   declined — it was asked about and you said no, so it never ran.
 *
 * "done" is the action's own report, not an independent re-check; only
 * something that read the result back (a Setup's checks, a verified install)
 * may say it *confirmed* it. Events recorded before outcomes existed carry no
 * marker and were only ever written for successes, so they read as `done`.
 */
export type EpisodeOutcome = 'done' | 'failed' | 'declined';

/**
 * Whether Atlas read the effect back afterwards. Only a `done` entry can be `confirmed`; an
 * entry with no marker was never read back, which is "reported done", not "unconfirmed".
 */
export function episodeVerification(event: Pick<EpisodicEvent, 'data'>): 'confirmed' | 'unconfirmed' | null {
  const v = event.data?.verified;
  return v === 'confirmed' || v === 'unconfirmed' ? v : null;
}

export function episodeOutcome(event: Pick<EpisodicEvent, 'data'>): EpisodeOutcome {
  const o = event.data?.outcome;
  return o === 'failed' || o === 'declined' ? o : 'done';
}

/**
 * Something Atlas knows to be true.
 *
 * `alias` is the one that earns its keep: "my work folder is D:\Dev" turns
 * every later "open my work folder" into a resolved path, which is the
 * difference between an assistant that learns your vocabulary and one that
 * makes you learn its.
 */
/**
 * What a remembered thing *is*.
 *
 * `note` and `todo` are list-shaped rather than key-shaped: many facts share
 * the kind and are told apart by their subject (a timestamp), where an `alias`
 * or a `preference` has one value per subject. Kept in the same store anyway,
 * because a second storage schema for "things with a timestamp" would buy
 * nothing that a filter doesn't.
 */
export type FactKind = 'fact' | 'preference' | 'alias' | 'note' | 'todo';

export interface Fact {
  kind: FactKind;
  /** What it's about — the alias name, the preference key. */
  subject: string;
  value: string;
  at: number;
}

/** A single exchange. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

/**
 * What "it" and "the second one" refer to right now.
 *
 * Deliberately short-lived. A pronoun that resolves against something from an
 * hour ago is worse than one that admits it doesn't know, because the user has
 * no way to see what it latched onto.
 */
export interface Focus {
  type: string;
  title: string;
  payload?: unknown;
  at: number;
}
