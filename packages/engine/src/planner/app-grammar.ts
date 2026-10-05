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
import { COLOR_HUES } from '../skills/recolor-plan';

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

/* ── Recolouring and editing a project ───────────────────────────────────────────────────── */

const COLOR_WORDS = Object.keys(COLOR_HUES).join('|');

/**
 * What the request is changing. "The whole app", "the look", "the theme" — all of it. Deliberately
 * NOT "the background", "the button" or "the title": a change to one part of a project is an edit
 * that needs code written, not a recolour of the lot, and must never be claimed as one.
 */
const WHOLE_LOOK = String.raw`(?:app|apps|application|site|website|web\s?site|web\s?page|page|game|project|program|software|ui|gui|interface|design|look|looks|theme|style|styling|colou?rs?|colou?r\s+(?:scheme|palette)|palette|scheme|appearance|everything|whole\s+thing|it)`;

/** A part of a project: its presence means "this is an edit", not a recolour of everything. */
const ONE_PART =
  /\b(?:background|backgrounds|button|buttons|text|font|fonts|heading|headings|header|title|titles|menu|menus|icon|icons|logo|border|borders|sidebar|panel|card|cards|link|links|image|images|chart|bar|bars|score|counter|chip|chips|badge|badges|banner|footer|nav|navbar|tab|tabs)\b/i;

