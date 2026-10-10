/**
 * LIVE: can the developer agent build something NEW (no template) with a real local model?
 * Skipped unless ATLAS_LIVE_OLLAMA=<model>. Point it at a CPU-only Ollama with ATLAS_LIVE_URL.
 *
 *   ATLAS_LIVE_OLLAMA=qwen3.5:9b ATLAS_LIVE_URL=http://127.0.0.1:11435 \
 *     pnpm --filter @atlas/engine exec vitest run test/live-build-from-scratch.test.ts
 *
 * Real: the model, the loop, the Executor, files on disk, and Atlas's own `checkProject`. Only the
 * file skills are thin stand-ins named like the real ones. Output is printed as LIVE-BUILD lines and
 * never asserted to be GOOD; the test asserts only that Atlas did not claim more than is on disk.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, IntelligenceRegistry, Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { Executor } from '../src/planner/executor';
import { runDevTask } from '../src/devagent/loop';
import { checkProject } from '../src/skills/project-check';

const MODEL = process.env.ATLAS_LIVE_OLLAMA;
const URL = process.env.ATLAS_LIVE_URL ?? 'http://127.0.0.1:11434';
const ROOT = process.env.ATLAS_LIVE_DIR ?? 'D:\\Dev\\_atlas-live-build';
const live = MODEL ? describe : describe.skip;

function log(kind: string, data: unknown) {
  console.log(`LIVE-BUILD ${kind} ${JSON.stringify(data)}`);
}

function ollama(model: string): IntelligenceRegistry {
  let n = 0;
  const provider = {
    id: 'ollama-live',
    label: 'Ollama (live build test)',
    isConfigured: () => true,
    isLocal: () => true,
    ask(prompt: string, handlers: { onDone: (full: string) => void; onError?: (e: Error) => void }) {
      const call = ++n;
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25 * 60_000);
      log('call-start', { call, promptChars: prompt.length });
      fetch(`${URL}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: '30m',
          options: { temperature: 0, num_ctx: 8192, num_predict: 2500 },
          messages: [{ role: 'user', content: prompt }],
        }),
      })
        .then((r) => r.json() as Promise<{ message?: { content?: string }; eval_count?: number; prompt_eval_count?: number }>)
        .then((j) => {
          const text = j.message?.content ?? '';
          try {
            mkdirSync(ROOT, { recursive: true });
            writeFileSync(join(ROOT, `reply-${Date.now()}-${call}.txt`), text, 'utf8');
          } catch {
            /* diagnostics only */
          }
          log('call-done', { call, seconds: Math.round((Date.now() - started) / 1000), promptTokens: j.prompt_eval_count, evalTokens: j.eval_count, reply: text.slice(0, 160) });
          handlers.onDone(text);
        })
        .catch((e) => {
          log('call-error', { call, error: String(e) });
          handlers.onError?.(e as Error);
        })
        .finally(() => clearTimeout(timer));
    },
  } as unknown as IntelligenceProvider;
  return { register: () => {}, get: () => provider, list: () => [provider], active: () => provider, setActive: () => {} };
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

const P = {
  path: { type: 'string' as const, required: false, description: 'full path of a file or the project folder' },
  content: { type: 'string' as const, required: false, description: 'the whole text of the file' },
};

live('the developer agent builds something with no template', () => {
  test('a pet feeding tracker web page', { timeout: 90 * 60_000 }, async () => {
    const dir = join(ROOT, `pet-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const ran: string[] = [];
    const skills = new SkillRegistry({ capabilities: () => ['devtools', 'fs'] });
    const mk = (id: string, domain: string, description: string, run: Skill['run']): Skill => ({
      id,
      label: id,
      domain,
      description,
      risk: 'safe',
      params: P,
      run: async (a, c) => {
        ran.push(id);
        return run(a, c);
      },
    });
    skills.registerMany([
      mk('files.create', 'files', 'Create a file with its whole content. path = full path inside the project, content = the complete text.', async (a) => {
        const p = String(a.path);
        if (!p.toLowerCase().startsWith(dir.toLowerCase())) return { ok: false, error: `${p} is outside the project folder ${dir}` };
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(a.content ?? ''), 'utf8');
        return { ok: true, message: `Created ${p} (${String(a.content ?? '').length} characters).` };
      }),
      mk('files.readText', 'files', 'Read a text file. path = the file.', async (a) => {
        try {
          return { ok: true, message: readFileSync(String(a.path), 'utf8') };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }),
      mk('project.check', 'project', 'Look at the project folder on disk and say whether the pieces are all there and well-formed. path = the project folder.', async () => {
        const all = walk(dir);
        const texts = new Map(all.filter((f) => /\.(html|css|js|json|md)$/i.test(f)).map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const));
        const result = checkProject({ allFiles: all, texts, hasNodeModules: false });
        const text = result.items.map((i) => `${i.level}: ${i.text}`).join('\n') || 'no problems found';
        return result.ok ? { ok: true, message: text } : { ok: false, error: text };
      }),
    ]);

    const goal =
      `Build a pet feeding tracker web page in ${dir}. It is a plain website with three files: index.html, style.css and app.js ` +
      `(no libraries, no internet). It lets me type a pet name and press "Feed" to log a feeding with the current time; the log is a list ` +
      `shown on the page, newest first, and is kept in localStorage so it survives a reload. Add a "Clear log" button. ` +
      `Write each file in full with files.create, then run project.check to prove the pieces fit together.`;

    const t0 = Date.now();
    const report = await runDevTask(
      goal,
      dir,
      { skills, intelligence: ollama(MODEL!), executor: new Executor(skills), getExecutionMode: () => 'doIt', contextChars: 12_000 },
      { say: (t: string) => log('say', t.slice(0, 300)), confirm: async () => true } as unknown as SkillContext,
    );
    const files = existsSync(dir) ? walk(dir) : [];
    const html = files.includes('index.html') ? readFileSync(join(dir, 'index.html'), 'utf8') : '';
    const js = files.includes('app.js') ? readFileSync(join(dir, 'app.js'), 'utf8') : '';
    log('result', {
      model: MODEL,
      url: URL,
      ok: report.ok,
      verified: report.verified,
      stoppedBecause: report.stoppedBecause,
      totalSeconds: Math.round((Date.now() - t0) / 1000),
      steps: report.steps.map((s) => `${s.skill}:${s.ok}`),
      files,
      htmlRefsApp: /app\.js/.test(html),
      htmlRefsStyle: /style\.css/.test(html),
      hasLocalStorage: /localStorage/.test(js),
      hasFeed: /feed/i.test(html + js),
      hasClear: /clear/i.test(html + js),
      message: report.message.slice(0, 300),
      dir,
    });
    // Atlas must not claim success for files that are not on disk.
    if (report.ok && report.steps.some((s) => s.ok)) expect(files.length).toBeGreaterThan(0);
    if (!files.length) expect(report.ok).toBe(false);
  });
});
