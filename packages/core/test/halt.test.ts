import { test, assert } from 'vitest';
import {
  HaltController,
  HaltedError,
  isHaltedError,
  parseHaltShortcut,
  shortcutFromKeyEvent,
  untilHalted,
} from '../src/models/halt';

// The same cases as halt.rs's parse tests — the two must agree, or Settings
// accepts a key the shell then refuses.
test('stop keys parse to the canonical label halt.rs stores', () => {
  const cases: [string, string][] = [
    ['F8', 'F8'],
    ['f8', 'F8'],
    ['shift+ctrl+f12', 'Ctrl+Shift+F12'],
    ['Pause', 'Pause'],
    ['Ctrl+Alt+H', 'Ctrl+Alt+H'],
    ['Win+Escape', 'Win+Escape'],
    ['Ctrl+Alt+PageDown', 'Ctrl+Alt+PageDown'],
  ];
  for (const [input, label] of cases) {
    const parsed = parseHaltShortcut(input);
    assert.deepEqual(parsed, { ok: true, value: label }, input);
  }
});

test('keys that would steal typing or system shortcuts are refused', () => {
  for (const bad of [
    'H', 'Shift+H', 'Ctrl+C', 'Alt+X', 'Escape', 'Shift+Delete', 'Space', 'Ctrl+Space',
    'Alt+F4', 'Ctrl+Alt+Delete', 'Ctrl+Ctrl+F8', 'Hyper+F8', 'Ctrl+', '', 'Tab', 'Ctrl+Alt+Tab',
  ]) {
    assert.isFalse(parseHaltShortcut(bad).ok, bad);
  }
});

test('a refusal explains itself', () => {
  const r = parseHaltShortcut('Ctrl+C');
  assert.isFalse(r.ok);
  if (!r.ok) assert.match(r.reason, /two modifiers/);
});

test('the recorder names the physical key and waits out bare modifiers', () => {
  const base = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  assert.isNull(shortcutFromKeyEvent({ ...base, key: 'Control', code: 'ControlLeft', ctrlKey: true }));
  assert.equal(shortcutFromKeyEvent({ ...base, key: 'F8', code: 'F8' }), 'F8');
  assert.equal(
    shortcutFromKeyEvent({ ...base, key: 'Ó', code: 'KeyH', ctrlKey: true, altKey: true }),
    'Ctrl+Alt+H',
  );
  // Synthetic key events (and some remote-desktop clients) carry no physical
  // code — seen in the real app, where Ctrl+C was shown as "Ctrl + c".
  assert.equal(shortcutFromKeyEvent({ ...base, key: 'c', code: '', ctrlKey: true }), 'Ctrl+C');
});

test('halted errors are recognised by the prefix halt.rs sends', () => {
  assert.isTrue(isHaltedError('Atlas is halted — nothing else runs until you send something new.'));
  assert.isFalse(isHaltedError('Something else went wrong'));
  assert.isFalse(isHaltedError(undefined));
});

test('untilHalted rejects the moment the signal aborts, without waiting for the work', async () => {
  const controller = new AbortController();
  const never = new Promise<never>(() => {});
  const waiting = untilHalted(never, controller.signal);
  setTimeout(() => controller.abort(), 5);
  const started = Date.now();
  await waiting.then(
    () => assert.fail('should not resolve'),
    (e) => assert.instanceOf(e, HaltedError),
  );
  assert.isBelow(Date.now() - started, 100);
});

test('untilHalted passes results through and rejects at once when already aborted', async () => {
  assert.equal(await untilHalted(Promise.resolve(3), new AbortController().signal), 3);
  const aborted = new AbortController();
  aborted.abort();
  await untilHalted(Promise.resolve(3), aborted.signal).then(
    () => assert.fail('should not resolve'),
    (e) => assert.instanceOf(e, HaltedError),
  );
});

test('HaltController notifies once, reports aborted, and honours removal', () => {
  const c = new HaltController();
  let hits = 0;
  const removed = () => (hits += 100);
  c.signal.addEventListener('abort', () => hits++, { once: true });
  c.signal.addEventListener('abort', removed);
  c.signal.removeEventListener('abort', removed);
  assert.isFalse(c.signal.aborted);
  c.abort();
  c.abort();
  assert.isTrue(c.signal.aborted);
  assert.equal(hits, 1);
});
