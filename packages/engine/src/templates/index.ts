/**
 * The projects Atlas can write with no model, and how a plain request is matched to one.
 *
 * Matching is deliberately dull: keywords in the request, most specific first. A request that
 * names a thing Atlas has a ready-made version of ("a clicker game") gets it; a request that only
 * says "app" or "website" gets a starter; anything else gets nothing, and the caller says so
 * rather than guessing.
 */

import { clickerFiles } from './clicker-game';
import { desktopStarterFiles, websiteStarterFiles } from './starters';
import type { AppTemplate } from './types';

export type { AppTemplate, TemplateFile, TemplateOptions } from './types';

export const APP_TEMPLATES: readonly AppTemplate[] = [
  {
    id: 'clicker',
    label: 'a clicker game',
    summary:
      'a desktop clicker game: generators, upgrades, synergies, milestones, Rift Surges, ascension and achievements, with numbers that run into the trillions and beyond',
    desktop: true,
    launch: 'Play.cmd',
    tip: 'Run "npm test" in the folder to check its maths.',
    files: clickerFiles,
  },
  {
    id: 'desktop',
    label: 'a desktop app',
    summary: 'a desktop app starter: a window with a page and a button, ready to be filled in',
    desktop: true,
    launch: 'Play.cmd',
    tip: 'This is a starter, not a finished app. Tell me what it should do and I will help once a model is available, or edit index.html and app.js yourself.',
    files: desktopStarterFiles,
  },
  {
    id: 'website',
    label: 'a website',
    summary: 'a one-page website starter: header, hero, about and contact sections',
    desktop: false,
    launch: 'index.html',
    tip: 'This is a starter page with placeholder text. Edit index.html and style.css, then refresh.',
    files: websiteStarterFiles,
  },
];

export const APP_TEMPLATE_IDS = APP_TEMPLATES.map((t) => t.id) as readonly string[];

export function templateById(id: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((t) => t.id === id);
}

/**
 * Which template a request is for, or undefined when none fits. Order matters: the ready-made
 * game is checked before the generic "app", so "a clicker app" is the game, not the starter.
 */
export function chooseTemplate(request: string): AppTemplate | undefined {
  const text = request.toLowerCase();
  if (/\b(?:clicker|idle|incremental|cookie[- ]?clicker|tapper)\b/.test(text)) return templateById('clicker');
  if (/\b(?:web ?site|web ?page|landing page|homepage|portfolio|blog)\b/.test(text) || /\bsite\b/.test(text)) {
    return templateById('website');
  }
  // A game of some other kind has no template, and a blank window is not a game.
  if (/\bgame\b/.test(text)) return undefined;
  if (/\b(?:desktop|windows|electron)\b/.test(text) || /\b(?:app|application|program|tool)\b/.test(text)) {
    return templateById('desktop');
  }
  return undefined;
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
