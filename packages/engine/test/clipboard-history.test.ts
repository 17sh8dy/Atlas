import { assert, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { ClipboardHistory, HISTORY_LIMIT, MAX_ENTRY_CHARS, looksSensitive } from '../src/clipboard/history';
import { createClipboardHistorySkills } from '../src/skills/clipboard-history-skills';

test('ordinary copies are kept, newest first, and repeats move to the top', () => {
  const h = new ClipboardHistory();
  assert.equal(h.capture('hello world'), true);
  assert.equal(h.capture('second thing'), true);
  assert.equal(h.capture('second thing'), false); // same as the last one
  assert.equal(h.capture('hello world'), true); // moves up, not duplicated
  assert.deepEqual(h.list().map((e) => e.text), ['hello world', 'second thing']);
});

test('only the most recent twenty are kept', () => {
  const h = new ClipboardHistory();
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) h.capture(`item number ${i}`);
  assert.equal(h.size, HISTORY_LIMIT);
  assert.equal(h.list()[0]!.text, `item number ${HISTORY_LIMIT + 4}`);
});

test('empty, whitespace and oversized copies are not kept', () => {
  const h = new ClipboardHistory();
  assert.equal(h.capture(''), false);
  assert.equal(h.capture('   \n '), false);
  assert.equal(h.capture('x '.repeat(MAX_ENTRY_CHARS)), false);
  assert.equal(h.capture(null), false);
  assert.equal(h.size, 0);
});

const SECRETS = [
  'ghp_abcdefghijklmnop' + 'qrstuvwxyz0123456789',
  'github_pat_11ABCDEFG012' + '3456789_abcdefghijklmnop',
  'sk-ant-api03-AbCdE' + 'fGhIjKlMnOpQrStUvWx',
  'sk_live_4eC39HqL' + 'yjWDarjtT1zdp7dc',
  'xox' + 'b-123456789012-abcdefghijklmn',
  'AKIAIOSFOD' + 'NN7EXAMPLE',
  'AIzaSyA-1234567890ab' + 'cdefghijklmnopqrstuv',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0N' + 'TY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
  'password: hunter2',
  'API_KEY=abc123',
  'my token = 12345',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIE',
  'postgres://admin:s3cretpw@db.example.com/app',
  '4111 1111 1111 1111',
  '4111-1111-1111-1111',
  '123-45-6789',
  'a3f5c9e1b2d4f60718293a4b5c6d7e8f',
  'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==',
  'Xk39dLmQ82pRtYw7ZaB4vNcE1uHgS5jF',
];

test('things that look like secrets are never kept', () => {
  const h = new ClipboardHistory();
  for (const s of SECRETS) {
    assert.equal(looksSensitive(s), true, s);
    assert.equal(h.capture(s), false, s);
  }
  assert.equal(h.size, 0);
});

const ORDINARY = [
  'Meeting at 3pm with the design team',
  'https://github.com/17sh8dy/Atlas/issues/12',
  'C:\\Users\\Brandon\\Documents\\notes-from-the-long-meeting.txt',
  'The quick brown fox jumps over the lazy dog',
  'git commit -m "fix the scroll speed"',
  '12345',
  '2026-09-30',
  'Call mom at 555-0123',
  'password reset email sent', // the word alone is not a key: value pair
];

test('ordinary text is not mistaken for a secret', () => {
  for (const s of ORDINARY) assert.equal(looksSensitive(s), false, s);
});

test('clear forgets everything, including the last-seen value', () => {
  const h = new ClipboardHistory();
  h.capture('keep me');
  h.clear();
  assert.equal(h.size, 0);
  assert.equal(h.capture('keep me'), true);
});

function skills(enabled: boolean, history = new ClipboardHistory()) {
  const written: string[] = [];
  const platform = { writeClipboard: async (t: string) => (written.push(t), true) } as unknown as Platform;
  const list = createClipboardHistorySkills({ platform, history, isEnabled: () => enabled });
  const by = (id: string) => list.find((s) => s.id === id)!;
  return { by, written, history };
}

test('while history is off, the skills say so and show nothing', async () => {
  const { by, history } = skills(false);
  history.capture('something');
  const shown: unknown[] = [];
  const r = (await by('clipboard.history').run({}, { showResults: (x: unknown) => shown.push(x) } as never)) as { message?: string };
  assert.match(String(r.message), /history is off/i);
  assert.equal(shown.length, 0);
});

test('restore puts the numbered item back; a bad number is refused', async () => {
  const { by, written, history } = skills(true);
  history.capture('first');
  history.capture('second');
  const ok = (await by('clipboard.restore').run({ n: 2 }, {} as never)) as { ok: boolean };
  assert.equal(ok.ok, true);
  assert.deepEqual(written, ['first']);
  const bad = (await by('clipboard.restore').run({ n: 9 }, {} as never)) as { ok: boolean; error?: string };
  assert.equal(bad.ok, false);
});
