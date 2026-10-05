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
export type { ExecutorOptions, ActivityEvent } from './planner/executor';

export { Engine } from './engine';
export type { EngineIO, EngineOptions, AskOutcome } from './engine';

export { createCoreSkills } from './skills/core-skills';
export { createWebSearchSkills } from './skills/web-search-skills';
export { createSearchManager } from './web/providers';
export { SearchManager, SearchError } from './web/search-manager';
export type { SearchProvider, SearchOutcome } from './web/search-manager';
export { routeQuestion } from './web/router';
export { createUtilitySkills } from './skills/utility-skills';
export { createTextSkills } from './skills/text-skills';
export { createCalcSkills } from './skills/calc-skills';
export { createNotesSkills } from './skills/notes-skills';
export { createOsSkills } from './skills/os-skills';
export { RoutineScheduler, ROUTINES_KEY } from './routines/scheduler';
export type { Routine, RoutineHost } from './routines/scheduler';
export { createRoutineSkills } from './skills/routine-skills';
export { createCoverageSkills } from './skills/coverage-skills';
export { createCatalogSkills } from './skills/catalog-skills';
export { createCatalogFileSkills } from './skills/catalog-file-skills';
export { createCatalogGitSkills } from './skills/catalog-git-skills';
export { createCatalogSystemSkills } from './skills/catalog-system-skills';
export { createCatalogMediaSkills } from './skills/catalog-media-skills';
export { createCatalogMakeSkills } from './skills/catalog-make-skills';
export { ClipboardHistory, looksSensitive } from './clipboard/history';
export { createClipboardHistorySkills } from './skills/clipboard-history-skills';
export { createSelfTestSkills, type SelfCheck, type CheckResult } from './skills/selftest-skills';
export { createAppsSkills, resolvePackage } from './skills/apps-skills';
export { createCreatorSkills, renamed, SCAFFOLD_TEMPLATES } from './skills/creator-skills';
export { createEverydaySkills, buildIcs } from './skills/everyday-skills';
export { withSpokenPaths } from './skills/spoken-paths';
export { createShellSkills, SETTINGS_PAGES } from './skills/shell-skills';
export { createSettingsSkills } from './skills/settings-skills';
export { createFileToolsSkills } from './skills/file-tools-skills';
export { resolveTarget, resolvePlace } from './skills/locate';
export { createSystemControlSkills } from './skills/system-skills';
export { createReminderSkills } from './skills/reminder-skills';
export { ReminderScheduler, REMINDERS_KEY } from './reminders/scheduler';
export type { Reminder, ReminderHost } from './reminders/scheduler';
export { createNetworkSkills } from './skills/network-skills';
export { createServiceSkills } from './skills/service-skills';
export { createWindowSkills } from './skills/window-skills';
export { createInputSkills } from './skills/input-skills';
export { createUiaSkills } from './skills/uia-skills';
export { createKbmSkills } from './skills/kbm-skills';
export { createScreenSkills } from './skills/screen-skills';
export { createEnvironmentSkills } from './skills/environment-skills';
export { createStorageSkills } from './skills/storage-skills';
export {
  createOrganizeSkills,
  createMemoryJournal,
  withFileJournal,
  JOURNAL_LIMIT,
} from './skills/organize-skills';
export type {
  FileJournal,
  JournalBatch,
  JournalKind,
  JournalMove,
} from './skills/organize-skills';
export { createDevToolsSkills } from './skills/devtools-skills';
export { ProjectContext, withCurrentProject, createProjectSkills } from './skills/project-context';
export { createDevAgentSkill } from './skills/devagent-skill';
export { createAppScaffoldSkills } from './skills/app-scaffold-skills';
export { createRecolorSkills } from './skills/recolor-skills';
export { createProjectToolSkills } from './skills/project-tools-skills';
export { createPowerShellSkills } from './skills/powershell-skills';
export { createPluginSkills, engineAdvice } from './skills/plugin-skills';
export { loadPlugins, pluginReport } from './plugins/host';
export { parseManifest, manifestTemplates } from './plugins/manifest';
export { embeddedPaths, powershellRefusal } from './safety/powershell-policy';
export { allTemplates, chooseTemplate, registerTemplates, unregisterTemplates } from './templates';
export type { DevAgentSkillOptions } from './skills/devagent-skill';
export { runDevTask, MAX_DEV_ITERATIONS } from './devagent/loop';
export type {
  DevAgentDeps,
  DevTaskReport,
  DevTaskStepLog,
  DevTaskStopReason,
} from './devagent/loop';
export { createUiAgentSkill } from './skills/uiagent-skill';
export type { UiAgentSkillOptions } from './skills/uiagent-skill';
export { runUiTask, MAX_UI_ITERATIONS } from './uiagent/loop';
export type {
  UiAgentDeps,
  UiTaskReport,
  UiTaskStepLog,
  UiTaskStopReason,
} from './uiagent/loop';
export { createCoreGrammar } from './planner/core-grammar';
export { createExtraGrammar } from './planner/extra-grammar';
export { createAgentGrammar } from './planner/agent-grammar';
export { createAppGrammar } from './planner/app-grammar';

export { WatchManager, WATCHES_KEY } from './watch/manager';
export type { WatchHost, WatchManagerOptions, NewWatch, WatchAnswer } from './watch/manager';
export {
  describeCondition,
  fingerprintSteps,
  isPartialDownload,
  probeCondition,
  reliableAfterGap,
} from './watch/conditions';
export { createWatchSkills, watchRow } from './skills/watch-skills';
export type { WatchSkillDeps } from './skills/watch-skills';
export { SetupStore, SETUPS_KEY } from './setup/store';
export { parseSpec, describeItem, setupKey, readPosition, splitNames } from './setup/spec';
export { runSetup, planSetup, reportFor } from './setup/runner';
export { createSetupSkills } from './skills/setup-skills';
export type { SetupSkillDeps } from './skills/setup-skills';
export { matchRunningProcess, BUILD_PROCESSES } from './text/processes';
export { placementBounds, describePosition } from './skills/window-skills';

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
export { readAffirmation, type Affirmation } from './text/affirmation';
export { readSmallTalk, type SmallTalkKind } from './text/smalltalk';
export { stripFiller, splitBrowserHint, normalizeRequest } from './text/normalize';
export { KNOWN_SITES, resolveSite, isKnownSiteName, exactSiteName } from './text/sites';
export type { KnownSite } from './text/sites';
export { resolveWindow, liveWindows } from './text/windows';
export type { WindowMatch } from './text/windows';

export {
  filterDestinations,
  isExplicitDestination,
  refusalFor,
  screenPlan,
  screenRequest,
  screenSkillCall,
} from './safety/content-policy';
export type { BlockReason, PolicyVerdict } from './safety/content-policy';

export { createPhrasing, JOKES } from './phrasing';
export type { Phrasing } from './phrasing';

export { WorkingMemory } from './working-memory';

export { recordEpisodes } from './episodic';

export { SimpleIntelligenceRegistry } from './intelligence-registry';
