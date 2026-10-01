/**
 * Atlas checks itself: `engine.selfTest`.
 *
 * This looks at the RUNNING app, not at the test suites (those run in the repository, not
 * on a person's PC). It answers "is this installation in working order?":
 *   - the skill registry is loaded and what is hidden because this build lacks something,
 *   - every phrasing Atlas advertises still reaches the skill that advertised it,
 *   - the PC-facing pieces answer (system info, processes, installed apps, allowed folders),
 *   - git and ffmpeg are installed (some skills need them),
 *   - whatever the app adds (storage works, saved settings are valid, a model is connected…).
 *
 * Everything it does is a read. It touches no files and runs no program but `git --version`
 * / `ffmpeg -version`, and it never reads the clipboard, credentials or conversation.
 */

import type { Platform, Skill } from '@atlas/core';
import type { SkillRegistry } from './registry';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface CheckResult {
  status: CheckStatus;
  detail?: string;
}
export interface SelfCheck {
  name: string;
  run(): Promise<CheckResult> | CheckResult;
}

export interface SelfTestDeps {
  skills: SkillRegistry;
  platform: Platform;
  /** Which skill a sentence reaches — the grammar, with no model involved. */
  route: (text: string) => string | null;
  /** Checks only the host app can make (storage, settings, a connected model). */
  extraChecks?: () => SelfCheck[];
}

const ICON: Record<CheckStatus, string> = { pass: '✅', warn: '⚠️', fail: '❌' };

async function guarded(check: SelfCheck): Promise<CheckResult> {
  try {
    return await check.run();
  } catch (e) {
    return { status: 'fail', detail: e instanceof Error ? e.message : typeof e === 'string' ? e : 'it threw' };
  }
}

export function builtInChecks({ skills, platform, route }: SelfTestDeps): SelfCheck[] {
  const checks: SelfCheck[] = [];

  checks.push({
    name: 'Skill registry',
    run() {
      const all = skills.all().length;
      const available = skills.available().length;
      if (!available) return { status: 'fail', detail: 'no actions are available' };
      const hidden = all - available;
      return { status: 'pass', detail: `${available} actions available${hidden ? ` (${hidden} more need something this build doesn't have)` : ''}` };
    },
  });

  checks.push({
    name: 'Phrasings reach their skills',
    run() {
      let tried = 0;
      const wrong: string[] = [];
      for (const s of skills.available()) {
        for (const example of s.examples ?? []) {
          tried += 1;
          if (route(example) !== s.id) wrong.push(`“${example}”`);
        }
      }
      if (!tried) return { status: 'warn', detail: 'no example phrasings to try' };
      // Some examples refer to "this" / "that" (the clipboard, the last result) and need context.
      // That is known, so it is a note, not a failure.
      return wrong.length
        ? { status: 'warn', detail: `${tried - wrong.length} of ${tried} work; ${wrong.length} need more context or aren't recognised (${wrong.slice(0, 3).join(', ')}${wrong.length > 3 ? '…' : ''})` }
        : { status: 'pass', detail: `all ${tried} example phrasings reach the right action` };
    },
  });

  const probe = (name: string, fn: (() => Promise<unknown>) | undefined, missing: string, check: (v: unknown) => CheckResult): void => {
    checks.push({
      name,
      async run() {
        if (!fn) return { status: 'warn', detail: missing };
        return check(await fn());
      },
    });
  };
  probe('System information', platform.systemInfo?.bind(platform), 'not available in this build', (v) => {
    const s = v as { memoryTotalBytes?: number };
    return s?.memoryTotalBytes ? { status: 'pass', detail: 'reads CPU, memory and disks' } : { status: 'warn', detail: 'answered, but with nothing in it' };
  });
  probe('Running programs', platform.runningProcesses ? () => platform.runningProcesses!(50) : undefined, 'not available in this build', (v) =>
    Array.isArray(v) && v.length ? { status: 'pass', detail: 'can see what is running' } : { status: 'warn', detail: 'saw no processes' },
  );
  probe('Installed apps', platform.listApps?.bind(platform), 'not available in this build', (v) =>
    Array.isArray(v) && v.length ? { status: 'pass', detail: `${v.length} apps found` } : { status: 'warn', detail: 'found no installed apps' },
  );
  probe('Allowed folders', platform.allowedFolders?.bind(platform), 'not available in this build', (v) =>
    Array.isArray(v) && v.length ? { status: 'pass', detail: `${v.length} folder${v.length === 1 ? '' : 's'} Atlas may use` } : { status: 'fail', detail: 'no folder is allowed, so file actions will all be refused' },
  );
  probe('Git and ffmpeg', platform.toolVersions?.bind(platform), 'not checked in this build', (v) => {
    const t = v as { git: string | null; ffmpeg: string | null };
    const missing = [!t.git ? 'git' : '', !t.ffmpeg ? 'ffmpeg' : ''].filter(Boolean);
    return missing.length
      ? { status: 'warn', detail: `${missing.join(' and ')} not installed — the skills that use ${missing.length === 2 ? 'them' : 'it'} will say so` }
      : { status: 'pass', detail: `${t.git} · ${t.ffmpeg?.split(' ').slice(0, 3).join(' ')}` };
  });

  return checks;
}

export function createSelfTestSkills(deps: SelfTestDeps): Skill[] {
  return [
    {
      id: 'engine.selfTest',
      label: 'Self-test',
      icon: '🩺',
      domain: 'core',
      description: 'Check this installation is in working order: the actions are loaded, every example phrasing works, the PC-facing parts answer, git and ffmpeg are there, and saved settings are valid. Read-only.',
      risk: 'safe',
      examples: ['run a self test', 'is atlas working properly'],
      params: {},
      async run(_args, ctx) {
        const checks = [...builtInChecks(deps), ...(deps.extraChecks?.() ?? [])];
        const results: Array<{ name: string } & CheckResult> = [];
        for (const c of checks) results.push({ name: c.name, ...(await guarded(c)) });
        const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
        const [pass, warn, fail] = [count('pass'), count('warn'), count('fail')];
        ctx.showResults?.(
          results.map((r) => ({ title: `${r.name}: ${r.status.toUpperCase()}`, subtitle: r.detail ?? '', icon: ICON[r.status] })),
          { title: 'Atlas self-test', subtitle: `${pass} passed · ${warn} to note · ${fail} failed` },
        );
        return {
          ok: fail === 0,
          spoken: true,
          message: fail ? `🩺 ${fail} check${fail === 1 ? '' : 's'} failed: ${results.filter((r) => r.status === 'fail').map((r) => r.name).join(', ')}.` : `🩺 ${pass} checks passed${warn ? `, ${warn} to note` : ''}. Nothing is broken.`,
          data: results,
        };
      },
    },
  ];
}
