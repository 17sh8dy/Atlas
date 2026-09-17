/**
 * The skills Atlas ships with.
 *
 * Every one reaches the machine through the `Platform` port and declares the
 * capabilities it needs, so this exact pack works unchanged on the Tauri
 * desktop build (where most capabilities exist), in a browser tab (where
 * almost none do, and the impossible ones are simply invisible), and against a
 * test platform.
 *
 * ── What needs asking about, and what doesn't ───────────────────────────────
 * `risk: 'confirm'` used to mean "touches the world outside Atlas", which put
 * a card in front of *opening* things. That bar was set on the reasoning that
 * one extra click is trivial next to an assistant that opens things you didn't
 * ask for — and it was wrong twice over. When you did ask, the extra click is
 * not trivial: it is the entire interaction, asked again. And once you are
 * talking rather than typing, a card is not one click, it is a trip back to
 * the keyboard, which is the exact thing being talked to was supposed to
 * remove.
 *
 * The line is now what the action *does*, not how far it reaches. Opening,
 * showing and searching change nothing that closing a window does not undo, so
 * they run. Writing, renaming, moving, deleting, clearing and powering the
 * machine off do not undo, so they still ask.
 *
 * Note what this does not weaken: `safety/content-policy.ts` screens every
 * outward-reaching destination at `SkillRegistry.invoke`, which is below this
 * and unaffected by risk. A search Atlas should refuse is still refused; it is
 * only the "are you sure" in front of the ones it should allow that has gone.
 */

import type { AppEntry, FileEntry, KnownFolder, Memory, Platform, ResultRow, Skill } from '@atlas/core';
import { createPhrasing, type Phrasing } from '../phrasing';
import { rankMatches, nearMatches, RANK } from '../text/fuzzy';
import { resolveSite, exactSiteName } from '../text/sites';
import { attemptGoal } from '../planner/attempts';
import { evaluateExpression } from './math';
import { convertUnit } from './units';
import type { SkillRegistry } from './registry';

/**
 * Colloquial names for `app.open`, tried only after the exact/prefix/contains
 * chain against real Start Menu entries has already failed. "vscode" isn't a
 * substring of "Visual Studio Code," so without this, a completely ordinary
 * way of saying the name would fail to resolve.
 */
const APP_ALIASES: Record<string, string> = {
  vscode: 'visual studio',
  'vs code': 'visual studio',
  epic: 'epic games',
};

/**
 * Browsers in the order Atlas reaches for them when asked for "a browser" and
 * not a particular one — what someone who says "any browser" most likely wants
 * in front of them, rather than alphabetical.
 */
const BROWSER_NAMES = [
  'brave',
  'chrome',
  'firefox',
  'edge',
  'opera',
  'vivaldi',
  'arc',
  'zen',
  'chromium',
];

const SYSTEM_TOOL_NAMES: Record<string, string> = {
  'task-manager': 'Task Manager',
  'device-manager': 'Device Manager',
  'windows-settings': 'Windows Settings',
  'control-panel': 'Control Panel',
  'file-explorer': 'File Explorer',
  'this-pc': 'This PC',
  'recycle-bin': 'the Recycle Bin',
};

/**
 * The name to match on, and what it matched.
 *
 * ── Why the verb has to be peeled off *here* ────────────────────────────────
 * "open open steam" reaches the grammar as a perfectly ordinary sentence: the
 * first "open" is the verb, and everything after it is the name. So the name
 * becomes "open steam", nothing is installed under it, and Atlas reports that
 * honestly and uselessly. Voice makes this common — a stutter, a false start,
 * or the transcriber hearing the wake of a previous word.
 *
 * The obvious fix is to let the grammar swallow repeated verbs. It cannot:
 * "open Open Cut" is the same shape and the second "open" is the first word of
 * the application's name. Only the layer holding the list of installed
 * applications can tell those apart, which is this one.
 *
 * So the name is tried as given, and a leading verb is peeled off only when
 * that found nothing. Installed applications win, exactly as they win over
 * site names — "Open Cut" matches on the first attempt and never reaches the
 * retry.
 */
function resolveAppName(apps: AppEntry[], name: string) {
  const matches = matchApps(apps, name);
  if (matches.length) return { wanted: name, matches };

  const stripped = name.replace(/^\s*(?:open|launch|start|run)\s+/i, '').trim();
  if (stripped && stripped !== name) {
    const retry = matchApps(apps, stripped);
    if (retry.length) return { wanted: stripped, matches: retry };
  }

  // Nothing either way. The *original* is what gets reported, because that is
  // what was asked for and "I couldn't find open steam" is at least a true
  // account of what Atlas heard.
  return { wanted: name, matches };
}

/**
 * The most things one sentence may open.
 *
 * A cap rather than a limit of the parser: "open everything" should not be a
 * way to launch forty programs, and three is about as many as anyone means
 * when they list things out loud.
 */
const MAX_TARGETS = 3;

/** "OBS, Epic Games and Discord" — an Oxford-comma-free list a person would say. */
function readableList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * "OBS and Epic Games" → ["OBS", "Epic Games"].
 *
 * ⚠️ Only ever called *after* the whole string has failed to match an
 * installed application, and that ordering is the entire safety of it.
 * "Command and Conquer" is a real program; so are "Brawl Stars and Friends"
 * and anything else with a conjunction in its name. Splitting first would
 * break every one of them. Splitting only once the whole name has been ruled
 * out means a real application always wins over a guess about grammar —
 * exactly how a stuttered verb and a site name are already handled.
 */
