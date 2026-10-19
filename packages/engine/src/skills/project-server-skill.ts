/**
 * `project.startServer` — start the current project's dev server in a visible terminal.
 *
 * The command is NOT guessed by a model and NOT typed by the person: it is read from the project itself
 * (`detectProject`: which ecosystems are present and which npm scripts exist) and chosen by a short fixed
 * table. The result is the same thing `terminal.open` would run, shown on the same card with the same
 * fingerprint, and it goes through the same refusals and Allowed Folders. If the project offers no
 * unambiguous way to serve itself, this says so and starts nothing.
 *
 * Preference order, first match wins:
 *   package.json scripts  `dev` > `start` > `serve` > `preview`   (run with pnpm when pnpm was detected, else npm)
 *   Cargo.toml                                                     → `cargo run`
 *   a .NET project                                                 → `dotnet run`
 */

import type { DevSystem, Platform, Skill } from '@atlas/core';
import { terminalFingerprint } from './terminal-skills';
import { powershellRefusal } from '../safety/powershell-policy';

const SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview'] as const;

/** The command a project's own markers point to, or null when nothing is unambiguous. Pure. */
export function serverCommandFor(info: { systems: readonly DevSystem[]; npmScripts: readonly string[] }): { command: string; why: string } | null {
  const js = info.systems.includes('pnpm') ? 'pnpm' : info.systems.includes('npm') ? 'npm' : null;
  if (js) {
    const script = SCRIPT_ORDER.find((s) => info.npmScripts.includes(s));
    if (script) return { command: script === 'start' && js === 'npm' ? 'npm start' : `${js} run ${script}`, why: `package.json has a "${script}" script` };
  }
  if (info.systems.includes('cargo')) return { command: 'cargo run', why: 'this is a Cargo project' };
  if (info.systems.includes('dotnet')) return { command: 'dotnet run', why: 'this is a .NET project' };
  return null;
}

export function createProjectServerSkill(platform: Platform, currentProject: () => Promise<string | null>): Skill {
  async function resolve(args: Record<string, unknown>): Promise<{ ok: true; path: string; command: string; why: string } | { ok: false; error: string }> {
    const path = String(args.path ?? '').trim() || (await currentProject()) || '';
    if (!path) return { ok: false, error: 'Which project? Say "use D:\\Dev\\MyApp as my project" once, or give me the folder.' };
    if (!platform.detectProject) return { ok: false, error: "I can't look at projects on this device." };
    try {
      const info = await platform.detectProject(path);
      const found = serverCommandFor(info);
      if (!found) return { ok: false, error: `I can't tell how to start a server for ${path}: it has no dev/start/serve script, and it is not a Cargo or .NET project. Tell me the command and I'll run it in a terminal.` };
      const refusal = powershellRefusal(found.command);
      if (refusal) return { ok: false, error: refusal };
      return { ok: true, path, ...found };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    id: 'project.startServer',
    label: "Start the project's dev server",
    icon: '🌐',
    domain: 'project',
    description:
      "Start the current project's development server in a visible terminal window. The command comes from the project itself (its dev/start script, or cargo run / dotnet run), is shown to you in full, and needs your approval every time.",
    needs: ['devtools'],
    risk: 'confirm',
    examples: ['start the dev server', 'run my project in dev mode'],
    params: { path: { type: 'string', required: false, description: 'the project folder (defaults to your current project)' } },
    summarize: () => "start the project's dev server",
    async preview(args) {
      const r = await resolve(args);
      if (!r.ok) return { kind: 'refuse', error: r.error };
      return {
        kind: 'ask',
        question: 'Start the dev server in a terminal?',
        detail: `${r.command}\n\n(in ${r.path}; ${r.why})`,
        fingerprint: terminalFingerprint(r.command, r.path, true),
      };
    },
    async run(args, ctx) {
      const r = await resolve(args);
      if (!r.ok) return { ok: false, error: r.error };
      if (ctx.approvedPreview !== undefined && ctx.approvedPreview !== terminalFingerprint(r.command, r.path, true)) {
        return { ok: false, error: 'That is not the command you approved, so I did not start it.' };
      }
      if (!platform.openTerminal) return { ok: false, error: "I can't open a terminal on this device." };
      try {
        const info = await platform.openTerminal(r.command, { cwd: r.path, watch: true, title: `dev server: ${r.command}` });
        return { ok: true, message: `Started \`${r.command}\` in a terminal (${info.title}). Say "what did the terminal print" to see how it went.`, data: { ...info, command: r.command, path: r.path } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
