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
import { chooseTemplate, templateById } from '../templates';

const PATH = String.raw`[a-z]:[\\/]`;

const BUILD_VERB =
  String.raw`(?:build|make|create|write|code|develop|generate|design|set\s+up|put\s+together|whip\s+up)`;

/** How a request opens: "please", "can you", "I want to", "I would like you to", "I'd like to". */
const LEAD_IN =
  String.raw`^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:i(?:'d|\s+would)?\s+(?:want|need|like)\s+(?:you\s+)?to\s+)?`;

/**
 * Languages, frameworks and engines. A request that names one is not a request for a vanilla
 * template: `project.scaffold` builds React/Vue/Svelte by name, the developer agent does the rest,
 * and an engine plugin's own template (group 'engine') is the only template that may match.
 */
const OTHER_STACK =
  /\b(?:react|vue|svelte|vite|next\.?js|angular|python|rust|tauri|c\+\+|c#|java|unity|unreal|ue4|ue5|godot|roblox|minecraft|discord|flutter|swift|kotlin)\b/i;

/** Things that are not a project at all, whatever the verb. */
const NOT_A_PROJECT =
  /\b(?:shortcut|routine|setup|reminder|alarm|folder|file|backup|playlist|note|notes?\s+to|copy|zip)\b|\.(?:txt|md|docx?|pdf|png|jpe?g|gif|mp[34]|zip|json|csv|xlsx?|exe|lnk)\b/i;

/** Words that carry no information about WHAT is being built. */
const FILLER = new Set(
  (
    'a an the my me some please simple basic small little new nice cool clean good great high quality ' +
    'modern fancy beautiful pretty full complete working real proper decent polished professional ' +
    'desktop windows native standalone starter blank empty minimal electron one of for i can you ' +
    'could would to that with and it fun quick classic retro arcade 2d video computer pc offline ' +
    'playable little tiny custom'
  ).split(' '),
);

const GENERIC_NOUN = new Set(['game', 'games', 'app', 'apps', 'application', 'program', 'tool', 'utility', 'software']);

/**
 * "A game", "a simple app": a request that says what KIND of thing but not which one. It is
 * claimed so Atlas can ask which, with the real choices as buttons, instead of guessing.
 */
function isGenericRequest(subject: string): boolean {
  const words = subject
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.some((w) => GENERIC_NOUN.has(w))) return false;
  return words.every((w) => FILLER.has(w) || GENERIC_NOUN.has(w));
}

/**
 * Games past what hand-written code in a folder can reach: AAA, 3D, open worlds, shooters,
 * "like GTA". Deliberately about the game being big, not about a word like "3d" alone in a note.
 */
const BIG_GAME = new RegExp(
  String.raw`\b(?:aaa|triple[- ]?a|3d|open[- ]world|first[- ]person|third[- ]person|fps|mmo|mmorpg|battle royale|` +
    String.raw`console game|next[- ]?gen|photoreal\w*|ray[- ]?trac\w*|game engine|unreal|ue[45]|unity|godot|` +
    String.raw`(?:like|similar to|as good as)\s+(?:gta|grand theft auto|skyrim|elden ring|the witcher|fortnite|call of duty|cyberpunk|red dead|zelda|minecraft))\b`,
  'i',
);

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
    LEAD_IN +
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
  // A game that big is not a job for the developer agent either: it gets the honest answer about
  // engines (the needsEngine rule below), not a toy built to look like it.
  if (BIG_GAME.test(subject)) return null;
  return { goal: raw.trim().replace(/[.!]+$/, ''), path };
}

