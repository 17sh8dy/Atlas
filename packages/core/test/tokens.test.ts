import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_CHARS_PER_TOKEN, classify, estimateTokens, estimateTokensAs } from '../src/tokens';

/**
 * The inputs both estimators are checked against. The expected numbers live in
 * `token-fixtures.json`, which the Rust twin (`tokens.rs`) also reads, so the two cannot drift.
 * After deliberately retuning `token-weights.json`, regenerate with:
 *   WRITE_TOKEN_FIXTURES=1 pnpm --filter @atlas/core test
 */
const INPUTS: Array<{ name: string; text: string }> = [
  { name: 'empty', text: '' },
  { name: 'one letter', text: 'a' },
  { name: 'english sentence', text: 'The quick brown fox jumps over the lazy dog, then goes home for tea.' },
  { name: 'english paragraphs', text: 'First paragraph about settings.\n\nSecond paragraph about files and folders.\n\nThird.' },
  { name: 'question', text: 'How do you count tokens?' },
  { name: 'typo and slang', text: 'hw do u cuont tokens lol' },
  { name: 'spanish', text: 'Hola, ¿cómo estás? Estoy buscando información sobre el rendimiento del programa.' },
  { name: 'german', text: 'Die Straße ist größer als erwartet, aber schön.' },
  { name: 'french', text: "L'été dernier, nous avons visité la forêt près de Genève." },
  { name: 'russian', text: 'Привет, как дела? Я ищу информацию о программе.' },
  { name: 'greek', text: 'Καλημέρα, πώς είστε σήμερα;' },
  { name: 'chinese', text: '你好，世界。这是一个关于令牌计数的测试句子。' },
  { name: 'japanese', text: 'こんにちは、世界。これはトークンの数え方のテストです。' },
  { name: 'korean', text: '안녕하세요, 세계. 토큰 계산 테스트입니다.' },
  { name: 'arabic', text: 'مرحبا بالعالم، هذا اختبار لعد الرموز.' },
  { name: 'hebrew', text: 'שלום עולם, זו בדיקה של ספירת אסימונים.' },
  { name: 'thai', text: 'สวัสดีชาวโลก นี่คือการทดสอบนับโทเค็น' },
  { name: 'hindi', text: 'नमस्ते दुनिया, यह टोकन गिनती का परीक्षण है।' },
  { name: 'emoji', text: 'Great job 🎉🎉 see you 😀 soon 🚀' },
  { name: 'zwj family', text: '👨‍👩‍👧‍👦' },
  { name: 'flag and skin tone', text: '👍🏽 🇺🇸' },
  { name: 'combining marks', text: 'é ä ñ ô' },
  { name: 'rust code', text: 'fn main() {\n    let x = vec![1, 2, 3];\n    for i in &x {\n        println!("{}", i);\n    }\n}' },
  { name: 'typescript code', text: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nconst x = add(1, 2);' },
  { name: 'json object', text: '{"name":"atlas","version":"2.0.3","tags":["a","b"],"nested":{"k":"v"}}' },
  { name: 'json array', text: '[{"id":1,"ok":true},{"id":2,"ok":false},{"id":3,"ok":"maybe"}]' },
  { name: 'log lines', text: '2026-10-21 12:00:01: started\n2026-10-21 12:00:02: ready\n[12:00:03] listening: 8080\n12:00:04: done' },
  { name: 'mixed prose and code', text: 'Please fix this function.\n\nfn add(a: i32, b: i32) -> i32 {\n    a - b\n}\n\nThanks!' },
  { name: 'fenced code', text: 'Here you go:\n```\nls -la\n```' },
  { name: 'crlf text', text: 'line one\r\nline two\r\n\r\nline three' },
  { name: 'only whitespace', text: '   \n\n   \t  ' },
  { name: 'only punctuation', text: '!!! ??? ... --- ===' },
  { name: 'long prose', text: 'word '.repeat(2000) },
  { name: 'long cjk', text: '字'.repeat(1500) },
];

const FIXTURES = fileURLToPath(new URL('./token-fixtures.json', import.meta.url));

describe('token estimator', () => {
  it('matches the fixture file (which the Rust estimator also checks)', () => {
    const actual = INPUTS.map((i) => ({ name: i.name, text: i.text, kind: classify(i.text), tokens: estimateTokens(i.text) }));
    if (process.env.WRITE_TOKEN_FIXTURES === '1') {
      writeFileSync(FIXTURES, JSON.stringify(actual, null, 2) + '\n', 'utf8');
    }
    const stored = JSON.parse(readFileSync(FIXTURES, 'utf8')) as typeof actual;
    expect(stored).toEqual(actual);
  });

  it('is zero for nothing and rounds up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('never goes down as text grows', () => {
    let s = '';
    let last = 0;
    for (const p of ['hello ', 'world ', '你好 ', '{"a":1} ', '😀 ', 'ünïcödé ', '\n\n', 'x']) {
      s += p;
      const now = estimateTokens(s);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it('charges CJK far more per character than English', () => {
    const en = 'the quick brown fox jumps over';
    const zh = '你好世界你好世界你好世界你好世界你好世界';
    expect(estimateTokens(zh) / [...zh].length).toBeGreaterThan(3 * (estimateTokens(en) / en.length));
  });

  it('applies calibration', () => {
    const t = 'a'.repeat(1000);
    expect(estimateTokens(t, 1500)).toBeGreaterThan(estimateTokens(t));
    expect(estimateTokens(t, 500)).toBeLessThan(estimateTokens(t));
  });

  it('lets the caller say what the text is', () => {
    expect(estimateTokensAs('{"a":1}', 'json')).toBeGreaterThanOrEqual(estimateTokensAs('{"a":1}', 'prose'));
  });

  it('keeps one chars-per-token figure for budgets', () => {
    expect(AGENT_CHARS_PER_TOKEN).toBe(3);
  });
});
