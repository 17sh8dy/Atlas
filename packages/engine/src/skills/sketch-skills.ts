/**
 * `sketch.save` — keep a drawing the model made, as an .svg in Pictures\Atlas Sketches.
 *
 * The drawing is run through the sanitiser AGAIN here. The skill's argument comes from the conversation
 * (a button on a message), and nothing that reaches a file is trusted just because it was shown earlier.
 * It writes a file, so it asks first like every other file-creating action.
 */

import type { Platform, Skill } from '@atlas/core';
import { sanitizeSvg } from '../general/sketch';

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'sketch';
}

export function createSketchSkills(platform: Platform): Skill[] {
  return [
    {
      id: 'sketch.save',
      label: 'Save a sketch',
      icon: '🖼️',
      domain: 'files',
      description: 'Save a drawing Atlas made as an .svg file in Pictures\\Atlas Sketches.',
      needs: ['fs'],
      risk: 'confirm',
      params: {
        svg: { type: 'string', required: true, description: 'the drawing, as SVG text' },
        name: {
          type: 'string',
          required: false,
          description: 'what it shows, used for the file name',
        },
      },
      async run(args) {
        const checked = sanitizeSvg(String(args.svg ?? ''));
        if (!checked.ok) return { ok: false, error: `I won't save that: ${checked.reason}.` };
        if (!platform.knownFolder || !platform.createFile)
          return { ok: false, error: "I can't write files here." };
        const pictures = await platform.knownFolder('pictures');
        const folder = `${pictures}\\Atlas Sketches`;
        try {
          await platform.createFolder?.(folder);
        } catch {
          /* already there */
        }
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
        const path = `${folder}\\${slug(String(args.name ?? ''))}-${stamp}.svg`;
        try {
          const ok = await platform.createFile(path, checked.svg);
          return ok
            ? { ok: true, message: `Saved ${path}` }
            : { ok: false, error: `I couldn't save ${path}.` };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : `I couldn't save ${path}.` };
        }
      },
    },
  ];
}
