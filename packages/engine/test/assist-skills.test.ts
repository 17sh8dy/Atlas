/**
 * The 1.0.9 assist tools: self-audit, dry run, explain an error, change impact, config diff,
 * evidence from files. The pure logic is tested directly; the skills are run over a real folder.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Plan, Platform, Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { createAssistSkills, dryRunSteps, formatDryRun } from '../src/skills/assist-skills';
import { auditSkills, formatAudit, type AuditSkillView } from '../src/skills/self-audit';
import { explainFailure, formatExplanation } from '../src/skills/explain-failure';
import { diffConfig, formatConfigDiff, parseConfig } from '../src/skills/config-diff';
import { analyseImpact, formatImpact, importsOf } from '../src/skills/change-impact';
import { findPassages, formatPassages, termsOf } from '../src/skills/evidence-cite';
import { createAssistGrammar, parseCiteEvidence, parseConfigDiff, parseDryRun, parseExplainError } from '../src/planner/assist-grammar';
import { diskPlatform, makeTempProject } from './helpers/disk-platform';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const ctx = { say: () => undefined } as unknown as SkillContext;

const view = (over: Partial<AuditSkillView>): AuditSkillView => ({
  id: 'files.open',
  label: 'Open a file',
  domain: 'files',
  description: 'Open a file with the program that normally opens it.',
  risk: 'safe',
  examples: ['open notes.txt'],
  available: true,
  ...over,
});

describe('atlas.selfAudit', () => {
  test('a well-declared tool has no findings worth a problem', () => {
    const r = auditSkills([view({})]);
    expect(r.findings.filter((f) => f.level !== 'info')).toEqual([]);
    expect(formatAudit(r)).toMatch(/found nothing wrong/);
  });

  test('missing and malformed declarations are named, worst first', () => {
    const r = auditSkills([
      view({ id: 'badid', description: '' }),
      view({ id: 'a.b', label: 'Same', params: { x: { type: 'string', description: '', enum: [], required: true, default: 'z' } } }),
      view({ id: 'a.c', label: 'Same', params: { y: { type: 'string', enum: ['p', 'q'], default: 'r', description: 'y' } } }),
      view({ id: 'x.y', risk: 'dangerous' }),
    ]);
    const text = r.findings.map((f) => `${f.level} ${f.skill} ${f.text}`).join('\n');
    expect(text).toMatch(/fail badid its id is not of the form domain\.name/);
    expect(text).toMatch(/fail badid it has no description/);
    expect(text).toMatch(/empty enum/);
    expect(text).toMatch(/defaults to “r”, which is not in its own list/);
    expect(text).toMatch(/required AND has a default/);
    expect(text).toMatch(/share the label “same”/);
    expect(text).toMatch(/risk is “dangerous”/);
    expect(r.findings[0]!.level).toBe('fail');
  });

  test('a tool that changes things but is marked safe is a note, not a verdict; hidden tools are counted by what they need', () => {
    const r = auditSkills([view({ id: 'files.delete', risk: 'safe' }), view({ id: 'a.x', available: false, needs: ['window-control'] }), view({ id: 'a.y', available: false, needs: ['window-control'] })]);
    expect(r.findings.some((f) => f.level === 'info' && /changes something/.test(f.text))).toBe(true);
    expect(r.hiddenBy).toEqual({ 'window-control': 2 });
    expect(formatAudit(r)).toMatch(/Hidden by: window-control \(2\)/);
    expect(formatAudit(r)).toMatch(/does not prove any of them works/);
  });

  test('the skill audits the registry it is registered in', async () => {
    const skills = new SkillRegistry({ capabilities: () => [] as never });
    const platform = {} as Platform;
    skills.registerMany(createAssistSkills({ platform, skills, planFor: async () => null }));
    const out = await Promise.resolve(skills.get('atlas.selfAudit')!.run({}, ctx));
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/all 6 of my tools/);
  });

  test('every tool the assist module ships passes its own audit with no problems or warnings', () => {
    const skills = new SkillRegistry({ capabilities: () => ['devtools', 'fs'] as never });
    skills.registerMany(createAssistSkills({ platform: {} as Platform, skills, planFor: async () => null }));
    const r = auditSkills(skills.all().map((s) => ({ ...s, hasRiskFor: Boolean(s.riskFor), params: s.params as never, available: skills.isAvailable(s) })));
    expect(r.findings.filter((f) => f.level !== 'info')).toEqual([]);
  });
});

describe('diagnostics.explainFailure', () => {
  test('common shapes are recognised, with the triggering line quoted', () => {
    const cases: Array<[string, RegExp]> = [
      ["Error: ENOENT: no such file or directory, open 'C:\\x\\a.json'", /file or folder was not found/],
      ['Error: listen EADDRINUSE: address already in use :::3000', /port is already in use/],
      ["Cannot find module 'vite'", /module or package is missing/],
      ['src/a.ts(3,5): error TS2322: Type string is not assignable to type number.', /TypeScript type error/],
      ['fatal: not a git repository (or any of the parent directories): .git', /Not a git repository/],
      ["'foo' is not recognized as an internal or external command", /command was not found/],
      ['npm ERR! code ERESOLVE', /Dependency versions conflict/],
      ['Error: connect ECONNREFUSED 127.0.0.1:8080', /connection failed/],
      ['npm ERR! JavaScript heap out of memory', /Ran out of memory/],
      ['TypeError: Cannot read properties of undefined (reading "map")', /not there/],
      ['EACCES: permission denied, mkdir', /Permission denied/],
      ['status: 429 Too Many Requests', /Too many requests/],
      ['File C:\\x.ps1 cannot be loaded because running scripts is disabled on this system.', /PowerShell blocked/],
    ];
    for (const [input, title] of cases) {
      const e = explainFailure(input);
      expect(e.recognised, input).toBe(true);
      const text = formatExplanation(e);
      expect(text, input).toMatch(title);
      expect(text, input).toMatch(/Likely causes/);
      expect(text, input).toMatch(/leads to check, not a certain diagnosis/);
    }
  });

  test('something it does not know is said plainly, not invented', () => {
    const e = explainFailure('flibbertigibbet widget exploded');
    expect(e.recognised).toBe(false);
    expect(formatExplanation(e)).toMatch(/don’t recognise that error, so I won’t guess/);
  });

  test('the skill needs the error text, and context can help it match', async () => {
    const skills = new SkillRegistry({ capabilities: () => [] as never });
    skills.registerMany(createAssistSkills({ platform: {} as Platform, skills, planFor: async () => null }));
    const run = (args: Record<string, unknown>) => Promise.resolve(skills.get('diagnostics.explainFailure')!.run(args, ctx));
    expect((await run({ error: '' })).ok).toBe(false);
    const withContext = await run({ error: 'it failed', context: 'ENOSPC no space left on device' });
    expect(withContext.message).toMatch(/disk is full/);
  });
});

describe('config.diff', () => {
  test('a re-sorted file with a new comment is the same', () => {
    const a = parseConfig('a.env', 'PORT=3000\nHOST=localhost\n');
    const b = parseConfig('b.env', '# note\nHOST=localhost\nPORT=3000\n\n');
    if ('error' in a || 'error' in b) throw new Error('parse');
    const d = diffConfig(a.values, b.values);
    expect(d.added.length + d.removed.length + d.changed.length).toBe(0);
    expect(formatConfigDiff('a.env', 'b.env', d)).toMatch(/same 2 settings/);
  });

  test('changed, added and removed are reported, notable settings flagged, secrets never printed', () => {
    const a = parseConfig('a.json', JSON.stringify({ server: { port: 3000, host: 'localhost' }, apiKey: 'sk-OLD-SECRET', debug: true }));
    const b = parseConfig('b.json', JSON.stringify({ server: { port: 8080, host: 'localhost' }, apiKey: 'sk-NEW-SECRET', extra: ['x'] }));
    if ('error' in a || 'error' in b) throw new Error('parse');
    const text = formatConfigDiff('a.json', 'b.json', diffConfig(a.values, b.values));
    expect(text).toMatch(/~ server\.port: 3000 → 8080 {2}⚑/);
    expect(text).toMatch(/~ apiKey: changed \(value hidden\)/);
    expect(text).toMatch(/\+ extra\[0\] = x/);
    expect(text).toMatch(/- debug = true {2}⚑/);
    expect(text).not.toMatch(/SECRET/);
    expect(text).toMatch(/Nothing was changed or applied/);
  });

  test('yaml, toml and ini read into the same keys', () => {
    const y = parseConfig('c.yml', 'server:\n  port: 80 # web\n  hosts:\n    - a\n    - b\nname: "x"\n');
    const t = parseConfig('c.toml', '[server]\nport = 80\nname = "x"\n');
    const i = parseConfig('c.ini', '[server]\nport=80\n');
    if ('error' in y || 'error' in t || 'error' in i) throw new Error('parse');
    expect(y.values.get('server.port')).toBe('80');
    expect(y.values.get('server.hosts[1]')).toBe('b');
    expect(y.values.get('name')).toBe('x');
    expect(t.values.get('server.name')).toBe('x');
    expect(i.values.get('server.port')).toBe('80');
  });

  test('broken JSON is a clear error, JSON with comments and trailing commas is accepted', () => {
    expect(parseConfig('a.json', '{ nope')).toHaveProperty('error');
    const ok = parseConfig('a.json', '{\n // c\n "a": 1,\n}\n');
    expect('error' in ok).toBe(false);
  });

  test('the skill reads two real files', async () => {
    const proj = makeTempProject({ 'a.json': '{"port":1,"token":"abc"}', 'b.json': '{"port":2,"token":"xyz"}' });
    cleanups.push(proj.cleanup);
    const skills = new SkillRegistry({ capabilities: () => ['fs'] as never });
    skills.registerMany(createAssistSkills({ platform: diskPlatform(), skills, planFor: async () => null }));
    const out = await Promise.resolve(skills.get('config.diff')!.run({ a: join(proj.root, 'a.json'), b: join(proj.root, 'b.json') }, ctx));
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/~ port: 1 → 2/);
    expect(out.message).not.toMatch(/abc|xyz/);
  });
});

describe('git.changeImpact', () => {
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/util/index.ts', 'test/a.test.ts', 'test/c.test.ts', 'package.json', 'src/lonely.ts'];
  const texts = new Map([
    ['src/a.ts', "export const a = 1;\n"],
    ['src/b.ts', "import { a } from './a';\nexport const b = a + 1;\n"],
    ['src/c.ts', "import { b } from './b.js';\nimport u from './util';\nexport const c = b;\n"],
    ['src/util/index.ts', 'export default 1;\n'],
    ['test/a.test.ts', "import { a } from '../src/a';\n"],
    ['test/c.test.ts', "import { c } from '../src/c';\n"],
    ['src/lonely.ts', 'export const x = 1;\n'],
  ]);

  test('imports resolve to real files only, including .js for .ts and index files', () => {
    const set = new Set(files);
    expect(importsOf('src/c.ts', texts.get('src/c.ts')!, set).sort()).toEqual(['src/b.ts', 'src/util/index.ts']);
    expect(importsOf('src/a.ts', "import x from './missing'", set)).toEqual([]);
    expect(importsOf('src/a.ts', "import x from '../../../escape'", set)).toEqual([]);
  });

  test('dependents, tests, untested code and config are reported', () => {
    const i = analyseImpact({ changed: ['src/a.ts', 'src/lonely.ts', 'package.json'], files, texts });
    expect(i.direct).toEqual(['src/b.ts', 'test/a.test.ts']);
    expect(i.indirect).toEqual(['src/c.ts']);
    expect(i.tests).toContain('test/a.test.ts');
    expect(i.tests).toContain('test/c.test.ts');
    expect(i.untested).toEqual(['src/lonely.ts']);
    expect(i.beyondCode).toEqual([{ file: 'package.json', why: 'dependencies or scripts may have changed' }]);
    const text = formatImpact('proj', i);
    expect(text).toMatch(/3 changed files/);
    expect(text).toMatch(/Changed code with no test pointing at it: src\/lonely\.ts/);
    expect(text).toMatch(/only JavaScript\/TypeScript imports are followed/);
  });

  test('no changes is said, not guessed', () => {
    expect(formatImpact('proj', analyseImpact({ changed: [], files, texts }))).toMatch(/no uncommitted changes/);
  });

  test('the skill reads git status and the real project', async () => {
    const proj = makeTempProject({ 'src/a.ts': 'export const a = 1;', 'src/b.ts': "import { a } from './a';", 'src/a.test.ts': "import { a } from './a';" });
    cleanups.push(proj.cleanup);
    const platform = { ...diskPlatform(), gitStatus: async () => ({ branch: 'main', staged: [], unstaged: ['src/a.ts'], untracked: [], clean: false }) } as unknown as Platform;
    const skills = new SkillRegistry({ capabilities: () => ['devtools'] as never });
    skills.registerMany(createAssistSkills({ platform, skills, planFor: async () => null }));
    const out = await Promise.resolve(skills.get('git.changeImpact')!.run({ path: proj.root }, ctx));
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/Imported directly by 2: src\/a\.test\.ts, src\/b\.ts/);
  });
});

describe('knowledge.citeEvidence', () => {
  const docs = [
    { rel: 'docs/update.md', text: '# Updates\nAtlas checks for updates on its own.\nThe check asks GitHub for one small file.\nNothing about you is sent.\n' },
    { rel: 'docs/voice.md', text: '# Voice\nSpeaking uses Piper.\nListening uses whisper.cpp.\n' },
  ];

  test('terms drop filler words', () => {
    expect(termsOf('What does the update check send?')).toEqual(['update', 'check', 'send']);
  });

  test('passages are the files’ own words with line numbers', () => {
    const r = findPassages('how does the update check work', docs);
    expect(r.passages[0]!.file).toBe('docs/update.md');
    const text = formatPassages('how does the update check work', r, 2);
    expect(text).toMatch(/docs\/update\.md, lines? \d/);
    expect(text).toMatch(/Atlas checks for updates on its own\./);
    expect(text).toMatch(/a lead, not proof/);
  });

  test('nothing matching says so instead of answering', () => {
    const r = findPassages('quantum entanglement', docs);
    expect(formatPassages('quantum entanglement', r, 2)).toMatch(/Nothing in the 2 files.*I won’t answer it from memory/);
  });

  test('overlapping passages from one file are not repeated', () => {
    const r = findPassages('update check github', docs, 5);
    const ranges = r.passages.filter((p) => p.file === 'docs/update.md');
    for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) expect(ranges[i]!.to < ranges[j]!.from || ranges[j]!.to < ranges[i]!.from).toBe(true);
  });

  test('the skill searches a real folder', async () => {
    const proj = makeTempProject({ 'notes/a.md': 'The release is on Friday.\nBring the signed installer.\n', 'notes/b.md': 'Unrelated.\n' });
    cleanups.push(proj.cleanup);
    const skills = new SkillRegistry({ capabilities: () => ['fs'] as never });
    skills.registerMany(createAssistSkills({ platform: diskPlatform(), skills, planFor: async () => null }));
    const out = await Promise.resolve(skills.get('knowledge.citeEvidence')!.run({ question: 'when is the release', folder: proj.root }, ctx));
    expect(out.message).toMatch(/notes\/a\.md, lines 1–2/);
    expect(out.message).toMatch(/The release is on Friday\./);
  });
});

describe('workflow.dryRun', () => {
  const mk = (id: string, risk: 'safe' | 'confirm', extra: Partial<Skill> = {}): Skill => ({ id, label: id, icon: 'x', domain: id.split('.')[0]!, description: id, risk, params: {}, run: () => ({ ok: true }), ...extra }) as Skill;

  test('says what each step does, what asks, what changes, what cannot run — and runs nothing', async () => {
    let ran = 0;
    const skills = new SkillRegistry({ capabilities: () => ['fs'] as never });
    skills.register(mk('files.list', 'safe', { run: () => (ran++, { ok: true }) }));
    skills.register(mk('files.delete', 'confirm', { run: () => (ran++, { ok: true }) }));
    skills.register(mk('window.close', 'confirm', { needs: ['window-control'] as never, run: () => (ran++, { ok: true }) }));
    const plan: Plan = {
      source: 'grammar',
      intent: 'x',
      confidence: 1,
      steps: [
        { skill: 'files.list', args: { path: 'D:\\x' } },
        { skill: 'files.delete', args: { path: 'D:\\x\\a.txt' } },
        { skill: 'window.close', args: { name: 'Notepad' } },
        { skill: 'nope.gone', args: {} },
      ],
    };
    skills.registerMany(createAssistSkills({ platform: {} as Platform, skills, planFor: async () => plan }));
    const out = await Promise.resolve(skills.get('workflow.dryRun')!.run({ request: 'tidy x' }, ctx));
    expect(ran).toBe(0);
    expect(out.message).toMatch(/Dry run — nothing below was done/);
    expect(out.message).toMatch(/1\. files\.list \(files\.list\) — runs/);
    expect(out.message).toMatch(/2\. files\.delete \(files\.delete\) — asks you first · changes something/);
    expect(out.message).toMatch(/3\. window\.close \(window\.close\) — CANNOT run here · changes something · it needs window-control/);
    expect(out.message).toMatch(/4\. nope\.gone \(nope\.gone\) — UNKNOWN tool/);
    expect(out.message).toMatch(/2 steps cannot run on this PC/);
    expect(out.message).toMatch(/not a promise of the outcome/);
  });

  test('a model plan is labelled as one, and an un-plannable request says there is nothing to preview', async () => {
    const skills = new SkillRegistry({ capabilities: () => [] as never });
    skills.register(mk('files.list', 'safe'));
    const plan: Plan = { source: 'ai', intent: 'x', confidence: 0.6, steps: [{ skill: 'files.list', args: {} }] };
    expect(formatDryRun('list', plan, dryRunSteps(plan, skills))).toMatch(/came from a model \(confidence 60%\)/);
    skills.registerMany(createAssistSkills({ platform: {} as Platform, skills, planFor: async () => null }));
    const out = await Promise.resolve(skills.get('workflow.dryRun')!.run({ request: 'asdf qwer' }, ctx));
    expect(out.message).toMatch(/nothing to preview/);
  });
});

describe('what the grammar claims', () => {
  const rules = createAssistGrammar();
  const route = (text: string) => {
    for (const r of rules) {
      const p = r.test(text.toLowerCase(), text, {} as never) as { steps: Array<{ skill: string; args: Record<string, unknown> }> } | null;
      if (p) return `${p.steps[0]!.skill} ${JSON.stringify(p.steps[0]!.args)}`;
    }
    return null;
  };

  test('self audit', () => {
    for (const t of ['audit your tools', 'check your own tools', 'run a tool audit', 'self audit', 'are all your tools set up right?']) expect(route(t), t).toMatch(/^atlas\.selfAudit/);
  });
  test('explain an error', () => {
    expect(route('explain this error: ENOENT no such file')).toBe('diagnostics.explainFailure {"error":"ENOENT no such file"}');
    expect(route('what does EADDRINUSE mean')).toBe('diagnostics.explainFailure {"error":"EADDRINUSE"}');
    expect(parseExplainError('explain this error')).toBeNull();
    expect(route('what does love mean')).toBeNull();
  });
  test('dry run', () => {
    expect(parseDryRun('dry run: clean up my downloads')).toBe('clean up my downloads');
    expect(parseDryRun('what would happen if I said organize my desktop')).toBe('organize my desktop');
    expect(parseDryRun('dry run')).toBeNull();
  });
  test('change impact', () => {
    for (const t of ['what does my change affect', 'what could my changes break?', 'what is the impact of my changes', 'which tests will my edits touch']) expect(route(t), t).toMatch(/^git\.changeImpact/);
    expect(route('what does my change affect in D:\\Dev\\Atlas')).toBe('git.changeImpact {"path":"D:\\\\Dev\\\\Atlas"}');
    expect(route('what does the weather affect')).toBeNull();
  });
  test('config diff needs two paths and a config word', () => {
    expect(parseConfigDiff('compare the config files D:\\a\\x.json and D:\\a\\y.json')).toEqual({ a: 'D:\\a\\x.json', b: 'D:\\a\\y.json' });
    expect(parseConfigDiff('compare D:\\a\\x.txt and D:\\a\\y.txt')).toBeNull();
    expect(parseConfigDiff('compare the config files x.json and y.json')).toBeNull();
  });
  test('cite evidence', () => {
    expect(parseCiteEvidence('what do my notes say about the update system in D:\\Dev\\Atlas\\docs')).toEqual({ question: 'the update system', folder: 'D:\\Dev\\Atlas\\docs' });
    expect(parseCiteEvidence('find the evidence for the voice setup')).toEqual({ question: 'the voice setup' });
    expect(parseCiteEvidence('what is the capital of France')).toBeNull();
  });
});
