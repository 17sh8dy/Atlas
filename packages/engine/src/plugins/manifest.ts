/**
 * Plugins: data, never code.
 *
 * A plugin is a folder under Atlas's plugins folder holding one `plugin.json`. It can add project
 * templates (a starter for a game engine, a company's website skeleton, a classroom assignment) so
 * "build me a …" can write them. It can NOT run anything: nothing in a plugin folder is executed,
 * loaded as a script or handed to a shell. That is the whole security model, and this file is
 * where it is enforced — every byte of a manifest comes from outside Atlas, so it is validated
 * strictly before any of it is believed:
 *
 *  - plain data only (strings, lists); unknown fields are ignored, never acted on;
 *  - file paths are relative, short, free of `..`, drive letters, backslashes and reserved Windows
 *    names, with a cap on how many files and how large;
 *  - nothing executable can be written: no .exe/.bat/.cmd/.ps1/.vbs/.msi/.lnk/…, and no file an
 *    engine runs by itself when a project opens (Unreal's init_unreal.py);
 *  - a template cannot be a desktop (npm) project, because that would install whatever its
 *    package.json names; it cannot take a built-in's id; and the file it opens must be a document
 *    or a project file, not a program.
 *
 * Installing a plugin is still a decision to trust its author: a project it writes can contain
 * anything that is not on the list above, and the engine or browser that opens it will treat it as
 * the person's own. `plugin.list` shows what each one adds.
 */

import type { AppTemplate, TemplateFile, TemplateGroup, TemplateOptions } from '../templates/types';

export const LIMITS = {
  id: /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/,
  templatesPerPlugin: 20,
  filesPerTemplate: 60,
  fileBytes: 512 * 1024,
  templateBytes: 4 * 1024 * 1024,
  pathLength: 120,
  pathDepth: 8,
  wordsPerTemplate: 12,
  word: /^[a-z0-9][a-z0-9 -]{1,38}$/,
} as const;

const GROUPS: readonly TemplateGroup[] = ['game', 'tool', 'starter', 'engine'];

/** Programs, scripts and shortcuts a plugin may never write. */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'com', 'scr', 'msi', 'msp', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'hta',
  'lnk', 'url', 'reg', 'jar', 'sh', 'scf', 'cpl', 'gadget', 'appx', 'msix', 'sys', 'drv',
]);

/** Files an engine runs on its own when a project is opened. */
const BLOCKED_NAMES = new Set(['init_unreal.py', 'autoexec.bat', 'package.json', 'play.cmd']);

/** Files a "launch" may name: documents and project files, never a program. */
const LAUNCH_OK = /\.(?:html?|md|txt|uproject|godot|sln|unity)$/i;

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface ManifestFile {
  path: string;
  content: string;
}
export interface ManifestTemplate {
  id: string;
  label: string;
  summary: string;
  group: TemplateGroup;
  words: string[];
  launch: string;
  tip: string;
  files: ManifestFile[];
}
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  templates: ManifestTemplate[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

/**
 * Why a file path is not acceptable, or null. {{ID}} and {{PASCAL}} (the project's safe names) may
 * appear in a path; {{NAME}} may not, because it is free text and could hold anything.
 */
export function pathProblem(raw: string): string | null {
  if (!raw || raw.length > LIMITS.pathLength) return 'is empty or too long';
  if (raw.includes('\\')) return 'uses a backslash (use / between folders)';
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return 'is not relative';
  for (const ch of raw) {
    if (ch.charCodeAt(0) < 32 || '<>:"|?*'.includes(ch)) return 'has a character Windows does not allow';
  }
  const withoutPlaceholders = raw.replace(/\{\{(?:ID|PASCAL)\}\}/g, 'x');
  if (/[{}]/.test(withoutPlaceholders)) return 'has a { or } that is not {{ID}} or {{PASCAL}} (a path cannot use {{NAME}})';
  const parts = raw.split('/');
  if (parts.length > LIMITS.pathDepth) return 'is nested too deeply';
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return 'has an empty, "." or ".." part';
    if (/[. ]$/.test(part)) return 'has a part ending in a dot or space';
    if (RESERVED.test(part.replace(/\{\{[A-Z]+\}\}/g, 'x'))) return 'uses a name Windows reserves';
  }
  const last = parts[parts.length - 1]!.toLowerCase();
  const ext = last.includes('.') ? last.split('.').pop()! : '';
  if (BLOCKED_EXTENSIONS.has(ext)) return `would write a program or shortcut (.${ext})`;
  if (BLOCKED_NAMES.has(last)) return `would write ${last}, which something runs by itself`;
  return null;
}

export type ParseResult = { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] };

