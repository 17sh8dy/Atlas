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

export { createCoreSkills } from './skills/core-skills';
export { createCoreGrammar } from './planner/core-grammar';
