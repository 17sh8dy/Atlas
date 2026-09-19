/**
 * The UI-driving agent's own configuration of the shared observe-act-replan
 * core — see `agent/loop.ts`'s module doc for the mechanism and why it was
 * pulled out of `devagent/loop.ts` to make this possible without a second
 * implementation.
 *
 * ── Why this was blocked on nothing but a name ───────────────────────────────
 * `docs/ROADMAP.md` named "an autonomous observe-and-replan loop" as the gap
 * behind "go to the Nova server and start a call in Hangouts" — Phase 12
 * deferred it, Phase 13 built the *shape* for a text-only task, and it was
 * left there because the natural next question ("who looks at the screen?")
 * sounded like a vision problem, and Atlas deliberately has no vision
 * provider (see `docs/ARCHITECTURE.md`'s OCR/`screen.describe` note). But
 * "go to the Nova server" was never a vision task: `uia.tree` already
 * returns the server list as structured text — names, roles, the path to
 * click — the exact shape `runAgentTask` already knows how to fold into a
 * prompt. The only piece that didn't exist yet was `observationText`'s
 * fallback to `StepOutcome.data` in `agent/loop.ts`, because `uia.tree`
 * follows the "empty `message`, real payload in `data`" convention built for
 * chat cards, not for a model reading its own history back. Once that one
 * fallback existed, this file is a config, not an architecture.
 *
 * ── Why `allow` here can't just be a domain set, the way devagent's is ──────
 * `window.*`, `uia.*`, `input.*` and `os.power`/`service.stop` all share
 * `domain: 'system'` — a flat domain that long predates this task and isn't
 * being restructured for it. Filtering on domain the way devagent does would
 * hand a UI-driving step reach into shutting the machine down or stopping a
 * Windows service, which is exactly the kind of scope creep the "relevant by
 * construction" rule exists to prevent. So `UI_AGENT_SKILLS` names the exact
 * ids this task may touch — window control, UI Automation, raw input as the
 * fallback UIA itself prefers, and `app.open` to get the target application
 * running in the first place — rather than a domain that would have to
 * include several skills that must stay out of reach.
 */

import type { SkillContext } from '@atlas/core';
import { runAgentTask, type AgentDeps, type AgentTaskReport } from '../agent/loop';

/** Same shape as `MAX_DEV_ITERATIONS` — a real UI-driving task is genuinely
 * multi-step (open → observe → click → observe → click → verify), and this
 * caps it rather than sizing it down for a simpler-looking example. */
export const MAX_UI_ITERATIONS = 12;

/**
 * The exact skills a UI-driving step may touch — see this file's module
 * doc for why an explicit id set replaces the domain check devagent uses.
 * `window.close`/`system.endProcess` are deliberately not both here:
 * closing a window is a plausible part of a real task ("close the extra
 * tab"); ending a process is not what "drive this app" ever means, and
 * stays reachable only the way every other skill outside this list is —
 * directly, or through `planWithAI`, never through this loop.
 */
const UI_AGENT_SKILLS = new Set([
  'app.open',
  'window.list',
  'window.active',
  'window.focus',
  'window.minimize',
  'window.maximize',
  'window.restore',
  'window.move',
  'window.close',
  'uia.tree',
  'uia.focusedElement',
  'uia.invoke',
  'uia.expand',
  'uia.collapse',
  'uia.setValue',
  'uia.typeInto',
  'input.moveMouse',
  'input.cursorPosition',
  'input.click',
  'input.scroll',
  'input.drag',
  'input.pressKey',
  'input.hotkey',
  'input.typeText',
]);

export type UiTaskStepLog = AgentTaskReport['steps'][number];
export type UiTaskStopReason = AgentTaskReport['stoppedBecause'];
export type UiTaskReport = AgentTaskReport;
export type UiAgentDeps = AgentDeps;

export async function runUiTask(
  goal: string,
  deps: UiAgentDeps,
  ctx: SkillContext,
): Promise<UiTaskReport> {
  return runAgentTask(
    goal,
    {
      role: 'UI-driving agent',
      allow: (skillId) => UI_AGENT_SKILLS.has(skillId),
      maxIterations: MAX_UI_ITERATIONS,
      context: {},
      extraInstruction:
        'read uia.tree before every click to get current, real control paths — a path from an earlier read may no longer be valid; prefer app.open to bring the target application to the front before looking for anything in it',
      noProviderMessage:
        'Driving another app needs Cortex connected — turn it on in Settings → Intelligence, then ask again.',
    },
    deps,
    ctx,
  );
}
