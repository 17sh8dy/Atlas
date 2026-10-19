/**
 * Terminal skills — a window the person can SEE, and a way for Atlas to find out how it went.
 *
 * `powershell.run` runs a script hidden and returns its output: right for "list these files", wrong for
 * "open Claude Code", "start my dev server", "run the tests and let me watch". Those need a real window
 * that stays open. `terminal.open` is that, and it is deliberately no looser than `powershell.run`:
 *
 *  - the person reads the WHOLE script on a card every time (a preview no execution mode softens), and
 *    `run` refuses if it is not the script they approved;
 *  - the same refusal table (`safety/powershell-policy.ts`) and the same Allowed-Folders check, repeated in
 *    Rust next to the machine (`terminal.rs`);
 *  - the emergency stop is checked first.
 *
 * "It opened" is never assumed: the launcher writes `[atlas-started]` to a log, and `run` reads it back.
 * If the marker does not appear Atlas says the window may not have started, instead of claiming success.
 *
 * `terminal.read` / `terminal.list` read those logs (Atlas's own folder, only ids Atlas issued).
 * `dev.tools` answers "is X installed?" from a fixed list, running each program once with a fixed
 * version flag. It never installs anything.
 */

import type { Platform, Skill } from '@atlas/core';
import { MAX_SCRIPT_CHARS, powershellRefusal } from '../safety/powershell-policy';

