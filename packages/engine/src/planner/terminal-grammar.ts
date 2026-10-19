/**
 * Plain-English routes to the terminal skills, so "open opencode", "open claude code in powershell" and
 * "is git installed" are answered in milliseconds with no model.
 *
 * Narrow on purpose. The only command a bare "open X" turns into is one of a few names that are command
 * line programs and nothing else (an AI coding assistant has no desktop app to be confused with). Any
 * other command needs the person to say WHERE: "in powershell", "in a terminal". Whatever the rule
 * proposes still goes through `terminal.open`'s own card, refusal table and Allowed Folders, exactly as
 * if a model had proposed it: a rule here chooses a skill, it never makes anything safe.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

/** Command-line programs with no desktop app of the same name. Spoken name → what is typed. */
const CLI_ONLY: Record<string, string> = {
  opencode: 'opencode',
  'open code': 'opencode',
  'claude code': 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  'codex cli': 'codex',
  'gemini cli': 'gemini',
  aider: 'aider',
};

/** Programs that draw the whole screen themselves: their output cannot be logged. */
const FULL_SCREEN = new Set(['opencode', 'claude', 'codex', 'gemini', 'aider', 'vim', 'nvim', 'nano', 'htop', 'less']);

const WHERE = String.raw`(?:in|inside|within|using|with|from)\s+(?:a\s+|an\s+|the\s+|my\s+|new\s+)*(?:(?:new|separate|visible|windows)\s+)*(?:power\s*shell|pwsh|terminal|console|command\s+prompt|cmd)(?:\s+(?:window|session|tab|prompt))?`;

