/**
 * Context a person hands Atlas alongside a message — a file, an image, a
 * screenshot, a frame of a shared screen.
 *
 * ── An attachment is a reference, not a payload ──────────────────────────────
 * The tempting shape is "read the file, paste it into the prompt". This is
 * deliberately not that. An attachment records *what you pointed at* — path,
 * name, kind, size — and nothing more. Atlas's own skills already know how to
 * act on a path (`files.readText`, `files.info`, `files.move`, `files.peek`),
 * so pointing at a file makes every one of them available for it without a
 * model being involved at all.
 *
 * Reading the contents is therefore a **separate, deliberate action**, offered
 * only where it is genuinely supported (`canExtractText`). That split is what
 * keeps three promises at once: a 400 MB video can be attached without
 * anything trying to read it, the 256 KB cap on `files.readText` is respected
 * rather than bypassed, and a PDF is honestly labelled as not-yet-extractable
 * instead of silently producing mojibake.
 *
 * ── Images ──────────────────────────────────────────────────────────────────
 * An image attachment carries `dataUrl` because it has to be *shown* — in the
 * composer as a thumbnail, in the transcript as what was sent. It is not
 * carried in order to be sent anywhere. Nothing in this build can interpret an
 * image: the intelligence port is `ask(prompt: string, …)` with no image
 * channel, and the local models are text models. `VisionContext` below is the shape a
 * provider would have to satisfy, declared so the seam is real and typed
 * rather than imagined — see `docs/ARCHITECTURE.md` §9.
 */

export type AttachmentKind =
  /** Something on disk, pointed at by path. */
  | 'file'
  /** An image on disk, pointed at by path, and previewable. */
  | 'image'
  /** A capture taken by Atlas: whole desktop, one display, or one window. */
  | 'screenshot'
  /** The current frame of a live screen share. */
  | 'frame';

/** Why an attachment's text is or isn't available. */
export type ExtractionState =
  /** Text can be read from this, and hasn't been asked for yet. */
  | 'available'
  /** The person asked, and it worked. `text` is populated. */
  | 'extracted'
  /** Readable in principle, but larger than `files.readText` will return. */
  | 'too-large'
  /** No extractor exists for this format yet. Not a failure — an absence. */
  | 'unsupported'
  /** Tried and failed; `extractionError` says why. */
  | 'failed';

export interface Attachment {
  /** Stable for the lifetime of the composer draft; used as a React key too. */
  id: string;
  kind: AttachmentKind;
  /** What to show: a file name, "Screen 1", a window title. */
  name: string;
  /**
   * Where it is on disk. Absent for a capture that was never saved — a
   * screenshot lives in memory until something asks for it on disk.
   */
  path?: string;
  /** Lowercase, no dot. Empty for a capture. */
  ext: string;
  sizeBytes?: number;
  /** Only for something previewable. PNG data URL. */
  dataUrl?: string;
  width?: number;
  height?: number;
  /** Epoch ms. */
  addedAt: number;
  /** Where a capture came from, so the chip can say "Screen 2" or the window title. */
  source?: string;
  extraction: ExtractionState;
  /** Populated only once extraction has actually run. */
  text?: string;
  /** Present when `extraction` is `failed`. */
  extractionError?: string;
  /** True when `text` is a prefix of a larger file rather than the whole thing. */
  truncated?: boolean;
}

/**
 * Formats `files.readText` returns usefully as text.
 *
 * Deliberately a list rather than "anything that isn't binary". Guessing wrong
 * turns a `.docx` — which is a zip — into several screens of mojibake, and the
 * person who attached it learns nothing except that Atlas is unreliable.
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php', 'lua', 'sh', 'bash', 'zsh',
  'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql', 'proto',
  'html', 'htm', 'css', 'scss', 'less', 'svg', 'xml', 'vue', 'svelte', 'astro',
  'gitignore', 'dockerfile', 'makefile', 'lock', 'diff', 'patch',
]);

export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic', 'tif', 'tiff',
]);

/**
 * Formats a person will reasonably expect to work, and that don't yet.
 *
 * Named specifically so the UI can say "PDF text extraction isn't built yet"
 * rather than the uninformative "unsupported" every unknown extension gets.
 * Each one is a real pipeline somebody has to write — a PDF parser, a zip
 * reader for OOXML — and naming them is how the gap stays visible.
 */
