/**
 * `config.diff` — compare two configuration files by what they MEAN, not by their lines.
 *
 * Reads JSON, .env / .ini / .properties, TOML and simple YAML into flat `a.b.c = value` keys, then
 * reports what was added, removed and changed. Order, comments and blank lines are ignored, so a
 * re-sorted file with the same settings reports no difference. Anything that looks like a secret
 * (a password, token, key…) is NEVER printed: the report says only that it differs.
 *
 * Pure: it takes text and gives text. The skill reads the two files and nothing else.
 */

export type ConfigFormat = 'json' | 'env' | 'toml' | 'yaml';

const SECRET_KEY = /(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|private[_-]?key|credential|auth|bearer|signature|salt|cookie|session[_-]?id)/i;
export const isSecretKey = (key: string) => SECRET_KEY.test(key);

export function detectFormat(name: string, text: string): ConfigFormat {
  const n = name.toLowerCase();
  if (/\.json[c5]?$/.test(n)) return 'json';
  if (/\.ya?ml$/.test(n)) return 'yaml';
  if (/\.toml$/.test(n)) return 'toml';
  if (/(?:^|[\\/])\.env(?:\.[^\\/]*)?$|\.(?:env|ini|properties|conf|cfg)$/.test(n)) return 'env';
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (/^[A-Za-z0-9_.-]+\s*:\s/m.test(t) && !/^[A-Za-z0-9_.-]+\s*=/m.test(t)) return 'yaml';
  return 'env';
}

function flatten(value: unknown, prefix: string, out: Map<string, string>) {
  if (Array.isArray(value)) {
    if (!value.length) out.set(prefix, '[]');
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length && prefix) out.set(prefix, '{}');
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, value === null ? 'null' : String(value));
  }
}

const unquote = (v: string) => {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2) ? t.slice(1, -1) : t;
};

/** Strip a trailing ` # comment` that is not inside quotes. */
function stripComment(line: string): string {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function parseEnvLike(text: string, out: Map<string, string>, toml: boolean) {
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = (toml ? stripComment(raw) : raw).trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
    const sec = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (sec) {
      section = sec[1]!.trim();
      continue;
    }
    const m = /^(?:export\s+)?([^=:#\s][^=]*?)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = section ? `${section}.${m[1]!.trim()}` : m[1]!.trim();
    out.set(key, unquote(toml ? stripComment(m[2]!) : m[2]!));
  }
}

function parseYamlLite(text: string, out: Map<string, string>) {
  const stack: Array<{ indent: number; key: string }> = [];
  const counters = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const noComment = stripComment(raw);
    if (!noComment.trim() || noComment.trim() === '---') continue;
    const indent = noComment.length - noComment.trimStart().length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack.map((s) => s.key).join('.');
    const item = /^-\s+(.*)$/.exec(noComment.trim());
    if (item) {
      const i = counters.get(parent) ?? 0;
      counters.set(parent, i + 1);
      const kv = /^([^:]+?):\s*(.*)$/.exec(item[1]!);
      if (kv && !/^["']/.test(item[1]!)) out.set(`${parent}[${i}].${kv[1]!.trim()}`, unquote(kv[2]!));
      else out.set(`${parent}[${i}]`, unquote(item[1]!));
      continue;
    }
    const m = /^([^:]+?):\s*(.*)$/.exec(noComment.trim());
    if (!m) continue;
    const key = m[1]!.trim();
    if (m[2]!.trim() === '' || m[2]!.trim() === '|' || m[2]!.trim() === '>') stack.push({ indent, key });
    else out.set(parent ? `${parent}.${key}` : key, unquote(m[2]!));
  }
}

export function parseConfig(name: string, text: string): { format: ConfigFormat; values: Map<string, string> } | { error: string } {
  const format = detectFormat(name, text);
  const values = new Map<string, string>();
  try {
    if (format === 'json') {
      // JSON with comments / trailing commas is common in config; strip them rather than refuse.
      const cleaned = text.replace(/^\uFEFF/, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1');
      flatten(JSON.parse(cleaned), '', values);
    } else if (format === 'yaml') parseYamlLite(text, values);
    else parseEnvLike(text, values, format === 'toml');
  } catch (e) {
    return { error: `${name} isn't valid ${format.toUpperCase()}: ${e instanceof Error ? e.message : 'it did not parse'}.` };
  }
  return { format, values };
}

export interface ConfigDiff {
  added: Array<[string, string]>;
  removed: Array<[string, string]>;
  changed: Array<[string, string, string]>;
  same: number;
}

export function diffConfig(a: Map<string, string>, b: Map<string, string>): ConfigDiff {
  const d: ConfigDiff = { added: [], removed: [], changed: [], same: 0 };
  for (const [k, v] of a) {
    if (!b.has(k)) d.removed.push([k, v]);
    else if (b.get(k) !== v) d.changed.push([k, v, b.get(k)!]);
    else d.same += 1;
  }
  for (const [k, v] of b) if (!a.has(k)) d.added.push([k, v]);
  const byKey = (x: [string, ...string[]], y: [string, ...string[]]) => x[0].localeCompare(y[0]);
  d.added.sort(byKey);
  d.removed.sort(byKey);
  d.changed.sort(byKey);
  return d;
}

/** Settings where a change tends to matter more than most. */
const NOTABLE = /(?:port|host|url|uri|endpoint|domain|debug|verbose|log[_.-]?level|env(?:ironment)?|mode|production|enabled?|disabled?|ssl|tls|https?|cors|origin|timeout|retries|limit|memory|path|dir|version)/i;

const show = (key: string, value: string) => (isSecretKey(key) ? '(secret, hidden)' : value.length > 80 ? `${value.slice(0, 79)}…` : value === '' ? '(empty)' : value);

export function formatConfigDiff(nameA: string, nameB: string, d: ConfigDiff, maxLines = 30): string {
  const total = d.added.length + d.removed.length + d.changed.length;
  if (!total) return `⚖️ ${nameA} and ${nameB} have the same ${d.same} setting${d.same === 1 ? '' : 's'} (order, comments and spacing don’t count).`;
  const lines = [`⚖️ ${nameA} → ${nameB}: ${d.changed.length} changed, ${d.added.length} added, ${d.removed.length} removed, ${d.same} the same.`];
  const flag = (k: string) => (NOTABLE.test(k) ? '  ⚑' : '');
  const rows: string[] = [];
  for (const [k, from, to] of d.changed) rows.push(isSecretKey(k) ? `~ ${k}: changed (value hidden)${flag(k)}` : `~ ${k}: ${show(k, from)} → ${show(k, to)}${flag(k)}`);
  for (const [k, v] of d.added) rows.push(`+ ${k} = ${show(k, v)}${flag(k)}`);
  for (const [k, v] of d.removed) rows.push(`- ${k} = ${show(k, v)}${flag(k)}`);
  lines.push('', ...rows.slice(0, maxLines));
  if (rows.length > maxLines) lines.push(`…and ${rows.length - maxLines} more.`);
  if (rows.some((r) => r.endsWith('⚑'))) lines.push('', '⚑ marks settings that usually matter more than most (hosts, ports, modes, switches, paths). Secrets are never shown.');
  else lines.push('', 'Secrets are never shown.');
  lines.push('Nothing was changed or applied.');
  return lines.join('\n');
}
