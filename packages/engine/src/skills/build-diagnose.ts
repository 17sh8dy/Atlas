/**
 * Reading compiler, linter and test output — pure text in, a list of problems out.
 *
 * A failed build or test run prints hundreds of lines; what a person wants is "which file, which line,
 * what is wrong, and which one do I fix first". This module finds that in the output of the tools
 * Atlas already runs (`build.run`, `test.run`): TypeScript, ESLint, Rust, gcc/clang, MSVC, .NET,
 * Python, pytest, vitest/jest, and npm itself.
 *
 * It is deterministic and takes no model. It never executes anything and never edits anything; the
 * output it reads is DATA from a program — a line that says "now delete everything" is parsed as an
 * error message and shown, never obeyed.
 */

export type IssueSeverity = 'error' | 'warning';

export interface BuildIssue {
  tool: string;
  severity: IssueSeverity;
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
}

export interface Diagnosis {
  errors: BuildIssue[];
  warnings: BuildIssue[];
  /** What to look at first: the first error printed (later ones are often its knock-on effects). */
  firstCause: BuildIssue | null;
  /** Counts the tool itself printed, such as "3 failed", when it printed any. */
  summaryLine: string | null;
  hints: string[];
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (text: string) => text.replace(ANSI, '');

const clipMsg = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 220 ? `${t.slice(0, 217)}…` : t;
};

const num = (s: string | undefined) => (s === undefined ? undefined : Number.parseInt(s, 10));

