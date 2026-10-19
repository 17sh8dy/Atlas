/**
 * MANUAL: the universal agent against a REAL local model (Ollama), without the desktop app.
 *
 *   REAL_MODEL=1 REAL_MODEL_TAG=qwen3.5:9b pnpm --filter @atlas/engine exec vitest run test/real/real-model.manual.test.ts
 *
 * Skipped unless REAL_MODEL=1, so the normal suite never needs a model. Everything runs against a disposable
 * folder from scripts/e2e/lib/sandbox.mjs. The skills are the REAL catalog's descriptions with ONE exception:
 * their `run` is replaced by a small, honest file implementation confined to the sandbox, so what a model "did" is
 * checked on disk, and nothing outside the sandbox can be touched whatever the model asks for. Cards are answered
 * by the same refuse-by-default policy the UI driver uses.
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceProvider, IntelligenceRegistry, Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../../src/skills/registry';
import { Executor } from '../../src/planner/executor';
import { runUniversalTask } from '../../src/universal/loop';
import { everySkill } from '../helpers/every-skill';
// @ts-expect-error plain ES modules
import { createSandbox } from '../../../../scripts/e2e/lib/sandbox.mjs';
// @ts-expect-error plain ES modules
import { decideCard } from '../../../../scripts/e2e/lib/policy.mjs';

const ON = process.env.REAL_MODEL === '1';
const TAG = process.env.REAL_MODEL_TAG ?? 'qwen3.5:9b';
const BASE = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';

function ollama(structured: boolean): IntelligenceProvider {
  return {
    id: 'real', label: TAG, isConfigured: () => true, isLocal: () => true,
    capabilities: () => ({ structuredOutput: structured ? 'yes' : 'unknown', conversation: 'yes', toolCalling: 'unknown', longContext: 'unknown', vision: 'unknown', coding: 'unknown', source: 'reported' }),
    ask(prompt: string, h: { onDone(t: string): void; onError(e: string): void }, opts?: { responseSchema?: Record<string, unknown> }) {
      void (async () => {
        try {
          const res = await fetch(`${BASE}/api/chat`, {
            method: 'POST',
            body: JSON.stringify({ model: TAG, stream: false, ...(process.env.REAL_THINK === 'default' ? {} : { think: false }), keep_alive: '10m', options: { num_ctx: 8192 }, messages: [{ role: 'user', content: prompt }], ...(opts?.responseSchema ? { format: opts.responseSchema } : {}) }),
          });
          const j = (await res.json()) as { message?: { content?: string } };
          h.onDone(j.message?.content ?? '');
        } catch (e) {
          h.onError(String(e));
        }
      })();
    },
  } as unknown as IntelligenceProvider;
}

/** The real catalog's declarations, with run() replaced by sandbox-confined implementations for the few skills used. */
function sandboxedRegistry(root: string) {
  const inside = (p: string) => path.resolve(String(p)).toLowerCase().startsWith(path.resolve(root).toLowerCase());
  const guard = (p: unknown) => (inside(String(p)) ? null : `outside the test folder: ${String(p)}`);
  const impl: Record<string, (a: Record<string, unknown>) => { ok: boolean; message?: string; error?: string }> = {
    'files.createFolder': (a) => (guard(a.path) ? { ok: false, error: guard(a.path)! } : (fs.mkdirSync(String(a.path), { recursive: true }), { ok: true, message: `Created ${String(a.path)}.` })),
    'files.move': (a) => {
      const g = guard(a.path) ?? guard(a.destDir);
      if (g) return { ok: false, error: g };
      if (!fs.existsSync(String(a.path))) return { ok: false, error: `${String(a.path)} does not exist.` };
      fs.renameSync(String(a.path), path.join(String(a.destDir), path.basename(String(a.path))));
      return { ok: true, message: `Moved ${path.basename(String(a.path))}.` };
    },
    'files.list': (a) => (guard(a.path) ? { ok: false, error: guard(a.path)! } : { ok: true, message: fs.readdirSync(String(a.path)).join('\n') }),
    'storage.largestFiles': (a) => (guard(a.path) ? { ok: false, error: guard(a.path)! } : { ok: true, message: fs.readdirSync(String(a.path)).map((n) => `${n} ${fs.statSync(path.join(String(a.path), n)).size} B`).join('\n') }),
  };
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany(
    everySkill().map((k): Skill => {
      const { verify, preview, guard: g0, needs, ...rest } = k as Skill & Record<string, unknown>;
      void verify; void preview; void g0; void needs;
      const f = impl[k.id];
      return { ...(rest as Skill), async run(args) { return f ? f(args as Record<string, unknown>) : { ok: false, error: `${k.id} is not available in this test.` }; } };
    }),
  );
  return registry;
}

describe.skipIf(!ON)('universal agent with a real local model', () => {
  for (const structured of [true, false]) {
    test(`two-step job, ${structured ? 'schema-held' : 'free-text'} replies, 3 runs`, async () => {
      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        const sb = createSandbox('real', { 'big.log': 'x'.repeat(3000), 'medium.log': 'y'.repeat(800) });
        const registry = sandboxedRegistry(sb.dir);
        const provider = ollama(structured);
        const intelligence = { register() {}, get: () => provider, list: () => [provider], active: () => provider, setActive() {} } as unknown as IntelligenceRegistry;
        const cards: string[] = [];
        const said: string[] = [];
        const ctx = {
          say: (t: string) => void said.push(t),
          confirm: async (q: string, d?: string) => {
            const card = `${q}\n${d ?? ''}`;
            const verdict = decideCard(card, { sandbox: sb.dir });
            cards.push(`${verdict.answer}: ${card.replace(/\s+/g, ' ').slice(0, 160)}`);
            return verdict.answer === 'yes';
          },
        } as unknown as SkillContext;
        const goal = `create a folder called reports in ${sb.slash} and then move big.log into it`;
        const report = await runUniversalTask(goal, { skills: registry, intelligence, executor: new Executor(registry), getExecutionMode: () => 'confirmActions' }, ctx);
        const done = fs.existsSync(path.join(sb.dir, 'reports', 'big.log'));
        results.push(`run ${i + 1}: ${done ? 'COMPLETE' : fs.existsSync(path.join(sb.dir, 'reports')) ? 'PARTIAL' : 'NOTHING'} | stopped=${report.stoppedBecause} | steps=${report.steps.map((s) => `${s.skill}:${s.ok ? 'ok' : 'fail'}`).join(',') || '-'} | cards=${cards.length}`);
        if (i === 0) console.log(`REPORT (run 1, structured=${structured}):\n${report.message}`);
        sb.destroy();
      }
      console.log(`RESULTS structured=${structured}\n${results.join('\n')}`);
      expect(results.length).toBe(3);
    }, 900_000);
  }
});
