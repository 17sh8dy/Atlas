/**
 * The context attached to the message being written: files, images, captures,
 * and the live frame of a shared screen.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 * **An attachment is a reference. Reading it is a separate action.** Attaching
 * a file records what you pointed at; it never reads it, never previews its
 * contents, and never puts them anywhere. `extractText` is the only thing that
 * reads, it only runs when a person asks for it, and it refuses honestly when
 * the format has no extractor or the file is past `files.readText`'s cap.
 *
 * That split is what lets a 4 GB video and a `.pdf` both be attachable without
 * either producing nonsense — and what keeps the 256 KB read cap a real limit
 * rather than one worked around by the feature that was added after it.
 *
 * ── Captures stay here ──────────────────────────────────────────────────────
 * A screenshot is held as a data URL in this hook's state and goes nowhere
 * else. Nothing in this build can interpret an image (see `VisionContext` in
 * `@atlas/core`), so there is no send path to leak down — the image is shown,
 * and that is all that happens to it.
 */

import { useCallback, useRef, useState } from 'react';
import {
  describeAttachment,
  extensionOf,
  extractionStateFor,
  isImageFile,
  type Attachment,
  type Platform,
} from '@atlas/core';

/** PNG width/height out of the IHDR chunk — the same two numbers `screen-skills.ts` reads. */
function pngDimensions(buffer: ArrayBuffer): { width: number; height: number } | null {
  if (buffer.byteLength < 24) return null;
  const view = new DataView(buffer);
  const isPng = view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a;
  if (!isPng) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Chunked, because spreading a screenshot-sized array blows the argument limit. */
export function toDataUrl(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

let nextId = 1;

export interface Attachments {
  items: Attachment[];
  /** True while a picker or a capture is in flight, so the button can say so. */
  busy: boolean;
  addFiles(options?: { imagesOnly?: boolean }): Promise<void>;
  addCapture(capture: {
    buffer: ArrayBuffer;
    name: string;
    source: string;
    kind?: Attachment['kind'];
  }): void;
  remove(id: string): void;
  clear(): void;
  /** Read a supported file's text, on purpose, once. */
  extractText(id: string): Promise<void>;
  /** What the engine is told about the attached context — paths, never contents. */
  describeForEngine(): string;
}

export function useAttachments(platform: Platform): Attachments {
  const [items, setItems] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  // A ref as well as state, so `describeForEngine` can be called from a submit
  // handler without the closure it was created in going stale.
  const ref = useRef<Attachment[]>([]);
  ref.current = items;

  const update = useCallback((id: string, patch: Partial<Attachment>) => {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const addFiles = useCallback(
    async (options: { imagesOnly?: boolean } = {}) => {
      if (!platform.pickFiles) return;
      setBusy(true);
      try {
        const paths = await platform.pickFiles({
          multiple: true,
          title: options.imagesOnly ? 'Add images' : 'Add files and documents',
          filters: options.imagesOnly
            ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] }]
            : undefined,
        });

        const added: Attachment[] = [];
        for (const path of paths) {
          const ext = extensionOf(path);
          // Size comes from `path_info`, which every build with files has.
          // Absent is fine — `extractionStateFor` then judges on format
          // alone, and the cap is enforced again at read time regardless.
          const info = await platform.pathInfo?.(path).catch(() => null);
          const sizeBytes = info?.sizeBytes;
          const image = isImageFile(path);

          const attachment: Attachment = {
            id: `a${nextId++}`,
            kind: image ? 'image' : 'file',
            name: baseName(path),
            path,
            ext,
            sizeBytes,
            addedAt: Date.now(),
            extraction: image ? 'unsupported' : extractionStateFor(ext, sizeBytes),
          };
          added.push(attachment);
        }
        if (added.length) setItems((prev) => [...prev, ...added]);
      } finally {
        setBusy(false);
      }
    },
    [platform],
  );

  const addCapture = useCallback<Attachments['addCapture']>((capture) => {
    const size = pngDimensions(capture.buffer);
    setItems((prev) => [
      ...prev,
      {
        id: `a${nextId++}`,
        kind: capture.kind ?? 'screenshot',
        name: capture.name,
        ext: 'png',
        sizeBytes: capture.buffer.byteLength,
        dataUrl: toDataUrl(capture.buffer),
        width: size?.width,
        height: size?.height,
        addedAt: Date.now(),
        source: capture.source,
        // An image has no text to extract, and saying "unsupported" is more
        // honest than leaving it looking like something nobody got round to.
        extraction: 'unsupported',
      },
    ]);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const extractText = useCallback(
    async (id: string) => {
      const attachment = ref.current.find((a) => a.id === id);
      if (!attachment?.path || attachment.extraction !== 'available') return;
      if (!platform.readTextFile) {
        update(id, { extraction: 'failed', extractionError: 'This build cannot read files.' });
        return;
      }
      try {
        const text = await platform.readTextFile(attachment.path);
        update(id, { extraction: 'extracted', text, truncated: false });
      } catch (e) {
        // The likeliest failure by far is the allowed-folders boundary, and
        // the person needs to be told *that* rather than "it didn't work" —
        // it is fixable, in Settings, in about ten seconds.
        const reason = String(e instanceof Error ? e.message : e);
        update(id, {
          extraction: 'failed',
          extractionError: /outside the folders/i.test(reason)
            ? "It's outside the folders Atlas can read — add its folder in Settings → General."
            : reason,
        });
      }
    },
    [platform, update],
  );

  /**
   * What goes to the engine when the message is sent.
   *
   * Paths and names — a reference, exactly as attached. Contents appear only
   * for an attachment whose text the person explicitly extracted, and even
   * then the file is still named, so a skill can act on it rather than only
   * read about it.
   */
  const describeForEngine = useCallback(() => {
    const current = ref.current;
    if (!current.length) return '';

    const lines = current.map((a) => {
      const where = a.path ? ` (${a.path})` : a.source ? ` (${a.source})` : '';
      const note = a.kind === 'screenshot' || a.kind === 'frame' ? ' — an image' : '';
      return `- ${a.name}${where}${note}`;
    });

    const extracted = current.filter((a) => a.extraction === 'extracted' && a.text);
    const contents = extracted.map(
      (a) => `\n<file name="${a.name}">\n${a.text}\n</file>`,
    );

    return [`[Attached: ${current.length}]`, ...lines, ...contents].join('\n');
  }, []);

  return { items, busy, addFiles, addCapture, remove, clear, extractText, describeForEngine };
}

export { describeAttachment };