export function parseManifest(json: string, folder: string): ParseResult {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, errors: ['plugin.json is not valid JSON.'] };
  }
  if (!isRecord(raw)) return { ok: false, errors: ['plugin.json must be an object.'] };

  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!LIMITS.id.test(id)) errors.push('"id" must be 3-40 lower-case letters, digits and dashes, starting with a letter.');
  else if (id !== folder.toLowerCase()) errors.push(`"id" (${id}) must match the folder name (${folder}).`);
  const name = str(raw.name, 60);
  if (!name) errors.push('"name" is required (up to 60 characters).');
  const version = str(raw.version, 30);
  if (!version) errors.push('"version" is required, like "1.0.0".');
  const description = str(raw.description, 400) ?? '';
  const author = str(raw.author, 80) ?? '';

  const templates: ManifestTemplate[] = [];
  const list = raw.templates;
  if (list !== undefined && !Array.isArray(list)) errors.push('"templates" must be a list.');
  else if (Array.isArray(list)) {
    if (list.length > LIMITS.templatesPerPlugin) errors.push(`A plugin can add at most ${LIMITS.templatesPerPlugin} templates.`);
    const seen = new Set<string>();
    list.slice(0, LIMITS.templatesPerPlugin).forEach((t, i) => {
      const at = `templates[${i}]`;
      if (!isRecord(t)) { errors.push(`${at} must be an object.`); return; }
      const before = errors.length;
      const tid = typeof t.id === 'string' ? t.id : '';
      if (!LIMITS.id.test(tid)) errors.push(`${at}: "id" must be 3-40 lower-case letters, digits and dashes.`);
      else if (seen.has(tid)) errors.push(`${at}: the id "${tid}" is used twice.`);
      seen.add(tid);
      const label = str(t.label, 60), summary = str(t.summary, 300), tip = str(t.tip, 300) ?? '';
      if (!label) errors.push(`${at}: "label" is required, like "a company website".`);
      if (!summary) errors.push(`${at}: "summary" is required.`);
      const group = t.group as TemplateGroup;
      if (!GROUPS.includes(group)) errors.push(`${at}: "group" must be one of ${GROUPS.join(', ')}.`);
      if (t.desktop === true) errors.push(`${at}: a plugin template cannot be a desktop project (it would install packages).`);

      const words: string[] = [];
      if (!Array.isArray(t.words) || !t.words.length) errors.push(`${at}: "words" needs at least one phrase people will say.`);
      else {
        if (t.words.length > LIMITS.wordsPerTemplate) errors.push(`${at}: at most ${LIMITS.wordsPerTemplate} words.`);
        for (const w of t.words.slice(0, LIMITS.wordsPerTemplate)) {
          const word = typeof w === 'string' ? w.trim().toLowerCase() : '';
          if (!LIMITS.word.test(word)) errors.push(`${at}: the word ${JSON.stringify(w)} must be 2-40 letters, digits, spaces or dashes.`);
          else words.push(word);
        }
      }

      const files: ManifestFile[] = [];
      let bytes = 0;
      if (!Array.isArray(t.files) || !t.files.length) errors.push(`${at}: "files" needs at least one file.`);
      else {
        if (t.files.length > LIMITS.filesPerTemplate) errors.push(`${at}: at most ${LIMITS.filesPerTemplate} files.`);
        const paths = new Set<string>();
        t.files.slice(0, LIMITS.filesPerTemplate).forEach((f, j) => {
          if (!isRecord(f) || typeof f.path !== 'string' || typeof f.content !== 'string') { errors.push(`${at}.files[${j}] needs a "path" and a "content" string.`); return; }
          const problem = pathProblem(f.path);
          if (problem) { errors.push(`${at}.files[${j}]: the path ${JSON.stringify(f.path)} ${problem}.`); return; }
          if (paths.has(f.path.toLowerCase())) { errors.push(`${at}.files[${j}]: ${JSON.stringify(f.path)} is listed twice.`); return; }
          paths.add(f.path.toLowerCase());
          const size = new TextEncoder().encode(f.content).length;
          if (size > LIMITS.fileBytes) { errors.push(`${at}.files[${j}]: larger than ${LIMITS.fileBytes / 1024} KB.`); return; }
          bytes += size;
          files.push({ path: f.path, content: f.content });
        });
        if (bytes > LIMITS.templateBytes) errors.push(`${at}: its files add up to more than ${LIMITS.templateBytes / 1024 / 1024} MB.`);
      }

      const launch = typeof t.launch === 'string' ? t.launch : '';
      if (!LAUNCH_OK.test(launch) || pathProblem(launch)) errors.push(`${at}: "launch" must be a document or project file (.html, .md, .txt, .uproject, .godot, .sln).`);
      else if (files.length && !files.some((f) => f.path === launch)) errors.push(`${at}: "launch" (${launch}) is not one of its files.`);

      if (errors.length === before && label && summary) {
        templates.push({ id: tid, label, summary, group, words, launch, tip, files });
      }
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: { id, name: name!, version: version!, description, author, templates } };
}

const fill = (text: string, o: TemplateOptions) =>
  text.replace(/\{\{NAME\}\}/g, o.name).replace(/\{\{ID\}\}/g, o.id).replace(/\{\{PASCAL\}\}/g, o.pascal ?? o.id);

/** A plugin's templates, as the registry wants them. They write plain files and nothing else. */
export function manifestTemplates(m: PluginManifest): AppTemplate[] {
  return m.templates.map((t) => ({
    id: t.id,
    label: t.label,
    summary: t.summary,
    group: t.group,
    words: t.words,
    desktop: false,
    launch: t.launch,
    launchFile: (o: TemplateOptions) => fill(t.launch, o),
    tip: t.tip || `From the ${m.name} plugin.`,
    source: m.id,
    files(o: TemplateOptions): TemplateFile[] {
      return t.files.map((f) => ({ path: fill(f.path, o), content: fill(f.content, o) }));
    },
  }));
}
