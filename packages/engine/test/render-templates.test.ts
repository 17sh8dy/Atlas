/**
 * A developer tool, not a check: write every template into a folder so it can be opened in a
 * browser and driven by hand or by Playwright.
 *
 *   ATLAS_RENDER_DIR=C:\some\folder pnpm --filter @atlas/engine exec vitest run test/render-templates.test.ts
 *
 * Skipped unless ATLAS_RENDER_DIR is set, so it does nothing in a normal test run.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { allTemplates, displayNameFor, idFor } from '../src/templates';

const out = process.env.ATLAS_RENDER_DIR;

test.skipIf(!out)('render every template to ATLAS_RENDER_DIR', () => {
  for (const t of allTemplates()) {
    const name = displayNameFor(t.id);
    for (const f of t.files({ name, id: idFor(name) })) {
      const target = join(out!, t.id, ...f.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf8');
    }
  }
});
