/**
 * "Build me a clicker game" — the request that used to end in "I didn't catch that".
 *
 * Atlas is meant to be fully useful with no model, and building a small app is exactly the kind
 * of request people make first. This rule recognises a build verb plus a thing Atlas has a
 * ready-made version of (`../templates`), and turns it into a plan made of skills that already
 * exist, each through its own gate:
 *
 *   app.scaffold → dependency.installAll (desktop projects) → project.play
 *
 * What it does NOT do is guess. A request for something Atlas has no template for ("a snake
 * game") is not claimed here, so it goes on to the model if there is one, and otherwise gets an
 * honest answer that names what Atlas can build on its own (`Engine.unresolvedReply`).
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';
import { chooseTemplate } from '../templates';

const PATH = String.raw`[a-z]:[\\/]`;

const BUILD_VERB =
  String.raw`(?:build|make|create|write|code|develop|generate|design|set\s+up|put\s+together|whip\s+up)`;

/** Things Atlas has a better route for than a template, or cannot template at all. */
const ELSEWHERE =
  /\b(?:react|vue|svelte|vite|next\.?js|angular|python|rust|tauri|c\+\+|c#|java|unity|unreal|godot|roblox|minecraft|discord|bot|api|server|database|extension|plugin|mod|script|shortcut|routine|setup|reminder|alarm|timer|note|folder|file|backup)\b/i;

/** Words that carry no information about WHAT is being built. */
const FILLER = new Set(
  (
    'a an the my me some please simple basic small little new nice cool clean good great high quality ' +
    'modern fancy beautiful pretty full complete working real proper decent polished professional ' +
    'desktop windows native standalone app application program software tool starter blank empty ' +
    'minimal electron one of for i can you could would to that with and it'
  ).split(' '),
);

/**
 * A request that only says "app" — no game, no subject — is a request for the blank starter.
 * "A todo app" says what it is, so it is not claimed: a blank window would be the wrong answer.
 */
function isGenericApp(subject: string): boolean {
  const words = subject
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;
  if (!words.some((w) => w === 'app' || w === 'application' || w === 'program')) return false;
  return words.every((w) => FILLER.has(w));
}

/** The subject of the request: everything before the first clause break or the folder. */
function subjectOf(rest: string): string {
  return rest
    .split(/[,;]|\s+(?:that|which|where|with|it\s+(?:must|should|can|has)|so\s+that)\b/i)[0]!
    .trim();
}

/** What is being built, as an app-like thing — so "make a folder called Games" is never a project. */
const BUILDABLE =
  /\b(?:game|app|apps|application|program|software|web\s?site|web\s?page|site|tool|bot|script|api|server|extension|plugin|calculator|tracker|dashboard|launcher|widget|library|cli|clicker)\b/i;

/** Frameworks `project.scaffold` (creator-grammar) already builds on its own, from a template. */
const HAS_SCAFFOLDER = /\b(?:react|vue|svelte|vite)\b/i;

/**
 * A build request Atlas has no ready-made project for, but that names a folder: with a model it is
 * the developer agent's job (`devagent.run`: it reads, writes, builds and tests step by step, and
 * every step goes through the same gates). Without a model that skill says so plainly. A request
 * with no folder is not claimed here, so the planner or the honest fallback gets it instead.
 */
export function parseAgentBuildRequest(raw: string): { goal: string; path: string } | null {
  const m = new RegExp(
    String.raw`^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:i\s+(?:want|need)\s+(?:you\s+to\s+)?)?` +
      BUILD_VERB +
      String.raw`\s+(?:me\s+)?(?!(?:a\s+)?new\s+project\b)(.+?)\s*$`,
    'i',
  ).exec(raw);
  if (!m) return null;
  const rest = m[1]!;
  const where = new RegExp(
    String.raw`\s+(?:in|at|into|inside|under|to)\s+(?:the\s+(?:folder\s+)?)?("?${PATH}[^"]*?"?)(?=\s*(?:[,.;!](?:\s|$)|\s+(?:and|then|with)\s|$))`,
    'i',
  ).exec(rest);
  if (!where) return null;
  const path = where[1]!.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  const subject = (rest.slice(0, where.index) + rest.slice(where.index + where[0].length)).trim();
  if (!BUILDABLE.test(subject) || HAS_SCAFFOLDER.test(subject)) return null;
  return { goal: raw.trim().replace(/[.!]+$/, ''), path };
}

export function parseBuildRequest(
  raw: string,
): { template: string; path?: string; name?: string } | null {
  const m = new RegExp(
    String.raw`^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:i\s+(?:want|need)\s+(?:you\s+to\s+)?)?` +
      BUILD_VERB +
      String.raw`\s+(?:me\s+)?(?!(?:a\s+)?new\s+project\b)(.+?)\s*[.!]*$`,
    'i',
  ).exec(raw);
  if (!m) return null;
  let rest = m[1]!.trim();

  // A folder, if one was named: "... in D:\Dev\Clicker" / "... called Clicker in D:\Dev".
  let path: string | undefined;
  const where = new RegExp(
    String.raw`\s+(?:in|at|into|inside|under|to)\s+(?:the\s+(?:folder\s+)?)?("?${PATH}[^"]*?"?)(?=\s*(?:[,.;!](?:\s|$)|\s+(?:and|then|with)\s|$))`,
    'i',
  ).exec(rest);
  if (where) {
    path = where[1]!.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
    rest = (rest.slice(0, where.index) + rest.slice(where.index + where[0].length)).trim();
  }

  if (ELSEWHERE.test(rest)) return null;

  let name: string | undefined;
  const named = /\b(?:called|named)\s+["“]?([A-Za-z0-9][A-Za-z0-9 _'-]{0,40}?)["”]?(?=\s*(?:[,.;!]|\s+(?:in|at|with|and|that)\b|$))/i.exec(
    rest,
  );
  if (named) name = named[1]!.trim();

  const subject = subjectOf(rest);
  let template = chooseTemplate(subject)?.id;
  // The generic starter only for a request that says nothing else.
  if (template === 'desktop' && !isGenericApp(subject) && !/\b(?:desktop|windows)\s+app/i.test(subject)) {
    template = undefined;
  }
  // "game" without a kind Atlas knows is not a clicker, and not a blank app either.
  if (template === 'desktop' && /\bgame\b/i.test(subject)) template = undefined;
  if (!template) return null;
  return { template, path, name };
}

/** "run powershell: Get-Date", "in powershell, run Get-Date", "ps> Get-Date", "run Get-Date in powershell". */
export function parsePowerShellRequest(raw: string): string | null {
  const fenced = (s: string) =>
    s
      .trim()
      .replace(/^```(?:powershell|ps1|pwsh)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  const forms = [
    /^\s*(?:please\s+)?(?:run|execute|do)\s+(?:this\s+|the\s+following\s+)?(?:in\s+|with\s+|using\s+)?(?:windows\s+)?powershell\s*(?:script|command)?\s*[:,-]?\s*([\s\S]+?)\s*$/i,
    /^\s*(?:in|using|with)\s+(?:windows\s+)?powershell\s*[:,-]?\s*(?:run\s+|do\s+)?([\s\S]+?)\s*$/i,
    /^\s*(?:ps|pwsh|powershell)\s*[:>]\s*([\s\S]+?)\s*$/i,
    /^\s*(?:run|execute)\s+([\s\S]+?)\s+(?:in|with|using)\s+(?:windows\s+)?powershell\s*[.!]*$/i,
  ];
  for (const form of forms) {
    const m = form.exec(raw);
    if (m?.[1]) {
      const script = fenced(m[1]);
      if (script) return script;
    }
  }
  return null;
}

export function createAppGrammar(): GrammarRule[] {
  return [
    {
      // The last resort, asked for by name. The script is shown in full and approved every time.
      name: 'powershellRun',
      order: -11.7,
      pathSafe: true,
      test(_lower, raw) {
        const script = parsePowerShellRequest(raw);
        return script ? plan(step('powershell.run', { script }), 'powershell-run') : null;
      },
    },
    {
      name: 'buildApp',
      order: -11.6,
      pathSafe: true,
      test(_lower, raw) {
        const request = parseBuildRequest(raw);
        if (!request) {
          const agent = parseAgentBuildRequest(raw);
          return agent ? plan(step('devagent.run', { goal: agent.goal, path: agent.path }), 'build-agent') : null;
        }
        const args: Record<string, string> = { template: request.template };
        if (request.path) args.path = request.path;
        if (request.name) args.name = request.name;
        const steps = [step('app.scaffold', args)];
        // Electron is what makes a desktop project a window instead of a web page.
        if (request.template !== 'website') steps.push(step('dependency.installAll', {}));
        steps.push(step('project.play', {}));
        return plan(steps, 'build-app');
      },
    },
  ];
}
