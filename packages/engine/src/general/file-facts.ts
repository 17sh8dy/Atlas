/**
 * Questions about the files on this PC: "how many folders are there in: D:\Dev?", "what's the newest file in my
 * downloads", "does D:\Dev\Atlas exist", "how many mp4 files are in D:\Videos".
 *
 * Pure text → request. The skill that answers is `files.facts` (skills/file-facts-skills.ts); this file only
 * decides whether a sentence IS such a question and what exactly it asks. Read-only by construction: nothing
 * here can name an action that changes a file.
 *
 * ── Why a parser and not a list of phrasings ──────────────────────────────────────────────────────────
 * "How many folders are there in: D:\Dev?" was refused with "I couldn't reach your language model", although
 * no model is needed to count folders. The fix is not that sentence; it is the shape: a count word, a kind of
 * thing, and a place. Whatever order they come in, with whatever filler, they are read the same way.
 */

export type FileFactThing = 'folders' | 'files' | 'items' | 'ext';

export type FileFactRequest =
  | {
      op: 'count';
      path: string;
      thing: FileFactThing;
      exts?: string[];
      label?: string;
      deep?: boolean;
    }
  | {
      op: 'extreme';
      path: string;
      which: 'newest' | 'oldest' | 'largest' | 'smallest';
      thing: 'folders' | 'files' | 'items';
    }
  | { op: 'exists'; path: string; name?: string }
  | { op: 'list'; path: string; thing: 'folders' | 'files' }
  | { op: 'modified'; path: string }
  | { op: 'drives' };

