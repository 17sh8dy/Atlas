/**
 * "downloads", "notes.txt in documents", "my work folder" → a real path.
 *
 * The file skills were written to take an explicit path, which is exactly what
 * nobody types. This is the one place a spoken place or name becomes a path, so
 * the new file skills (and, later, the old ones) resolve things the same way and
 * disagree about nothing.
 *
 * Resolution never guesses between candidates. A name that matches two files is
 * reported with both, and the person picks — because the next thing that
 * happens to the answer may be a rename or a delete.
 */

import type { FileEntry, KnownFolder, Memory, Platform } from '@atlas/core';

export type Resolved = { ok: true; path: string; isDirectory?: boolean } | { ok: false; error: string };

const PLACES: Array<[RegExp, KnownFolder]> = [
  [/^(?:downloads?|download folder)$/, 'downloads'],
  [/^(?:documents?|docs|documents folder)$/, 'documents'],
  [/^(?:desktop|desktop folder)$/, 'desktop'],
  [/^(?:pictures?|photos?|images|pictures folder)$/, 'pictures'],
  [/^(?:music|music folder)$/, 'music'],
  [/^(?:videos?|movies|videos folder)$/, 'videos'],
  [/^(?:home|home folder|user folder|my folder)$/, 'home'],
];

const ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\|~[\\/]?)/i;

/** Where bare names are looked for, in the order people keep things. */
const SEARCH_ORDER: KnownFolder[] = ['desktop', 'downloads', 'documents'];

function clean(s: string): string {
  return s
    .trim()
    .replace(/^["'“‘]|["'”’]$/g, '')
    .replace(/^(?:the|my|this|that)\s+/i, '')
    .trim();
}

function stem(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function list(files: FileEntry[]): string {
  return files
    .slice(0, 4)
    .map((f) => `${f.name} (${f.path.replace(/[\\/][^\\/]*$/, '')})`)
    .join('; ');
}

export async function resolvePlace(
  platform: Platform,
  memory: Memory | undefined,
  raw: string,
): Promise<Resolved | null> {
  // "downloads folder", "my documents directory" — the word for the place is what matters.
  const full = clean(raw).toLowerCase();
  const text = full.replace(/\s+(?:folder|directory|dir)$/, '');
  if (!text) return null;
  for (const [re, id] of PLACES) {
    if (re.test(text)) {
      if (!platform.knownFolder) return { ok: false, error: "I can't look up folders on this machine." };
      return { ok: true, path: await platform.knownFolder(id), isDirectory: true };
    }
  }
  // A remembered name may itself end in "folder" ("my work folder"), so try it as said first.
  const alias =
    (await memory?.fact('alias', full).catch(() => undefined)) ??
    (await memory?.fact('alias', text).catch(() => undefined));
  if (alias) return { ok: true, path: alias.value };
  return null;
}

/** Match a name against a folder's entries: exact, then same name without extension, then a unique "contains". */
function pick(entries: FileEntry[], wanted: string): { hit?: FileEntry; ambiguous?: FileEntry[] } {
  const w = wanted.toLowerCase();
  const exact = entries.filter((e) => e.name.toLowerCase() === w);
  if (exact.length === 1) return { hit: exact[0] };
  const sameStem = entries.filter((e) => stem(e.name).toLowerCase() === w);
  if (sameStem.length === 1) return { hit: sameStem[0] };
  if (sameStem.length > 1) return { ambiguous: sameStem };
  const contains = entries.filter((e) => e.name.toLowerCase().includes(w));
  if (contains.length === 1) return { hit: contains[0] };
  if (contains.length > 1) return { ambiguous: contains };
  return {};
}

export async function resolveTarget(
  platform: Platform,
  memory: Memory | undefined,
  spec: string,
): Promise<Resolved> {
  const raw = String(spec ?? '').trim().replace(/^["'“‘]|["'”’]$/g, '');
  if (!raw) return { ok: false, error: 'Which file or folder?' };
  if (ABSOLUTE.test(raw)) return { ok: true, path: raw };

  // "documents/atlaslivetest" or "documents\notes\a.txt": a relative path, said the way it is written.
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.length > 1 && !/\s(?:in|on|from)\s/i.test(raw)) {
    let at: Resolved = await resolveTarget(platform, memory, segments[0]!);
    for (const seg of segments.slice(1)) {
      if (!at.ok) return at;
      at = await resolveTarget(platform, memory, `${seg} in ${at.path}`);
    }
    return at;
  }

  // "notes in downloads", "budget.xlsx on the desktop", "report from documents"
  const inPlace = /^(.+?)\s+(?:in|on|from|inside|under)\s+(?:my\s+|the\s+)?(.+)$/i.exec(raw);
  if (inPlace) {
    // The place may itself be a folder named in words ("alpha.txt in atlaslivetest in documents").
    const base =
      (await resolvePlace(platform, memory, inPlace[2]!)) ??
      (await (async (): Promise<Resolved | null> => {
        const r = await resolveTarget(platform, memory, inPlace[2]!);
        return r.ok ? r : null;
      })());
    if (base && base.ok) {
      const entries = await platform.listDir?.(base.path, 2000).catch(() => [] as FileEntry[]);
      const { hit, ambiguous } = pick(entries ?? [], clean(inPlace[1]!));
      if (hit) return { ok: true, path: hit.path, isDirectory: hit.isDirectory };
      if (ambiguous) {
        return { ok: false, error: `That matches more than one thing in ${inPlace[2]}: ${list(ambiguous)}. Say which.` };
      }
      return { ok: false, error: `I can't find “${clean(inPlace[1]!)}” in ${inPlace[2]}.` };
    }
    if (base && !base.ok) return base;
  }

  const place = await resolvePlace(platform, memory, raw);
  if (place) return place;

  // A bare name: the usual places, in order, then the file index.
  const wanted = clean(raw);
  if (platform.knownFolder && platform.listDir) {
    const found: FileEntry[] = [];
    for (const id of SEARCH_ORDER) {
      const dir = await platform.knownFolder(id).catch(() => '');
      if (!dir) continue;
      const entries = await platform.listDir(dir, 2000).catch(() => [] as FileEntry[]);
      const { hit, ambiguous } = pick(entries, wanted);
      if (hit) found.push(hit);
      else if (ambiguous) found.push(...ambiguous);
    }
    if (found.length === 1) return { ok: true, path: found[0]!.path, isDirectory: found[0]!.isDirectory };
    if (found.length > 1) {
      const exact = found.filter((f) => f.name.toLowerCase() === wanted.toLowerCase() || stem(f.name).toLowerCase() === wanted.toLowerCase());
      if (exact.length === 1) return { ok: true, path: exact[0]!.path, isDirectory: exact[0]!.isDirectory };
      return { ok: false, error: `“${wanted}” could be more than one thing: ${list(found)}. Say which, or give the folder.` };
    }
  }
  if (platform.searchFiles) {
    const hits = await platform.searchFiles(wanted, { limit: 5 }).catch(() => [] as FileEntry[]);
    if (hits.length === 1) return { ok: true, path: hits[0]!.path, isDirectory: hits[0]!.isDirectory };
    if (hits.length > 1) {
      return { ok: false, error: `“${wanted}” could be more than one thing: ${list(hits)}. Say which, or give the folder.` };
    }
  }
  return { ok: false, error: `I couldn't find “${wanted}” in your Desktop, Downloads or Documents, or in a search of this PC. If you know where it is, say the folder (“${wanted} in a folder like D:/Projects”), or tell me the exact name.` };
}