export const EXTRACTION_NOT_BUILT_YET = new Set([
  'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'rtf', 'epub',
]);

/** The cap in `platform.readTextFile`, mirrored so the UI can explain a refusal before making it. */
export const MAX_EXTRACTABLE_BYTES = 256 * 1024;

export function extensionOf(nameOrPath: string): string {
  const base = String(nameOrPath ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // A dotfile (".gitignore") is named by its whole self, not by an empty
  // extension — and `.gitignore` is in the text list above precisely so it
  // reads as extractable.
  if (dot <= 0) return base.toLowerCase().replace(/^\./, '');
  return base.slice(dot + 1).toLowerCase();
}

export function isImageFile(nameOrPath: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(nameOrPath));
}

/**
 * Whether text could be read from this, and if not, why — the single place
 * that question is answered, so the chip's label, the menu item's enabled
 * state and the extraction itself can never disagree.
 */
export function extractionStateFor(ext: string, sizeBytes?: number): ExtractionState {
  const e = ext.toLowerCase();
  if (!TEXT_EXTENSIONS.has(e)) return 'unsupported';
  if (sizeBytes !== undefined && sizeBytes > MAX_EXTRACTABLE_BYTES) return 'too-large';
  return 'available';
}

/** One short line for the chip: "12 KB · TXT", "PDF · text not extractable yet". */
export function describeAttachment(a: Attachment): string {
  const parts: string[] = [];
  if (a.width && a.height) parts.push(`${a.width}×${a.height}`);
  if (a.sizeBytes !== undefined) parts.push(formatBytes(a.sizeBytes));
  if (a.ext) parts.push(a.ext.toUpperCase());
  if (a.extraction === 'unsupported' && EXTRACTION_NOT_BUILT_YET.has(a.ext)) {
    parts.push('text not extractable yet');
  } else if (a.extraction === 'too-large') {
    parts.push(`over ${formatBytes(MAX_EXTRACTABLE_BYTES)} — too big to read`);
  } else if (a.extraction === 'extracted') {
    parts.push(a.truncated ? 'contents added (truncated)' : 'contents added');
  }
  return parts.join(' · ');
}

export function formatBytes(bytes: number): string {
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

/**
 * What a vision-capable provider would have to accept.
 *
 * Declared, and deliberately unimplemented. Nothing in this build can read an
 * image: `IntelligenceProvider.ask` takes a string, the local models are text models,
 * and the cloud providers in `cloud_intelligence.rs` post a text-only body. A
 * capture therefore stays on this machine — it is shown, it is a referent for
 * Atlas's own skills, and it is never sent anywhere.
 *
 * `isLocal` is on the interface rather than left to the implementation because
 * of the decision this seam was shaped by: the first vision provider Atlas
 * accepts is intended to be a local one. A surface can refuse a remote
 * implementation by reading one field, instead of every caller having to
 * remember the rule.
 */
export interface VisionContext {
  /** PNG bytes, as a data URL. */
  dataUrl: string;
  width?: number;
  height?: number;
  /** What this is a picture of, for the prompt: "Screen 1", "Notepad". */
  label: string;
}

export interface VisionProvider {
  id: string;
  label: string;
  /** Runs on this machine and sends nothing outward. */
  isLocal(): boolean;
  isConfigured(): boolean;
  describe(images: readonly VisionContext[], question: string): Promise<string>;
}

/** What Atlas says when handed an image and asked to interpret it. */
export const NO_VISION_PROVIDER =
  "I've got the capture, but I can't read images yet — nothing in this build can see. " +
  'It stays on this machine; I can still act on it as a file.';
