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
 * Something Atlas knows to be true.
 *
 * `alias` is the one that earns its keep: "my work folder is D:\Dev" turns
 * every later "open my work folder" into a resolved path, which is the
 * difference between an assistant that learns your vocabulary and one that
 * makes you learn its.
 */
export interface Fact {
  kind: 'fact' | 'preference' | 'alias';
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
