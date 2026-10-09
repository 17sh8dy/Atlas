/**
 * `knowledge.citeEvidence` — answer a question FROM local files, and show where each line came from.
 *
 * Finds the passages in a folder's text files that best match the words of a question and returns
 * them with the file and line numbers, quoted exactly. It does not paraphrase and does not add
 * anything: what comes back is the file's own text, so a person can open it and check. If nothing
 * in the folder mentions the words, it says that rather than producing an answer from nowhere.
 *
 * This is retrieval, not understanding. A passage that shares the question's words is a lead; it is
 * not proof the passage answers the question.
 */

const STOP = new Set(
  'a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who whom why will with would you your about tell show find give'.split(
    ' ',
  ),
);

export const termsOf = (question: string): string[] => {
  const words = question.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words.map((w) => w.replace(/(?:ing|ed|es|s)$/, '') || w))];
};

export interface Passage {
  file: string;
  /** 1-based, inclusive. */
  from: number;
  to: number;
  text: string;
  matched: string[];
  score: number;
}

export interface SourceFile {
  rel: string;
  text: string;
}

const WINDOW = 3;

export function findPassages(question: string, files: readonly SourceFile[], max = 5): { terms: string[]; passages: Passage[] } {
  const terms = termsOf(question);
  if (!terms.length) return { terms, passages: [] };

  // Rarer terms count for more: how many files mention each one.
  const docFreq = new Map<string, number>();
  for (const t of terms) docFreq.set(t, files.filter((f) => f.text.toLowerCase().includes(t)).length);
  const weight = (t: string) => 1 + Math.log(1 + files.length / (1 + (docFreq.get(t) ?? 0)));

  const all: Passage[] = [];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    const lower = lines.map((l) => l.toLowerCase());
    for (let start = 0; start < lines.length; start++) {
      const end = Math.min(lines.length, start + WINDOW);
      const slice = lower.slice(start, end).join(' ');
      const matched = terms.filter((t) => slice.includes(t));
      if (!matched.length) continue;
      // Start only where the first line itself matches, so windows don't shadow one another.
      if (!terms.some((t) => lower[start]!.includes(t))) continue;
      const score = matched.reduce((s, t) => s + weight(t), 0) * (matched.length / terms.length + 0.5);
      // A window that runs into blank lines ends at its last real line, so the cited range is exact.
      let last = end;
      while (last > start + 1 && lines[last - 1]!.trim() === '') last -= 1;
      all.push({ file: f.rel, from: start + 1, to: last, text: lines.slice(start, last).join('\n').trim(), matched, score });
    }
  }
  all.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.from - b.from);

  // Best first, but never two passages that overlap in the same file.
  const chosen: Passage[] = [];
  for (const p of all) {
    if (chosen.some((c) => c.file === p.file && p.from <= c.to && p.to >= c.from)) continue;
    chosen.push(p);
    if (chosen.length >= max) break;
  }
  return { terms, passages: chosen };
}

export function formatPassages(question: string, r: { terms: string[]; passages: Passage[] }, scanned: number): string {
  if (!r.terms.length) return 'What would you like me to find? Ask it with a few specific words — “what does the update system do” — and name the folder.';
  if (!r.passages.length) {
    return `📎 Nothing in the ${scanned} file${scanned === 1 ? '' : 's'} I looked at mentions ${r.terms.map((t) => `“${t}”`).join(', ')}, so I have no local source for that. I won’t answer it from memory and call it sourced.`;
  }
  const lines = [`📎 ${r.passages.length} passage${r.passages.length === 1 ? '' : 's'} from your files that match “${question.trim().replace(/[?.!]+$/, '')}” — quoted exactly, with where to find them:`, ''];
  r.passages.forEach((p, i) => {
    const text = p.text.length > 400 ? `${p.text.slice(0, 399)}…` : p.text;
    lines.push(`[${i + 1}] ${p.file}, line${p.from === p.to ? ` ${p.from}` : `s ${p.from}–${p.to}`} (matches ${p.matched.join(', ')})`, ...text.split('\n').map((l) => `    ${l}`), '');
  });
  lines.push('These are the file’s own words. Sharing a question’s words makes a passage a lead, not proof it answers the question — open the file to confirm.');
  return lines.join('\n');
}
