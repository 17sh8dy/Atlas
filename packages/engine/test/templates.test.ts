/**
 * Every ready-made project, checked the same way and for real: written to an actual folder, each
 * script syntax-checked by Node, the project's own test.js run, and the page checked to reference
 * only files that exist. A new template gets all of this for free by joining the registry.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assert, test } from 'vitest';
import { BUILT_IN_TEMPLATES, allTemplates, chooseTemplate, idFor } from '../src/templates';

function write(templateId: string, name: string) {
  const template = BUILT_IN_TEMPLATES.find((t) => t.id === templateId)!;
  const root = mkdtempSync(join(tmpdir(), `atlas-tpl-${templateId}-`));
  const files = template.files({ name, id: idFor(name) });
  for (const file of files) {
    const target = join(root, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  return { root, files, template };
}

test('the built-ins are what the registry holds', () => {
  const ids = allTemplates().map((t) => t.id);
  for (const t of BUILT_IN_TEMPLATES) assert.include(ids, t.id);
  assert.equal(new Set(ids).size, ids.length, 'template ids are unique');
});

test('no two templates claim the same word', () => {
  const owner = new Map<string, string>();
  for (const t of BUILT_IN_TEMPLATES) {
    for (const w of t.words) {
      const other = owner.get(w);
      assert.isUndefined(other, `"${w}" is claimed by both ${other} and ${t.id}`);
      owner.set(w, t.id);
    }
  }
});

test('every template is found by each of its own words', () => {
  for (const t of BUILT_IN_TEMPLATES) {
    for (const w of t.words) {
      assert.equal(chooseTemplate(`please make me a ${w} for my desk`)?.id, t.id, `"${w}" should find ${t.id}`);
    }
  }
});

for (const template of BUILT_IN_TEMPLATES) {
  test(`${template.id}: writes a complete project that passes its own checks`, () => {
    const { root, files } = write(template.id, 'Night Orb');
    try {
      const names = files.map((f) => f.path);
      assert.include(names, template.launch, 'the launch file is written');
      for (const f of files) {
        assert.notMatch(f.content, /\{\{[A-Z]+\}\}/, `${f.path} still has a placeholder`);
        assert.isAbove(f.content.length, 5, `${f.path} is empty`);
      }
      // A Tauri project is not Electron (no main.js, no electron.exe); tauri-launcher.test.ts checks it.
      if (!template.desktop || template.shell === 'tauri') return;

      // Desktop projects: package.json valid, window loads index.html, scripts are real JavaScript.
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      assert.equal(pkg.main, 'main.js');
      assert.equal(pkg.name, 'night-orb');
      assert.include(readFileSync(join(root, 'Play.cmd'), 'utf8'), 'electron.exe');
      for (const f of names.filter((n) => n.endsWith('.js'))) {
        execFileSync(process.execPath, ['--check', join(root, f)]);
      }

      // The page only references files that exist, and loads nothing from the internet.
      const html = readFileSync(join(root, 'index.html'), 'utf8');
      for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        assert.isTrue(existsSync(join(root, m[1]!)), `index.html references ${m[1]}, which is not written`);
      }
      assert.notMatch(html, /(?:src|href)="https?:/);
      // The Content-Security-Policy blocks inline styles, so none may be written (the page would log
      // violations here and silently lose the styling in the desktop window). Setting a property on
      // element.style from a script is fine; the style attribute is not.
      assert.notMatch(html, /\sstyle\s*=/i, 'index.html has an inline style attribute');
      for (const f of names.filter((n) => n.endsWith('.js') && n !== 'test.js')) {
        assert.notMatch(readFileSync(join(root, f), 'utf8'), /setAttribute\(\s*['"]style['"]|\.cssText\s*=/, f + ' sets an inline style attribute');
      }
      assert.include(html, 'Content-Security-Policy');
      assert.include(html, 'Night Orb');

      // The project's own tests pass.
      if (names.includes('test.js')) {
        const out = execFileSync(process.execPath, ['test.js'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
        // A failing check makes node exit non-zero, which throws above; this proves they all ran.
        assert.match(out, /\d+ checks passed/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
}
