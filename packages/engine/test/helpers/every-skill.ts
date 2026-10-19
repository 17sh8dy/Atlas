/**
 * Every skill Atlas registers, built from its factories with a platform that can do nothing.
 *
 * Only declarations are read (never `run`), so this is the right way to look at the WHOLE catalog from a
 * test: capability descriptors, retrieval, coverage and phrasing tests all start here. Mirrors the list
 * in `advertised-examples.test.ts`; a skill added to the app should be added to both.
 */
import type { Platform, Skill } from '@atlas/core';
import { Grammar } from '../../src/planner/grammar';
import { createCoreGrammar } from '../../src/planner/core-grammar';
import { createExtraGrammar } from '../../src/planner/extra-grammar';
import { WorkingMemory } from '../../src/working-memory';
import { createCoreSkills } from '../../src/skills/core-skills';
import { createWebSearchSkills } from '../../src/skills/web-search-skills';
import { createUtilitySkills } from '../../src/skills/utility-skills';
import { createTextSkills } from '../../src/skills/text-skills';
import { createCalcSkills } from '../../src/skills/calc-skills';
import { createNotesSkills } from '../../src/skills/notes-skills';
import { createOsSkills } from '../../src/skills/os-skills';
import { createReminderSkills } from '../../src/skills/reminder-skills';
import { createSystemControlSkills } from '../../src/skills/system-skills';
import { createRoutineSkills } from '../../src/skills/routine-skills';
import { RoutineScheduler } from '../../src/routines/scheduler';
import { createCoverageSkills } from '../../src/skills/coverage-skills';
import { createCatalogSkills } from '../../src/skills/catalog-skills';
import { createCatalogFileSkills } from '../../src/skills/catalog-file-skills';
import { createCatalogGitSkills } from '../../src/skills/catalog-git-skills';
import { createCatalogSystemSkills } from '../../src/skills/catalog-system-skills';
import { createPcHealthSkills } from '../../src/skills/pc-health-skills';
import { createFileIntelSkills } from '../../src/skills/file-intel-skills';
import { createBuilderSkills } from '../../src/skills/builder-skills';
import { createWorkflowSkills } from '../../src/skills/workflow-skills';
import { createDocsSkills } from '../../src/skills/docs-skills';
import { WorkflowLog } from '../../src/workflow/report';
import { createCatalogMediaSkills } from '../../src/skills/catalog-media-skills';
import { createCatalogMakeSkills } from '../../src/skills/catalog-make-skills';
import { createClipboardHistorySkills } from '../../src/skills/clipboard-history-skills';
import { ClipboardHistory } from '../../src/clipboard/history';
import { createSelfTestSkills } from '../../src/skills/selftest-skills';
import { createAppsSkills } from '../../src/skills/apps-skills';
import { createCreatorSkills } from '../../src/skills/creator-skills';
import { createEverydaySkills } from '../../src/skills/everyday-skills';
import { createShellSkills } from '../../src/skills/shell-skills';
import { createSettingsSkills } from '../../src/skills/settings-skills';
import { createFileToolsSkills } from '../../src/skills/file-tools-skills';
import { ReminderScheduler } from '../../src/reminders/scheduler';
import { createNetworkSkills } from '../../src/skills/network-skills';
import { createServiceSkills } from '../../src/skills/service-skills';
import { createEnvironmentSkills } from '../../src/skills/environment-skills';
import { createStorageSkills } from '../../src/skills/storage-skills';
import { createWindowSkills } from '../../src/skills/window-skills';
import { createInputSkills } from '../../src/skills/input-skills';
import { createUiaSkills } from '../../src/skills/uia-skills';
import { createScreenSkills } from '../../src/skills/screen-skills';
import { createDevToolsSkills } from '../../src/skills/devtools-skills';
import { createWatchSkills } from '../../src/skills/watch-skills';
import { createSetupSkills } from '../../src/skills/setup-skills';
import { SetupStore } from '../../src/setup/store';
import { SkillRegistry } from '../../src/skills/registry';
import { createPowerShellSkills } from '../../src/skills/powershell-skills';
import { createWorkflowMemorySkills } from '../../src/skills/workflow-memory-skills';
import { WorkflowMemory } from '../../src/workflow/memory';
import { createUniversalAgentSkill } from '../../src/skills/universal-skill';
import { createProjectServerSkill } from '../../src/skills/project-server-skill';
import { createTerminalSkills } from '../../src/skills/terminal-skills';
import { createKbmSkills } from '../../src/skills/kbm-skills';
import { createPluginSkills } from '../../src/skills/plugin-skills';