/** A short, stable fingerprint, so a changed script can't ride an earlier approval. */
export function terminalFingerprint(script: string, cwd: string, watch: boolean): string {
  let h = 2166136261;
  const text = `${script}\n${cwd}\n${watch}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `term:${text.length}:${h.toString(16)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long `terminal.open` waits to see the launcher's first line before it stops claiming success. */
export const START_WAIT_MS = 6_000;
const POLL_MS = 400;

export function createTerminalSkills(platform: Platform): Skill[] {
  return [
    {
      id: 'terminal.open',
      label: 'Open a terminal and run something',
      icon: '🖥️',
      domain: 'terminal',
      description:
        'Open a VISIBLE PowerShell window that runs a command and stays open, e.g. to start a coding assistant (opencode, claude), a dev server, a build or the tests. Use this instead of powershell.run when the person wants to SEE or keep using the window. The person is shown the whole script and approves it every time. Same refusals and Allowed Folders as powershell.run. Full-screen programs cannot be logged: set watch to false for them.',
      needs: ['devtools'],
      risk: 'confirm',
      examples: ['open a terminal and run npm test', 'open opencode in a terminal'],
      params: {
        script: {
          type: 'string',
          required: true,
          description: `the PowerShell to run in the window (at most ${MAX_SCRIPT_CHARS} characters)`,
        },
        cwd: { type: 'string', required: false, description: 'the folder to start in; must be an allowed folder' },
        watch: {
          type: 'boolean',
          required: false,
          description: 'log the output so Atlas can read it afterwards (default true). Use false for full-screen programs.',
        },
        title: { type: 'string', required: false, description: 'a short name for the window' },
      },
      summarize: (args) => `open a terminal: ${String(args.title ?? args.script ?? '').slice(0, 60)}`,
      guard: (args) => (typeof args.script === 'string' && args.script.trim() ? powershellRefusal(args.script) : null),
      async preview(args) {
        const script = String(args.script ?? '');
        const refusal = powershellRefusal(script);
        if (refusal) return { kind: 'refuse', error: refusal };
        const cwd = String(args.cwd ?? '');
        const watch = args.watch !== false;
        return {
          kind: 'ask',
          question: 'Open a terminal and run this?',
          detail: `${script.trim()}${cwd ? `\n\n(starting in ${cwd})` : ''}${watch ? '' : '\n\n(a full-screen program: I will know when it starts and ends, not what is on screen)'}`,
          fingerprint: terminalFingerprint(script, cwd, watch),
        };
      },
      async run(args, ctx) {
        const script = String(args.script ?? '');
        const cwd = String(args.cwd ?? '');
        const watch = args.watch !== false;
        const refusal = powershellRefusal(script);
        if (refusal) return { ok: false, error: refusal };
        if (ctx.approvedPreview !== undefined && ctx.approvedPreview !== terminalFingerprint(script, cwd, watch)) {
          return { ok: false, error: 'That is not the script you approved, so I did not run it.' };
        }
        if (!platform.openTerminal) return { ok: false, error: "I can't open a terminal on this device." };
        try {
          const info = await platform.openTerminal(script, {
            cwd: cwd || undefined,
            watch,
            title: typeof args.title === 'string' ? args.title : undefined,
          });
          // Read it back: the window exists when its launcher says so, not when Windows was asked.
          let started = false;
          if (platform.readTerminal) {
            for (let waited = 0; waited <= START_WAIT_MS && !started; waited += POLL_MS) {
              const seen = await platform.readTerminal(info.id, 200).catch(() => null);
              if (seen?.started) started = true;
              else await sleep(POLL_MS);
            }
          }
          if (!started && platform.readTerminal) {
            return {
              ok: false,
              error: `I asked Windows for a terminal (${info.title}) but did not see it start. It may still be opening, or something blocked it.`,
              data: info,
            };
          }
          return { ok: true, message: `Opened a terminal: ${info.title}.`, data: info };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      id: 'terminal.read',
      label: 'Read what a terminal printed',
      icon: '📜',
      domain: 'terminal',
      description:
        'Read the end of the log of a terminal Atlas opened (default: the most recent one) and say whether it is still running or how it ended. Only terminals opened with watch on have output; a full-screen program logs just its start and end.',
      needs: ['devtools'],
      risk: 'safe',
      examples: ['what did the terminal print', 'did the build finish'],
      params: {
        id: { type: 'string', required: false, description: 'the terminal id; omit for the most recent' },
        tail: { type: 'number', required: false, description: 'how many characters from the end (default 6000)' },
      },
      summarize: () => 'read a terminal log',
      async run(args) {
        if (!platform.readTerminal || !platform.listTerminals) return { ok: false, error: "I can't read terminals on this device." };
        try {
          let id = typeof args.id === 'string' ? args.id.trim() : '';
          if (!id) {
            const all = await platform.listTerminals();
            if (!all.length) return { ok: false, error: "I haven't opened a terminal yet." };
            id = all[0]!.id;
          }
          const t = await platform.readTerminal(id, typeof args.tail === 'number' ? args.tail : undefined);
          const state = !t.started
            ? "hasn't started"
            : t.running
              ? 'is still running'
              : `finished with exit code ${t.exitCode ?? 0}`;
          const body = t.text.trim() ? `\n\n${t.text.trim()}${t.truncated ? '\n(earlier output cut)' : ''}` : '\n\n(nothing printed that I can see)';
          return { ok: true, message: `That terminal ${state}.${body}`, data: t };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      id: 'terminal.list',
      label: 'List terminals Atlas opened',
      icon: '🗂️',
      domain: 'terminal',
      description: 'List the terminals Atlas has opened (newest first) and whether each is running or how it ended.',
      needs: ['devtools'],
      risk: 'safe',
      examples: ['list my terminals'],
      params: {},
      summarize: () => 'list terminals',
      async run() {
        if (!platform.listTerminals) return { ok: false, error: "I can't list terminals on this device." };
        try {
          const all = await platform.listTerminals();
          if (!all.length) return { ok: true, message: "I haven't opened any terminals." };
          const lines = all.slice(0, 10).map((t) => {
            const when = new Date(t.at).toLocaleTimeString();
            const state = !t.started ? 'not started' : t.running ? 'running' : `exit ${t.exitCode ?? 0}`;
            return `${t.id} · ${when} · ${state}`;
          });
          return { ok: true, message: lines.join('\n'), data: all };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      id: 'dev.tools',
      label: 'Which developer tools are installed',
      icon: '🧰',
      domain: 'devtools',
      description:
        'Check whether well-known developer tools (git, node, npm, pnpm, python, cargo, dotnet, go, java, docker, gh, ffmpeg, code, claude, opencode, ollama…) are installed and which version. Read-only; never installs anything. Leave names empty to check all.',
      needs: ['devtools'],
      risk: 'safe',
      examples: ['is git installed', 'do I have node', 'is opencode installed'],
      params: {
        names: { type: 'string', required: false, description: 'comma-separated tool names; omit for all' },
      },
      summarize: (args) => `check ${String(args.names ?? 'developer tools')}`,
      async run(args) {
        if (!platform.probeDevTools) return { ok: false, error: "I can't check installed tools on this device." };
        const names = String(args.names ?? '')
          .split(/[,\s]+/)
          .map((n) => n.trim())
          .filter(Boolean);
        try {
          const rows = await platform.probeDevTools(names);
          const found = rows.filter((r) => r.found);
          const missing = rows.filter((r) => !r.found);
          const lines = [
            ...found.map((r) => `✓ ${r.name}${r.version ? ` — ${r.version}` : ''}`),
            ...missing.map((r) => `✗ ${r.name} — not found`),
          ];
          return { ok: true, message: lines.join('\n'), data: rows };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}
