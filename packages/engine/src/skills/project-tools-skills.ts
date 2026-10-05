/**
 * Project tools that need no model: find-and-replace across a whole project, code statistics, and a
 * TODO finder.
 *
 * Atlas could already search a project (`code.search`) and edit one file at a time (`code.edit`).
 * What it could not do — and what a developer reaches for daily — was change a name everywhere, ask
 * "how big is this?", or list what was left unfinished. Each of these is plain text work on files
 * Atlas is already allowed to read, so none of them needs a language model, and none of them is a
 * way round a gate:
 *
 *   `code.replaceAll`  WRITES, so it has the full rails (`project-files.ts`): a preview that names
 *                      every file and count, an approval that is for exactly that plan, a backup
 *                      of each original first, and `code.replaceAllUndo`. Exact text only (no
 *                      regex), at least two characters, and never in dependencies, lockfiles,
 *                      build output or binary files.
 *   `project.stats`    READ-ONLY: files and lines by language, the biggest files.
 *   `project.todos`    READ-ONLY: TODO / FIXME / HACK / XXX comments, with file and line.
 *
 * The two read-only tools are `safe` because they change nothing, exactly as `code.search` is.
 */

import type { Platform, Skill, SkillContext } from '@atlas/core';
import { fingerprintOf } from './organize-plan';
import {
  BACKUP_DIR,
  backupThenWrite,
  baseName,
  extOf,
  isTextFile,
  plural,
  readProjectFiles,
  restoreLatestBackup,
  trimPath,
  type ProjectFile,
} from './project-files';

const REPLACE_LABEL = 'replace';
const MIN_FIND = 2;
/** More than this and "every occurrence" is probably not what was meant: say so on the card. */
const MANY = 500;

/** A file with a NUL in it is binary whatever its extension says; never rewrite one. */
const looksBinary = (text: string) => text.includes('\u0000');

/** Count and replace exact, case-sensitive occurrences — no regex, so "a.b" means a, dot, b. */
export function replaceExact(text: string, find: string, replace: string): { text: string; count: number } {
  if (!find) return { text, count: 0 };
  let count = 0;
  let out = '';
  let from = 0;
  for (;;) {
    const at = text.indexOf(find, from);
    if (at === -1) break;
    out += text.slice(from, at) + replace;
    from = at + find.length;
    count += 1;
  }
  return { text: out + text.slice(from), count };
}

/* ── Statistics ──────────────────────────────────────────────────────────────────────────── */

const LANGUAGES: Record<string, string> = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript (JSX)', ts: 'TypeScript', tsx: 'TypeScript (TSX)',
  css: 'CSS', scss: 'Sass', sass: 'Sass', less: 'Less', html: 'HTML', htm: 'HTML', vue: 'Vue', svelte: 'Svelte',
  json: 'JSON', jsonc: 'JSON', md: 'Markdown', markdown: 'Markdown', txt: 'Text', py: 'Python', rs: 'Rust', go: 'Go',
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin', c: 'C', h: 'C/C++ header', cpp: 'C++', cc: 'C++', hpp: 'C++ header', cs: 'C#',
  lua: 'Lua', gd: 'GDScript', gdscript: 'GDScript', rb: 'Ruby', php: 'PHP', swift: 'Swift', sh: 'Shell', bash: 'Shell',
  ps1: 'PowerShell', bat: 'Batch', cmd: 'Batch', sql: 'SQL', yml: 'YAML', yaml: 'YAML', toml: 'TOML', xml: 'XML', svg: 'SVG',
  ini: 'Config', cfg: 'Config', conf: 'Config', env: 'Config', csv: 'Data', tsv: 'Data',
};

export interface LanguageStat {
  language: string;
  files: number;
  lines: number;
  blank: number;
}

export interface ProjectStats {
  files: number;
  lines: number;
  blank: number;
  bytes: number;
  byLanguage: LanguageStat[];
  biggest: Array<{ rel: string; lines: number }>;
}

