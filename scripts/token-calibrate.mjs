// Measures the token estimator against a real tokenizer (docs/PLAN-2.0.3.md §A6).
//
//   node scripts/token-calibrate.mjs [--model qwen3.5:9b] [--out docs/TOKEN-ACCURACY.md]
//
// Local only: it needs Ollama running, and it only ever sends the fixed corpus in
// packages/core/test/token-calibrate.test.ts. No cloud key is read or used.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
let model = opt('--model', process.env.OLLAMA_MODEL ?? '');
if (!model) {
  const tags = await fetch(`${base}/api/tags`).then((r) => r.json()).catch(() => null);
  model = tags?.models?.[0]?.name ?? '';
}
if (!model) {
  console.error(`No model found. Start Ollama (${base}) and pull one, or pass --model.`);
  process.exit(2);
}

const out = resolve(root, opt('--out', 'docs/TOKEN-ACCURACY.md'));
const res = spawnSync('pnpm', ['--filter', '@atlas/core', 'exec', 'vitest', 'run', 'test/token-calibrate.test.ts'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TOKEN_CALIBRATE: '1', OLLAMA_MODEL: model, OLLAMA_URL: base, TOKEN_CALIBRATE_OUT: out },
});
process.exit(res.status ?? 1);