function splitTargets(name: string): string[] {
  // The word boundaries are load-bearing: without them "and" matches inside
  // "Command" and "Command Center" splits into "Comm" and "Center".
  return name
    .split(/\s*(?:,|&|\band\b|\bthen\b|\bplus\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Resolve several named applications, or decline entirely.
 *
 * All or nothing on purpose. Opening two of the three things someone asked
 * for is worse than opening none: they have to work out which one is missing,
 * and they are now looking at windows they did not get to choose. If any part
 * is unrecognised the whole thing falls through to the ordinary "did you
 * mean…" path for the original phrase.
 *
 * Resolution only — launching belongs to the skill, which is the thing that
 * holds the platform and can report what happened.
 */
function resolveSeveral(apps: AppEntry[], name: string): AppEntry[] | null {
  const parts = splitTargets(name);
  if (parts.length < 2 || parts.length > MAX_TARGETS) return null;

  const resolved: AppEntry[] = [];
  for (const part of parts) {
    const { matches } = resolveAppName(apps, part);
    const best = matches[0];
    // Each one has to be unambiguous. A typo-tolerant guess is fine when a
    // person can see it and say no; three of them at once is not.
    if (!best || (best.rank >= 4 && matches.length > 1)) return null;
    // The same program named twice is one launch, not two.
    if (!resolved.some((a) => a.id === best.app.id)) resolved.push(best.app);
  }

  // At least one *survivor*, not at least two: the "did you name several
  // things" question was already answered by `parts.length` above, and
  // "open steam and steam" should open Steam once rather than fail.
  return resolved.length ? resolved : null;
}

export function createCoreSkills(
  platform: Platform,
  memory: Memory,
  registry: SkillRegistry,
  phrasing: Phrasing = createPhrasing(),
): Skill[] {
  const skills: Skill[] = [];

  // ---- help --------------------------------------------------------------------
  // Reads the registry live, at run time — by which point `registerMany`
  // below has long since finished — rather than a written list that could
  // silently drift from the actual catalog.

  skills.push({
    id: 'engine.help',
    label: 'What can you do',
    icon: '✨',
    domain: 'core',
    description: 'List everything Atlas can currently do, grouped by domain.',
    risk: 'safe',
    examples: ['what can you do?', 'help'],
    run(_args, ctx) {
      const byDomain = registry.byDomain();
      const total = registry.available().length;
      const rows: ResultRow[] = [];
      // Each row carries its domain. That one field is the whole difference
      // between a hundred-line inventory and something a person can read:
      // the surface groups on it, and decides for itself whether that means
      // headings, collapsible sections or nothing at all. What the domains
      // are *called* is not decided here — "files" is a fact about the
      // registry, "Files" with an icon and a summary is presentation.
      for (const [domain, list] of byDomain) {
        for (const s of list) {
          rows.push({
            title: s.label,
            subtitle: s.description,
            icon: s.icon ?? '✨',
            group: domain,
          });
        }
      }
      ctx.showResults?.(rows, { title: 'What I can do', subtitle: `${total} actions` });
      return { ok: true, spoken: true, message: '' };
    },
  });

  // ---- memory ----------------------------------------------------------------

  skills.push({
    id: 'memory.remember',
    label: 'Remember an alias',
    icon: '🧠',
    domain: 'memory',
    description: 'Remember what a name refers to, so it can be used later (e.g. "my work folder").',
    risk: 'safe',
    examples: ['remember my work folder is D:\\Dev'],
    params: {
      subject: { type: 'string', required: true, description: 'the name being defined' },
      value: { type: 'string', required: true, description: 'what it refers to' },
    },
    async run(args) {
      const subject = String(args.subject);
      const value = String(args.value);
      await memory.remember('alias', subject, value);
      return { ok: true, message: `Got it — "${subject}" is ${value}.` };
    },
  });

  skills.push({
    id: 'memory.list',
    label: 'What you remember',
    icon: '🧠',
    domain: 'memory',
    description: 'Show everything Atlas has been told to remember.',
    risk: 'safe',
    examples: ['what do you remember', 'list what you remember'],
    params: {},
    async run(_args, ctx) {
      const facts = await memory.facts();
      if (!facts.length) {
        return { ok: true, message: "I haven't been told anything to remember yet." };
      }
      ctx.showResults?.(
        facts.map((f) => ({
          title: f.subject,
          subtitle: String(f.value),
          icon: '🧠',
          payload: f,
          actions: [{ label: 'Forget', skill: 'memory.forget', args: { subject: f.subject } }],
        })),
        { title: 'What I remember', subtitle: `${facts.length} remembered` },
      );
      return { ok: true, spoken: true, message: '' };
    },
  });

  skills.push({
    id: 'memory.forget',
    label: 'Forget an alias',
    icon: '🗑️',
    domain: 'memory',
    description: 'Forget something Atlas was told to remember.',
    risk: 'safe',
    examples: ['forget my work folder'],
    params: { subject: { type: 'string', required: true, description: 'the name to forget' } },
    async run(args) {
      const subject = String(args.subject).trim();
      const existing = await memory.fact('alias', subject);
      if (!existing) {
        return { ok: false, error: `I don't have anything remembered for "${subject}".` };
      }
      await memory.forget('alias', subject);
      return { ok: true, message: `Forgotten — I no longer know what "${subject}" is.` };
    },
  });

  // ---- math & time -----------------------------------------------------------
  // No `needs` — these touch nothing outside the process, so they're always
  // available: on the web build, in tests, everywhere.

  skills.push({
    id: 'math.calculate',
    label: 'Calculate',
    icon: '🧮',
    domain: 'math',
    description: 'Evaluate an arithmetic expression.',
    risk: 'safe',
    examples: ["what's 12 * 7", 'calculate 200 / 8 + 1'],
    params: {
      expression: { type: 'string', required: true, description: 'the arithmetic expression' },
    },
    run(args) {
      const expression = String(args.expression);
      const result = evaluateExpression(expression);
      if (result === null) return { ok: false, error: `I couldn't work out "${expression}".` };
      // Restates the expression rather than just the answer — "84." means
      // nothing on its own a minute later, in the transcript or in Recent
      // Activity; "12 * 7 = 84." does.
      return { ok: true, message: `🧮 ${expression} = ${result}.`, data: result };
    },
  });

  skills.push({
    id: 'math.convert',
    label: 'Convert units',
    icon: '📐',
    domain: 'math',
    description: 'Convert a value from one unit to another (length, weight, volume, temperature).',
    risk: 'safe',
    examples: ['convert 10 miles to km', 'how many km in 10 miles'],
    params: {
      value: { type: 'number', required: true, description: 'the quantity to convert' },
      from: { type: 'string', required: true, description: 'the unit it is in' },
      to: { type: 'string', required: true, description: 'the unit to convert to' },
    },
    run(args) {
      const value = Number(args.value);
      const from = String(args.from);
      const to = String(args.to);
      const result = convertUnit(value, from, to);
      if (result === null)
        return { ok: false, error: `I can't convert between "${from}" and "${to}".` };
      const rounded = Math.round(result * 1000) / 1000;
      return { ok: true, message: `📐 ${value} ${from} is ${rounded} ${to}.`, data: rounded };
    },
  });

  skills.push({
    id: 'time.now',
    label: 'Time and date',
    icon: '🕒',
    domain: 'time',
    description: 'Report the current time and date.',
    risk: 'safe',
    examples: ['what time is it', "what's the date"],
    params: {},
    run() {
      const now = new Date();
      const message = `🕒 ${now.toLocaleTimeString()} — ${now.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })}.`;
      return { ok: true, message, data: now.toISOString() };
    },
  });

  skills.push({
    id: 'time.timer',
    label: 'Set a timer',
    icon: '⏳',
    domain: 'time',
    description:
      'Set a timer and get a notification when it finishes, for as long as Atlas is running.',
    needs: ['notifications'],
    risk: 'safe',
    examples: ['set a timer for 10 minutes', 'remind me in 5 minutes to stretch'],
    params: {
      seconds: { type: 'number', required: true, description: 'how long, in seconds' },
      label: { type: 'string', required: false, description: 'what the timer is for' },
    },
    run(args) {
      const seconds = Math.round(Number(args.seconds));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, error: 'Tell me how long the timer should run for.' };
      }
      if (seconds > 24 * 60 * 60) {
        return { ok: false, error: "The longest timer I'll hold is 24 hours." };
      }
      const label = args.label ? String(args.label).trim() : '';

      // A plain timeout, deliberately: it lives exactly as long as Atlas does,
      // which is what the description promises. A timer that outlived the app
      // would need a scheduler, a store and a story about missed alarms —
      // real work, and not what "set a timer for ten minutes" is asking for.
      setTimeout(() => {
        void platform.notify!(
          'Timer finished',
          label || `Your ${describeDuration(seconds)} timer is up.`,
        );
      }, seconds * 1000);

      return {
        ok: true,
        message: `⏳ Timer set for ${describeDuration(seconds)}${label ? ` — ${label}` : ''}.`,
        data: seconds,
      };
    },
  });

  // ---- files ---------------------------------------------------------------

  /**
   * The words of a query, matched independently and combined — the second,
   * looser reading `files.find` falls back to when the phrase exactly as
   * typed finds nothing.
   *
   * `search_files` (`platform.rs`) matches one literal substring against a
   * file's whole name, which is right and precise whenever the words in the
   * request actually sit next to each other in that order — but a real file
   * name routinely doesn't: "find my japan vacation photos" (the file-noun
   * "photos" already stripped by the grammar, leaving the query "japan
   * vacation") never matches `Japan_Vacation_2024.jpg`, because there is an
   * underscore where the query has a space. The words are all there; the
   * phrase just isn't contiguous.
   *
   * So this searches once per word and keeps only the files every search
   * agreed on — every word present, in any order, wherever it sits in the
   * name. Still a name search, never a content search, and still bounded to
   * the same indexed roots and the same per-call cap as the phrase search;
   * it only widens *which* names count as a match, not *where* Atlas looks.
   */
  async function searchWordsIndependently(
    query: string,
    opts: { kind?: string; limit: number },
  ): Promise<FileEntry[]> {
    const words = query.split(/\s+/).filter((w) => w.length > 1);
    // One word is exactly the phrase search that already ran — nothing new
    // to try, and running it twice would just double the work for the same
    // answer.
    if (words.length < 2) return [];

    // A wider per-word cap than the final limit: a common word narrows a lot
    // once every other word's set is intersected against it, so capping each
    // individual search at the *answer's* size risks losing the very file
    // being looked for to whatever else that one word happens to match.
    const perWordLimit = Math.max(opts.limit * 4, 80);
    const perWord = await Promise.all(
      words.map((word) => platform.searchFiles!(word, { kind: opts.kind, limit: perWordLimit })),
    );

    const [first, ...rest] = perWord;
    const survivors = new Map(first!.map((f) => [f.path, f]));
    for (const set of rest) {
      const paths = new Set(set.map((f) => f.path));
      for (const path of survivors.keys()) {
        if (!paths.has(path)) survivors.delete(path);
      }
    }
    return [...survivors.values()].slice(0, opts.limit);
  }

  skills.push({
    id: 'files.find',
    label: 'Find files',
    icon: '🔍',
    domain: 'files',
    description: 'Search the file index by name and show matching files.',
    needs: ['files'],
    risk: 'safe',
    examples: ['find my tax pdf', 'where are my screenshots'],
    params: {
      query: { type: 'string', required: true, description: 'words from the file name' },
      kind: {
        type: 'string',
        required: false,
        description: 'narrow by type: document, image, video, audio, archive, folder',
      },
      limit: { type: 'number', default: 20, description: 'how many to show' },
    },
    async run(args, ctx) {
      const query = String(args.query);
      const kind = args.kind ? String(args.kind) : undefined;
      const limit = Number(args.limit ?? 20);

      // Two relevant, ordered readings of "find <query>" — the phrase exactly
      // as typed, and only once that comes back empty, its words matched
      // independently. See `searchWordsIndependently` above for why the
      // second one exists and why it is never tried first: the tighter
      // search is the more precise answer whenever it works, and trying the
      // loose one only after the tight one has genuinely failed is what
      // keeps this a fallback rather than a replacement. See
      // `planner/attempts.ts` for the ladder itself.
      const { result } = await attemptGoal<FileEntry[]>([
        {
          id: 'exact-phrase',
          async run() {
            const found = await platform.searchFiles!(query, { kind, limit });
            return { result: { ok: found.length > 0, error: 'no match', data: found } };
          },
        },
        {
          id: 'words-any-order',
          async run() {
            const found = await searchWordsIndependently(query, { kind, limit });
            return { result: { ok: found.length > 0, error: 'no match', data: found } };
          },
        },
      ]);

      const files = result.data ?? [];
      if (!files.length) {
        return { ok: true, message: `Nothing named like “${query}”.` };
      }

      const rows: ResultRow[] = files.map((f) => ({
        title: f.name,
        subtitle: f.path,
        icon: f.isDirectory ? '📁' : '📄',
        payload: f,
        actions: [
          { label: 'Open', skill: 'files.open', args: { path: f.path } },
          { label: 'Show in folder', skill: 'files.reveal', args: { path: f.path } },
        ],
      }));

      ctx.showResults?.(rows, {
        title: `Files matching “${query}”`,
        subtitle: `${files.length} found`,
      });
      return { ok: true, spoken: true, message: '', data: files };
    },
  });

  skills.push({
    id: 'files.open',
    label: 'Open a file',
    icon: '📄',
    domain: 'files',
    description: 'Open a file or folder with whatever the system uses for it.',
    needs: ['fs'],
    risk: 'safe',
    params: { path: { type: 'string', required: true, description: 'full path' } },
    async run(args) {
      const ok = await platform.openPath!(String(args.path));
      return ok
        ? { ok: true, message: phrasing.opening(basename(String(args.path))) }
        : { ok: false, error: `I couldn't open ${String(args.path)}.` };
    },
  });

  skills.push({
    id: 'files.reveal',
    label: 'Show in folder',
    icon: '📁',
    domain: 'files',
    description: 'Reveal a file in the system file manager without opening it.',
    needs: ['fs'],
    risk: 'safe',
    params: { path: { type: 'string', required: true, description: 'full path' } },
    async run(args) {
      const ok = await platform.revealPath!(String(args.path));
      return ok
        ? { ok: true, message: phrasing.revealing(basename(String(args.path))) }
        : { ok: false, error: `I couldn't reveal ${String(args.path)}.` };
    },
  });

  skills.push({
    id: 'files.openAlias',
    label: 'Open by remembered name',
    icon: '📁',
    domain: 'files',
    description: 'Open whatever a remembered name refers to (see memory.remember).',
    needs: ['fs'],
    risk: 'safe',
    examples: ['open my work folder'],
    params: { subject: { type: 'string', required: true, description: 'the remembered name' } },
    async run(args) {
      const subject = String(args.subject);
      const fact = await memory.fact('alias', subject);
      if (!fact) {
        return {
          ok: false,
          error: `I don't know what "${subject}" refers to yet. Say "remember my ${subject} is <path>" to teach me.`,
        };
      }
      const ok = await platform.openPath!(fact.value);
      return ok
        ? { ok: true, message: phrasing.opening(basename(fact.value)) }
        : { ok: false, error: `I couldn't open ${fact.value}.` };
    },
  });

  // Only explicit absolute paths are handled here — "create a folder called
  // Projects in my documents" needs alias resolution, which files.openAlias
  // (above) now covers for the "open X" phrasing; create/rename/move/copy
  // still require an explicit path.

  skills.push({
    id: 'files.create',
    label: 'Create a file',
    icon: '📄',
    domain: 'files',
    description: 'Create a new, empty (or pre-filled) file at a given path.',
    needs: ['fs'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'full path for the new file' },
      content: { type: 'string', required: false, description: 'initial contents' },
    },
    async run(args) {
      const path = String(args.path);
      const ok = await platform.createFile!(
        path,
        args.content !== undefined ? String(args.content) : undefined,
      );
      return ok
        ? { ok: true, message: `Created ${basename(path)}.` }
        : { ok: false, error: `I couldn't create ${path}.` };
    },
  });

  skills.push({
    id: 'files.createFolder',
    label: 'Create a folder',
    icon: '📁',
    domain: 'files',
    description: 'Create a new folder at a given path.',
    needs: ['fs'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'full path for the new folder' },
    },
    async run(args) {
      const path = String(args.path);
      const ok = await platform.createFolder!(path);
      return ok
        ? { ok: true, message: `Created ${basename(path)}.` }
        : { ok: false, error: `I couldn't create ${path}.` };
    },
  });

  skills.push({
    id: 'files.rename',
    label: 'Rename',
    icon: '✏️',
    domain: 'files',
    description: 'Rename a file or folder in place.',
    needs: ['fs'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'full path of the file or folder' },
      newName: { type: 'string', required: true, description: 'the new name, no path' },
    },
    async run(args) {
      const path = String(args.path);
      const newName = String(args.newName);
      const ok = await platform.renamePath!(path, newName);
      return ok
        ? { ok: true, message: `Renamed ${basename(path)} to ${newName}.` }
        : { ok: false, error: `I couldn't rename ${path}.` };
    },
  });

  skills.push({
    id: 'files.move',
    label: 'Move',
    icon: '📦',
    domain: 'files',
    description: 'Move a file or folder into another folder.',
    needs: ['fs'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'full path of the file or folder' },
      destDir: { type: 'string', required: true, description: 'the destination folder' },
    },
    async run(args) {
      const path = String(args.path);
      const ok = await platform.movePath!(path, String(args.destDir));
      return ok
        ? { ok: true, message: `Moved ${basename(path)}.` }
        : { ok: false, error: `I couldn't move ${path}.` };
    },
  });

  skills.push({
    id: 'files.copy',
    label: 'Copy',
    icon: '📋',
    domain: 'files',
    description: 'Copy a file into another folder.',
    needs: ['fs'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'full path of the file' },
      destDir: { type: 'string', required: true, description: 'the destination folder' },
    },
    async run(args) {
      const path = String(args.path);
      const ok = await platform.copyPath!(path, String(args.destDir));
      return ok
        ? { ok: true, message: `Copied ${basename(path)}.` }
        : { ok: false, error: `I couldn't copy ${path}.` };
    },
  });

  skills.push({
    id: 'files.delete',
    label: 'Delete',
    icon: '🗑️',
    domain: 'files',
    description: 'Send a file or folder to the recycle bin.',
    needs: ['fs'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'full path of the file or folder' },
    },
    async run(args) {
      const path = String(args.path);
      const ok = await platform.deletePath!(path);
      return ok
        ? { ok: true, message: `Sent ${basename(path)} to the recycle bin.` }
        : { ok: false, error: `I couldn't delete ${path}.` };
    },
  });

  skills.push({
    id: 'files.readText',
    label: 'Read a file',
    icon: '📖',
    domain: 'files',
    description: 'Read the contents of a small plain-text file.',
    needs: ['fs'],
    risk: 'safe',
    params: { path: { type: 'string', required: true, description: 'full path of the text file' } },
    async run(args) {
      const path = String(args.path);
      try {
        const text = await platform.readTextFile!(path);
        return { ok: true, message: `📖 ${basename(path)}:\n\n${text}`, data: text };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn't read ${path}.` };
      }
    },
  });

  skills.push({
    id: 'files.info',
    label: 'File details',
    icon: 'ℹ️',
    domain: 'files',
    description: 'How big a file or folder is and when it last changed.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['how big is D:\\Dev\\notes.txt'],
    params: { path: { type: 'string', required: true, description: 'full path' } },
    async run(args) {
      const info = await platform.pathInfo!(String(args.path));
      // Written out ("September 8, 2026 at 4:19 PM") rather than
      // `toLocaleString()`'s bare default ("9/8/2026, 4:19:16 PM"): fine to
      // read, and a numeric date read aloud is heard as a fraction, not a
      // day — see `prepareForSpeech`'s doc comment for the rest of this kind
      // of bug.
      const changed = info.modifiedAt
        ? `${new Date(info.modifiedAt).toLocaleDateString(undefined, {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })} at ${new Date(info.modifiedAt).toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
          })}`
        : 'unknown';
      const size = info.isDirectory
        ? `${info.entryCount ?? 0} item${info.entryCount === 1 ? '' : 's'}`
        : formatBytes(info.sizeBytes);
      return {
        ok: true,
        message: `ℹ️ ${info.name} — ${info.isDirectory ? 'folder' : info.ext || 'file'} · ${size} · changed ${changed}.`,
        data: info,
      };
    },
  });

  skills.push({
    id: 'files.append',
    label: 'Add a line to a file',
    icon: '✍️',
    domain: 'files',
    description: 'Append a line of text to a file, creating it if it does not exist.',
    needs: ['fs'],
    risk: 'confirm',
    examples: ['append "shipped v2" to D:\\Dev\\log.txt'],
    params: {
      path: { type: 'string', required: true, description: 'full path' },
      text: { type: 'string', required: true, description: 'the line to add' },
    },
    async run(args) {
      const ok = await platform.appendFile!(String(args.path), String(args.text));
      return ok
        ? { ok: true, message: `✍️ Added to ${basename(String(args.path))}.` }
        : { ok: false, error: `I couldn't write to ${String(args.path)}.` };
    },
  });

  skills.push({
    id: 'files.list',
    label: "What's in a folder",
    icon: '📂',
    domain: 'files',
    description: 'List what is directly inside a folder.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['what is in C:\\Users\\me\\Downloads'],
    params: {
      path: { type: 'string', required: true, description: 'the folder' },
      limit: { type: 'number', default: 100, description: 'how many to show' },
    },
    async run(args, ctx) {
      const entries = await platform.listDir!(String(args.path), Number(args.limit ?? 100));
      if (!entries.length) return { ok: true, message: 'That folder is empty.' };

      ctx.showResults?.(
        entries.map((entry) => ({
          title: entry.name,
          subtitle: entry.isDirectory ? 'folder' : formatBytes(entry.sizeBytes ?? 0),
          icon: entry.isDirectory ? '📁' : '📄',
          payload: entry,
          actions: [
            { label: 'Open', skill: 'files.open', args: { path: entry.path } },
            { label: 'Show in folder', skill: 'files.reveal', args: { path: entry.path } },
          ],
        })),
        {
          title: String(args.path),
          subtitle: `${entries.length} item${entries.length === 1 ? '' : 's'}`,
        },
      );
      return { ok: true, spoken: true, message: '', data: entries };
    },
  });

  skills.push({
    id: 'files.peek',
    label: 'Peek inside a file',
    icon: '👀',
    domain: 'files',
    description: 'Show the first few lines of a text file without opening it.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['peek at C:\\Users\\me\\Documents\\notes.txt'],
    params: {
      path: { type: 'string', required: true, description: 'full path' },
      lines: { type: 'number', default: 15, description: 'how many lines' },
    },
    async run(args) {
      const text = await platform.readTextFile!(String(args.path));
      const wanted = Math.min(200, Math.max(1, Math.round(Number(args.lines ?? 15))));
      const all = text.split(/\r?\n/);
      const head = all.slice(0, wanted).join('\n');
      const rest = all.length - wanted;
      return {
        ok: true,
        message: rest > 0 ? `👀 ${head}\n\n…and ${rest} more lines.` : `👀 ${head}`,
        data: head,
      };
    },
  });

  skills.push({
    id: 'files.openKnown',
    label: 'Open a standard folder',
    icon: '📁',
    domain: 'files',
    description: 'Open Downloads, Documents, Desktop, Pictures, Music or Videos.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['open my downloads', 'open my documents folder'],
    params: {
      folder: {
        type: 'string',
        required: true,
        enum: ['home', 'downloads', 'documents', 'desktop', 'pictures', 'music', 'videos'],
        description: 'which folder',
      },
    },
    async run(args) {
      const folder = String(args.folder) as KnownFolder;
      let path: string;
      try {
        path = await platform.knownFolder!(folder);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : `I can't find your ${folder} folder.`,
        };
      }
      const ok = await platform.openPath!(path);
      return ok
        ? { ok: true, message: phrasing.opening(path) }
        : { ok: false, error: `I couldn't open ${path}.` };
    },
  });

  // ---- applications --------------------------------------------------------

  skills.push({
    id: 'app.open',
    label: 'Open an app',
    icon: '🚀',
    domain: 'apps',
    description: 'Launch an installed application by name.',
    needs: ['apps'],
    risk: 'safe',
    examples: ['open steam', 'launch discord'],
    params: { name: { type: 'string', required: true, description: 'the application name' } },
    async run(args, ctx) {
      const apps = await platform.listApps!();
      const { wanted, matches } = resolveAppName(apps, String(args.name).trim());

      // Three relevant, ordered ways to satisfy "open <name>" — each one a
      // real, causally-connected strategy for *this* request, never a random
      // action taken because attempts remain. See `planner/attempts.ts`.
      const { result, final } = await attemptGoal<unknown>([
        {
          // A confident match launches. A typo-tolerant one is a guess, so
          // when there is more than one of those, the user picks rather than
          // Atlas — which is why this reports "not final" when ambiguous,
          // letting the ladder fall through to the "did you mean" step below
          // rather than trying something else that could also just guess.
          id: 'installed-app',
          async run() {
            if (!matches.length) return { result: { ok: false, error: 'no installed app matched' } };
            const best = matches[0]!;
            const ambiguous = best.rank >= 4 && matches.length > 1;

            // One exception to "installed applications win", and it is
            // narrow. "open google" found Google Docs — a different product
            // whose name merely begins with the word — while the thing
            // actually called Google is a website. A partial match against a
            // longer application name is a weaker claim than a site named
            // precisely what was said. An *exact* application match still
            // wins, so "open steam" is untouched.
            const site = best.rank > RANK.exact ? exactSiteName(wanted) : null;
            if (site && platform.openUrl) {
              const ok = await platform.openUrl(site.url);
              if (ok) return { result: { ok: true, message: phrasing.opening(site.name) } };
            }

            if (!ambiguous) {
              const ok = await platform.launchApp!(best.app.id);
              return {
                // A real launch was attempted — committed, whether it worked
                // or not. A failure here means "that program wouldn't
                // start," never "let's also try it as a website."
                final: true,
                result: ok
                  ? { ok: true, message: phrasing.opening(best.app.name) }
                  : { ok: false, error: `${best.app.name} wouldn't start.` },
              };
            }
            return { result: { ok: false, error: 'ambiguous' } };
          },
        },
        {
          // "open OBS and Epic Games" is one request naming two programs,
          // and it arrives here as a single name because that is the only
          // reading the grammar can safely take — see `splitTargets`. Only
          // relevant once no single installed app matched the whole name.
          id: 'multiple-named-apps',
          async run() {
            if (matches.length) return { result: { ok: false, error: 'not applicable' } };
            const several = resolveSeveral(apps, wanted);
            if (!several) return { result: { ok: false, error: 'no multi-target reading' } };

            const launched: string[] = [];
            const failed: string[] = [];
            for (const app of several) {
              const ok = await platform.launchApp!(app.id);
              (ok ? launched : failed).push(app.name);
            }
            // Real launches were attempted — committed either way, same as
            // the single-app case above.
            if (launched.length) {
              return {
                final: true,
                result: {
                  ok: failed.length === 0,
                  message: phrasing.opening(readableList(launched)),
                  error: failed.length ? `${readableList(failed)} wouldn't start.` : undefined,
                },
              };
            }
            return {
              final: true,
              result: { ok: false, error: `${readableList(failed)} wouldn't start.` },
            };
          },
        },
        {
          // Nothing installed matches. If the name is domain-shaped, that is
          // what "open steelseries.gg" means when the app isn't there — and
          // it is also what "open github.com" always meant. Then the sites
          // people name without a domain — checked after installed apps
          // deliberately, so "open discord" means the program when it's
          // installed and the website when it isn't.
          id: 'known-destination',
          async run() {
            if (matches.length) return { result: { ok: false, error: 'not applicable' } };

            if (looksLikeDomain(wanted) && platform.openUrl) {
              const url = `https://${wanted}`;
              const ok = await platform.openUrl(url);
              if (ok) {
                return {
                  final: true,
                  result: { ok: true, message: `No app called “${wanted}” — opening ${url} instead.` },
                };
              }
            }

            if (platform.openUrl) {
              const site = resolveSite(wanted);
              if (site) {
                const ok = await platform.openUrl(site.url);
                if (ok) return { final: true, result: { ok: true, message: phrasing.opening(site.name) } };
              }
            }
            return { result: { ok: false, error: 'no known destination' } };
          },
        },
      ]);

      if (final) return result;

      // Every relevant strategy declined — the honest moment to ask rather
      // than guess. Suggestions use the wider net on purpose, see
      // `nearMatches`.
      const near = matches.length
        ? matches
        : nearMatches(apps, wanted, (a) => a.name).map((m) => ({ app: m.item, rank: m.rank }));

      if (!near.length) {
        return {
          ok: false,
          error: `I couldn't figure out which app you meant by “${wanted}”. It isn't installed here under that name.`,
        };
      }

      ctx.showResults?.(
        near.slice(0, 6).map((m) => ({
          title: m.app.name,
          subtitle: 'Open this instead?',
          icon: '🚀',
          payload: m.app,
          actions: [{ label: 'Open', skill: 'app.open', args: { name: m.app.name } }],
        })),
        { title: `Nothing called “${wanted}”`, subtitle: 'Did you mean one of these?' },
      );
      return { ok: true, spoken: true, message: '' };
    },
  });

  skills.push({
    id: 'app.list',
    label: 'List apps',
    icon: '🗂️',
    domain: 'apps',
    description: 'Show the applications installed on this machine.',
    needs: ['apps'],
    risk: 'safe',
    // For the eyes, not the ear — see SkillResult.aloud.
    aloud: false,
    params: { filter: { type: 'string', required: false, description: 'optional name filter' } },
    async run(args, ctx) {
      const filter = args.filter ? String(args.filter).toLowerCase() : '';
      const apps = (await platform.listApps!()).filter((a) =>
        filter ? a.name.toLowerCase().includes(filter) : true,
      );

      if (!apps.length) return { ok: true, message: 'No applications matched.' };

      ctx.showResults?.(
        apps.map((a) => ({
          title: a.name,
          icon: a.icon ?? '🚀',
          payload: a,
          actions: [{ label: 'Open', skill: 'app.open', args: { name: a.name } }],
        })),
        { title: 'Installed applications', subtitle: `${apps.length} found` },
      );
      return { ok: true, spoken: true, message: '', data: apps };
    },
  });

  // ---- the machine ---------------------------------------------------------

  skills.push({
    id: 'system.info',
    label: 'System status',
    icon: '📊',
    domain: 'system',
    description: 'Report CPU, memory, disk and battery for this machine.',
    needs: ['system'],
    risk: 'safe',
    // For the eyes, not the ear — see SkillResult.aloud.
    aloud: false,
    examples: ['system status', 'how much memory am I using'],
    params: {},
    async run() {
      const s = await platform.systemInfo!();
      const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
      const parts = [
        `CPU ${Math.round(s.cpuPercent)}%`,
        `memory ${gb(s.memoryUsedBytes)}/${gb(s.memoryTotalBytes)} GB`,
        ...s.disks.map((d) => `${d.mount} ${gb(d.usedBytes)}/${gb(d.totalBytes)} GB`),
      ];
      if (s.battery) {
        parts.push(`battery ${s.battery.percent}%${s.battery.charging ? ' (charging)' : ''}`);
      }
      return { ok: true, message: `📊 ${parts.join(' · ')}.`, data: s };
    },
  });

  skills.push({
    id: 'system.processes',
    label: 'What is running',
    icon: '⚙️',
    domain: 'system',
    description: 'Show the processes running right now, heaviest first.',
    needs: ['processes'],
    risk: 'safe',
    // For the eyes, not the ear — see SkillResult.aloud.
    aloud: false,
    examples: ["what's running", 'show running processes'],
    params: { limit: { type: 'number', default: 12, description: 'how many to show' } },
    async run(args, ctx) {
      const procs = await platform.runningProcesses!(Number(args.limit ?? 12));
      if (!procs.length) return { ok: true, message: 'Nothing is reporting in.' };

      ctx.showResults?.(
        procs.map((proc) => ({
          title: proc.name,
          subtitle: [
            proc.memoryBytes ? `${(proc.memoryBytes / 1024 ** 2).toFixed(0)} MB` : null,
            proc.cpuPercent != null ? `${proc.cpuPercent.toFixed(0)}% CPU` : null,
            `pid ${proc.pid}`,
          ]
            .filter(Boolean)
            .join(' · '),
          icon: '⚙️',
          payload: proc,
        })),
        { title: 'Running now', subtitle: `${procs.length} processes, heaviest first` },
      );
      return { ok: true, spoken: true, message: '', data: procs };
    },
  });

  skills.push({
    id: 'system.battery',
    label: 'Battery level',
    icon: '🔋',
    domain: 'system',
    description: 'How much battery is left, and whether it is charging.',
    needs: ['system'],
    risk: 'safe',
    examples: ['how much battery', 'how much battery do I have'],
    params: {},
    async run() {
      const snapshot = await platform.systemInfo!();
      if (!snapshot.battery)
        return { ok: true, message: 'This machine has no battery — it runs on mains power.' };
      const { percent, charging } = snapshot.battery;
      return {
        ok: true,
        message: `🔋 ${percent}%${charging ? ' and charging' : ''}.`,
        data: snapshot.battery,
      };
    },
  });

  skills.push({
    id: 'system.disk',
    label: 'Disk space',
    icon: '💽',
    domain: 'system',
    description: 'How much free space each drive has left.',
    needs: ['system'],
    risk: 'safe',
    // For the eyes, not the ear — see SkillResult.aloud.
    aloud: false,
    examples: ['how much disk space do I have left'],
    params: {},
    async run() {
      const snapshot = await platform.systemInfo!();
      if (!snapshot.disks.length) return { ok: true, message: 'No drives reported in.' };
      const parts = snapshot.disks.map((disk) => {
        const free = disk.totalBytes - disk.usedBytes;
        const percent = disk.totalBytes ? Math.round((free / disk.totalBytes) * 100) : 0;
        return `${disk.mount} ${formatBytes(free)} free (${percent}%)`;
      });
      return { ok: true, message: `💽 ${parts.join(' · ')}.`, data: snapshot.disks };
    },
  });

  skills.push({
    id: 'system.uptime',
    label: 'Uptime',
    icon: '⏱️',
    domain: 'system',
    description: 'How long this machine has been running since it last booted.',
    needs: ['system'],
    risk: 'safe',
    examples: ['how long has my pc been on'],
    params: {},
    async run() {
      const snapshot = await platform.systemInfo!();
      const total = snapshot.uptimeSeconds;
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const parts = [
        days ? `${days} day${days === 1 ? '' : 's'}` : '',
        hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '',
        !days && minutes ? `${minutes} minute${minutes === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      return {
        ok: true,
        message: `⏱️ Up for ${parts.join(', ') || 'less than a minute'}.`,
        data: total,
      };
    },
  });

  skills.push({
    id: 'system.openTool',
    label: 'Open a system tool',
    icon: '🛠️',
    domain: 'system',
    description:
      'Launch a known Windows shell or utility: File Explorer, This PC, the Recycle Bin, Task Manager, Device Manager, Windows Settings, or Control Panel.',
    needs: ['system'],
    risk: 'safe',
    examples: ['open file explorer', 'open task manager', 'open the recycle bin'],
    params: {
      tool: {
        type: 'string',
        required: true,
        enum: [
          'task-manager',
          'device-manager',
          'windows-settings',
          'control-panel',
          'file-explorer',
          'this-pc',
          'recycle-bin',
        ],
        description: 'which system tool to open',
      },
    },
    async run(args) {
      const tool = String(args.tool);
      const ok = await platform.openSystemTool!(tool);
      return ok
        ? { ok: true, message: `Opening ${SYSTEM_TOOL_NAMES[tool] ?? tool}.` }
        : { ok: false, error: `I couldn't open that.` };
    },
  });

  // ---- the web -------------------------------------------------------------

  skills.push({
    id: 'web.open',
    label: 'Open a link',
    icon: '🌐',
    domain: 'web',
    description: 'Open an http or https URL in the default browser.',
    needs: ['fs'],
    risk: 'safe',
    params: { url: { type: 'string', required: true, description: 'the address' } },
    async run(args) {
      const url = String(args.url).trim();
      if (!/^https?:\/\//i.test(url)) {
        // The platform validates too; refusing here as well means the reason
        // reaches the user in words rather than as a silent failure.
        return { ok: false, error: 'I only open http and https links.' };
      }
      const ok = await platform.openUrl!(url);
      return ok
        ? { ok: true, message: phrasing.opening(url) }
        : { ok: false, error: `I couldn't open ${url}.` };
    },
  });

  // Both of these are web.open in disguise — they just build the URL rather
  // than requiring the user to spell out a search engine's query string.

  skills.push({
    id: 'web.search',
    label: 'Search the web',
    icon: '🔎',
    domain: 'web',
    description: 'Search the web for something.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['search the web for tide times', 'google the weather'],
    params: { query: { type: 'string', required: true, description: 'what to search for' } },
    async run(args) {
      const query = String(args.query).trim();
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      const ok = await platform.openUrl!(url);
      return ok
        ? { ok: true, message: `Searching for ${query}.` }
        : { ok: false, error: "I couldn't open a search." };
    },
  });

  skills.push({
    id: 'web.searchYoutube',
    label: 'Search YouTube',
    icon: '📺',
    domain: 'web',
    description: 'Search YouTube for something.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['search youtube for lofi', 'youtube guitar lessons'],
    params: { query: { type: 'string', required: true, description: 'what to search for' } },
    async run(args) {
      const query = String(args.query).trim();
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      const ok = await platform.openUrl!(url);
      return ok
        ? { ok: true, message: `Searching YouTube for ${query}.` }
        : { ok: false, error: "I couldn't open a search." };
    },
  });

  skills.push({
    id: 'web.searchImages',
    label: 'Search for images',
    icon: '🖼️',
    domain: 'web',
    description: 'Search the web for images of something.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['find images of red pandas'],
    params: { query: { type: 'string', required: true, description: 'what to look for' } },
    async run(args) {
      const query = String(args.query).trim();
      const url = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
      const ok = await platform.openUrl!(url);
      return ok
        ? { ok: true, message: `Looking for images of ${query}.` }
        : { ok: false, error: "I couldn't open an image search." };
    },
  });

  skills.push({
    id: 'web.searchMaps',
    label: 'Look up a place',
    icon: '🗺️',
    domain: 'web',
    description: 'Find a place on a map, or get directions to it.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['map of Kyoto', 'directions to Denver airport'],
    params: {
      place: { type: 'string', required: true, description: 'the place to look up' },
      directions: { type: 'boolean', default: false, description: 'ask for directions instead' },
    },
    async run(args) {
      const place = String(args.place).trim();
      const url = args.directions
        ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
      const ok = await platform.openUrl!(url);
      if (!ok) return { ok: false, error: "I couldn't open a map." };
      return {
        ok: true,
        message: args.directions ? `Directions to ${place}.` : `Finding ${place} on the map.`,
      };
    },
  });

  skills.push({
    id: 'web.searchWikipedia',
    label: 'Look it up on Wikipedia',
    icon: '📚',
    domain: 'web',
    description: 'Look a subject up on Wikipedia.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['wikipedia the Voyager program'],
    params: { query: { type: 'string', required: true, description: 'the subject' } },
    async run(args) {
      const query = String(args.query).trim();
      const url = `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
      const ok = await platform.openUrl!(url);
      return ok
        ? { ok: true, message: `Looking up ${query} on Wikipedia.` }
        : { ok: false, error: "I couldn't open Wikipedia." };
    },
  });

  skills.push({
    id: 'web.openBrowser',
    label: 'Open a browser',
    icon: '🧭',
    domain: 'web',
    description: 'Open a web browser — a named one if it is installed, otherwise whichever one is.',
    needs: ['apps'],
    risk: 'safe',
    examples: ['open any browser', 'open a browser'],
    params: {
      name: { type: 'string', required: false, description: 'a particular browser, e.g. firefox' },
    },
    async run(args) {
      const apps = await platform.listApps!();
      const wanted = args.name ? String(args.name).trim().toLowerCase() : '';
      const named = (needle: string) => apps.find((a) => a.name.toLowerCase().includes(needle));

      const hit = wanted ? named(wanted) : BROWSER_NAMES.map(named).find(Boolean);
      if (hit) {
        const ok = await platform.launchApp!(hit.id);
        if (ok) return { ok: true, message: phrasing.opening(hit.name) };
      }

      // No browser in the Start Menu index doesn't mean no browser: opening a
      // URL hands the job to whatever the OS considers the default, which is
      // exactly what "open any browser" is asking for.
      if (!wanted && platform.openUrl) {
        const ok = await platform.openUrl('https://www.google.com');
        if (ok) return { ok: true, message: 'Opening your default browser.' };
      }
      return {
        ok: false,
        error: wanted
          ? `I can't find a browser called “${wanted}”.`
          : "I couldn't find a browser to open.",
      };
    },
  });

  // ---- clipboard -----------------------------------------------------------

  skills.push({
    id: 'clipboard.copy',
    label: 'Copy to clipboard',
    icon: '📋',
    domain: 'clipboard',
    description: 'Put some text on the clipboard.',
    needs: ['clipboard'],
    risk: 'safe',
    params: { text: { type: 'string', required: true, description: 'what to copy' } },
    async run(args) {
      const ok = await platform.writeClipboard!(String(args.text));
      return ok
        ? { ok: true, message: phrasing.copied() }
        : { ok: false, error: "I couldn't reach the clipboard." };
    },
  });

  skills.push({
    id: 'clipboard.read',
    label: 'Read the clipboard',
    icon: '📋',
    domain: 'clipboard',
    description: "Show what's currently on the clipboard.",
    needs: ['clipboard'],
    risk: 'safe',
    examples: ["what's on my clipboard"],
    params: {},
    async run() {
      const text = await platform.readClipboard!();
      if (!text.trim()) return { ok: true, message: 'The clipboard is empty.' };
      // Truncated for display only — `data` keeps the whole thing, so a long
      // paste stays readable without flooding the transcript.
      const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      return { ok: true, message: `📋 ${preview}`, data: text };
    },
  });

  skills.push({
    id: 'clipboard.clear',
    label: 'Clear the clipboard',
    icon: '🧽',
    domain: 'clipboard',
    description: 'Wipe whatever is on the clipboard.',
    needs: ['clipboard'],
    risk: 'safe',
    examples: ['clear my clipboard'],
    params: {},
    async run() {
      const ok = await platform.writeClipboard!('');
      return ok
        ? { ok: true, message: '🧽 Clipboard cleared.' }
        : { ok: false, error: "I couldn't reach the clipboard." };
    },
  });

  skills.push({
    id: 'clipboard.append',
    label: 'Add to the clipboard',
    icon: '➕',
    domain: 'clipboard',
    description: 'Add text to what is already on the clipboard instead of replacing it.',
    needs: ['clipboard'],
    risk: 'safe',
    examples: ['add "and one more thing" to my clipboard'],
    params: { text: { type: 'string', required: true, description: 'what to add' } },
    async run(args) {
      const existing = await platform.readClipboard!();
      const addition = String(args.text);
      const joined = existing.trim() ? `${existing}\n${addition}` : addition;
      const ok = await platform.writeClipboard!(joined);
      return ok
        ? { ok: true, message: phrasing.copied() }
        : { ok: false, error: "I couldn't reach the clipboard." };
    },
  });

  skills.push({
    id: 'clipboard.transform',
    label: 'Transform the clipboard',
    icon: '🔄',
    domain: 'clipboard',
    description:
      'Rewrite what is on the clipboard — change its case, trim it, or strip line breaks.',
    needs: ['clipboard'],
    risk: 'safe',
    examples: ['uppercase my clipboard', 'trim my clipboard'],
    params: {
      style: {
        type: 'string',
        required: true,
        enum: ['upper', 'lower', 'trim', 'single-line'],
        description: 'how to rewrite it',
      },
    },
    async run(args) {
      const text = await platform.readClipboard!();
      if (!text.trim()) return { ok: false, error: 'The clipboard is empty.' };

      const style = String(args.style);
      const out =
        style === 'upper'
          ? text.toUpperCase()
          : style === 'lower'
            ? text.toLowerCase()
            : style === 'single-line'
              ? text.replace(/\s*\r?\n\s*/g, ' ').trim()
              : text.trim();

      const ok = await platform.writeClipboard!(out);
      return ok
        ? { ok: true, message: `🔄 ${out.length > 200 ? `${out.slice(0, 200)}…` : out}` }
        : { ok: false, error: "I couldn't write to the clipboard." };
    },
  });

  skills.push({
    id: 'clipboard.save',
    label: 'Save the clipboard to a file',
    icon: '💾',
    domain: 'clipboard',
    description: 'Write whatever is on the clipboard into a new file.',
    needs: ['clipboard', 'fs'],
    risk: 'confirm',
    examples: ['save my clipboard to D:\\Dev\\snippet.txt'],
    params: { path: { type: 'string', required: true, description: 'where to save it' } },
    async run(args) {
      const text = await platform.readClipboard!();
      if (!text.trim()) return { ok: false, error: 'The clipboard is empty.' };
      const ok = await platform.createFile!(String(args.path), text);
      return ok
        ? { ok: true, message: `💾 Saved to ${basename(String(args.path))}.` }
        : { ok: false, error: `I couldn't write ${String(args.path)}.` };
    },
  });

  // ---- notifications -------------------------------------------------------

  skills.push({
    id: 'notify.send',
    label: 'Send a notification',
    icon: '🔔',
    domain: 'notifications',
    description: 'Post a desktop notification.',
    needs: ['notifications'],
    risk: 'safe',
    examples: ['notify me "the build is done"'],
    params: {
      message: { type: 'string', required: true, description: 'what the notification should say' },
      title: { type: 'string', default: 'Atlas', description: 'the notification heading' },
    },
    async run(args) {
      const message = String(args.message).trim();
      if (!message) return { ok: false, error: 'Give me something to say.' };
      const ok = await platform.notify!(String(args.title ?? 'Atlas'), message);
      return ok
        ? { ok: true, message: `🔔 Notified: ${message}` }
        : { ok: false, error: 'Notifications are turned off for Atlas.' };
    },
  });

  // ---- Atlas itself --------------------------------------------------------

  skills.push({
    id: 'atlas.hide',
    label: 'Hide Atlas',
    icon: '👋',
    domain: 'atlas',
    description: 'Put the Atlas window away.',
    needs: ['windows'],
    risk: 'safe',
    params: {},
    async run() {
      await platform.hideWindow!();
      return { ok: true, message: '', spoken: true };
    },
  });

  return skills;
}

