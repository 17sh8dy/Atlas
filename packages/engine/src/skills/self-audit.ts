/**
 * `atlas.selfAudit` — Atlas looks at its OWN tool list, not at the machine.
 *
 * `engine.selfTest` asks "is this installation in working order?" (does the registry load, do the
 * advertised phrasings still route, are git and ffmpeg there). This asks a different question about
 * the same registry: "is every tool declared properly?" — the thing that goes wrong quietly when a
 * catalog passes three hundred entries. It reads declarations only and runs nothing.
 *
 * What it can and cannot say: it finds declarations that are missing, malformed or inconsistent. It
 * does not prove a tool WORKS (that is the tests, and `engine.selfTest`), and a "looks risky" hint is
 * a prompt for a person to look, never a verdict.
 */

export type AuditLevel = 'fail' | 'warn' | 'info';

export interface AuditSkillView {
  id: string;
  label: string;
  domain: string;
  description: string;
  risk?: string;
  needs?: readonly string[];
  examples?: readonly string[];
  hasRiskFor?: boolean;
  params?: Record<string, { type?: string; description?: string; required?: boolean; default?: unknown; enum?: readonly string[] }>;
  /** Visible on this build (its capabilities are present). */
  available: boolean;
}

export interface AuditFinding {
  level: AuditLevel;
  skill: string;
  text: string;
}

export interface AuditReport {
  total: number;
  available: number;
  findings: AuditFinding[];
  /** Tools that are hidden here, by the capability they need. */
  hiddenBy: Record<string, number>;
}

/** Words in an id that mean the tool changes something a closing window will not undo. */
const CHANGES_THINGS = /(?:^|\.)(?:delete|remove|clear|kill|close|uninstall|format|shutdown|restart|reboot|move|rename|overwrite|write|install|push|commit|discard|empty|wipe|erase|terminate|logoff|signout|disable|enable|set|send|create|replaceAll|revert|change)/i;

const ID_SHAPE = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/;

export function auditSkills(skills: readonly AuditSkillView[], knownCapabilities?: ReadonlySet<string>): AuditReport {
  const findings: AuditFinding[] = [];
  const add = (level: AuditLevel, skill: string, text: string) => findings.push({ level, skill, text });
  const hiddenBy: Record<string, number> = {};
  const labels = new Map<string, string[]>();

  for (const s of skills) {
    if (!ID_SHAPE.test(s.id)) add('fail', s.id, 'its id is not of the form domain.name.');
    if (!s.label?.trim()) add('fail', s.id, 'it has no label.');
    if (!s.domain?.trim()) add('fail', s.id, 'it has no domain.');
    if (!s.description?.trim()) add('fail', s.id, 'it has no description (a model and the capability browser both read it).');
    else if (s.description.trim().length < 25) add('warn', s.id, `its description is very short (“${s.description.trim()}”).`);

    for (const [name, p] of Object.entries(s.params ?? {})) {
      if (!p.description?.trim()) add('warn', s.id, `parameter “${name}” has no description, so a model has to guess what it means.`);
      if (!p.type) add('fail', s.id, `parameter “${name}” has no type.`);
      if (p.enum && p.enum.length === 0) add('fail', s.id, `parameter “${name}” is an empty enum, so nothing could ever be passed.`);
      if (p.enum && typeof p.default === 'string' && !p.enum.includes(p.default)) add('fail', s.id, `parameter “${name}” defaults to “${p.default}”, which is not in its own list.`);
      if (p.required && p.default !== undefined) add('warn', s.id, `parameter “${name}” is required AND has a default; one of those is wrong.`);
    }

    if (s.risk && s.risk !== 'safe' && s.risk !== 'confirm') add('fail', s.id, `its risk is “${s.risk}”, which is not safe or confirm.`);
    if ((s.risk ?? 'safe') === 'safe' && !s.hasRiskFor && CHANGES_THINGS.test(s.id)) {
      add('info', s.id, 'it is marked safe but its name suggests it changes something. Worth a look that it should not ask first.');
    }
    if (!s.examples?.length) add('info', s.id, 'it has no example phrasing, so it cannot be searched or suggested by a sentence.');

    for (const need of s.needs ?? []) {
      if (knownCapabilities && !knownCapabilities.has(need)) add('fail', s.id, `it needs “${need}”, which is not a capability Atlas knows, so it can never become available.`);
    }
    if (!s.available) {
      const key = (s.needs ?? []).join(' + ') || 'unknown';
      hiddenBy[key] = (hiddenBy[key] ?? 0) + 1;
    }

    const key = s.label.trim().toLowerCase();
    if (key) labels.set(key, [...(labels.get(key) ?? []), s.id]);
  }

  for (const [label, ids] of labels) {
    if (ids.length > 1) add('warn', ids.join(', '), `share the label “${label}”, so a list of tools shows the same name twice.`);
  }

  const order: Record<AuditLevel, number> = { fail: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level] || a.skill.localeCompare(b.skill));
  return { total: skills.length, available: skills.filter((s) => s.available).length, findings, hiddenBy };
}

const MARK: Record<AuditLevel, string> = { fail: '❌', warn: '⚠️', info: 'ℹ️' };

export function formatAudit(r: AuditReport, maxLines = 25): string {
  const count = (l: AuditLevel) => r.findings.filter((f) => f.level === l).length;
  const fails = count('fail');
  const warns = count('warn');
  const infos = count('info');
  const head =
    fails === 0 && warns === 0
      ? `✅ I checked how all ${r.total} of my tools are declared and found nothing wrong${infos ? ` (${infos} small note${infos === 1 ? '' : 's'})` : ''}.`
      : `${fails ? '❌' : '⚠️'} I checked how all ${r.total} of my tools are declared: ${fails} problem${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}, ${infos} note${infos === 1 ? '' : 's'}.`;
  const lines = [head, `${r.available} are available on this PC${r.total - r.available ? `; ${r.total - r.available} are hidden because this build lacks something they need` : ''}.`];
  const hidden = Object.entries(r.hiddenBy).sort((a, b) => b[1] - a[1]);
  if (hidden.length) lines.push(`Hidden by: ${hidden.slice(0, 5).map(([k, n]) => `${k} (${n})`).join(', ')}.`);
  const shown = r.findings.filter((f) => f.level !== 'info').concat(r.findings.filter((f) => f.level === 'info')).slice(0, maxLines);
  if (shown.length) lines.push('', ...shown.map((f) => `${MARK[f.level]} ${f.skill}: ${f.text}`));
  if (r.findings.length > shown.length) lines.push(`…and ${r.findings.length - shown.length} more.`);
  lines.push('', 'This reads how each tool is declared. It does not prove any of them works — “run a self test” checks the install itself.');
  return lines.join('\n');
}
