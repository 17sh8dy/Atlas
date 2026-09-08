/**
 * Screen capture and display information — the last resort in the
 * "operate the machine" hierarchy, reached for only once a Windows API or
 * UI Automation (`uia-skills.ts`) can't answer the question. Both captures
 * are read-only and instantly reversible in the sense that matters here —
 * nothing on the machine changes — so everything in this pack is `safe`.
 *
 * ⚠️ There is deliberately no "describe what's on screen" skill here. That
 * would need a vision-capable model, and this codebase's intelligence port
 * (`packages/core/src/ports/intelligence.ts`) is Cortex-only, text-prompt-only
 * — `ask(prompt: string, ...)` has no channel for an image at all, and Cortex
 * itself is a text model. Building a "describe" skill on top of that would be
 * exactly the placeholder-function shape this project's own rule refuses:
 * capture is real and works today; description waits for a real
 * vision-capable provider to exist, and is written up as deferred in
 * `docs/ROADMAP.md` rather than faked.
 */

import type { DisplayInfo, Platform, ResultRow, Skill } from '@atlas/core';
import { resolveWindow, liveWindows } from '../text/windows';

/** Width/height straight out of a PNG's IHDR chunk — no image library needed for two numbers. */
function pngDimensions(buffer: ArrayBuffer): { width: number; height: number } | null {
  const view = new DataView(buffer);
  if (buffer.byteLength < 24) return null;
  // Bytes 0-7 are the PNG signature; the IHDR chunk (always first) starts at
  // 8 (length+type) and carries width then height as big-endian u32s at 16/20.
  const isPng = view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a;
  if (!isPng) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A data URL, so the bytes are at least usable somewhere — pasted into a browser, or a future preview UI. */
function toDataUrl(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked rather than one `String.fromCharCode(...bytes)` spread, which
  // blows the call-stack argument limit on a screenshot-sized buffer.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function displayRow(d: DisplayInfo): ResultRow {
  return {
    title: d.name || (d.primary ? 'Primary display' : 'Display'),
    subtitle: `${d.width}×${d.height} at ${d.dpi} DPI${d.primary ? ' · primary' : ''}`,
    icon: '🖥️',
    payload: d,
  };
}

export function createScreenSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'screen.capture',
    label: 'Capture the screen',
    icon: '🖥️',
    domain: 'system',
    description: 'Take a screenshot of the whole desktop, across every monitor.',
    needs: ['screen'],
    risk: 'safe',
    aloud: false,
    examples: ['take a screenshot', 'capture the screen'],
    async run() {
      const buffer = await platform.captureScreen?.();
      if (!buffer) return { ok: false, error: "I couldn't capture the screen." };
      const size = pngDimensions(buffer);
      return {
        ok: true,
        message: size ? `Captured the screen — ${size.width}×${size.height}.` : 'Captured the screen.',
        data: { dataUrl: toDataUrl(buffer), width: size?.width, height: size?.height },
      };
    },
  });

  skills.push({
    id: 'screen.captureWindow',
    label: 'Capture a window',
    icon: '🖥️',
    domain: 'system',
    description: 'Take a screenshot of one window, by its title or app name.',
    needs: ['screen', 'window-control'],
    risk: 'safe',
    aloud: false,
    examples: ['take a screenshot of the notepad window'],
    params: {
      window: { type: 'string', required: true, description: 'the window, by its title or app name' },
    },
    async run(args, ctx) {
      const query = String(args.window ?? '');
      const match = resolveWindow(await liveWindows(platform), query);
      if (match.kind === 'none') return { ok: false, error: `I can't find a window called "${query}".` };
      if (match.kind === 'many') {
        ctx.showResults?.(
          match.candidates.slice(0, 12).map((w) => ({
            title: w.title,
            subtitle: w.processName,
            icon: '🪟',
            payload: w,
            actions: [{ label: 'Capture', skill: 'screen.captureWindow', args: { window: w.id } }],
          })),
          { title: `${match.candidates.length} windows match "${query}"`, subtitle: 'Click one, or say which.' },
        );
        return { ok: true, spoken: true, message: '' };
      }

      const buffer = await platform.captureWindow?.(match.entry.id);
      if (!buffer) return { ok: false, error: `I couldn't capture ${match.entry.title}.` };
      const size = pngDimensions(buffer);
      return {
        ok: true,
        message: `Captured ${match.entry.title}${size ? ` — ${size.width}×${size.height}` : ''}.`,
        data: { dataUrl: toDataUrl(buffer), width: size?.width, height: size?.height },
      };
    },
  });

  skills.push({
    id: 'screen.listDisplays',
    label: 'Displays',
    icon: '🖥️',
    domain: 'system',
    description: 'List the monitors connected to this machine.',
    needs: ['screen'],
    risk: 'safe',
    examples: ['what monitors do I have', 'list my displays'],
    async run(_args, ctx) {
      const displays = (await platform.listDisplays?.()) ?? [];
      if (!displays.length) return { ok: false, error: "I couldn't read the displays." };
      ctx.showResults?.(displays.map(displayRow), {
        title: `${displays.length} display${displays.length === 1 ? '' : 's'}`,
      });
      return { ok: true, spoken: true, message: '' };
    },
  });

  return skills;
}
