/**
 * Working out how a folder should be tidied — and nothing else.
 *
 * Pure: it takes a listing and returns a plan, touching no disk. That is what
 * lets `files.organize` show the plan on the confirmation card *before*
 * anything moves (`Skill.preview`), and lets `run` re-derive the identical plan
 * afterwards to check nothing changed underneath the approval. It is also why
 * the whole thing is testable without a filesystem.
 *
 * ── What it will and won't do, on purpose ───────────────────────────────────
 *  - **Only loose files, only directly inside the folder.** Folders are never
 *    moved and nothing is recursed into: a project directory that happens to
 *    sit in Downloads is one unit, and tearing it apart by extension is the
 *    kind of tidy-up nobody forgives.
 *  - **Nothing it doesn't recognise is moved.** A catch-all "Other" folder is
 *    the usual answer, and it turns a tidy folder into a tidy folder plus a
 *    junk drawer. Unrecognised files stay where they are and are *counted*, so
 *    the report says what was left rather than hiding it.
 *  - **A file that is still arriving is left alone.** Half a download renamed
 *    into `Installers` is a corrupt installer; `.crdownload`/`.part` files and
 *    anything modified in the last two minutes are skipped and reported.
 *  - **Nothing is ever overwritten or deleted.** A name clash becomes
 *    `name (2).ext`. Deleting is a different skill with a different card.
 */

import type { FileEntry } from '@atlas/core';

export type CategoryId =
  | 'installers'
  | 'diskImages'
  | 'archives'
  | 'images'
  | 'videos'
  | 'audio'
  | 'documents'
  | 'spreadsheets'
  | 'presentations'
  | 'code'
  | 'fonts';

/** The folder a category lands in when the person named none. */
export const DEFAULT_FOLDER: Record<CategoryId, string> = {
  installers: 'Installers',
  diskImages: 'Disk Images',
  archives: 'Archives',
  images: 'Images',
  videos: 'Videos',
  audio: 'Audio',
  documents: 'Documents',
  spreadsheets: 'Spreadsheets',
  presentations: 'Presentations',
  code: 'Code',
  fonts: 'Fonts',
};

const EXTENSIONS: Record<CategoryId, readonly string[]> = {
  installers: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle'],
  diskImages: ['iso', 'img', 'vhd', 'vhdx'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
  images: [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tif', 'tiff', 'ico', 'avif',
    'raw', 'cr2', 'nef',
  ],
  videos: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'webm', 'flv', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
  documents: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'md', 'epub'],
  spreadsheets: ['xls', 'xlsx', 'csv', 'ods'],
  presentations: ['ppt', 'pptx', 'odp', 'key'],
  code: [
    'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'c', 'cpp', 'h', 'cs', 'java', 'go', 'json', 'html',
    'css', 'sh', 'ps1', 'bat', 'xml', 'yml', 'yaml',
  ],
  fonts: ['ttf', 'otf', 'woff', 'woff2'],
};

const BY_EXTENSION = new Map<string, CategoryId>();
for (const [category, exts] of Object.entries(EXTENSIONS) as Array<[CategoryId, readonly string[]]>) {
  for (const ext of exts) BY_EXTENSION.set(ext, category);
}

/** Which category a file belongs to, or `null` when it is not one Atlas knows. */
export function categorize(ext: string): CategoryId | null {
  return BY_EXTENSION.get(ext.toLowerCase()) ?? null;
}

/**
 * Words people use for a category → the category. Singular and plural both,
 * because "put installer files in Software" and "installers in Software" are
 * the same sentence.
 */
const ALIASES: Record<string, CategoryId> = {
  installers: 'installers', installer: 'installers', setups: 'installers', setup: 'installers',
  programs: 'installers', software: 'installers', apps: 'installers', executables: 'installers',
  images: 'images', image: 'images', pictures: 'images', picture: 'images', photos: 'images',
  photo: 'images', pics: 'images', screenshots: 'images', screenshot: 'images',
  videos: 'videos', video: 'videos', movies: 'videos', clips: 'videos',
  audio: 'audio', music: 'audio', songs: 'audio', sounds: 'audio',
  documents: 'documents', document: 'documents', docs: 'documents', pdfs: 'documents',
  pdf: 'documents', text: 'documents',
  spreadsheets: 'spreadsheets', spreadsheet: 'spreadsheets', sheets: 'spreadsheets',
  presentations: 'presentations', presentation: 'presentations', slides: 'presentations',
  archives: 'archives', archive: 'archives', zips: 'archives', zip: 'archives',
  code: 'code', scripts: 'code', script: 'code', source: 'code',
  fonts: 'fonts', font: 'fonts',
  'disk images': 'diskImages', 'disk image': 'diskImages', isos: 'diskImages', iso: 'diskImages',
};

