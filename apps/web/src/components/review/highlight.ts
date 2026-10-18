/**
 * A small, dependency-free syntax highlighter for diff lines.
 *
 * It colours what is obvious (comments, strings, numbers, keywords) in the languages people most
 * often ask Atlas to edit, and leaves everything else plain. It is deliberately NOT a parser: each
 * line is coloured on its own, so a string or comment that runs over several lines is only coloured
 * where it starts on that line. A diff shows a few lines of context at a time, so that is the honest
 * limit, and a wrong colour is far better than a wrong character.
 *
 * The one invariant that must never break: the tokens of a line, joined, are EXACTLY that line.
 * Highlighting may only decide colours. It must never add, drop or alter a character, because what
 * is shown in a review has to be what is in the file. `highlight.test.ts` holds this for every
 * language and for a few thousand random lines.
 *
 * Unknown file types are shown plain. "Syntax highlighting where supported" means exactly that.
 */

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number';

export interface Token {
  kind: TokenKind;
  text: string;
}

export type Lang = 'js' | 'json' | 'python' | 'rust' | 'c' | 'css' | 'html' | 'shell' | 'markdown' | 'yaml' | 'plain';

const EXT: Record<string, Lang> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  json: 'json', jsonc: 'json',
  py: 'python', pyw: 'python',
  rs: 'rust',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', cs: 'c', java: 'c', go: 'c', kt: 'c', swift: 'c',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  sh: 'shell', bash: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml',
};

export function languageOf(path: string): Lang {
  const name = path.split(/[\\/]/).pop() ?? '';
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return EXT[ext] ?? 'plain';
}

const set = (words: string) => new Set(words.split(/\s+/).filter(Boolean));

const KEYWORDS: Record<Lang, Set<string>> = {
  js: set(
    'const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of this super null undefined true false void yield interface type enum implements readonly public private protected static as',
  ),
  json: set('true false null'),
  python: set(
    'def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield None True False async await global nonlocal',
  ),
  rust: set(
    'fn let mut const static struct enum impl trait use mod pub crate self super match if else for while loop return break continue as in ref move async await where type unsafe true false Some None Ok Err',
  ),
  c: set(
    'int long short char float double void unsigned signed bool const static struct class enum union if else for while do switch case break continue return new delete public private protected virtual override namespace using typedef sizeof null nullptr true false func package import var interface go defer range fun val',
  ),
  css: set('important inherit initial unset none auto'),
  html: set(''),
  shell: set('if then else elif fi for while do done case esac function return exit echo export local set unset in param foreach'),
  markdown: set(''),
  yaml: set('true false null yes no on off'),
  plain: set(''),
};

const LINE_COMMENT: Partial<Record<Lang, string[]>> = {
  js: ['//'],
  rust: ['//'],
  c: ['//'],
  python: ['#'],
  shell: ['#', 'REM '],
  yaml: ['#'],
};

const BLOCK_COMMENT: Partial<Record<Lang, [string, string]>> = {
  js: ['/*', '*/'],
  rust: ['/*', '*/'],
  c: ['/*', '*/'],
  css: ['/*', '*/'],
  html: ['<!--', '-->'],
};

const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);

/** Colour one line. The tokens always join back to `line` exactly. */
export function highlightLine(line: string, lang: Lang): Token[] {
  if (lang === 'plain' || line === '') return [{ kind: 'plain', text: line }];
  const out: Token[] = [];
  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };

  // Markdown: headings and inline code are the only things worth colouring.
  if (lang === 'markdown') {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return [{ kind: 'keyword', text: line }];
    let i = 0;
    while (i < line.length) {
      const tick = line.indexOf('`', i);
      if (tick < 0) break;
      const end = line.indexOf('`', tick + 1);
      if (end < 0) break;
      push('plain', line.slice(i, tick));
      push('string', line.slice(tick, end + 1));
      i = end + 1;
    }
    push('plain', line.slice(i));
    return out;
  }

  const keywords = KEYWORDS[lang];
  const lineComments = LINE_COMMENT[lang] ?? [];
  const block = BLOCK_COMMENT[lang];
  const quotes = lang === 'html' ? ['"', "'"] : ['"', "'", '`'];
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const c = line[i]!;

    const lc = lineComments.find((m) => rest.startsWith(m) && (m !== '#' || lang !== 'css'));
    // A "#" starts a comment only at the start of a word, so `#fff` in CSS or `$#` in shell is not one.
    if (lc && (lc.length > 1 || i === 0 || /\s/.test(line[i - 1]!) || lang === 'python')) {
      push('comment', rest);
      break;
    }
    if (block && rest.startsWith(block[0])) {
      const end = line.indexOf(block[1], i + block[0].length);
      if (end < 0) {
        push('comment', rest);
        break;
      }
      push('comment', line.slice(i, end + block[1].length));
      i = end + block[1].length;
      continue;
    }
    if (quotes.includes(c)) {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, line.length);
      push('string', line.slice(i, stop));
      i = stop;
      continue;
    }
    if (lang === 'html' && c === '<' && /[A-Za-z/]/.test(line[i + 1] ?? '')) {
      const m = /^<\/?[A-Za-z][\w:-]*/.exec(rest);
      if (m) {
        push('keyword', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[0-9]/.test(c) && !isWordChar(line[i - 1])) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
      if (m) {
        push('number', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (isWordChar(c) && !isWordChar(line[i - 1])) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
      if (m) {
        push(keywords.has(m[0]) ? 'keyword' : 'plain', m[0]);
        i += m[0].length;
        continue;
      }
    }
    push('plain', c);
    i += 1;
  }
  return out;
}

/** Tailwind classes for each kind. Chosen to stay legible on the green and red diff backgrounds. */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: '',
  keyword: 'text-primary',
  string: 'text-success',
  comment: 'text-foreground-subtle italic',
  number: 'text-warning',
};
