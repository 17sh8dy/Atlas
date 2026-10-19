/**
 * "Do not delete any of Atlas's existing tools." Held mechanically: every skill id that existed when the
 * 2.0.2 capability layer began must still be in the source. New skills may be added freely.
 *
 * To regenerate the baseline (only ever to ADD ids): `UPDATE_BASELINE=1 pnpm --filter @atlas/engine test baseline`.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSkillIds } from './baseline/scan';

const FILE = join(__dirname, 'baseline', 'skill-ids.json');

describe('no existing skill disappears', () => {
  const current = scanSkillIds();

  test('the baseline file is present and large', () => {
    if (process.env.UPDATE_BASELINE) {
      const old = (() => {
        try {
          return JSON.parse(readFileSync(FILE, 'utf8')) as string[];
        } catch {
          return [] as string[];
        }
      })();
      writeFileSync(FILE, `${JSON.stringify([...new Set([...old, ...current])].sort(), null, 2)}\n`);
    }
    const baseline = JSON.parse(readFileSync(FILE, 'utf8')) as string[];
    expect(baseline.length).toBeGreaterThan(300);
  });

  test('every id in the baseline is still defined', () => {
    const baseline = JSON.parse(readFileSync(FILE, 'utf8')) as string[];
    const missing = baseline.filter((id) => !current.includes(id));
    expect(missing, `skills that were removed or renamed: ${missing.join(', ')}`).toEqual([]);
  });
});