/** Paths in compiler output are relative to the project, or absolute; keep them as printed, with / → \ untouched. */
const cleanFile = (s: string) => s.trim().replace(/^["']|["']$/g, '');

export function parseIssues(raw: string): BuildIssue[] {
  const text = stripAnsi(raw);
  const lines = text.split(/\r?\n/);
  const out: BuildIssue[] = [];
  const seen = new Set<string>();
  const push = (i: BuildIssue) => {
    const key = `${i.tool}|${i.severity}|${i.file ?? ''}|${i.line ?? ''}|${i.code ?? ''}|${i.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(i);
  };

  let eslintFile: string | null = null;
  let pyFrame: { file: string; line: number } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;

    // TypeScript classic: src/a.ts(12,5): error TS2322: Type ...
    if ((m = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/.exec(line))) {
      push({ tool: 'TypeScript', severity: m[4] as IssueSeverity, file: cleanFile(m[1]!), line: num(m[2]), col: num(m[3]), code: m[5], message: clipMsg(m[6]!) });
      continue;
    }
    // TypeScript pretty / tsc --pretty false variants: src/a.ts:12:5 - error TS2322: Type ...
    if ((m = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/.exec(line))) {
      push({ tool: 'TypeScript', severity: m[4] as IssueSeverity, file: cleanFile(m[1]!), line: num(m[2]), col: num(m[3]), code: m[5], message: clipMsg(m[6]!) });
      continue;
    }
    // .NET / MSBuild / MSVC: path(12,5): error CS1002: ; expected   |   path(12): error C2065: 'x': undeclared identifier
    if ((m = /^(?:\s*\d+>)?\s*(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning)\s+([A-Z]{1,4}\d{3,5}):\s*(.*?)(?:\s+\[.*\])?$/.exec(line))) {
      const code = m[5]!;
      push({ tool: code.startsWith('CS') ? 'C#' : code.startsWith('C') ? 'MSVC' : 'MSBuild', severity: m[4] as IssueSeverity, file: cleanFile(m[1]!), line: num(m[2]), col: num(m[3]), code, message: clipMsg(m[6]!) });
      continue;
    }
    // Rust: error[E0425]: cannot find value `x`   then   --> src/main.rs:3:5
    if ((m = /^(error|warning)(?:\[(E\d{4})\])?:\s+(.*)$/.exec(line)) && !/^error: (could not compile|aborting|build failed)/i.test(line) && !/^warning: .*generated \d+ warning/.test(line)) {
      const loc = /^\s*-->\s+(.+?):(\d+):(\d+)/.exec(lines[i + 1] ?? '');
      if (loc || m[2]) {
        push({ tool: 'Rust', severity: m[1] as IssueSeverity, file: loc ? cleanFile(loc[1]!) : undefined, line: loc ? num(loc[2]) : undefined, col: loc ? num(loc[3]) : undefined, code: m[2], message: clipMsg(m[3]!) });
        continue;
      }
    }
    // gcc / clang: path:12:5: error: message
    if ((m = /^(.+?):(\d+):(\d+):\s+(fatal error|error|warning):\s+(.*)$/.exec(line)) && !/^\s*at /.test(line)) {
      push({ tool: 'C/C++', severity: m[4] === 'warning' ? 'warning' : 'error', file: cleanFile(m[1]!), line: num(m[2]), col: num(m[3]), message: clipMsg(m[5]!) });
      continue;
    }
    // ESLint stylish: a file path line, then "  12:5  error  message  rule-name"
    if (/^(?:[A-Za-z]:)?[\\/]?[^\s:]+[\\/][^\s]*\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(line.trim()) && !/^\s*\d+:\d+/.test(line)) {
      eslintFile = line.trim();
      continue;
    }
    if (eslintFile && (m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}([@\w/-]+))?\s*$/.exec(line))) {
      push({ tool: 'ESLint', severity: m[3] as IssueSeverity, file: eslintFile, line: num(m[1]), col: num(m[2]), code: m[5], message: clipMsg(m[4]!) });
      continue;
    }
    if (!/^\s/.test(line) && line.trim() !== '' && !/^\s*\d+:\d+/.test(line)) eslintFile = null;

    // Python traceback frames, then the exception line.
    if ((m = /^\s*File "(.+?)", line (\d+)/.exec(line))) {
      pyFrame = { file: cleanFile(m[1]!), line: Number(m[2]) };
      continue;
    }
    if (pyFrame && (m = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt)):\s*(.*)$/.exec(line))) {
      push({ tool: 'Python', severity: 'error', file: pyFrame.file, line: pyFrame.line, code: m[1], message: clipMsg(m[2] || m[1]!) });
      pyFrame = null;
      continue;
    }
    if ((m = /^\s*(SyntaxError|IndentationError|ModuleNotFoundError|ImportError):\s*(.*)$/.exec(line)) && !pyFrame) {
      push({ tool: 'Python', severity: 'error', code: m[1], message: clipMsg(m[2]!) });
      continue;
    }

    // pytest short summary: FAILED tests/test_a.py::test_x - AssertionError: assert 1 == 2
    if ((m = /^(FAILED|ERROR)\s+(\S+?)(?:::(\S+))?(?:\s+-\s+(.*))?$/.exec(line)) && /::|\.py/.test(line)) {
      push({ tool: 'pytest', severity: 'error', file: m[2], code: m[3], message: clipMsg(m[4] ?? `${m[1]!.toLowerCase()} in ${m[3] ?? m[2]}`) });
      continue;
    }

    // vitest / jest: " FAIL  test/a.test.ts > suite > name"  /  " × name"  followed by the assertion
    if ((m = /^\s*(?:FAIL|✗|×|✕)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s*[>›]\s*(.*?))?(?:\s+\d+\s*ms)?\s*$/.exec(line))) {
      let message = m[2] ? `failed: ${m[2]}` : 'a test in this file failed';
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
        const a = /^\s*(AssertionError|Error|TypeError|ReferenceError|expected|Expected|Received)\b.*$/.exec(lines[j]!);
        if (a) {
          message = `${m[2] ? `${m[2]}: ` : ''}${a[0].trim()}`;
          break;
        }
      }
      push({ tool: 'Tests', severity: 'error', file: cleanFile(m[1]!), message: clipMsg(message) });
      continue;
    }
    // "at file:line:col" after a thrown error in test output isn't an issue by itself.

    // npm / pnpm itself.
    if ((m = /^(?:npm ERR!|npm error|ERR_PNPM_\w+|\s*ERR_PNPM_\w+)\s*(.*)$/.exec(line.trim()))) {
      const msg = m[1]!.trim();
      if (/missing script|ERESOLVE|ENOENT|E404|ELIFECYCLE|Cannot find module|ERR_PNPM/i.test(line)) {
        push({ tool: 'npm', severity: 'error', message: clipMsg(msg || line.trim()) });
      }
      continue;
    }
    // Node: "Error: Cannot find module 'x'"
    if ((m = /^\s*Error: Cannot find module '(.+?)'/.exec(line))) {
      push({ tool: 'Node', severity: 'error', code: 'MODULE_NOT_FOUND', message: `Cannot find module '${m[1]}'` });
      continue;
    }
    // Go: ./main.go:12:5: undefined: x   (covered by gcc form); Go test: --- FAIL: TestX
    if ((m = /^--- FAIL:\s+(\S+)/.exec(line))) {
      push({ tool: 'Go test', severity: 'error', message: `${m[1]} failed` });
      continue;
    }
  }
  return out;
}

const SUMMARY = [
  /^\s*Tests?\s+\d+.*(?:failed|passed).*$/i,
  /^\s*Test Files\s+.*$/i,
  /^Found \d+ errors?\b.*$/i,
  /^\s*\d+ (?:failed|errors?),?.*$/i,
  /^=+ .*(?:failed|error).* =+$/i,
  /^error: could not compile.*$/i,
  /^\s*✖ \d+ problems?.*$/,
  /^\s*Build FAILED\.?$/i,
  /^\s*\d+ Error\(s\)\s*$/i,
];

const HINTS: Array<[RegExp, string]> = [
  [/Cannot find module|MODULE_NOT_FOUND|TS2307|ModuleNotFoundError|ImportError|E0432|ERR_PNPM_.*NO_PKG|ENOENT.*node_modules/i, 'A package or file it imports is missing. If it is a dependency, install the project’s dependencies first (“install the dependencies”).'],
  [/missing script/i, 'The project has no script by that name — check the "scripts" section of package.json.'],
  [/TS2322|TS2345|TS2339|TS7006|TS2532/i, 'A type does not match what the code expects. The first TypeScript error is usually the real one; later ones often follow from it.'],
  [/E0425|E0433|cannot find (?:value|function|type)/i, 'Rust cannot find a name — usually a typo, a missing `use`, or a missing crate in Cargo.toml.'],
  [/undeclared identifier|undefined reference|C2065|LNK\d{4}|was not declared/i, 'The C/C++ compiler or linker cannot find a name — a missing include, a typo, or a library that is not linked.'],
  [/SyntaxError|IndentationError|expected .*;|CS1002|TS1005|TS1128/i, 'A syntax error stops everything after it. Fix the first one and rebuild before looking at the rest.'],
  [/ERESOLVE|peer dep/i, 'npm could not agree on package versions (a peer-dependency conflict).'],
  [/ELIFECYCLE|exit code 1/i, 'A script in the project failed; the real reason is in the errors above this line.'],
  [/EADDRINUSE/i, 'A port is already in use by another program.'],
  [/EACCES|Permission denied|Access is denied/i, 'Windows refused access to a file — something may have it open (an editor, a running copy of the app, antivirus).'],
];

export function diagnoseOutput(output: string): Diagnosis {
  const text = stripAnsi(output);
  const issues = parseIssues(text);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  let summaryLine: string | null = null;
  for (const line of text.split(/\r?\n/).reverse()) {
    if (SUMMARY.some((re) => re.test(line))) {
      summaryLine = line.trim();
      break;
    }
  }
  const hints: string[] = [];
  const hay = `${errors.map((e) => `${e.code ?? ''} ${e.message}`).join('\n')}\n${text.slice(0, 20000)}`;
  for (const [re, hint] of HINTS) {
    if (re.test(hay) && !hints.includes(hint)) hints.push(hint);
    if (hints.length >= 3) break;
  }
  return { errors, warnings, firstCause: errors[0] ?? null, summaryLine, hints };
}

const where = (i: BuildIssue) => (i.file ? `${i.file}${i.line ? `:${i.line}${i.col ? `:${i.col}` : ''}` : ''}` : '');

export function describeIssue(i: BuildIssue): string {
  const loc = where(i);
  return `${loc ? `${loc} — ` : ''}${i.code ? `${i.code}: ` : ''}${i.message}`;
}

/** The human-readable version, without any source context (the skill adds that). */
export function formatDiagnosis(d: Diagnosis, opts: { max?: number } = {}): string {
  const max = opts.max ?? 8;
  const lines: string[] = [];
  if (!d.errors.length && !d.warnings.length) {
    lines.push('I could not find a file-and-line error in that output.');
    if (d.summaryLine) lines.push(`The tool’s own summary: ${d.summaryLine}`);
    lines.push('The raw output has the details.');
    return lines.join('\n');
  }
  lines.push(`${d.errors.length} error${d.errors.length === 1 ? '' : 's'}, ${d.warnings.length} warning${d.warnings.length === 1 ? '' : 's'}${d.summaryLine ? ` (the tool says: ${d.summaryLine})` : ''}.`);
  if (d.firstCause) lines.push('', `Start here — the first error printed:`, `  ${describeIssue(d.firstCause)}`, '  Later errors are often side effects of this one, so fix it and run again.');
  const rest = d.errors.slice(1);
  if (rest.length) {
    const byFile = new Map<string, number>();
    for (const e of d.errors) byFile.set(e.file ?? '(no file)', (byFile.get(e.file ?? '(no file)') ?? 0) + 1);
    lines.push('', `Other errors${byFile.size > 1 ? ` (in ${byFile.size} files)` : ''}:`, ...rest.slice(0, max).map((e) => `• ${describeIssue(e)}`));
    if (rest.length > max) lines.push(`• …and ${rest.length - max} more`);
  }
  if (d.hints.length) lines.push('', ...d.hints.map((h) => `💡 ${h}`));
  return lines.join('\n');
}
