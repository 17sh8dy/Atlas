/**
 * File intelligence and read-only utilities — 1.0.8.
 *
 *   `files.verify`         what a file REALLY is (its first bytes), whether that fits its extension,
 *                          its SHA-256, and — for programs, installers and scripts — whether
 *                          Windows trusts its signature. Read-only.
 *   `files.readDocument`   the text of a PDF or Word (.docx) file. Read-only.
 *   `files.searchContent`  find text INSIDE files in a folder: plain-text/code files (the same
 *                          `code.search` engine) and, optionally, PDF and Word documents.
 *   `files.mergeText`      join several text files into ONE NEW file. It never overwrites anything,
 *                          shows exactly what it will join first, and the originals are untouched.
 *   `registry.read`        look at one registry key (HKCU / HKLM only; never security hives; never
 *                          writes). Atlas has no tool that writes the registry.
 *
 * What these read is data, never instructions: a PDF that says "ignore your rules" is just text in a
 * result. All of it is deterministic — no model is involved.
 */

import type { Platform, Skill, SkillContext } from '@atlas/core';
import { fingerprintOf } from './organize-plan';
import { bytesText } from './pc-report';

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const trimPath = (p: unknown) => String(p ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
const stopped = (ctx: SkillContext) => ctx.signal?.aborted === true;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What Windows' own signature word means, in plain language. */
export function signatureMeaning(status: string): string {
  switch (status) {
    case 'Valid':
      return 'signed, and Windows trusts the signature';
    case 'NotSigned':
      return 'not signed (no publisher to check)';
    case 'HashMismatch':
      return 'signed, but the file has been CHANGED since it was signed';
    case 'NotTrusted':
      return 'signed, but by a publisher Windows does not trust';
    case 'UnknownError':
    case 'NotSupportedFileFormat':
      return 'Windows could not check a signature on this kind of file';
    case '':
      return 'not checked';
    default:
      return `signature status: ${status}`;
  }
}

/** Case-insensitive snippet around the first hit, one line, trimmed to ~120 characters. */
export function snippetAround(text: string, query: string, radius = 55): string | null {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return null;
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + query.length + radius);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

export function countOccurrences(text: string, query: string): number {
  if (!query) return 0;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

/** Split "a.txt | b.txt" or lines into trimmed, de-duplicated paths. */
export function splitPaths(raw: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw ?? '').split(/\r?\n|\|/)) {
    const p = trimPath(part);
    if (p && !seen.has(p.toLowerCase())) {
      seen.add(p.toLowerCase());
      out.push(p);
    }
  }
  return out;
}

const MERGE_MAX_FILES = 20;
const MERGE_MAX_TOTAL = 2 * 1024 * 1024;
const MERGE_MIN_FILES = 2;
const DOC_SCAN_MAX = 25;