/** A file's lines. A trailing newline ends the last line; it does not start another, blank one. */
const linesOf = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Pure: statistics from file text. Binary-looking files are not counted. */
export function projectStats(files: ReadonlyArray<{ rel: string; text: string }>): ProjectStats {
  const by = new Map<string, LanguageStat>();
  const per: Array<{ rel: string; lines: number }> = [];
  let total = 0;
  let blankTotal = 0;
  let bytes = 0;
  let counted = 0;
  for (const f of files) {
    if (looksBinary(f.text)) continue;
    const all = linesOf(f.text);
    const lines = all.length;
    const blank = all.filter((l) => l.trim() === '').length;
    const language = LANGUAGES[extOf(f.rel)] ?? 'Other';
    const stat = by.get(language) ?? { language, files: 0, lines: 0, blank: 0 };
    stat.files += 1;
    stat.lines += lines;
    stat.blank += Math.max(0, blank);
    by.set(language, stat);
    per.push({ rel: f.rel, lines });
    total += lines;
    blankTotal += Math.max(0, blank);
    bytes += new TextEncoder().encode(f.text).length;
    counted += 1;
  }
  return {
    files: counted,
    lines: total,
    blank: blankTotal,
    bytes,
    byLanguage: [...by.values()].sort((a, b) => b.lines - a.lines || a.language.localeCompare(b.language)),
    biggest: per.sort((a, b) => b.lines - a.lines || a.rel.localeCompare(b.rel)).slice(0, 5),
  };
}

const n = (value: number) => value.toLocaleString('en-US');
const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function describeStats(name: string, s: ProjectStats, skipped: number): string {
  if (!s.files) return `I found no text or code files in ${name} to count.`;
  const lines = [
    `${name}: ${plural(s.files, 'file')}, ${n(s.lines)} lines (${n(s.lines - s.blank)} of code and text, ${n(s.blank)} blank), ${size(s.bytes)}.`,
    '',
    ...s.byLanguage.slice(0, 10).map((l) => `• ${l.language} — ${plural(l.files, 'file')}, ${n(l.lines)} lines (${Math.round((l.lines / Math.max(1, s.lines)) * 100)}%)`),
  ];
  if (s.byLanguage.length > 10) lines.push(`• …and ${s.byLanguage.length - 10} more`);
  lines.push('', 'Biggest files:', ...s.biggest.map((f) => `• ${f.rel} — ${n(f.lines)} lines`));
  if (skipped) lines.push('', `${plural(skipped, 'file')} were too big to read and are not counted.`);
  return lines.join('\n');
}

/* ── TODOs ───────────────────────────────────────────────────────────────────────────────── */

export interface TodoHit {
  rel: string;
  line: number;
  tag: string;
  text: string;
}

