/**
 * Let the file skills take what people say — "atlas-secret-test.txt in
 * documents", "downloads" — as well as a full path.
 *
 * `files.rename`, `move`, `copy`, `delete`, `readText` and the rest were written
 * for explicit paths, which is exactly what nobody types. This wraps them so a
 * target that is not already a full path is resolved through `locate.ts` (the
 * same resolver the new file tools use) before the real skill runs. An
 * ambiguous or missing name is reported and nothing is touched.
 *
 * It sits *outside* the file journal, so the journal records the resolved
 * path — "undo that" needs the real one.
 *
 * The cards are rewritten too: "Atlas wants to send notes.txt in documents to
 * the Recycle Bin" instead of the skill's one-line description.
 */

import type { Memory, Platform, Skill } from '@atlas/core';
import { resolvePlace, resolveTarget } from './locate';

const ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i;

/** An existing file or folder, as `path`. */
const EXISTING = new Set([
  'files.rename',
  'files.move',
  'files.copy',
  'files.delete',
  'files.readText',
  'files.info',
  'files.peek',
  'files.append',
  'files.open',
  'files.reveal',
]);

/** A destination folder, as `destDir`. */
const DEST = new Set(['files.move', 'files.copy']);

/** A new file or folder, as `path`: "name in place". */
const NEW = new Set(['files.create', 'files.createFolder']);

const WORDS: Record<string, (a: Record<string, unknown>) => string> = {
  'files.delete': (a) => `send ${String(a.path)} to the Recycle Bin`,
  'files.rename': (a) => `rename ${String(a.path)} to ${String(a.newName)}`,
  'files.move': (a) => `move ${String(a.path)} into ${String(a.destDir)}`,
  'files.copy': (a) => `copy ${String(a.path)} into ${String(a.destDir)}`,
  'files.create': (a) => `create the file ${String(a.path)}`,
  'files.createFolder': (a) => `create the folder ${String(a.path)}`,
  'files.append': (a) => `add a line to ${String(a.path)}`,
};

export function withSpokenPaths(skills: Skill[], platform: Platform, memory?: Memory): Skill[] {
  return skills.map((skill) => {
    const existing = EXISTING.has(skill.id);
    const isNew = NEW.has(skill.id);
    if (!existing && !isNew) return skill;
    const confirmAs = WORDS[skill.id] ? (a: Record<string, unknown>) => WORDS[skill.id]!(a) : undefined;
    return {
      ...skill,
      ...(confirmAs && skill.risk === 'confirm' ? { confirmAs } : {}),
      async run(args, ctx) {
        const next = { ...args };
        const spec = String(args.path ?? '').trim();

        if (existing && spec && !ABSOLUTE.test(spec)) {
          const t = await resolveTarget(platform, memory, spec);
          if (!t.ok) return { ok: false, error: t.error };
          next.path = t.path;
        }

        if (isNew && spec && !ABSOLUTE.test(spec)) {
          // "Projects in documents" / "notes.txt on the desktop": a name, and where to put it.
          const m = /^(.+?)\s+(?:in|on|inside|under)\s+(?:my\s+|the\s+)?(.+)$/i.exec(spec);
          if (!m) {
            return { ok: false, error: 'Where? Say a folder ("… in documents") or give the full path.' };
          }
          const place = (await resolvePlace(platform, memory, m[2]!)) ?? (await resolveTarget(platform, memory, m[2]!));
          if (!place.ok) return { ok: false, error: place.error };
          const name = m[1]!.trim().replace(/^["']|["']$/g, '');
          if (!name || /[\\/:*?"<>|]/.test(name)) return { ok: false, error: 'That isn\'t a name Windows allows for a file or folder.' };
          next.path = `${place.path.replace(/[\\/]+$/, '')}\\${name}`;
        }

        if (DEST.has(skill.id) && args.destDir) {
          const d = String(args.destDir).trim();
          if (!ABSOLUTE.test(d)) {
            const place = (await resolvePlace(platform, memory, d)) ?? (await resolveTarget(platform, memory, d));
            if (!place.ok) return { ok: false, error: place.error };
            next.destDir = place.path;
          }
        }
        return skill.run(next, ctx);
      },
    } satisfies Skill;
  });
}