/** "installer files" / "all my images" → the category, ignoring filler words. */
function categoryFromPhrase(phrase: string): CategoryId | null {
  const cleaned = phrase
    .toLowerCase()
    .replace(/\b(?:all|any|the|my|of|files?|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[cleaned] ?? null;
}

export interface ParsedRules {
  /** Category → the folder the person asked for. */
  folders: Partial<Record<CategoryId, string>>;
  /** Clauses that could not be understood — reported, never silently dropped. */
  unknown: string[];
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const FORBIDDEN_IN_NAME = /[<>:"|?*\\/]/;

/** A valid single folder name, or an absolute path Rust will vet. */
export function isUsableDestination(dest: string): boolean {
  if (!dest.trim()) return false;
  if (ABSOLUTE.test(dest)) return !dest.split(/[\\/]/).includes('..');
  return !FORBIDDEN_IN_NAME.test(dest) && dest !== '.' && dest !== '..' && !/[. ]$/.test(dest);
}

/**
 * "installers in Software, images in Images" → a category → folder table.
 *
 * Deliberately strict about what it accepts: an instruction it half-understood
 * is reported back as `unknown` and the caller refuses, because carrying out
 * the part it caught and quietly ignoring the rest is precisely how a tidy-up
 * ends with files in places nobody asked for.
 */
export function parseOrganizeRules(text: string): ParsedRules {
  const folders: Partial<Record<CategoryId, string>> = {};
  const unknown: string[] = [];
  const source = text.trim();
  if (!source) return { folders, unknown };

  // Quoted folder names survive splitting on "and" and commas.
  const quotes: string[] = [];
  const masked = source.replace(/["“]([^"”]+)["”]/g, (_m, name: string) => {
    quotes.push(name);
    return `${quotes.length - 1}`;
  });

  for (const raw of masked.split(/\s*(?:,|;|\band\b(?=\s+\S+\s+(?:in|into|to)\b))\s*/i)) {
    const clause = raw.trim().replace(/[.!?]+$/, '');
    if (!clause) continue;
    const m = clause.match(
      /^(?:(?:put|move|sort|file|send|keep)\s+)?(.+?)\s+(?:in|into|to|under)\s+(?:a\s+|the\s+)?(?:folder\s+)?(?:called\s+|named\s+)?(.+)$/i,
    );
    const restore = (s: string) => s.replace(/(\d+)/g, (_x, i: string) => quotes[Number(i)]!);
    if (!m) {
      unknown.push(restore(clause));
      continue;
    }
    const category = categoryFromPhrase(restore(m[1]!));
    const dest = restore(m[2]!).trim();
    if (!category || !isUsableDestination(dest)) {
      unknown.push(restore(clause));
      continue;
    }
    folders[category] = dest;
  }
  return { folders, unknown };
}

// ---- the plan ------------------------------------------------------------

export interface PlannedMove {
  from: string;
  to: string;
  name: string;
  category: CategoryId;
  /** The destination folder, as it will be shown. */
  destFolder: string;
}

export interface OrganizePlan {
  folder: string;
  moves: PlannedMove[];
  /** Destination folders that do not exist yet and will be created. */
  newFolders: string[];
  left: {
    folders: number;
    unfinished: number;
    recent: number;
    unrecognised: number;
    hidden: number;
  };
  /** The listing was cut off at the cap — there may be more files than this. */
  truncated: boolean;
  /** Changes if anything the plan depends on changes. */
  fingerprint: string;
}

/** Downloads in progress. Anything ending like this is not yet a file. */
const UNFINISHED = new Set(['crdownload', 'part', 'partial', 'tmp', 'download', 'opdownload']);
const HIDDEN_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

/** Modified this recently means still being written. */
export const RECENT_MS = 2 * 60 * 1000;

export function sepOf(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function dirnameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return cut > 0 ? trimmed.slice(0, cut) : trimmed;
}

/** FNV-1a — not security, just "did anything in this list change". */
export function fingerprintOf(lines: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 1) {
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 10;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** `setup.exe` → `setup (2).exe`, `setup (3).exe`, … the first one not taken. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface PlanInput {
  folder: string;
  entries: readonly FileEntry[];
  folders: Partial<Record<CategoryId, string>>;
  /** Names already present in each destination folder, lowercased. Absent = new. */
  existing: ReadonlyMap<string, ReadonlySet<string>>;
  now: number;
  truncated?: boolean;
}

/** Where a category's files go: the person's folder, or the default one. */
export function destinationFor(
  folder: string,
  category: CategoryId,
  chosen: Partial<Record<CategoryId, string>>,
): string {
  const dest = chosen[category] ?? DEFAULT_FOLDER[category];
  return ABSOLUTE.test(dest) ? dest.replace(/[\\/]+$/, '') : joinPath(folder, dest);
}

export function planOrganize(input: PlanInput): OrganizePlan {
  const left = { folders: 0, unfinished: 0, recent: 0, unrecognised: 0, hidden: 0 };
  const moves: PlannedMove[] = [];
  const claimed = new Map<string, Set<string>>();

  const files = [...input.entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of files) {
    if (entry.isDirectory) {
      left.folders += 1;
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (entry.name.startsWith('.') || HIDDEN_NAMES.has(lower)) {
      left.hidden += 1;
      continue;
    }
    if (UNFINISHED.has(entry.ext.toLowerCase())) {
      left.unfinished += 1;
      continue;
    }
    if (entry.modifiedAt !== undefined && input.now - entry.modifiedAt < RECENT_MS) {
      left.recent += 1;
      continue;
    }
    const category = categorize(entry.ext);
    if (!category) {
      left.unrecognised += 1;
      continue;
    }

    const destDir = destinationFor(input.folder, category, input.folders);
    let taken = claimed.get(destDir);
    if (!taken) {
      taken = new Set(input.existing.get(destDir) ?? []);
      claimed.set(destDir, taken);
    }
    const finalName = uniqueName(entry.name, taken);
    taken.add(finalName.toLowerCase());

    moves.push({
      from: entry.path,
      to: joinPath(destDir, finalName),
      name: entry.name,
      category,
      destFolder: destDir,
    });
  }

  const newFolders = [...new Set(moves.map((m) => m.destFolder))].filter(
    (dir) => !input.existing.has(dir),
  );

  return {
    folder: input.folder,
    moves,
    newFolders,
    left,
    truncated: input.truncated ?? false,
    fingerprint: fingerprintOf([...newFolders, ...moves.map((m) => `${m.from}>${m.to}`)]),
  };
}
