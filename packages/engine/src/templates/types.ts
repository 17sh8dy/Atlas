/** One file a template writes, with a path relative to the project folder. */
export interface TemplateFile {
  path: string;
  content: string;
}

export interface TemplateOptions {
  /** How the project is named on screen: "Void Clicker". */
  name: string;
  /** The same name as a safe identifier: "void-clicker". */
  id: string;
}

/** What kind of thing a template makes, for grouping in lists and questions. */
export type TemplateGroup = 'game' | 'tool' | 'starter' | 'engine';

/**
 * A project Atlas can write without a model. Templates are plain data and plain functions —
 * nothing here runs, installs or opens anything; `app.scaffold` does the writing and the plan
 * around it does the rest.
 */
export interface AppTemplate {
  id: string;
  /** "a clicker game" — reads right in "Create a clicker game in …". */
  label: string;
  /** What the project is, for the card and the closing message. */
  summary: string;
  /** Which family it belongs to. */
  group: TemplateGroup;
  /**
   * Words and phrases that mean this template when they appear in a request ("snake",
   * "tic tac toe"). Lower case, matched as whole words. Plain text on purpose: a template from a
   * plugin supplies these too, and a pattern from outside would be code.
   */
  words: readonly string[];
  /** A desktop template needs `npm install` for its window; a web one runs as it is. */
  desktop: boolean;
  /** The file to open once it exists (relative to the project folder). */
  launch: string;
  /** What to say about running it after the first launch. */
  tip: string;
  /** Where it came from: a built-in, or the id of the plugin that supplies it. */
  source?: string;
  files(options: TemplateOptions): TemplateFile[];
}
