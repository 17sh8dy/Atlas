/**
 * `powershell.run` — run a PowerShell script when no other skill fits. The last resort.
 *
 * Atlas has a skill for nearly everything a person would reach for PowerShell to do, each with
 * its own checks; a general runner is the one tool that could walk round all of them, so it is
 * fenced in (the whole story is in `apps/desktop/src-tauri/src/powershell.rs`):
 *
 *  - **The person reads the whole script first.** `preview` puts it on the confirmation card, and
 *    a preview is never softened by an execution mode or by Allowed Folders, Do It + included
 *    (`safety/dangerous.ts`). An approval is for that script: `run` refuses if it is not the one
 *    that was shown.
 *  - **Refusals** for the classes of thing that have their own gated skills, or that exist to hide
 *    what a script does (`safety/powershell-policy.ts`), checked here before a card is drawn and
 *    again in Rust, next to the machine.
 *  - **Allowed Folders**: any drive path the script spells out must be inside one, and if it is
 *    not the usual "Add It? / Not Now" card is offered.
 *  - A time limit, capped output, and the emergency stop.
 *
 * Reached by `run powershell: …` (the grammar), by the AI planner when nothing else fits, and by
 * the developer agent. It is deliberately NOT a way to be quicker: if there is a skill for the
 * job, the skill is the better answer, and the description says so to the planner.
 */

import type { Platform, Skill } from '@atlas/core';
import { MAX_SCRIPT_CHARS, powershellRefusal } from '../safety/powershell-policy';

/** A short, stable fingerprint — enough to notice the script changed between card and run. */
function fingerprint(script: string, cwd: string): string {
  let h = 2166136261;
  const text = `${script}\n${cwd}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `ps:${text.length}:${h.toString(16)}`;
}

function previewOutput(text: string, lines = 60): string {
  const all = text.split(/\r?\n/);
  while (all.length && !all[all.length - 1]!.trim()) all.pop();
  const shown = all.slice(0, lines);
  const rest = all.length - shown.length;
  return shown.join('\n') + (rest > 0 ? `\n… ${rest} more line${rest === 1 ? '' : 's'}` : '');
}

export function createPowerShellSkills(platform: Platform): Skill[] {
  return [
    {
      id: 'powershell.run',
      label: 'Run a PowerShell script',
      icon: '🖥️',
      domain: 'powershell',
      description:
        'LAST RESORT. Run a short PowerShell script and report what it printed, when no other skill can do the job. Prefer a dedicated skill: files, apps, windows, settings, git, build and the rest each have their own checks. The person is shown the whole script and must approve it every time. Refused outright: elevation, encoded or built-up commands, downloads, permanent deletes, disks/registry/services/scheduled tasks, ending processes, credentials, keystrokes. Any drive path in the script must be inside Allowed Folders. 60 second limit.',
      needs: ['devtools'],
      risk: 'confirm',
      examples: ['run powershell: Get-ChildItem D:\\Dev | Select-Object Name, Length'],
      params: {
        script: {
          type: 'string',
          required: true,
          description: `the PowerShell to run (at most ${MAX_SCRIPT_CHARS} characters)`,
        },
        cwd: {
          type: 'string',
          required: false,
          description: 'the folder to start in; must be an allowed folder. Defaults to the home folder.',
        },
      },
      summarize: () => 'run a PowerShell script',
      guard: (args) => (typeof args.script === 'string' && args.script.trim() ? powershellRefusal(args.script) : null),
      async preview(args) {
        const script = String(args.script ?? '');
        const refusal = powershellRefusal(script);
        if (refusal) return { kind: 'refuse', error: refusal };
        const cwd = String(args.cwd ?? '');
        return {
          kind: 'ask',
          question: 'Run this PowerShell script?',
          detail: `${script.trim()}${cwd ? `\n\n(starting in ${cwd})` : ''}`,
          fingerprint: fingerprint(script, cwd),
        };
      },
      async run(args, ctx) {
        const script = String(args.script ?? '');
        const cwd = String(args.cwd ?? '');
        const refusal = powershellRefusal(script);
        if (refusal) return { ok: false, error: refusal };
        // An approval is for the script that was shown.
        if (ctx.approvedPreview !== undefined && ctx.approvedPreview !== fingerprint(script, cwd)) {
          return { ok: false, error: 'That is not the script you approved, so I did not run it.' };
        }
        if (!platform.runPowerShell) return { ok: false, error: "I can't run PowerShell on this device." };
        try {
          const result = await platform.runPowerShell(script, cwd || undefined);
          const out = [result.stdout, result.stderr].filter((s) => s.trim()).join('\n');
          const body = out ? previewOutput(out) : '(no output)';
          if (result.ok) {
            return { ok: true, message: `Done.\n\n${body}`, data: result };
          }
          return {
            ok: false,
            error: `${result.exitCode === null ? 'It did not finish.' : `It ended with exit code ${result.exitCode}.`}\n\n${body}`,
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}
