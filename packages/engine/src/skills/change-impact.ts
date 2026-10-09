/**
 * `git.changeImpact` — what does the change I have in the working tree touch?
 *
 * Starting from the files git says changed, it finds (from the project's own text, no program run):
 *   - the files that import them, one and two steps out (JS/TS: `import … from`, `require()`,
 *     dynamic `import()`, resolved against real files — so a name that only looks similar is not a hit),
 *   - the tests that probably cover them (a test file imports the changed file or its dependents, or
 *     is named after it),
 *   - changes that reach beyond the code (package.json, lockfiles, tsconfig, .env, CI),
 *   - changed source with no test pointing at it.
 *
 * It is an estimate from import statements. It cannot see dynamic paths, reflection, other
 * languages' imports (only JS/TS are followed; others are matched by file name) or runtime coupling,
 * and the report says so.
 */

export interface ImpactInput {
  /** Changed files, relative to the project, forward slashes. */
  changed: readonly string[];
  /** Every project file's relative path. */
  files: readonly string[];
  /** Text of the source files worth reading. */
  texts: ReadonlyMap<string, string>;
}

export interface Impact {
  changed: string[];
  direct: string[];
  indirect: string[];
  tests: string[];
  untested: string[];
  beyondCode: Array<{ file: string; why: string }>;
  followed: 'js-ts' | 'names-only';
}

const JS = /\.(?:[cm]?[jt]sx?)$/i;
const TEST = /(?:^|\/)(?:__tests__|tests?|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/i;
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

const BEYOND: Array<[RegExp, string]> = [
  [/(?:^|\/)package\.json$/, 'dependencies or scripts may have changed'],
  [/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock)$/, 'a lockfile changed, so installed versions may differ'],
  [/(?:^|\/)tsconfig[^/]*\.json$/, 'compiler settings changed, which can affect every file'],
  [/(?:^|\/)\.env[^/]*$/, 'environment settings changed'],
  [/(?:^|\/)(?:vite|webpack|rollup|next|vitest|jest|eslint)[^/]*\.(?:config\.)?[cm]?[jt]s$|(?:^|\/)\.eslintrc/, 'build, test or lint configuration changed'],
  [/(?:^|\/)\.github\/workflows\//, 'a CI workflow changed'],
  [/(?:^|\/)(?:Cargo\.toml|go\.mod|requirements[^/]*\.txt|pyproject\.toml)$/, 'dependencies changed'],
  [/(?:^|\/)(?:Dockerfile|docker-compose[^/]*\.ya?ml)$/, 'container setup changed'],
];

function dirOf(p: string) {
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
}

function normalise(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/** The relative imports a JS/TS file makes, as project paths that exist. */
export function importsOf(file: string, text: string, fileSet: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const re = /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*|\.{1,2})\1/g;
  for (const m of text.matchAll(re)) {
    const target = normalise(`${dirOf(file)}/${m[2]!}`.replace(/^\//, ''));
    if (target === null) continue;
    // TS projects often import './x.js' for a file called x.ts.
    const bare = target.replace(/\.(?:[cm]?js)$/, '');
    const hit = [target, bare].flatMap((t) => EXTS.map((e) => t + e)).find((c) => fileSet.has(c));
    if (hit) found.add(hit);
  }
  return [...found];
}

const stem = (p: string) => (p.split('/').pop() ?? p).replace(/\.(?:test|spec)(?=\.)/, '').replace(/\.[^.]+$/, '').replace(/^test_/, '').replace(/_test$/, '');

export function analyseImpact(input: ImpactInput): Impact {
  const fileSet = new Set(input.files);
  const changed = input.changed.filter((c) => fileSet.has(c) || input.changed.includes(c));
  const importers = new Map<string, Set<string>>();
  let sawJs = false;
  for (const [file, text] of input.texts) {
    if (!JS.test(file)) continue;
    sawJs = true;
    for (const target of importsOf(file, text, fileSet)) {
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target)!.add(file);
    }
  }

  const changedSet = new Set(changed);
  const direct = new Set<string>();
  for (const c of changed) for (const f of importers.get(c) ?? []) if (!changedSet.has(f)) direct.add(f);
  const indirect = new Set<string>();
  for (const d of direct) for (const f of importers.get(d) ?? []) if (!changedSet.has(f) && !direct.has(f)) indirect.add(f);

  // Tests: a test file among the changed/dependent files, or named after a changed file.
  const reach = new Set([...changedSet, ...direct, ...indirect]);
  const tests = new Set<string>();
  const importsReached = (f: string) => [...reach].some((r) => importers.get(r)?.has(f));
  for (const f of input.files) {
    if (!TEST.test(f)) continue;
    if (reach.has(f) || importsReached(f)) tests.add(f);
    else if (changed.some((c) => !TEST.test(c) && stem(c).toLowerCase() === stem(f).toLowerCase())) tests.add(f);
  }

  const source = changed.filter((c) => /\.(?:[cm]?[jt]sx?|py|rs|go|cs|java|kt|cpp|c|h)$/i.test(c) && !TEST.test(c));
  const untested = source.filter((c) => {
    const covering = new Set([c, ...(importers.get(c) ?? [])]);
    return ![...tests].some((t) => covering.has(t) || [...(importers.get(c) ?? [])].some((i) => importers.get(i)?.has(t)) || stem(t).toLowerCase() === stem(c).toLowerCase());
  });

  const beyondCode = changed.flatMap((file) => BEYOND.filter(([re]) => re.test(file)).map(([, why]) => ({ file, why })));
  return {
    changed,
    direct: [...direct].sort(),
    indirect: [...indirect].sort(),
    tests: [...tests].sort(),
    untested,
    beyondCode,
    followed: sawJs ? 'js-ts' : 'names-only',
  };
}

const list = (items: readonly string[], n = 8) => `${items.slice(0, n).join(', ')}${items.length > n ? `, and ${items.length - n} more` : ''}`;

export function formatImpact(name: string, i: Impact): string {
  if (!i.changed.length) return `🧭 ${name} has no uncommitted changes, so there is nothing to assess. (Stage or edit something, or tell me which change to look at.)`;
  const lines = [`🧭 ${i.changed.length} changed file${i.changed.length === 1 ? '' : 's'} in ${name}: ${list(i.changed, 6)}.`];
  lines.push(i.direct.length ? `Imported directly by ${i.direct.length}: ${list(i.direct)}.` : 'No other file imports them directly.');
  if (i.indirect.length) lines.push(`Reached one step further by ${i.indirect.length}: ${list(i.indirect)}.`);
  lines.push(i.tests.length ? `Tests likely to cover this (${i.tests.length}): ${list(i.tests)}.` : 'I found no test that points at these files.');
  if (i.untested.length) lines.push(`⚠️ Changed code with no test pointing at it: ${list(i.untested)}.`);
  for (const b of i.beyondCode.slice(0, 6)) lines.push(`⚠️ ${b.file}: ${b.why}.`);
  const regression = i.direct.length + i.indirect.length;
  if (regression >= 10) lines.push(`That is a wide change (${regression} dependent files); run the whole test suite, not just the nearest tests.`);
  else if (regression > 0 && i.tests.length) lines.push('Run the tests above first, then the full suite.');
  lines.push('', i.followed === 'js-ts' ? 'This is an estimate from import statements. It cannot see dynamic paths or runtime coupling, and only JavaScript/TypeScript imports are followed — other languages are matched by file name.' : 'This project has no JavaScript/TypeScript to follow, so files are matched by name only — treat it as a rough guide.');
  return lines.join('\n');
}
