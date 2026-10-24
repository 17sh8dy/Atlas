/**
 * Token-estimator accuracy harness (docs/PLAN-2.0.3.md §A6). NOT part of the normal test run:
 * it needs a local Ollama and is started with `node scripts/token-calibrate.mjs`.
 *
 * It sends a fixed corpus to Ollama in raw mode asking for ONE reply token, so the server's own
 * `prompt_eval_count` is a real tokenizer count of exactly that text, and compares it with
 * `estimateTokens`. Nothing but the fixed corpus below is ever sent anywhere.
 */
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { estimateTokens } from '../src/tokens';

const BASE = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL ?? '';
const OUT = process.env.TOKEN_CALIBRATE_OUT ?? '';

const prose = (s: string) => s.replace(/\s+/g, ' ').trim();

const CORPUS: Array<{ category: string; name: string; text: string }> = [
  { category: 'prose-en', name: 'settings help', text: prose(`Atlas keeps a record of how many tokens each request used. When your provider reports the number,
    Atlas uses it as is. When it does not, Atlas makes its own estimate and says so. You can set a monthly limit for each provider
    in Settings, and requests that fail after being sent still count toward that limit because they may have been billed.`) },
  { category: 'prose-en', name: 'story', text: prose(`The rain had been falling since morning, and by the time Mara reached the station the platform was a shallow river.
    She checked the board twice, as if the trains might change their minds, and then sat on the only dry bench with her bag on her knees.
    Somewhere behind the ticket office a radio was playing a song she half remembered from a summer she had spent trying to forget.`) },
  { category: 'prose-en', name: 'email', text: prose(`Hi Sam, thanks for sending the draft over. I read it twice and I think the second section needs a clearer example before
    the numbers appear. Could we move the table to the appendix and describe it in two sentences instead? Happy to jump on a call tomorrow
    afternoon if that is easier. Best, Jo.`) },
  { category: 'prose-en', name: 'technical', text: prose(`The scheduler assigns each job to the least loaded worker, breaking ties by queue age. If a worker misses two heartbeats
    its jobs are returned to the queue and retried with exponential backoff, capped at five minutes. Idempotency keys prevent a retried job from
    applying the same change twice.`) },
  { category: 'prose-other', name: 'spanish', text: prose(`Hola, estoy buscando información sobre el rendimiento del programa en ordenadores antiguos. ¿Podrías explicarme cómo se calculan
    los límites mensuales y qué ocurre cuando una petición falla después de haberse enviado? Muchas gracias por tu ayuda.`) },
  { category: 'prose-other', name: 'german', text: prose(`Die Straße war länger als erwartet, aber die Aussicht über das Tal machte alles wieder gut. Wir blieben stehen, tranken
    Tee aus der Thermosflasche und überlegten, ob wir den Rückweg über den Wald nehmen sollten, weil der Pfad dort weniger steil ist.`) },
  { category: 'prose-other', name: 'french', text: prose(`L'été dernier, nous avons visité la forêt près de Genève, où les enfants ont découvert une cabane abandonnée. Il fallait
    traverser un petit ruisseau pour y arriver, et personne n'a voulu rentrer avant la tombée de la nuit, malgré la fatigue.`) },
  { category: 'prose-other', name: 'russian', text: prose(`Привет, как дела? Я ищу информацию о том, как программа считает лимиты на каждый месяц и что происходит, если запрос
    не удался после отправки. Спасибо за помощь, буду очень благодарен за подробное объяснение.`) },
  { category: 'cjk', name: 'chinese', text: '你好，世界。这是一个关于令牌计数的测试句子。我们想知道系统如何估算一段文字的长度，以及在不同语言之间这个数字会有多大的差别。谢谢你的帮助。' },
  { category: 'cjk', name: 'japanese', text: 'こんにちは、世界。これはトークンの数え方のテストです。文章の長さがどのように見積もられるのか、言語によってどれくらい違うのかを知りたいと思います。' },
  { category: 'cjk', name: 'korean', text: '안녕하세요, 세계. 토큰 계산 테스트입니다. 문장의 길이가 어떻게 추정되는지, 언어마다 얼마나 다른지 알고 싶습니다. 도와주셔서 감사합니다.' },
  { category: 'code', name: 'typescript', text: `export function chooseWorkingMemory(capacity: ModelCapacity | null | undefined, pinned?: number | null): number {
  const limit = capacity?.contextTokens ? clamp(capacity.contextTokens, MIN_TOKENS, MAX_TOKENS) : DEFAULT_TOKENS;
  if (pinned && Number.isFinite(pinned)) return clamp(pinned, MIN_TOKENS, limit);
  if (!capacity?.contextTokens) return DEFAULT_TOKENS;
  const b = capacity.billions;
  return Math.min(b === undefined ? 32_768 : b < 5 ? 24_576 : 65_536, limit);
}` },
  { category: 'code', name: 'rust', text: `pub fn bump(metric: &str, n: u64) {
    if n == 0 {
        return;
    }
    let day = today_key();
    if let Ok(mut l) = live().lock() {
        *l.store.days.entry(day).or_default().entry(metric.to_string()).or_insert(0) += n;
        l.dirty = true;
    }
}` },
  { category: 'code', name: 'python', text: `def moving_average(values, window=3):
    result = []
    for i in range(len(values)):
        start = max(0, i - window + 1)
        chunk = values[start:i + 1]
        result.append(sum(chunk) / len(chunk))
    return result

if __name__ == "__main__":
    print(moving_average([1, 2, 3, 4, 5]))` },
  { category: 'json', name: 'record', text: '{"id":"a1b2c3","name":"Atlas","version":"2.0.3","tags":["assistant","desktop","local"],"limits":{"requests":1000,"tokens":2000000},"enabled":true,"owner":{"name":"Test","email":null}}' },
  { category: 'json', name: 'array', text: '[{"id":1,"ok":true,"ms":120},{"id":2,"ok":false,"ms":340},{"id":3,"ok":true,"ms":98},{"id":4,"ok":true,"ms":410},{"id":5,"ok":false,"ms":77}]' },
  { category: 'logs', name: 'service', text: `2026-10-21 12:00:01: service started on port 8080
2026-10-21 12:00:02: loaded 14 skills
[12:00:03] listening: 127.0.0.1:8080
12:00:04: request GET /health 200 2ms
12:00:05: request POST /ask 200 812ms
12:00:09: warning: slow response from provider (3402ms)` },
  { category: 'logs', name: 'build', text: `[INFO] 2026-10-21T08:15:02Z compiling atlas-desktop v2.0.3
[INFO] 2026-10-21T08:15:41Z finished dev profile in 39.2s
[WARN] 2026-10-21T08:15:42Z 3 warnings emitted
[ERROR] 2026-10-21T08:15:44Z test usage::parse failed: expected 1005, got 5
[INFO] 2026-10-21T08:15:45Z 532 passed, 1 failed` },
  { category: 'logs', name: 'access', text: `127.0.0.1 - - [21/Oct/2026:08:20:11 +0000] "GET /api/stats HTTP/1.1" 200 5123
127.0.0.1 - - [21/Oct/2026:08:20:12 +0000] "POST /api/ask HTTP/1.1" 200 9120
127.0.0.1 - - [21/Oct/2026:08:20:15 +0000] "GET /favicon.ico HTTP/1.1" 404 153` },
  { category: 'mixed', name: 'question with json', text: `Why does this request fail with a 400?

{"model":"gpt-x","messages":[{"role":"user","content":"hi"}],"max_tokens":-5}

I think the max_tokens value is wrong but I am not sure what it should be.` },
  { category: 'mixed', name: 'steps and shell', text: `To reset the cache, run the following and then restart the app:

rm -rf ~/.cache/atlas && atlas --reindex --verbose

Let me know if it still shows the old results.` },
  { category: 'emoji', name: 'chatty', text: 'Great job team 🎉🎉 shipping this today 🚀 see you all at the party 😀🥳 bring snacks 🍕🍿 and good vibes ✨💯' },
  { category: 'mixed', name: 'prose and code', text: `Please look at this function and tell me why it returns the wrong value for negative numbers.

function abs(n) {
  if (n > 0) { return n; }
  return n;
}

I expected -5 to come back as 5. Thanks!` },
];