/** "90 seconds", "10 minutes", "2 hours" — whichever unit reads naturally. */
function describeDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

interface AppMatch {
  app: AppEntry;
  /** Lower is better. */
  rank: number;
}

/**
 * Resolve a spoken name against the installed apps.
 *
 * The ranking chain itself now lives in `../text/fuzzy`, because none of it
 * was ever specific to applications — websites and every future named thing
 * resolve through the same code. What stays here is the one app-only step:
 * the colloquial alias table, which handles names that are not misspellings
 * ("vscode" is not a typo for "Visual Studio Code") and so cannot be derived
 * by distance.
 */
function matchApps(apps: readonly AppEntry[], wanted: string): AppMatch[] {
  const direct = rankMatches(apps, wanted, (a) => a.name);
  if (direct.length && direct[0]!.rank < RANK.typo) {
    return direct.map((m) => ({ app: m.item, rank: m.rank }));
  }

  // The alias table sits between certainty and guesswork: an alias hit is
  // surer than a typo hit, so it is consulted before the fuzzy results are
  // accepted, but after an exact or prefix match has had its chance.
  const aliased = APP_ALIASES[wanted.trim().toLowerCase()];
  if (aliased) {
    const hit = rankMatches(apps, aliased, (a) => a.name);
    if (hit.length) return hit.map((m) => ({ app: m.item, rank: RANK.alias }));
  }

  return direct.map((m) => ({ app: m.item, rank: m.rank }));
}

/** Bare "steelseries.gg" shaped — a name with a dot and a short suffix. */
function looksLikeDomain(text: string): boolean {
  return /^[\w-]+(\.[\w-]+)+$/.test(text.trim()) && !text.trim().endsWith('.');
}

/** Byte counts as people say them: "4.7 GB", not "5046586572". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
