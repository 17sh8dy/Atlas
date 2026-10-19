/**
 * Finds every skill id written in the engine's skill sources.
 *
 * The 2.0.2 capability layer is ADDITIVE: no existing tool may be removed or renamed. This scan is the
 * mechanical half of that promise (the other half is `advertised-examples`, which proves the phrasings
 * still reach them). It reads source rather than building a registry because the registry is composed in
 * the app shell from dozens of factories that need a live platform; a literal `id: 'x.y'` (or a helper
 * call that registers one) is what a removal would have to delete.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS = join(__dirname, '..', '..', 'src', 'skills');

export function scanSkillIds(): string[] {
  const ids = new Set<string>();
  for (const file of readdirSync(SKILLS).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(SKILLS, file), 'utf8');
    for (const m of text.matchAll(/\bid:\s*'([a-z][A-Za-z0-9]*\.[A-Za-z0-9.]+)'/g)) ids.add(m[1]!);
    // project-context.ts registers some through a small helper: open('project.terminal', ...)
    for (const m of text.matchAll(/\bopen\('([a-z][A-Za-z0-9]*\.[A-Za-z0-9.]+)'/g)) ids.add(m[1]!);
  }
  return [...ids].sort();
}