async function promptTokens(prompt: string): Promise<number | null> {
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, raw: true, stream: false, options: { num_predict: 1, temperature: 0 }, keep_alive: '2m' }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const j = (await res.json()) as { prompt_eval_count?: number };
  return typeof j.prompt_eval_count === 'number' ? j.prompt_eval_count : null;
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  if (s.length === 0) return 0;
  return s.length % 2 ? (s[(s.length - 1) / 2] as number) : ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2;
};

describe.skipIf(!process.env.TOKEN_CALIBRATE || !MODEL)('token estimator vs the real tokenizer', () => {
  it('measures the error per kind', async () => {
    // Every raw count carries a little fixed overhead (a start-of-text marker); one text token
    // plus that overhead is what 'a' costs, so subtract everything but that one token.
    const overhead = ((await promptTokens('a')) ?? 1) - 1;
    const rows: Array<{ category: string; name: string; chars: number; real: number; est: number; err: number }> = [];
    for (const c of CORPUS) {
      const raw = await promptTokens(c.text);
      if (raw === null) continue;
      const real = Math.max(1, raw - overhead);
      const est = estimateTokens(c.text);
      rows.push({ category: c.category, name: c.name, chars: [...c.text].length, real, est, err: (est - real) / real });
    }
    const cats = [...new Set(rows.map((r) => r.category))];
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const lines: string[] = [];
    lines.push('# Token estimator accuracy', '');
    lines.push(`Model: \`${MODEL}\` (Ollama \`prompt_eval_count\`, raw mode, start-of-text overhead removed). Generated by \`node scripts/token-calibrate.mjs\`.`, '');
    lines.push('| Kind | Samples | Median abs. error | Worst | Bias (estimate vs real) |', '|---|---:|---:|---:|---:|');
    for (const cat of cats) {
      const r = rows.filter((x) => x.category === cat);
      const abs = r.map((x) => Math.abs(x.err));
      lines.push(`| ${cat} | ${r.length} | ${pct(median(abs))} | ${pct(Math.max(...abs))} | ${pct(median(r.map((x) => x.err)))} |`);
    }
    lines.push('', '| Sample | Kind | Chars | Real | Estimated | Error |', '|---|---|---:|---:|---:|---:|');
    for (const x of rows) lines.push(`| ${x.name} | ${x.category} | ${x.chars} | ${x.real} | ${x.est} | ${pct(x.err)} |`);
    const text = lines.join('\n') + '\n';
    console.log(text);
    if (OUT) writeFileSync(OUT, text, 'utf8');
  }, 600_000);
});
