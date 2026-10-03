/**
 * The built-in projects, registered once. See `registry.ts` for how requests are matched and how
 * plugins add to the same list.
 */

import { clickerFiles } from './clicker-game';
import { desktopStarterFiles, websiteStarterFiles } from './starters';
import { game2048, minesweeperGame, snakeGame } from './games-a';
import { breakoutGame, memoryGame, ticTacToeGame } from './games-b';
import { notesApp, pomodoroApp, todoApp } from './tools-a';
import { calculatorApp, converterApp, passwordApp } from './tools-b';
import { budgetApp, flashcardsApp, habitsApp, kanbanApp } from './tools-c';
import { unrealProject } from './unreal';
import { blenderProject, godotProject, unityProject } from './engines';
import { allTemplates, registerTemplates } from './registry';
import type { AppTemplate } from './types';

export type { AppTemplate, TemplateFile, TemplateGroup, TemplateOptions } from './types';
export { newestUnreal, pascalFor } from './unreal';
export {
  APP_TEMPLATE_IDS,
  allTemplates,
  chooseTemplate,
  displayNameFor,
  hasPhrase,
  idFor,
  registerTemplates,
  templateById,
  unregisterTemplates,
} from './registry';

const clicker: AppTemplate = {
  id: 'clicker',
  label: 'a clicker game',
  summary:
    'a desktop clicker game: generators, upgrades, synergies, milestones, Rift Surges, ascension and achievements, with numbers that run into the trillions and beyond',
  group: 'game',
  words: ['clicker', 'idle game', 'incremental game', 'cookie clicker', 'idle clicker'],
  desktop: true,
  launch: 'Play.cmd',
  tip: 'Run "npm test" in the folder to check its maths.',
  files: clickerFiles,
};

const desktop: AppTemplate = {
  id: 'desktop',
  label: 'a blank desktop app',
  summary: 'a desktop app starter: a window with a page and a button, ready to be filled in',
  group: 'starter',
  words: ['blank desktop app', 'desktop app starter', 'app starter', 'blank app', 'empty app', 'starter app'],
  desktop: true,
  launch: 'Play.cmd',
  tip: 'This is a starter, not a finished app: edit index.html and app.js to make it yours, or ask for help once a model is available.',
  files: desktopStarterFiles,
};

const website: AppTemplate = {
  id: 'website',
  label: 'a website',
  summary: 'a one-page website starter: header, hero, about and contact sections',
  group: 'starter',
  words: ['website', 'web site', 'webpage', 'web page', 'landing page', 'homepage', 'home page', 'portfolio site', 'portfolio website', 'blog site', 'blog website'],
  desktop: false,
  launch: 'index.html',
  tip: 'This is a starter page with placeholder text. Edit index.html and style.css, then refresh.',
  files: websiteStarterFiles,
};

const BUILT_IN: readonly AppTemplate[] = [clicker, snakeGame, game2048, minesweeperGame, memoryGame, ticTacToeGame, breakoutGame, todoApp, notesApp, pomodoroApp, calculatorApp, converterApp, passwordApp, budgetApp, habitsApp, kanbanApp, flashcardsApp, unrealProject, godotProject, unityProject, blenderProject, desktop, website].map(
  (t) => ({ ...t, source: t.source ?? 'built-in' }),
);

if (allTemplates().length === 0) registerTemplates(BUILT_IN);

/** The built-in set, for tests that want to check them and nothing else. */
export const BUILT_IN_TEMPLATES = BUILT_IN;
export const APP_TEMPLATES = allTemplates();