export function createFileIntelSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'files.verify',
    label: 'Check a file’s type and signature',
    icon: '🔏',
    domain: 'files',
    description:
      'What a file really is (judged from its contents, not its name), whether that matches its extension, its SHA-256 fingerprint, and for programs/installers/scripts whether Windows trusts its digital signature and who signed it. Read-only; it never runs the file.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['verify D:\\Downloads\\setup.exe', 'is D:\\Downloads\\setup.exe signed', 'what kind of file is D:\\Downloads\\thing.pdf really'],
    params: { path: { type: 'string', required: true, description: 'the file to check' } },
    async run(args, ctx) {
      const path = trimPath(args.path);
      if (!path) return { ok: false, error: 'Which file should I check?' };
      if (!platform.verifyFile) return { ok: false, error: "I can't check files in this build." };
      try {
        const v = await platform.verifyFile(path);
        const hash = platform.fileHash ? await platform.fileHash(path).catch(() => null) : null;
        if (stopped(ctx)) return { ok: false, error: 'Stopped before it finished.' };
        const lines = [`🔏 ${baseName(v.path)} — ${bytesText(v.sizeBytes)}`];
        lines.push(v.realType ? `Its contents say it is a ${v.realType}.` : 'Its contents do not match a file type I recognise (plain text and many data files look like this).');
        if (v.mismatch) {
          lines.push(`⚠ The name ends in “.${v.ext || '(none)'}” but that does not fit: a ${v.realType} would usually end in ${v.expectedExt.filter(Boolean).slice(0, 4).map((e) => `.${e}`).join(', ') || 'something else'}. Be careful with a file that is not what its name says.`);
        } else if (v.realType) {
          lines.push('The extension fits.');
        }
        if (v.signable) {
          lines.push(`Signature: ${signatureMeaning(v.signature)}${v.signer ? ` — ${v.signer}` : ''}${v.issuer && v.issuer !== v.signer ? ` (issued by ${v.issuer})` : ''}${v.signedAt ? `, signed ${v.signedAt}` : ''}.`);
          if (v.signature === 'NotSigned') lines.push('Unsigned is common for small tools and hobby software; it just means I cannot tell you who made it.');
        } else {
          lines.push('This kind of file does not carry a Windows signature.');
        }
        if (hash) lines.push(`SHA-256: ${hash.sha256}`);
        lines.push('I read the file; I did not run it.');
        return { ok: true, message: lines.join('\n'), aloud: false, data: { verdict: v, sha256: hash?.sha256 ?? null } };
      } catch (e) {
        return fail(e, `I couldn't check ${baseName(path)}.`);
      }
    },
  });

  skills.push({
    id: 'registry.read',
    label: 'Read a registry key',
    icon: '🗝️',
    domain: 'system',
    description:
      'Show the sub-keys and values of one Windows registry key (HKEY_CURRENT_USER / HKEY_LOCAL_MACHINE only). Strictly read-only: Atlas has no registry write tool, security hives are refused, and values named like passwords or tokens are hidden.',
    needs: ['system'],
    risk: 'safe',
    examples: ['read the registry key HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'show registry HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'],
    params: { key: { type: 'string', required: true, description: 'the key, like HKCU\\Software\\Microsoft or HKLM\\SOFTWARE\\...' } },
    async run(args) {
      const key = trimPath(args.key);
      if (!key) return { ok: false, error: 'Which registry key? For example HKCU\\Software\\Microsoft.' };
      if (!platform.registryRead) return { ok: false, error: "I can't read the registry in this build." };
      try {
        const r = await platform.registryRead(key);
        const lines = [`🗝️ ${r.key} — ${plural(r.subkeyCount, 'sub-key')}, ${plural(r.valueCount, 'value')}`];
        if (r.values.length) lines.push('', 'Values:', ...r.values.slice(0, 40).map((v) => `• ${v.name || '(Default)'} [${v.kind}] = ${v.data}`));
        if (r.valueCount > Math.min(r.values.length, 40)) lines.push(`• …and ${r.valueCount - Math.min(r.values.length, 40)} more values`);
        if (r.subkeys.length) lines.push('', 'Sub-keys:', ...r.subkeys.slice(0, 40).map((k) => `• ${k}`));
        if (r.subkeyCount > Math.min(r.subkeys.length, 40)) lines.push(`• …and ${r.subkeyCount - Math.min(r.subkeys.length, 40)} more`);
        lines.push('', 'Read-only: nothing was changed.');
        return { ok: true, message: lines.join('\n'), aloud: false, data: r };
      } catch (e) {
        return fail(e, "I couldn't read that key.");
      }
    },
  });

  skills.push({
    id: 'files.readDocument',
    label: 'Read a PDF or Word document',
    icon: '📄',
    domain: 'files',
    description:
      'Read the text of a PDF or Word (.docx) document, optionally only the part around a word. Read-only. A scanned PDF (pictures of pages) has no text to read, and a password-protected one is refused.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['read D:\\Documents\\report.pdf', 'what does D:\\Docs\\contract.docx say', 'read the pdf D:\\Docs\\notes.pdf'],
    params: {
      path: { type: 'string', required: true, description: 'the .pdf or .docx file' },
      around: { type: 'string', required: false, description: 'only show the passages around this word' },
    },
    async run(args) {
      const path = trimPath(args.path);
      if (!path) return { ok: false, error: 'Which document?' };
      if (!platform.documentText) return { ok: false, error: "I can't read documents in this build." };
      try {
        const d = await platform.documentText(path);
        const around = typeof args.around === 'string' ? args.around.trim() : '';
        if (!d.text.trim()) {
          return { ok: true, message: `📄 ${baseName(path)} has no readable text${d.format === 'PDF' ? ' — it is probably a scan (pictures of pages), and I have no way to read pictures of text' : ''}.`, data: d };
        }
        if (around) {
          const hits: string[] = [];
          const lower = d.text.toLowerCase();
          for (let at = lower.indexOf(around.toLowerCase()); at >= 0 && hits.length < 8; at = lower.indexOf(around.toLowerCase(), at + around.length + 60)) {
            hits.push(snippetAround(d.text.slice(Math.max(0, at - 200), at + around.length + 200), around, 160) ?? '');
          }
          const n = countOccurrences(d.text, around);
          return { ok: true, message: n ? `📄 “${around}” appears ${n}× in ${baseName(path)}:\n${hits.map((h) => `• ${h}`).join('\n')}` : `📄 “${around}” isn't in ${baseName(path)}.`, aloud: false, data: { ...d, matches: n } };
        }
        const shown = d.text.length > 6000 ? `${d.text.slice(0, 6000)}\n…` : d.text;
        const head = `📄 ${baseName(path)} — ${d.format}${d.pages ? `, ${plural(d.pages, 'page')}` : ''}, ${d.text.length.toLocaleString('en-US')} characters${d.truncated ? ' (cut at the limit)' : ''}`;
        return { ok: true, message: `${head}\n\n${shown}`, aloud: false, data: d };
      } catch (e) {
        return fail(e, `I couldn't read ${baseName(path)}.`);
      }
    },
  });

  skills.push({
    id: 'files.searchContent',
    label: 'Search inside files',
    icon: '🔎',
    domain: 'files',
    description:
      'Find files whose CONTENT contains some text, in one folder (and below): text and code files, and — unless told otherwise — PDF and Word documents. Case-insensitive. Read-only; reports file, line and a short snippet.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['find files containing "invoice" in D:\\Documents', 'which files mention budget in D:\\Work'],
    params: {
      path: { type: 'string', required: true, description: 'the folder to search' },
      query: { type: 'string', required: true, description: 'the text to look for (at least 2 characters)' },
      documents: { type: 'boolean', required: false, default: true, description: 'also look inside PDF and Word documents' },
    },
    async run(args, ctx) {
      const path = trimPath(args.path);
      const query = String(args.query ?? '').trim();
      if (!path) return { ok: false, error: 'Which folder should I search?' };
      if (query.length < 2) return { ok: false, error: 'Give me at least two characters to look for.' };
      if (!platform.codeSearch) return { ok: false, error: "I can't search inside files in this build." };
      try {
        const info = await platform.pathInfo?.(path).catch(() => null);
        if (info && !info.isDirectory) return { ok: false, error: `${baseName(path)} is a file; point me at a folder.` };
        const text = await platform.codeSearch(path, query, undefined, 80);
        if (stopped(ctx)) return { ok: false, error: 'Stopped before it finished.' };

        const docHits: Array<{ path: string; count: number; snippet: string }> = [];
        let docsRead = 0;
        let docsSkipped = 0;
        const wantDocs = args.documents !== false;
        if (wantDocs && platform.documentText && platform.findFiles) {
          for (const ext of ['pdf', 'docx']) {
            const found = await platform.findFiles({ path, ext, limit: DOC_SCAN_MAX }).catch(() => null);
            for (const f of found?.items ?? []) {
              if (f.isDir) continue;
              if (stopped(ctx)) return { ok: false, error: 'Stopped before it finished.' };
              if (docsRead + docsSkipped >= DOC_SCAN_MAX) break;
              try {
                const d = await platform.documentText(f.path);
                docsRead += 1;
                const count = countOccurrences(d.text, query);
                if (count) docHits.push({ path: f.path, count, snippet: snippetAround(d.text, query) ?? '' });
              } catch {
                docsSkipped += 1;
              }
            }
          }
        }

        const byFile = new Map<string, Array<{ line: number; text: string }>>();
        for (const m of text) {
          const list = byFile.get(m.path) ?? [];
          list.push({ line: m.line, text: m.text });
          byFile.set(m.path, list);
        }
        const total = byFile.size + docHits.length;
        if (!total) {
          return { ok: true, message: `🔎 No file in ${baseName(path)} contains “${query}”${docsRead ? ` (I also looked inside ${plural(docsRead, 'document')})` : ''}.`, data: { files: [], documents: [] } };
        }
        const lines = [`🔎 “${query}” is in ${plural(total, 'file')} under ${baseName(path)}:`];
        for (const [file, hits] of [...byFile.entries()].slice(0, 15)) {
          lines.push(`• ${file}`, ...hits.slice(0, 2).map((h) => `    line ${h.line}: ${h.text.slice(0, 140)}`));
          if (hits.length > 2) lines.push(`    …and ${hits.length - 2} more line${hits.length - 2 === 1 ? '' : 's'}`);
        }
        if (byFile.size > 15) lines.push(`• …and ${byFile.size - 15} more text files`);
        for (const d of docHits.slice(0, 10)) lines.push(`• ${d.path}  (${plural(d.count, 'time')})`, `    ${d.snippet}`);
        if (docHits.length > 10) lines.push(`• …and ${docHits.length - 10} more documents`);
        if (docsRead >= DOC_SCAN_MAX) lines.push('', `I looked inside the first ${DOC_SCAN_MAX} PDF and Word documents only.`);
        if (docsSkipped) lines.push('', `${plural(docsSkipped, 'document')} could not be read (protected, scanned or damaged).`);
        return { ok: true, message: lines.join('\n'), aloud: false, data: { files: [...byFile.keys()], documents: docHits } };
      } catch (e) {
        return fail(e, `I couldn't search ${baseName(path)}.`);
      }
    },
  });

  /* ── Merge text files ─────────────────────────────────────────────────────────────────── */

  type MergePlan = { sources: Array<{ path: string; text: string }>; output: string; labels: boolean; total: number };

  async function freeName(dir: string, stem: string): Promise<string> {
    for (let i = 1; i < 100; i += 1) {
      const candidate = `${dir}\\${stem}${i === 1 ? '' : `-${i}`}.txt`;
      const exists = await platform.pathInfo?.(candidate).then(() => true).catch(() => false);
      if (!exists) return candidate;
    }
    return `${dir}\\${stem}-${Date.now()}.txt`;
  }

  async function planMerge(args: Record<string, unknown>): Promise<MergePlan | { error: string }> {
    const paths = splitPaths(args.paths);
    if (paths.length < MERGE_MIN_FILES) return { error: `Give me at least ${MERGE_MIN_FILES} files to merge, like “merge D:\\a.txt and D:\\b.txt”.` };
    if (paths.length > MERGE_MAX_FILES) return { error: `That's ${paths.length} files; I merge up to ${MERGE_MAX_FILES} at a time.` };
    if (!platform.readTextFile || !platform.createFile) return { error: "I can't merge files in this build." };
    const sources: MergePlan['sources'] = [];
    let total = 0;
    for (const p of paths) {
      try {
        const text = await platform.readTextFile(p);
        total += text.length;
        if (total > MERGE_MAX_TOTAL) return { error: 'Those files add up to more than I will merge in one go (2 MB).' };
        sources.push({ path: p, text });
      } catch (e) {
        return { error: `${baseName(p)}: ${e instanceof Error ? e.message : "I couldn't read it as text."}` };
      }
    }
    const requested = trimPath(args.output);
    let output = requested;
    if (!output) output = await freeName(dirName(paths[0]!), 'merged');
    if (paths.some((p) => p.toLowerCase() === output.toLowerCase())) return { error: 'The merged file would replace one of the originals. Pick a new name for it.' };
    if (requested) {
      const exists = await platform.pathInfo?.(output).then(() => true).catch(() => false);
      if (exists) return { error: `${baseName(output)} already exists, and I never overwrite. Pick a new name, or leave the name out and I will choose one.` };
    }
    return { sources, output, labels: args.labels !== false, total };
  }

  const joined = (p: MergePlan) =>
    p.sources
      .map((s) => (p.labels ? `===== ${baseName(s.path)} =====\n${s.text.replace(/\s+$/, '')}\n` : s.text.replace(/\s+$/, '') + '\n'))
      .join('\n');

  const mergeFingerprint = (p: MergePlan) => fingerprintOf([p.output, String(p.labels), ...p.sources.map((s) => `${s.path}|${s.text.length}|${fingerprintOf([s.text])}`)]);

  skills.push({
    id: 'files.mergeText',
    label: 'Merge text files',
    icon: '🧵',
    domain: 'files',
    description:
      'Join two or more text files, in the order given, into ONE NEW file (a heading line before each part, unless told not to). It never overwrites a file, never changes the originals, and shows what it will join before it does.',
    needs: ['fs'],
    risk: 'confirm',
    confirmAs: (a) => `merge ${splitPaths(a.paths).length} text files into a new file`,
    examples: ['merge D:\\a.txt and D:\\b.txt', 'combine D:\\a.txt and D:\\b.txt into D:\\all.txt'],
    params: {
      paths: { type: 'string', required: true, description: 'the files to join, in order, separated by | or new lines' },
      output: { type: 'string', required: false, description: 'the new file to create (must not exist); chosen for you if left out' },
      labels: { type: 'boolean', required: false, default: true, description: 'put a heading with each file’s name before its text' },
    },

    async preview(args) {
      const p = await planMerge(args);
      if ('error' in p) return { kind: 'refuse', error: p.error };
      const detail = [
        `Join ${plural(p.sources.length, 'file')} (${bytesText(p.total)}) in this order:`,
        ...p.sources.map((s, i) => `${i + 1}. ${baseName(s.path)} — ${bytesText(s.text.length)}`),
        `Into a NEW file: ${p.output}`,
        'Nothing is overwritten and the originals are not touched.',
      ].join('\n');
      return { kind: 'ask', question: `🧵 Merge ${p.sources.length} files into ${baseName(p.output)}?`, detail, fingerprint: mergeFingerprint(p) };
    },

    async run(args, ctx) {
      const p = await planMerge(args);
      if ('error' in p) return { ok: false, error: p.error };
      if (ctx.approvedPreview !== undefined && ctx.approvedPreview !== mergeFingerprint(p)) {
        return { ok: false, error: "A file changed after I showed you the plan, so I didn't merge anything. Ask again and I'll show you what's there now." };
      }
      if (stopped(ctx)) return { ok: false, error: 'Stopped before it finished.' };
      try {
        await platform.createFile!(p.output, joined(p));
        return { ok: true, message: `🧵 Merged ${plural(p.sources.length, 'file')} into ${p.output}. The originals are unchanged; delete the new file to undo.`, data: { output: p.output, sources: p.sources.map((s) => s.path) } };
      } catch (e) {
        return fail(e, 'I could not create the merged file.');
      }
    },
  });

  return skills;
}