/** The folder a request names: "D:\Dev\Game", quoted or bare, ending at a sentence break. */
function pathIn(raw: string): { path: string; rest: string } | null {
  // Quoted, a path may hold spaces. Bare, it ends at the first space — "D:\Dev\Game to blue" must
  // not swallow "to blue" — and at a sentence-ending full stop.
  const m = new RegExp(String.raw`("${PATH}[^"]+"|${PATH}[^\s"]*[^\s".,;:!?])`, 'i').exec(raw);
  if (!m) return null;
  const path = m[1]!.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  return { path, rest: (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
}

/**
 * "Switch the whole app look to red", "make the app blue", "recolour D:\Dev\Game green", "change my
 * project's theme to purple". Returns the colour as the person said it and the folder if one was
 * named (otherwise the current project fills in). Anything that targets one PART of the project,
 * or asks for a build ("make me a red app"), is not a recolour and returns null.
 */
export function parseRecolorRequest(raw: string): { color: string; path?: string } | null {
  if (/\?\s*$/.test(raw)) return null;
  // A question without its question mark ("what colour is the sky").
  if (/^\s*(?:what|which|who|whom|why|how|when|where|is|are|was|were|do|does|did|can|could|should|would|will)\b/i.test(raw)) return null;
  const named = pathIn(raw);
  const text = (named?.rest ?? raw).replace(/[.!]+\s*$/, '').trim();
  const lower = text.toLowerCase();

  // A build, not a recolour: "make me a red clicker game", "build a blue app".
  if (/\b(?:make|build|create|write|design|generate)\s+(?:me\s+)?(?:an?|some)\s+/.test(lower)) return null;
  if (ONE_PART.test(lower)) return null;

  const color = new RegExp(String.raw`\b(?:(?:dark|light|bright|deep|pale|soft|neon|hot)\s+)?(${COLOR_WORDS})\b`, 'gi');
  const colours = [...lower.matchAll(color)];
  if (!colours.length) return null;

  const verb = /\b(?:re-?colou?r|re-?theme|re-?paint|re-?style|paint|colou?r|tint|switch|change|turn|make|set|swap|update|convert|shift|flip|go)\b/.test(lower);
  if (!verb) return null;
  if (!new RegExp(String.raw`\b${WHOLE_LOOK}\b`, 'i').test(lower) && !/\bre-?colou?r|re-?theme|re-?paint\b/.test(lower)) return null;

  // "to red", "into blue", "in green": the colour after a preposition is the target; failing that,
  // the last colour mentioned ("make the app red").
  const to = new RegExp(String.raw`\b(?:to|into|in|as)\s+(?:an?\s+)?(?:(?:dark|light|bright|deep|pale|soft|neon|hot)\s+)?(${COLOR_WORDS})\b`, 'i').exec(lower);
  const chosen = to?.[1] ?? colours[colours.length - 1]![1]!;
  return { color: chosen, ...(named ? { path: named.path } : {}) };
}

/** "undo the recolor", "put the old colours back", "revert the colour change". */
export function parseRecolorUndo(raw: string): { path?: string } | null {
  const named = pathIn(raw);
  const lower = (named?.rest ?? raw).toLowerCase().replace(/[.!]+\s*$/, '').trim();
  const undo =
    /^(?:please\s+)?(?:undo|revert|reverse|roll\s*back)\s+(?:the\s+|that\s+|my\s+)?(?:last\s+)?re-?colou?r(?:ing|ed)?(?:\s+(?:change|job|thing))?$/.test(lower) ||
    /^(?:please\s+)?(?:undo|revert)\s+(?:the\s+|that\s+)?(?:colou?r|theme|look)\s+change$/.test(lower) ||
    /^(?:please\s+)?(?:put|set|change)\s+(?:the\s+)?(?:old|original|previous)\s+colou?rs?\s+back$/.test(lower) ||
    /^(?:please\s+)?(?:restore|bring\s+back)\s+(?:the\s+)?(?:old|original|previous)\s+(?:colou?rs?|look|theme)$/.test(lower);
  return undo ? { ...(named ? { path: named.path } : {}) } : null;
}

/** Words that name the thing being searched: "in my project", "across the codebase". */
const PROJECT_SCOPE = String.raw`(?:the\s+|my\s+|this\s+|our\s+)?(?:whole\s+|entire\s+)?(?:project|codebase|code\s?base|repo|repository|source(?:\s+code)?|code|app|game|site|website|folder)`;

/**
 * `replace "old" with "new" in D:\Dev\App` / `… across my project`. QUOTED text only, and only with a
 * project named as the place: `replace "a" with "b" in hello world` is the plain text tool's, and
 * this rule must never reach for it. Returns the exact strings, and the folder if one was named.
 */
export function parseReplaceAllRequest(raw: string): { find: string; replace: string; path?: string } | null {
  const named = pathIn(raw);
  const text = (named?.rest ?? raw).trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const m = /^\s*(?:please\s+)?(?:replace|change|swap|rename)\s+(?:all\s+|every\s+)?(?:(?:occurrences?|instances?|uses?)\s+of\s+)?(["'`])(.+?)\1\s+(?:with|to|into|by)\s+(["'`])(.*?)\3\s*(.*)$/i.exec(text);
  if (!m) return null;
  const tail = m[5]!.trim().replace(/[.!]+$/, '');
  // The scope must be a project: a folder was named, or the tail says "in/across … the project".
  const scoped = named !== null || new RegExp(String.raw`^(?:in|across|throughout|inside|within|for)\s+${PROJECT_SCOPE}$`, 'i').test(tail);
  if (!scoped) return null;
  // Anything else in the tail ("… in hello world") means it is not what we think it is.
  if (named !== null && tail && !new RegExp(String.raw`^(?:in|across|throughout|inside|within|for|at)(?:\s+${PROJECT_SCOPE})?$`, 'i').test(tail)) return null;
  return { find: m[2]!, replace: m[4]!, ...(named ? { path: named.path } : {}) };
}

export function parseReplaceUndo(raw: string): { path?: string } | null {
  const named = pathIn(raw);
  const lower = (named?.rest ?? raw).toLowerCase().replace(/[.!]+\s*$/, '').trim();
  return /^(?:please\s+)?(?:undo|revert|reverse|roll\s*back)\s+(?:the\s+|that\s+|my\s+)?(?:last\s+)?(?:find\s*(?:and|&)\s*replace|replace(?:ment)?(?:\s+all)?|rename)(?:\s+(?:change|job))?$/.test(lower)
    ? { ...(named ? { path: named.path } : {}) }
    : null;
}

/** "how many lines of code in D:\Dev\Game", "project stats", "count the lines in my project". */
export function parseProjectStats(raw: string): { path?: string } | null {
  const named = pathIn(raw);
  const lower = (named?.rest ?? raw).toLowerCase().replace(/[?.!]+\s*$/, '').trim();
  const hit =
    /\b(?:project|code(?:\s?base)?|repo)\s+(?:stats|statistics|size|summary|metrics)\b/.test(lower) ||
    /\b(?:stats|statistics)\s+(?:for|of|on)\s+(?:my\s+|the\s+|this\s+)?(?:project|code|codebase|repo)\b/.test(lower) ||
    /\bhow\s+many\s+(?:lines|files)\b.*\b(?:code|project|codebase|repo|app|game|site|folder|in)\b/.test(lower) ||
    /\bhow\s+(?:big|large)\s+(?:is|are)\s+(?:my\s+|the\s+|this\s+)?(?:project|codebase|repo|code)\b/.test(lower) ||
    /\b(?:count|total)\s+(?:up\s+)?(?:the\s+)?(?:lines|loc)(?:\s+of\s+code)?\b/.test(lower) ||
    /\blines\s+of\s+code\b/.test(lower);
  if (!hit) return null;
  // A different question that merely mentions lines ("how many lines does the poem have").
  if (named === null && !/\b(?:code|project|codebase|repo|app|game|site|stats|loc)\b/.test(lower)) return null;
  return named ? { path: named.path } : {};
}

/** "find the todos in D:\Dev\Game", "list the todo comments in my project", "show me the fixmes". */
export function parseTodoRequest(raw: string): { path?: string } | null {
  const named = pathIn(raw);
  const lower = (named?.rest ?? raw).toLowerCase().replace(/[?.!]+\s*$/, '').trim();
  const mentions = /\b(?:to-?dos?|fix-?mes?)\b/.test(lower);
  if (!mentions) return null;
  // "what's on my todo list", "add to my to-do list": the personal to-do list is its own skill.
  if (/\b(?:my|the|a|our)\s+to-?do\s+(?:list|items?|app)\b|\bon\s+my\s+to-?do|\bto-?do\s+list\b/.test(lower)) return null;
  // `search the project for "TODO"` is a text search and has its own skill; so is anything quoted.
  if (/["'“”‘’`]/.test(raw)) return null;
  // It has to be about CODE: a project is named, or the sentence says so ("in my code", "fixme comments").
  const aboutCode =
    named !== null ||
    /\b(?:project|code(?:\s?base)?|repo|repository|source|app|game|site|website|folder)\b/.test(lower) ||
    /\bfix-?mes?\b/.test(lower) ||
    /\bto-?dos?\s+(?:comments?|notes?|markers?)\b/.test(lower) ||
    /\bcomments?\b/.test(lower);
  if (!aboutCode) return null;
  const verb = /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:find|list|show|get|scan|search|check|look\s+for|what|are\s+there|any|do\s+i\s+have|display|give\s+me)\b/.test(lower);
  if (!verb) return null;
  // Adding or making a todo is the todo list skill's job, not a scan of a project.
  if (/\b(?:add|create|new|remind|set|mark|delete|remove|clear|finish|complete)\b/.test(lower)) return null;
  return named ? { path: named.path } : {};
}

/**
 * "Add a shop to D:\Dev\Game", "fix the bug in D:\Dev\Site", "redesign D:\Dev\Game": a change to a
 * project that is NOT a recolour. It needs code written, so with a model it is the developer
 * agent's job, and without one the answer says so plainly and says what Atlas can do alone —
 * instead of "I couldn't reach your language model, and that question needs one" and an offer to
 * search the web, which is what this used to get. Only claimed when a folder is NAMED: with none,
 * there is nothing to point the agent at.
 */
export function parseEditRequest(raw: string): { goal: string; path: string } | null {
  if (/\?\s*$/.test(raw)) return null;
  const named = pathIn(raw);
  if (!named) return null;
  const lower = raw.toLowerCase();
  const verb = /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:i(?:'d|\s+would)?\s+(?:want|need|like)\s+(?:you\s+)?to\s+)?(?:change|switch|update|edit|modify|restyle|redesign|rework|rewrite|improve|tweak|adjust|refactor|fix|add|remove|replace|rename|make|turn|convert|upgrade|polish|clean\s+up|extend|optimi[sz]e)\b/.test(lower);
  if (!verb) return null;
  // Not a request about files or folders as such: "move D:\a to D:\b", "copy…", handled elsewhere.
  if (NOT_A_PROJECT.test(named.rest)) return null;
  // A project is a folder: a path that ends in a file extension is a file, and has its own skills.
  if (/\.[a-z0-9]{1,5}$/i.test(named.path)) return null;
  return { goal: raw.trim().replace(/[.!]+$/, ''), path: named.path };
}

export function createAppGrammar(): GrammarRule[] {
  return [
    {
      // "replace "old" with "new" in D:\Dev\App": exact, previewed, backed up, undoable.
      name: 'replaceAllInProject',
      order: -11.79,
      pathSafe: true,
      test(_lower, raw) {
        const undo = parseReplaceUndo(raw);
        if (undo) return plan(step('code.replaceAllUndo', undo.path ? { path: undo.path } : {}), 'replace-undo');
        const request = parseReplaceAllRequest(raw);
        if (!request) return null;
        const args: Record<string, string> = { find: request.find, replace: request.replace };
        if (request.path) args.path = request.path;
        return plan(step('code.replaceAll', args), 'replace-all');
      },
    },
    {
      // "how many lines of code in my project": read-only, a question by shape.
      name: 'projectStats',
      order: -11.78,
      pathSafe: true,
      questionSafe: ['project-stats'],
      test(_lower, raw) {
        const request = parseProjectStats(raw);
        return request ? plan(step('project.stats', request.path ? { path: request.path } : {}), 'project-stats') : null;
      },
    },
    {
      // "find the todos in my project": read-only.
      name: 'projectTodos',
      order: -11.77,
      pathSafe: true,
      questionSafe: ['project-todos'],
      test(_lower, raw) {
        const request = parseTodoRequest(raw);
        return request ? plan(step('project.todos', request.path ? { path: request.path } : {}), 'project-todos') : null;
      },
    },
    {
      // "Switch the whole app look to red", "make the app blue": no model, preview + backup + undo.
      name: 'recolorProject',
      order: -11.8,
      pathSafe: true,
      test(_lower, raw) {
        const undo = parseRecolorUndo(raw);
        if (undo) return plan(step('project.recolorUndo', undo.path ? { path: undo.path } : {}), 'recolor-undo');
        const request = parseRecolorRequest(raw);
        if (!request) return null;
        const args: Record<string, string> = { color: request.color };
        if (request.path) args.path = request.path;
        return plan(step('project.recolor', args), 'recolor');
      },
    },
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
      // "Add a shop to D:\Dev\Game": a change that needs code written. LAST on purpose (a high
      // order): every more specific rule — allowed folders, git, files, the project skills — gets
      // first refusal, so this only ever sees what nothing else wanted.
      name: 'editProject',
      order: 90,
      pathSafe: true,
      test(_lower, raw) {
        const edit = parseEditRequest(raw);
        return edit ? plan(step('devagent.run', { goal: edit.goal, path: edit.path }), 'edit-project') : null;
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
