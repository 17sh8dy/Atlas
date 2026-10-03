/**
 * Every project Atlas can write without a model, and how a plain request is matched to one.
 *
 * Built-in templates and plugin templates live in the same registry. Matching is deliberately
 * dull: the words a template declares, whole words only, longest phrase wins. A request that
 * names a thing Atlas has a ready-made version of ("a snake game") gets it; a request that only
 * says "a game" or "an app" is asked what kind; anything else is not claimed, and the caller says
 * so rather than guessing.
 */

import type { AppTemplate } from './types';

const registry: AppTemplate[] = [];

/**
 * The ids, as a live array. `app.scaffold` hands this to the skill registry as its list of allowed
 * values, so a template added by a plugin is accepted without rebuilding the skill.
 */
export const APP_TEMPLATE_IDS: string[] = [];

function refreshIds(): void {
  APP_TEMPLATE_IDS.length = 0;
  for (const t of registry) APP_TEMPLATE_IDS.push(t.id);
}

/** Add (or replace, by id) templates. Order is kept: built-ins first, plugins after. */
export function registerTemplates(list: readonly AppTemplate[]): void {
  for (const t of list) {
    const at = registry.findIndex((x) => x.id === t.id);
    if (at >= 0) registry[at] = t;
    else registry.push(t);
  }
  refreshIds();
}

/** Take away everything a plugin supplied. */
export function unregisterTemplates(source: string): void {
  for (let i = registry.length - 1; i >= 0; i--) if (registry[i]!.source === source) registry.splice(i, 1);
  refreshIds();
}

export function allTemplates(): readonly AppTemplate[] {
  return registry;
}

export function templateById(id: string): AppTemplate | undefined {
  return registry.find((t) => t.id === id);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `phrase` appear in `text` as whole words? */
export function hasPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escape(phrase.toLowerCase())}(?:[^a-z0-9]|$)`).test(text);
}

/**
 * Which template a request is for, or undefined when none fits. The longest declared phrase that
 * appears wins, so "tic tac toe" beats a stray "game", and "password generator" is not the
 * "generator" in something else.
 */
export function chooseTemplate(request: string): AppTemplate | undefined {
  const text = request.toLowerCase();
  let best: AppTemplate | undefined;
  let bestLength = 0;
  for (const t of registry) {
    for (const word of t.words) {
      if (word.length > bestLength && hasPhrase(text, word)) {
        best = t;
        bestLength = word.length;
      }
    }
  }
  return best;
}

/** "D:\Dev\Void Clicker" / "void-clicker" -> "Void Clicker". */
export function displayNameFor(folderName: string): string {
  const words = folderName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'My App';
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

/** "Void Clicker" -> "void-clicker": lowercase letters, digits and dashes only. */
export function idFor(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || 'app';
}
