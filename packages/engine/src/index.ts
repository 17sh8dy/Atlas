/**
 * @atlas/engine — the local-first assistant runtime.
 *
 * Depends only on `@atlas/core`. No React, no Tauri, no DOM: the engine can be
 * driven by a desktop window, a browser tab, or a test harness, because it
 * renders nothing and reaches the machine only through the `Platform` port.
 */

export { Bus } from './bus';
export type { BusHandler, Unsubscribe } from './bus';

export { SkillRegistry } from './skills/registry';
export type { RegistryOptions } from './skills/registry';

export { Grammar, plan, step } from './planner/grammar';
export type { GrammarRule } from './planner/grammar';

export { Executor } from './planner/executor';
export type { ExecutorOptions } from './planner/executor';

export { Engine } from './engine';
export type { EngineIO, EngineOptions, AskOutcome } from './engine';
export type { EngineStage, EngineStatus } from './status';

export { createCoreSkills } from './skills/core-skills';
export { createWebSearchSkills } from './skills/web-search-skills';
export { createUtilitySkills } from './skills/utility-skills';
export { createTextSkills } from './skills/text-skills';
export { createCalcSkills } from './skills/calc-skills';
export { createNotesSkills } from './skills/notes-skills';
export { createOsSkills } from './skills/os-skills';
export { createCoreGrammar } from './planner/core-grammar';
export { createExtraGrammar } from './planner/extra-grammar';

export {
  matchKey,
  editDistance,
  typoBudget,
  rankMatches,
  nearMatches,
  confidentMatch,
  RANK,
} from './text/fuzzy';
export type { Match, MatchOptions } from './text/fuzzy';
export { stripFiller, splitBrowserHint, normalizeRequest } from './text/normalize';
export { KNOWN_SITES, resolveSite, isKnownSiteName } from './text/sites';
export type { KnownSite } from './text/sites';

export {
  filterDestinations,
  isExplicitDestination,
  refusalFor,
  screenPlan,
  screenRequest,
  screenSkillCall,
} from './safety/content-policy';
export type { BlockReason, PolicyVerdict } from './safety/content-policy';

export { createPhrasing } from './phrasing';
export type { Phrasing } from './phrasing';

export { WorkingMemory } from './working-memory';

export { recordEpisodes } from './episodic';

export { SimpleIntelligenceRegistry } from './intelligence-registry';