/** A command line that is plausibly typed: a program name and plain arguments. Nothing else is claimed. */
const COMMAND = /^[\w][\w.\-]*(?:\s+[\w.\-:/\\=@"'~%,]+){0,8}$/;

/** Spoken tool names → the name `dev.tools` knows. */
const TOOL_NAMES: Record<string, string> = {
  git: 'git', node: 'node', 'node.js': 'node', nodejs: 'node', npm: 'npm', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun',
  deno: 'deno', python: 'python', pip: 'pip', uv: 'uv', cargo: 'cargo', rust: 'rustc', rustc: 'rustc', rustup: 'rustup',
  dotnet: 'dotnet', '.net': 'dotnet', go: 'go', golang: 'go', java: 'java', javac: 'javac', cmake: 'cmake', make: 'make',
  docker: 'docker', gh: 'gh', 'github cli': 'gh', winget: 'winget', ffmpeg: 'ffmpeg', 'vs code': 'code', vscode: 'code',
  'visual studio code': 'code', claude: 'claude', 'claude code': 'claude', opencode: 'opencode', codex: 'codex', ollama: 'ollama',
};

function cleanCommand(text: string): string {
  return text.trim().replace(/^["'`]+|["'`.!?]+$/g, '').trim();
}

/** The command to type for a request, or null. Exposed for tests. */
export function parseTerminalRequest(raw: string): { script: string; watch: boolean; title: string } | null {
  const text = raw.trim().replace(/[\s.!?]+$/, '');
  const make = (command: string) => {
    const script = cleanCommand(command);
    if (!script || !COMMAND.test(script)) return null;
    const program = script.split(/\s+/)[0]!.toLowerCase();
    return { script, watch: !FULL_SCREEN.has(program), title: script.slice(0, 40) };
  };

  // "open claude code in powershell", "run npm test in a terminal", "start the dev server in a new terminal window".
  const placed =
    new RegExp(String.raw`^(?:please\s+)?(?:open|launch|start|run|fire\s+up|execute)\s+(?:up\s+)?(.+?)\s+${WHERE}$`, 'i').exec(text) ??
    // "in powershell, run npm test" / "in a terminal open opencode"
    new RegExp(String.raw`^(?:please\s+)?${WHERE}[,:]?\s+(?:open|launch|start|run|execute)\s+(.+)$`, 'i').exec(text) ??
    // "type opencode in the PowerShell window", "enter npm test in the terminal"
    new RegExp(String.raw`^(?:please\s+)?(?:type|enter|put|write)\s+(.+?)\s+${WHERE}$`, 'i').exec(text) ??
    // "open a terminal and run npm test", "open powershell and type opencode"
    /^(?:please\s+)?(?:open|launch|start)\s+(?:up\s+)?(?:a\s+|an\s+|the\s+|new\s+)*(?:power\s*shell|pwsh|terminal|console|command\s+prompt)(?:\s+window)?\s*(?:,|and|then)\s*(?:run|type|enter|execute|start|launch|open)\s+(.+)$/i.exec(text);
  if (placed?.[1]) {
    const spoken = cleanCommand(placed[1]).replace(/^(?:the\s+)?/i, '').toLowerCase();
    return make(CLI_ONLY[spoken] ?? placed[1]);
  }

  // Bare "open opencode" / "start claude code": only the names that are nothing but a command line.
  const bare = /^(?:please\s+)?(?:open|launch|start|run|fire\s+up|boot\s+up)\s+(?:up\s+)?(?:the\s+)?([a-z][a-z\s-]{2,20})$/i.exec(text);
  if (bare) {
    const spoken = bare[1]!.trim().toLowerCase().replace(/\s+/g, ' ');
    const command = CLI_ONLY[spoken];
    if (command) return make(command);
  }
  return null;
}

/** "is git installed", "do I have node", "do i have docker installed": one known tool, or null. */
export function parseToolCheck(raw: string): string[] | null {
  const t = raw.trim().replace(/[\s.!?]+$/, '').toLowerCase();
  if (/^(?:which|what)\s+(?:dev(?:eloper)?\s+)?(?:tools|clis?)\s+(?:do\s+i\s+have|are\s+installed|i\s+have|do\s+i\s+have\s+installed)$/.test(t) ||
    /^(?:list|show|check)\s+(?:my\s+|the\s+)?(?:installed\s+)?dev(?:eloper)?\s+tools$/.test(t)) {
    return [];
  }
  const m =
    /^(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:installed|set\s+up|available)(?:\s+(?:here|on\s+(?:this|my)\s+(?:pc|computer|machine)))?$/.exec(t) ??
    /^(?:do\s+i\s+have|have\s+i\s+got)\s+(?:the\s+)?(.+?)(?:\s+installed)?(?:\s+(?:here|on\s+(?:this|my)\s+(?:pc|computer|machine)))?$/.exec(t) ??
    /^(?:what\s+version\s+of|which\s+version\s+of)\s+(.+?)\s+(?:do\s+i\s+have|is\s+installed|am\s+i\s+(?:using|running))$/.exec(t);
  if (!m?.[1]) return null;
  const names = m[1].split(/\s*(?:,|and|&)\s*/).map((n) => TOOL_NAMES[n.trim()]);
  return names.length && names.every(Boolean) ? [...new Set(names as string[])] : null;
}

export function createTerminalGrammar(): GrammarRule[] {
  return [
    {
      // "open claude code in powershell", "open opencode", "type opencode in the PowerShell window".
      name: 'terminalOpen',
      order: -11.72,
      pathSafe: true,
      test(_lower, raw) {
        const request = parseTerminalRequest(raw);
        if (!request) return null;
        return plan(
          step('terminal.open', { script: request.script, watch: request.watch, title: request.title }),
          'terminal-open',
        );
      },
    },
    {
      // "is git installed", "do I have node", "which dev tools do I have".
      name: 'devToolsCheck',
      order: -11.71,
      questionSafe: ['dev-tools'],
      test(_lower, raw) {
        const names = parseToolCheck(raw);
        return names ? plan(step('dev.tools', names.length ? { names: names.join(',') } : {}), 'dev-tools') : null;
      },
    },
    {
      // "what did the terminal print", "is the terminal still running", "list my terminals".
      name: 'terminalRead',
      order: -11.705,
      questionSafe: ['terminal-read', 'terminal-list'],
      test(lower) {
        const t = lower.trim().replace(/[?.!]+$/, '');
        if (/^(?:list|show)\s+(?:me\s+)?(?:my\s+|the\s+|all\s+)*terminals$/.test(t)) return plan(step('terminal.list', {}), 'terminal-list');
        if (
          /^(?:what|show\s+me\s+what)\s+did\s+(?:the|that|my)\s+terminal\s+(?:print|say|show|output)$/.test(t) ||
          /^(?:read|show)\s+(?:me\s+)?(?:the\s+|that\s+|my\s+)?(?:last\s+)?terminal(?:\s+(?:output|log))?$/.test(t) ||
          /^is\s+(?:the|that|my)\s+terminal\s+(?:still\s+running|done|finished|ready)$/.test(t)
        ) {
          return plan(step('terminal.read', {}), 'terminal-read');
        }
        return null;
      },
    },
  ];
}