/** Words that stand for a set of extensions: "how many photos are in …". */
const CATEGORY: Record<string, { exts: string[]; label: string }> = {
  photos: {
    exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'tif', 'tiff', 'raw'],
    label: 'photos',
  },
  pictures: {
    exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'tif', 'tiff', 'raw'],
    label: 'pictures',
  },
  images: {
    exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'tif', 'tiff', 'svg'],
    label: 'images',
  },
  videos: { exts: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'flv', 'm4v'], label: 'videos' },
  movies: { exts: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'm4v'], label: 'movies' },
  songs: { exts: ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac', 'wma', 'opus'], label: 'songs' },
  music: { exts: ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac', 'wma', 'opus'], label: 'music files' },
  documents: {
    exts: ['doc', 'docx', 'pdf', 'txt', 'rtf', 'odt', 'md', 'xls', 'xlsx', 'ppt', 'pptx'],
    label: 'documents',
  },
  pdfs: { exts: ['pdf'], label: 'PDFs' },
  spreadsheets: { exts: ['xls', 'xlsx', 'csv', 'ods'], label: 'spreadsheets' },
  archives: { exts: ['zip', '7z', 'rar', 'tar', 'gz'], label: 'archives' },
  zips: { exts: ['zip'], label: 'zip files' },
  executables: { exts: ['exe', 'msi'], label: 'executables' },
  installers: { exts: ['exe', 'msi'], label: 'installers' },
};

/** "largest files", "newest folder", "most recent": those have skills of their own (storage.*, files.recent). */
const SUPERLATIVE =
  /\b(?:largest|biggest|smallest|heaviest|tiniest|newest|oldest|latest|earliest|most|least|recent(?:ly)?|top)\b/;

/** "in total", "including subfolders", "recursively": the person wants everything underneath, which means walking it. */
const DEEP =
  /\b(?:in total|altogether|in all|including\s+(?:all\s+)?(?:the\s+)?(?:sub-?folders?|sub-?directories|everything)|(?:and|with)\s+(?:all\s+)?(?:the\s+)?sub-?folders?|recursive(?:ly)?|nested|every(?:thing)?\s+(?:inside|under|within)|all\s+(?:the\s+)?sub-?(?:folders?|directories))\b/;

const KNOWN = ['downloads', 'documents', 'desktop', 'pictures', 'music', 'videos', 'home'] as const;

const PATH_RE =
  /("[a-z]:[\\/][^"]*"|[a-z]:[\\/][^\s"]*[^\s".,;:!?]|[a-z]:[\\/]|\b[a-z]:(?![\\/\w]))/i;

interface Located {
  path: string;
  rest: string;
}

/** The place a sentence names: a drive path, a bare drive ("on D:"), or "my downloads folder". */
function locate(raw: string): Located | null {
  const m = PATH_RE.exec(raw);
  if (m) {
    let path = m[1]!.trim().replace(/^"|"$/g, '');
    if (/^[a-z]:$/i.test(path)) path = `${path}\\`;
    else if (!/^[a-z]:[\\/]$/i.test(path)) path = path.replace(/[\\/]+$/, '');
    const rest = `${raw.slice(0, m.index)} ${raw.slice(m.index + m[0].length)}`
      .replace(/\s+/g, ' ')
      .trim();
    return { path, rest };
  }
  const k = new RegExp(
    String.raw`\b(?:my|the)\s+(${KNOWN.join('|')})(?:\s+(?:folder|directory))?\b|\b(${KNOWN.join('|')})\s+(?:folder|directory)\b`,
    'i',
  ).exec(raw);
  if (k) {
    const name = (k[1] ?? k[2])!.toLowerCase();
    const rest = `${raw.slice(0, k.index)} ${raw.slice(k.index + k[0].length)}`
      .replace(/\s+/g, ' ')
      .trim();
    return { path: name, rest };
  }
  return null;
}

function thingOf(text: string): { thing: FileFactThing; exts?: string[]; label?: string } | null {
  const t = text.toLowerCase();
  // "mp4 files", ".png images", "how many pdfs"
  const ext =
    /\.?\b([a-z0-9]{2,5})\s+(?:files?|documents?|images?|videos?)\b|\bfiles?\s+(?:ending|with)\s+(?:in\s+|the\s+)?(?:extension\s+)?\.?([a-z0-9]{2,5})\b|\*\.([a-z0-9]{1,5})\b|\.([a-z0-9]{2,5})\s+files?\b/.exec(
      t,
    );
  const extWord = ext ? (ext[1] ?? ext[2] ?? ext[3] ?? ext[4])! : null;
  const generic = new Set([
    'all',
    'the',
    'any',
    'how',
    'many',
    'my',
    'these',
    'those',
    'of',
    'text',
    'image',
    'video',
    'audio',
    'music',
    'media',
    'big',
    'hidden',
    'new',
    'old',
    'large',
    'small',
    'empty',
    'there',
    'are',
    'is',
    'total',
    'some',
    'what',
    'which',
    'and',
    'or',
    'in',
    'on',
    'files',
    'file',
    'folder',
    'folders',
  ]);
  if (extWord && !generic.has(extWord) && !CATEGORY[extWord])
    return { thing: 'ext', exts: [extWord], label: `.${extWord} files` };
  for (const [word, def] of Object.entries(CATEGORY)) {
    if (new RegExp(String.raw`\b${word}\b`).test(t))
      return { thing: 'ext', exts: def.exts, label: def.label };
  }
  if (/\b(?:sub-?folders?|sub-?directories|folders?|directories|dirs?)\b/.test(t))
    return { thing: 'folders' };
  if (/\bfiles?\b/.test(t)) return { thing: 'files' };
  if (/\b(?:items?|things?|entries|objects?|stuff|contents?)\b/.test(t)) return { thing: 'items' };
  return null;
}

/**
 * Read a sentence as a question about files. Null when it is not one — which includes any question that
 * names no place (there is nothing to look at) and anything asking to change something.
 */
export function parseFileQuestion(raw: string): FileFactRequest | null {
  const text = raw.trim();
  if (!text || text.length > 240) return null;
  // Something to DO, not to know: those are other rules' business and must never be read as a question.
  if (
    /^\s*(?:please\s+)?(?:delete|remove|move|copy|rename|clean|empty|organi[sz]e|sort|zip|unzip|extract|create|make|open|launch|run|install|uninstall|download|upload|send|write|edit|save)\b/i.test(
      text,
    )
  )
    return null;

  const lowerAll = text.toLowerCase();

  // "what drives do I have", "list my drives", "which drive has the most space"
  if (
    /\b(?:what|which|list|show)\b.*\bdrives?\b|\bhow many\s+(?:drives|disks|hard drives|partitions)\b|\bdrives?\s+(?:do i have|are there|are connected|are installed)\b/.test(
      lowerAll,
    ) &&
    !/\bgoogle drive\b|\bonedrive\b/.test(lowerAll) &&
    !locate(text)
  ) {
    return { op: 'drives' };
  }

  const where = locate(text);
  if (!where) return null;
  const rest = where.rest
    .toLowerCase()
    .replace(/[?!.]+\s*$/, '')
    .trim();

  // ---- exists -------------------------------------------------------------------------------------
  const exists =
    /^(?:does|do|is|are)\b.*\b(?:exist|exists)\b/.test(rest) ||
    /^(?:is there|are there|do i have|does .{0,20} have|is)\s+(?:a|an|any|the)?\s*(?:folder|file|directory|subfolder|project)\b/.test(
      rest,
    ) ||
    /\b(?:exist|exists)\s*$/.test(rest) ||
    /^(?:does|do)\s+\S*\s*(?:exist|exists)\b/.test(rest);
  if (exists && !/\bhow many\b/.test(rest)) {
    const named =
      /\b(?:called|named|titled)\s+"?([^"?]+?)"?\s*(?:$|\s+(?:in|inside|within|under|on|at)\b)/.exec(
        where.rest,
      );
    if (named) return { op: 'exists', path: where.path, name: named[1]!.trim() };
    const bare =
      /^(?:is there|are there|do i have|does .{0,20} have)\s+(?:a|an|any|the)?\s*(?:folder|file|directory|subfolder|project)\s+"?([\w .\-+]{1,60}?)"?\s*(?:$|\s+(?:in|inside|within|under|on|at)\b)/.exec(
        rest,
      );
    if (bare && bare[1] && !/^(?:folder|file|directory|called|named|any)$/.test(bare[1]))
      return { op: 'exists', path: where.path, name: bare[1]!.trim() };
    return { op: 'exists', path: where.path };
  }

  // ---- when was it last changed -------------------------------------------------------------------
  if (
    /\b(?:when|what (?:day|date|time))\b.*\b(?:last\s+)?(?:modified|changed|updated|edited|touched|written)\b|\blast\s+(?:modified|changed|updated|edited)\b/.test(
      rest,
    )
  ) {
    return { op: 'modified', path: where.path };
  }

  // ---- newest / oldest (the biggest are storage.largestFiles / largestFolders's) ------------------------------------------------------------------
  const ex =
    /\b(newest|latest|most recent(?:ly (?:changed|modified|updated|created))?|last modified|oldest|earliest)\b[^a-z]+(?:\w+\s+){0,2}?(files?|folders?|directories|items?|things?|documents?|downloads?)\b/.exec(
      rest,
    );
  if (
    ex &&
    /^(?:what|which|whats|what's|show|tell|find|get|give|name|is)\b|\b(?:what|which)\b/.test(rest)
  ) {
    const w = ex[1]!;
    const which = /^(?:newest|latest|most recent|last modified)/.test(w)
      ? 'newest'
      : /oldest|earliest/.test(w)
        ? 'oldest'
        : 'newest';
    const noun = ex[2]!;
    const thing = /^folder|^director/.test(noun)
      ? 'folders'
      : /^file|^document|^download/.test(noun)
        ? 'files'
        : 'items';
    return { op: 'extreme', path: where.path, which, thing };
  }

  // ---- list the folders / files in a place ----------------------------------------------------------
  // Only when a kind of thing is named ("list the folders in …"); "what's in X" is the plain listing's.
  const lister =
    /^(?:please\s+)?(?:list|show|display|give me|tell me|name|what|whats|what's|which)\b/.test(
      rest,
    ) &&
    !/\bhow many\b/.test(rest) &&
    !SUPERLATIVE.test(rest);
  if (lister) {
    const folderWord = /\b(?:sub-?folders?|sub-?directories|folders?|directories)\b/.test(rest);
    const fileWord = /\bfiles\b/.test(rest);
    if (folderWord !== fileWord)
      return { op: 'list', path: where.path, thing: folderWord ? 'folders' : 'files' };
  }

  // ---- how many -----------------------------------------------------------------------------------
  if (
    /\bhow many\b|\b(?:number|count|total|amount)\s+of\b|^count\b|\bcount\s+(?:the\s+)?(?:files|folders|items)\b|\bhow much stuff\b/.test(
      rest,
    ) ||
    /^(?:what|whats|what's)\s+(?:is\s+)?(?:the\s+)?(?:number|count|total)\b/.test(rest)
  ) {
    const t = thingOf(rest);
    if (t)
      return { op: 'count', path: where.path, ...t, ...(DEEP.test(rest) ? { deep: true } : {}) };
    // "how many are there in D:\Dev" — everything.
    if (/\b(?:are there|is there|do i have|have i got|do we have)\b/.test(rest))
      return {
        op: 'count',
        path: where.path,
        thing: 'items',
        ...(DEEP.test(rest) ? { deep: true } : {}),
      };
  }
  return null;
}
