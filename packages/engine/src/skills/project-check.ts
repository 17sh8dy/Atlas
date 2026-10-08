/**
 * “Does this project hang together?” — a static check of a built project, with no model and without
 * running anything.
 *
 * After a build (a template, or the developer agent) and before it is opened, Atlas looks at what is
 * actually on disk: is there something to open, does every local file the page refers to exist, does
 * each JSON file parse, does package.json point at real files. Nothing is executed, so it is safe on
 * anything — including code a model wrote a moment ago — and it says only what it checked.
 *
 * It does NOT prove the program works. A passing check means “the pieces are all there and
 * well-formed”, and the report says that in so many words.
 */

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckItem {
  level: CheckLevel;
  text: string;
}

export interface ProjectCheck {
  ok: boolean;
  items: CheckItem[];
  /** What would be opened, relative to the folder. */
  entry: string | null;
  fileCount: number;
  /** package.json scripts, when there is one. */
  scripts: string[];
}

export interface CheckInput {
  /** Every file in the project, relative, forward slashes. */
  allFiles: readonly string[];
  /** Text of the files worth reading (html, json, js, css…) by relative path. */
  texts: ReadonlyMap<string, string>;
  /** Folders exist check for `node_modules`. */
  hasNodeModules: boolean;
  /** Files too big to read, or unreadable, by relative path. */
  unread?: readonly string[];
}

const lower = (s: string) => s.toLowerCase();

/** `a/b/../c.js` → `a/c.js`; null if it climbs out of the project. */
export function resolveRef(fromFile: string, ref: string): string | null {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const parts = (ref.startsWith('/') ? ref.slice(1) : dir ? `${dir}/${ref}` : ref).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(p);
  }
  return out.join('/');
}

/** Local files an html page loads: `src=` and `href=` that are not web addresses, anchors or data. */
export function localRefs(html: string): string[] {
  const refs: string[] = [];
  for (const m of html.matchAll(/<(?:script|img|link|source|audio|video)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const ref = (m[1] ?? m[2] ?? '').trim();
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;
    const clean = ref.split(/[?#]/)[0]!;
    if (clean && !refs.includes(clean)) refs.push(clean);
  }
  return refs;
}

export function checkProject(input: CheckInput): ProjectCheck {
  const items: CheckItem[] = [];
  const set = new Set(input.allFiles.map(lower));
  const has = (rel: string) => set.has(lower(rel));
  const ok = (text: string) => items.push({ level: 'ok', text });
  const warn = (text: string) => items.push({ level: 'warn', text });
  const fail = (text: string) => items.push({ level: 'fail', text });

  if (!input.allFiles.length) {
    fail('The folder is empty — nothing was built.');
    return { ok: false, items, entry: null, fileCount: 0, scripts: [] };
  }
  ok(`${input.allFiles.length} file${input.allFiles.length === 1 ? '' : 's'} on disk.`);

  // Something to open.
  let entry: string | null = null;
  if (has('Play.cmd')) entry = 'Play.cmd';
  else if (has('index.html')) entry = 'index.html';
  else if (has('project.godot')) entry = 'project.godot';
  else entry = input.allFiles.find((f) => /^[^/]+\.uproject$/i.test(f)) ?? null;
  if (entry) ok(`It opens from ${entry}.`);
  else warn('There is no Play.cmd, index.html or engine project file to open, so “play it” will only open the folder.');

  // JSON that must parse.
  for (const [rel, text] of input.texts) {
    if (!/\.json$/i.test(rel) || /(^|\/)node_modules\//i.test(rel)) continue;
    try {
      JSON.parse(text);
    } catch {
      fail(`${rel} is not valid JSON.`);
    }
  }

  // package.json: name, scripts, main.
  let scripts: string[] = [];
  const pkgText = input.texts.get('package.json');
  if (pkgText !== undefined) {
    try {
      const pkg = JSON.parse(pkgText) as { name?: unknown; main?: unknown; scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      scripts = Object.keys(pkg.scripts ?? {});
      ok(scripts.length ? `package.json has scripts: ${scripts.slice(0, 8).join(', ')}.` : 'package.json has no scripts.');
      if (typeof pkg.main === 'string' && !has(pkg.main.replace(/^\.\//, ''))) fail(`package.json says the program starts at ${pkg.main}, but that file isn't there.`);
      const hasDeps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
      if (hasDeps && !input.hasNodeModules) warn('Its dependencies are not installed yet (no node_modules). “install the dependencies” does that.');
    } catch {
      /* already reported as invalid JSON */
    }
  }

  // Every page: the local files it loads must exist.
  for (const [rel, text] of input.texts) {
    if (!/\.html?$/i.test(rel) || /(^|\/)node_modules\//i.test(rel)) continue;
    const missing: string[] = [];
    let found = 0;
    for (const ref of localRefs(text)) {
      const target = resolveRef(rel, ref);
      if (target === null) missing.push(`${ref} (outside the project)`);
      else if (!has(target)) missing.push(ref);
      else found += 1;
    }
    if (missing.length) fail(`${rel} loads ${missing.map((m) => `“${m}”`).join(', ')}, which ${missing.length === 1 ? "isn't" : "aren't"} in the project.`);
    else if (found) ok(`${rel}: all ${found} file${found === 1 ? '' : 's'} it loads ${found === 1 ? 'is' : 'are'} there.`);
    if (!/<html[\s>]/i.test(text) && !/<!doctype/i.test(text)) warn(`${rel} doesn't look like a complete page (no <html> or doctype).`);
  }

  // Source files with nothing in them.
  const empty = [...input.texts].filter(([rel, text]) => /\.(?:html?|css|[cm]?[jt]sx?|json|py|cs|rs|go)$/i.test(rel) && text.trim() === '').map(([rel]) => rel);
  if (empty.length) warn(`Empty file${empty.length === 1 ? '' : 's'}: ${empty.slice(0, 5).join(', ')}${empty.length > 5 ? '…' : ''}.`);

  if (input.unread?.length) warn(`${input.unread.length} file${input.unread.length === 1 ? ' was' : 's were'} too big to read, so not checked.`);

  return { ok: !items.some((i) => i.level === 'fail'), items, entry, fileCount: input.allFiles.length, scripts };
}

const MARK: Record<CheckLevel, string> = { ok: '✓', warn: '⚠', fail: '✕' };

export function formatCheck(name: string, c: ProjectCheck): string {
  const head = c.ok ? `✅ ${name} hangs together${c.items.some((i) => i.level === 'warn') ? ', with a note' : ''}.` : `❌ ${name} has a problem.`;
  const lines = [head, '', ...c.items.map((i) => `${MARK[i.level]} ${i.text}`)];
  lines.push('', c.ok ? 'That checks the pieces are all there and well-formed. It does not prove the program works — try it, and run its tests if it has them.' : 'Nothing was changed. Fix the ✕ lines and I will check again.');
  return lines.join('\n');
}