export function parseBuildRequest(
  raw: string,
): { template?: string; path?: string; name?: string } | null {
  const m = new RegExp(
    LEAD_IN +
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

  let name: string | undefined;
  const named = /\b(?:called|named)\s+["“]?([A-Za-z0-9][A-Za-z0-9 _'-]{0,40}?)["”]?(?=\s*(?:[,.;!]|\s+(?:in|at|with|and|that)\b|$))/i.exec(
    rest,
  );
  if (named) name = named[1]!.trim();

  const subject = subjectOf(rest);
  if (NOT_A_PROJECT.test(subject)) return null;

  const found = chooseTemplate(subject);
  if (found) {
    // A template for plain web/desktop code is not the answer to "a React todo app": an engine
    // plugin's own template is the one kind that may share a request with a stack name.
    if (found.group !== 'engine' && OTHER_STACK.test(subject)) return null;
    return { template: found.id, path, name };
  }
  if (!OTHER_STACK.test(subject) && isGenericRequest(subject)) return { path, name };
  return null;
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
        const args: Record<string, string> = {};
        if (request.template) args.template = request.template;
        if (request.path) args.path = request.path;
        if (request.name) args.name = request.name;
        const steps = [step('app.scaffold', args)];
        // Electron is what makes a desktop project a window instead of a web page. When the kind is
        // not known yet (Atlas is about to ask) the install is left for the person to ask for: the
        // project opens in the browser until then, and the closing message says so.
        const chosen = request.template ? templateById(request.template) : undefined;
        if (chosen?.desktop) steps.push(step('dependency.installAll', {}));
        // A game engine project is NOT opened for you: the editor is a heavy program (shader
        // compiles, the GPU), so starting it stays the person's choice. "play it" opens it later.
        if (chosen?.group !== 'engine') steps.push(step('project.play', {}));
        return plan(steps, 'build-app');
      },
    },
    {
      // "What game engines do I have", "is unreal installed".
      name: 'engineList',
      order: -11.65,
      questionSafe: ['engine-list'],
      test(lower) {
        const t = lower.trim().replace(/[?.!]+$/, '');
        return /^(?:what|which|list|show)\s+(?:me\s+)?(?:(?:the|all|my)\s+)?(?:game\s+)?engines?(?:\s+(?:do\s+i\s+have|are\s+installed|i\s+have|installed))?$/.test(t) ||
          /^(?:do\s+i\s+have|is)\s+(?:unreal|unity|godot)(?:\s+engine)?\s+(?:installed|here|on\s+(?:this|my)\s+(?:pc|computer))$/.test(t) ||
          /^(?:what|which)\s+game\s+engines\b/.test(t)
          ? plan(step('engine.list', {}), 'engine-list')
          : null;
      },
    },
    {
      name: 'pluginCommands',
      order: -11.64,
      questionSafe: ['plugin-list'],
      test(lower) {
        const t = lower.trim().replace(/[?.!]+$/, '');
        if (/^(?:what|which|list|show)\s+(?:me\s+)?(?:(?:the|all|my)\s+)?plugins?(?:\s+(?:do\s+i\s+have|are\s+installed|i\s+have|installed))?$/.test(t)) {
          return plan(step('plugin.list', {}), 'plugin-list');
        }
        if (/^(?:reload|refresh|rescan)\s+(?:my\s+|the\s+)?plugins?$/.test(t)) return plan(step('plugin.reload', {}), 'plugin-reload');
        if (/^open\s+(?:my\s+|the\s+)?plugins?(?:\s+folder)?$/.test(t)) return plan(step('plugin.openFolder', {}), 'plugin-folder');
        return null;
      },
    },
    {
      // "Make me an AAA open-world game": past what hand-written code can do. Say so, honestly,
      // instead of building a toy or failing. A request a template or an engine template can
      // already satisfy is left to the build rule above.
      name: 'needsEngine',
      order: -11.55,
      pathSafe: true,
      test(_lower, raw) {
        if (!new RegExp(LEAD_IN + BUILD_VERB + String.raw`\b`, 'i').test(raw)) return null;
        if (parseBuildRequest(raw)) return null;
        if (!BIG_GAME.test(raw)) return null;
        return plan(step('engine.advise', { request: raw.trim() }), 'engine-advise');
      },
    },
  ];
}