/**
 * Only the declarations are read — never `run` — so a platform that can do
 * nothing at all is exactly the right one to build the catalog with.
 */
export const NOTHING = new Proxy({}, { get: () => undefined }) as Platform;
const memory = { record: async () => {}, episodes: async () => [], forget: async () => {} };

export function everySkill(): Skill[] {
  const working = new WorkingMemory();
  return [
    ...createCoreSkills({ platform: NOTHING, working, memory } as never),
    ...createWebSearchSkills(NOTHING),
    ...createUtilitySkills(),
    ...createTextSkills(),
    ...createCalcSkills(),
    ...createNotesSkills(),
    ...createOsSkills(NOTHING),
    ...createSystemControlSkills(NOTHING),
    ...createFileToolsSkills(NOTHING),
    ...createSettingsSkills(NOTHING),
    ...createShellSkills(NOTHING),
    ...createEverydaySkills(NOTHING),
    ...createCreatorSkills(NOTHING),
    ...createAppsSkills(NOTHING),
    ...createCoverageSkills(NOTHING),
    ...createCatalogSkills(NOTHING, new SkillRegistry()),
    ...createCatalogFileSkills(NOTHING),
    ...createCatalogGitSkills(NOTHING),
    ...createCatalogSystemSkills(NOTHING),
    ...createPcHealthSkills(NOTHING),
    ...createFileIntelSkills(NOTHING),
    ...createBuilderSkills(NOTHING),
    ...createDocsSkills({ platform: NOTHING, search: { search: async () => ({ ok: false as const, reason: 'none-available' as const, attempts: [] }) } }),
    ...createWorkflowSkills(new WorkflowLog()),
    ...createCatalogMediaSkills(NOTHING),
    ...createCatalogMakeSkills(NOTHING),
    ...createClipboardHistorySkills({ platform: NOTHING, history: new ClipboardHistory(), isEnabled: () => true }),
    ...createSelfTestSkills({ skills: new SkillRegistry(), platform: NOTHING, route: () => null }),
    ...createRoutineSkills({ scheduler: new RoutineScheduler({ storage: NOTHING as never, announce: () => {}, run: async () => ({}) as never }), skills: new SkillRegistry(), planFor: async () => null }),
    ...createReminderSkills(new ReminderScheduler({ storage: NOTHING as never, notify: () => {} })),
    ...createNetworkSkills(NOTHING),
    ...createServiceSkills(NOTHING),
    ...createEnvironmentSkills(NOTHING),
    ...createStorageSkills(NOTHING),
    ...createWindowSkills(NOTHING),
    ...createInputSkills(NOTHING),
    ...createUiaSkills(NOTHING),
    ...createScreenSkills(NOTHING),
    ...createDevToolsSkills(NOTHING),
    ...createPowerShellSkills(NOTHING),
    ...createTerminalSkills(NOTHING),
    createProjectServerSkill(NOTHING, async () => null),
    createUniversalAgentSkill({ skills: new SkillRegistry(), getExecutionMode: () => 'doIt' }),
    ...createWorkflowMemorySkills({ memory: new WorkflowMemory(NOTHING as never), skills: new SkillRegistry(), getExecutionMode: () => 'doIt', planFor: async () => null, lastPlan: () => null }),
    ...createKbmSkills(NOTHING),
    ...createPluginSkills(NOTHING),
    ...createWatchSkills({
      platform: NOTHING,
      skills: new SkillRegistry(),
      manager: () => null,
      planFor: async () => null,
    }),
    ...createSetupSkills({
      platform: NOTHING,
      skills: new SkillRegistry(),
      store: new SetupStore({ get: async () => undefined, set: async () => {}, remove: async () => {} }),
      getExecutionMode: () => 'doIt',
    }),
  ];
}

export function buildGrammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}

