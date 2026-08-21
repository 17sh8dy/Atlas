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

import type { AppEntry, KnownFolder, Memory, Platform, ResultRow, Skill } from '@atlas/core';
import { createPhrasing, type Phrasing } from '../phrasing';
import { rankMatches, nearMatches, RANK } from '../text/fuzzy';
import { resolveSite } from '../text/sites';
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
};

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
      for (const list of byDomain.values()) {
        for (const s of list) {
          rows.push({ title: s.label, subtitle: s.description, icon: s.icon ?? '✨' });
        }
      }
      ctx.showResults?.(rows, { title: 'What I can do', subtitle: `${total} actions available` });
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
      const result = evaluateExpression(String(args.expression));
      if (result === null)
        return { ok: false, error: `I couldn't work out "${String(args.expression)}".` };
      return { ok: true, message: `🧮 ${result}.`, data: result };
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
      const files = await platform.searchFiles!(String(args.query), {
        kind: args.kind ? String(args.kind) : undefined,
        limit: Number(args.limit ?? 20),
      });

      if (!files.length) {
        return { ok: true, message: `Nothing named like “${String(args.query)}”.` };
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
        title: `Files matching “${String(args.query)}”`,
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
      const changed = info.modifiedAt ? new Date(info.modifiedAt).toLocaleString() : 'unknown';
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
    examples: ['what is in D:\\Dev'],
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
    examples: ['peek at D:\\Dev\\notes.txt'],
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
      const wanted = String(args.name).trim();
      const apps = await platform.listApps!();
      const matches = matchApps(apps, wanted);

      if (matches.length) {
        const best = matches[0]!;
        // A confident match launches. A typo-tolerant one is a guess, so when
        // there is more than one of those, the user picks rather than Atlas.
        const ambiguous = best.rank >= 4 && matches.length > 1;
        if (!ambiguous) {
          const ok = await platform.launchApp!(best.app.id);
          return ok
            ? { ok: true, message: phrasing.opening(best.app.name) }
            : { ok: false, error: `${best.app.name} wouldn't start.` };
        }
      }

      // Nothing installed matches. If the name is domain-shaped, that is what
      // "open steelseries.gg" means when the app isn't there — and it is also
      // what "open github.com" always meant.
      if (!matches.length && looksLikeDomain(wanted) && platform.openUrl) {
        const url = `https://${wanted}`;
        const ok = await platform.openUrl(url);
        if (ok) return { ok: true, message: `No app called “${wanted}” — opening ${url} instead.` };
      }

      // Then the sites people name without a domain. This runs *after* the
      // installed apps deliberately: "open discord" means the program when
      // it's installed, and the website when it isn't. Typo tolerance comes
      // from the same matcher the app list uses, so "youtub" lands here too.
      if (!matches.length && platform.openUrl) {
        const site = resolveSite(wanted);
        if (site) {
          const ok = await platform.openUrl(site.url);
          if (ok) return { ok: true, message: phrasing.opening(site.name) };
        }
      }

      // Suggestions use the wider net on purpose — see `nearMatches`.
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
    examples: ['how much battery do I have'],
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
      'Launch a known Windows system utility: Task Manager, Device Manager, Windows Settings, or Control Panel.',
    needs: ['system'],
    risk: 'safe',
    examples: ['open task manager', 'open device manager'],
    params: {
      tool: {
        type: 'string',
        required: true,
        enum: ['task-manager', 'device-manager', 'windows-settings', 'control-panel'],
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