/** TODO / FIXME / HACK / XXX as a marker (upper-case, followed by a colon, bracket or space), not a word in prose. */
const TODO_MARK = /\b(TODO|FIXME|HACK|XXX)\b(?=\s*[:([-]|\s)/;

export function findTodos(files: ReadonlyArray<{ rel: string; text: string }>): TodoHit[] {
  const hits: TodoHit[] = [];
  for (const f of files) {
    if (looksBinary(f.text)) continue;
    const lines = f.text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = TODO_MARK.exec(line);
      if (!m) continue;
      // Only where it is written as a note: after a comment marker on the line, or at the start of
      // a markdown/text line. "the TODO list screen" in prose or a string is not a to-do.
      const before = line.slice(0, m.index);
      const commented = /(?:\/\/|\/\*|<!--|^\s*\*|(?:^|\s)#|(?:^|\s)--\s)/.test(before);
      const atStart = /^\s*(?:[-*]\s*)?$/.test(before);
      if (!commented && !atStart) continue;
      const after = line.slice(m.index + m[0].length).replace(/^[\s:([-]+/, '').replace(/\s*\*\/\s*$|\s*-->\s*$/, '').trim();
      hits.push({ rel: f.rel, line: i + 1, tag: m[1]!, text: after.slice(0, 140) });
    }
  }
  return hits;
}

export function describeTodos(name: string, hits: TodoHit[], skipped: number): string {
  if (!hits.length) return `No TODO, FIXME, HACK or XXX notes in ${name}.`;
  const tags = new Map<string, number>();
  for (const h of hits) tags.set(h.tag, (tags.get(h.tag) ?? 0) + 1);
  const summary = [...tags.entries()].map(([t, c]) => `${c} ${t}`).join(', ');
  const shown = hits.slice(0, 40);
  const lines = [
    `${plural(hits.length, 'note')} in ${name} (${summary}):`,
    ...shown.map((h) => `• ${h.rel}:${h.line} — ${h.tag}${h.text ? `: ${h.text}` : ''}`),
  ];
  if (hits.length > shown.length) lines.push(`• …and ${hits.length - shown.length} more`);
  if (skipped) lines.push('', `${plural(skipped, 'file')} were too big to read and were not searched.`);
  return lines.join('\n');
}

/* ── The skills ──────────────────────────────────────────────────────────────────────────── */

export function createProjectToolSkills(platform: Platform, current?: { set(path: string): Promise<void> }): Skill[] {
  type Plan = { root: string; find: string; replace: string; changes: Array<{ rel: string; path: string; before: string; after: string; count: number }>; total: number; skipped: number };

  async function plan(args: Record<string, unknown>): Promise<Plan | { error: string }> {
    const root = trimPath(String(args.path ?? ''));
    if (!root) return { error: 'Which project should I search?' };
    const find = typeof args.find === 'string' ? args.find : '';
    const replace = typeof args.replace === 'string' ? args.replace : '';
    if (find.length < MIN_FIND) {
      return { error: `Give me at least ${MIN_FIND} characters to find — a single character would change far too much.` };
    }
    if (find === replace) return { error: 'The text to find and the text to put in are the same, so nothing would change.' };
    const info = await platform.pathInfo?.(root).catch(() => null);
    if (info && !info.isDirectory) return { error: `${baseName(root)} is a file; point me at the project folder.` };

    const got = await readProjectFiles(platform, root, isTextFile);
    if ('error' in got) return { error: got.error };
    const changes: Plan['changes'] = [];
    let total = 0;
    for (const f of got.files) {
      if (looksBinary(f.text) || !f.text.includes(find)) continue;
      const done = replaceExact(f.text, find, replace);
      if (!done.count) continue;
      changes.push({ rel: f.rel, path: f.path, before: f.text, after: done.text, count: done.count });
      total += done.count;
    }
    return { root, find, replace, changes, total, skipped: got.skipped };
  }

  const fingerprintFor = (p: Plan) => fingerprintOf([p.find, p.replace, ...p.changes.map((c) => `${c.rel}|${c.count}|${c.after.length}`)]);
  const quote = (s: string) => (s.length > 40 ? `“${s.slice(0, 37)}…”` : `“${s}”`);

  const replaceAll: Skill = {
    id: 'code.replaceAll',
    label: 'Replace text across a project',
    icon: '🔁',
    domain: 'code',
    description:
      'Replace one exact piece of text with another in every text/code file of a project (case-sensitive, no regex), after showing every file and count. Skips dependencies, lockfiles, build output and binaries. Saves a backup first and can be undone.',
    needs: ['devtools'],
    // A bulk rewrite: always a confirm with the real list, never softened by a mode.
    risk: 'confirm',
    examples: ['replace "oldName" with "newName" in D:\\Dev\\MyApp', 'replace all "colour" with "color" in my project'],
    params: {
      path: { type: 'string', required: true, description: 'the project folder' },
      find: { type: 'string', required: true, description: 'the exact text to find (at least 2 characters, case-sensitive)' },
      replace: { type: 'string', required: true, description: 'what to put in its place (may be empty to remove it)' },
    },

    async preview(args) {
      const p = await plan(args);
      if ('error' in p) return { kind: 'refuse', error: p.error };
      if (!p.total) return { kind: 'nothing', message: `I didn't find ${quote(p.find)} in any file of ${baseName(p.root)}, so nothing would change.` };
      const lines = [
        `${quote(p.find)} → ${quote(p.replace)}: ${plural(p.total, 'place')} in ${plural(p.changes.length, 'file')}.`,
        ...p.changes.slice(0, 10).map((c) => `• ${c.rel} — ${plural(c.count, 'place')}`),
      ];
      if (p.changes.length > 10) lines.push(`• …and ${p.changes.length - 10} more`);
      if (p.total > MANY) lines.push(`That is a lot (${p.total}). Check ${quote(p.find)} is really the whole thing you mean to change.`);
      if (p.skipped) lines.push(`${plural(p.skipped, 'file')} were too big to read and are untouched.`);
      lines.push('Exact text, case-sensitive. Originals are saved to .atlas-backup first, and “undo the replace” puts them back.');
      return { kind: 'ask', question: `🔁 Replace ${quote(p.find)} in ${baseName(p.root)}?`, detail: lines.join('\n'), fingerprint: fingerprintFor(p) };
    },

    async run(args, ctx: SkillContext) {
      const p = await plan(args);
      if ('error' in p) return { ok: false, error: p.error };
      if (!p.total) return { ok: true, message: `I didn't find ${quote(p.find)} in ${baseName(p.root)}, so nothing changed.` };
      if (ctx.approvedPreview !== undefined && ctx.approvedPreview !== fingerprintFor(p)) {
        return {
          ok: false,
          error: "The project changed after I showed you the plan, so I didn't touch anything. Ask again and I'll show you what's there now.",
        };
      }
      const written = await backupThenWrite(platform, p.root, REPLACE_LABEL, p.changes, ctx, 'Replacing text');
      if (!written.ok) return { ok: false, error: written.error };
      await current?.set(p.root).catch(() => undefined);
      return {
        ok: true,
        message: `Replaced ${quote(p.find)} with ${quote(p.replace)}: ${plural(p.total, 'place')} in ${plural(p.changes.length, 'file')}. Originals are in ${BACKUP_DIR}\\${baseName(written.backup)} — say “undo the replace” to put them back.`,
        data: { path: p.root, backup: written.backup, files: written.done, replaced: p.total },
      };
    },
  };

  const replaceAllUndo: Skill = {
    id: 'code.replaceAllUndo',
    label: 'Undo a project-wide replace',
    icon: '↩️',
    domain: 'code',
    description: 'Put back the files as they were before the last project-wide replace, from the backup that was saved. Does nothing if there is no backup.',
    needs: ['devtools'],
    risk: 'confirm',
    examples: ['undo the replace'],
    params: { path: { type: 'string', required: true, description: 'the project folder' } },
    async run(args) {
      const root = trimPath(String(args.path ?? ''));
      if (!root) return { ok: false, error: 'Which project?' };
      const back = await restoreLatestBackup(platform, root, REPLACE_LABEL);
      if (!back.ok) return { ok: false, error: back.error };
      if ('none' in back) return { ok: true, message: `There is no replace to undo in ${baseName(root)}.` };
      return { ok: true, message: `Put back ${plural(back.restored.length, 'file')} (${back.restored.join(', ')}).`, data: { path: root, restored: back.restored } };
    },
  };

  const stats: Skill = {
    id: 'project.stats',
    label: 'Count a project’s code',
    icon: '📊',
    domain: 'project',
    description: 'Count the files and lines in a project by language, and list the biggest files. Read-only. Skips dependencies, lockfiles and build output.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['how many lines of code are in D:\\Dev\\MyApp', 'project stats for my project', 'count the lines of code in my project'],
    params: { path: { type: 'string', required: true, description: 'the project folder' } },
    async run(args) {
      const root = trimPath(String(args.path ?? ''));
      if (!root) return { ok: false, error: 'Which project?' };
      const got = await readProjectFiles(platform, root, isTextFile);
      if ('error' in got) return { ok: false, error: got.error };
      const s = projectStats(got.files);
      await current?.set(root).catch(() => undefined);
      return { ok: true, message: describeStats(baseName(root), s, got.skipped), data: s };
    },
  };

  const todos: Skill = {
    id: 'project.todos',
    label: 'Find TODOs in a project',
    icon: '📝',
    domain: 'project',
    description: 'List the TODO, FIXME, HACK and XXX notes in a project, with the file and line of each. Read-only.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['find the todos in D:\\Dev\\MyApp', 'list the todo comments in my project', 'show me the fixmes'],
    params: { path: { type: 'string', required: true, description: 'the project folder' } },
    async run(args) {
      const root = trimPath(String(args.path ?? ''));
      if (!root) return { ok: false, error: 'Which project?' };
      const got = await readProjectFiles(platform, root, isTextFile);
      if ('error' in got) return { ok: false, error: got.error };
      const hits = findTodos(got.files as ProjectFile[]);
      await current?.set(root).catch(() => undefined);
      return { ok: true, message: describeTodos(baseName(root), hits, got.skipped), data: { hits } };
    },
  };

  return [replaceAll, replaceAllUndo, stats, todos];
}
