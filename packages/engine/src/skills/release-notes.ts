/**
 * Release notes from a commit list — pure, deterministic, no model.
 *
 * It sorts commits by what their own message says: conventional-commit prefixes (`feat:`, `fix(ui):`),
 * or the plain verb a commit starts with ("Add …", "Fixed …", "Remove …"). A message it cannot place
 * goes under “Other changes” unchanged — it never invents what a commit did. Merge commits are not
 * passed in (the native side leaves them out), and the ones that are only a version bump are folded
 * away.
 */

export interface CommitRow {
  hash: string;
  author?: string;
  date?: string;
  subject: string;
}

export type NoteSection = 'Breaking changes' | 'Added' | 'Fixed' | 'Improved' | 'Changed' | 'Removed' | 'Documentation' | 'Internal' | 'Other changes';

export const SECTION_ORDER: NoteSection[] = ['Breaking changes', 'Added', 'Fixed', 'Improved', 'Changed', 'Removed', 'Documentation', 'Internal', 'Other changes'];

const CONVENTIONAL: Record<string, NoteSection> = {
  feat: 'Added', feature: 'Added', add: 'Added',
  fix: 'Fixed', bugfix: 'Fixed', hotfix: 'Fixed',
  perf: 'Improved', improve: 'Improved',
  refactor: 'Changed', change: 'Changed', style: 'Changed', update: 'Changed',
  remove: 'Removed', revert: 'Removed',
  docs: 'Documentation', doc: 'Documentation',
  chore: 'Internal', build: 'Internal', ci: 'Internal', test: 'Internal', tests: 'Internal',
};

const VERBS: Array<[RegExp, NoteSection]> = [
  [/^(add|adds|added|adding|new|introduce[sd]?|create[sd]?|support)\b/i, 'Added'],
  [/^(fix|fixes|fixed|fixing|resolve[sd]?|repair(?:ed)?|correct(?:ed)?|patch(?:ed)?)\b/i, 'Fixed'],
  [/^(improve[sd]?|speed|faster|optimi[sz]e[sd]?|reduce[sd]?|smooth(?:er|ed)?)\b/i, 'Improved'],
  [/^(remove[sd]?|delete[sd]?|drop(?:ped)?)\b/i, 'Removed'],
  [/^(update[sd]?|change[sd]?|rename[sd]?|move[sd]?|refactor(?:ed)?|switch(?:ed)?|replace[sd]?|rework(?:ed)?)\b/i, 'Changed'],
  [/^(doc|docs|document(?:ed)?|readme)\b/i, 'Documentation'],
  [/^(test|tests|ci|build|bump|chore|lint|format)\b/i, 'Internal'],
];

const VERSION_ONLY = /^(?:version\s+v?\d+(?:\.\d+)*|v?\d+\.\d+\.\d+|bump(?:ed)?\s+(?:the\s+)?version.*|release\s+v?\d+(?:\.\d+)*)\s*$/i;

export interface Classified {
  section: NoteSection;
  text: string;
  hash: string;
  breaking: boolean;
}

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
};

export function classifyCommit(c: CommitRow): Classified | null {
  const subject = c.subject.trim();
  if (!subject || VERSION_ONLY.test(subject)) return null;
  const conv = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
  if (conv) {
    const kind = conv[1]!.toLowerCase();
    const section = CONVENTIONAL[kind];
    if (section) {
      const scope = conv[2] ? `${conv[2]}: ` : '';
      const breaking = conv[3] === '!' || /BREAKING/.test(subject);
      return { section: breaking ? 'Breaking changes' : section, text: sentence(`${scope}${conv[4]}`), hash: c.hash, breaking };
    }
  }
  // "1.0.8: fix project tools…" — a leading version label is not a category.
  const stripped = subject.replace(/^v?\d+(?:\.\d+)+(?:\s*\([^)]*\))?\s*[:\-–]\s*/, '');
  const breaking = /\bBREAKING\b/.test(stripped);
  for (const [re, section] of VERBS) {
    if (re.test(stripped)) return { section: breaking ? 'Breaking changes' : section, text: sentence(stripped), hash: c.hash, breaking };
  }
  return { section: breaking ? 'Breaking changes' : 'Other changes', text: sentence(stripped), hash: c.hash, breaking };
}

export interface ReleaseNotes {
  title: string;
  total: number;
  skipped: number;
  sections: Array<{ section: NoteSection; items: Classified[] }>;
}

export function buildReleaseNotes(commits: ReadonlyArray<CommitRow>, opts: { version?: string; since?: string }): ReleaseNotes {
  const bySection = new Map<NoteSection, Classified[]>();
  let skipped = 0;
  const seen = new Set<string>();
  for (const c of commits) {
    const k = classifyCommit(c);
    if (!k) {
      skipped += 1;
      continue;
    }
    // The same change committed twice (a squash and its fixup) is listed once.
    const key = `${k.section}|${k.text.toLowerCase()}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const list = bySection.get(k.section) ?? [];
    list.push(k);
    bySection.set(k.section, list);
  }
  const sections = SECTION_ORDER.filter((s) => bySection.has(s)).map((section) => ({ section, items: bySection.get(section)! }));
  const title = opts.version ? `Release notes — ${opts.version}` : opts.since ? `Changes since ${opts.since}` : 'Recent changes';
  return { title, total: commits.length, skipped, sections };
}

export function formatReleaseNotes(n: ReleaseNotes, opts: { hashes?: boolean } = {}): string {
  if (!n.sections.length) return `${n.title}\n\nNo changes to list.`;
  const lines = [`## ${n.title}`, ''];
  for (const s of n.sections) {
    lines.push(`### ${s.section}`, ...s.items.map((i) => `- ${i.text}${opts.hashes ? ` (${i.hash})` : ''}`), '');
  }
  const shown = n.sections.reduce((t, s) => t + s.items.length, 0);
  lines.push(`_${shown} change${shown === 1 ? '' : 's'} from ${n.total} commit${n.total === 1 ? '' : 's'}${n.skipped ? `; ${n.skipped} version bump${n.skipped === 1 ? '' : 's'} or duplicate${n.skipped === 1 ? '' : 's'} left out` : ''}._`);
  return lines.join('\n');
}

/** Parse the native `%h\x1f%an\x1f%ad\x1f%s` lines. A malformed line is skipped, not guessed at. */
export function parseCommitLines(raw: string): CommitRow[] {
  const out: CommitRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split('\u001f');
    if (parts.length < 4 || !parts[0]!.trim()) continue;
    out.push({ hash: parts[0]!.trim(), author: parts[1], date: parts[2], subject: parts.slice(3).join('\u001f') });
  }
  return out;
}
