import { assert, test } from 'vitest';
import { DEFAULT_SCROLL, MAX_STEP_PX, SCROLL_MAX, SCROLL_MIN, cleanScroll, wheelStep } from '../src/atlas/scroll';

test('an ordinary wheel notch at 100% is unchanged', () => {
  assert.equal(wheelStep(100, 0, 100, 800), 100);
  assert.equal(wheelStep(-100, 0, 100, 800), -100);
});

test('a slower setting scales the step down', () => {
  assert.equal(wheelStep(100, 0, 50, 800), 50);
});

test('a huge fling is capped, in both directions, and the cap scales with the setting', () => {
  assert.equal(wheelStep(5000, 0, 100, 800), MAX_STEP_PX);
  assert.equal(wheelStep(-5000, 0, 100, 800), -MAX_STEP_PX);
  assert.equal(wheelStep(5000, 0, 50, 800), MAX_STEP_PX / 2);
});

test('line and page wheels are converted to pixels first', () => {
  assert.equal(wheelStep(3, 1, 100, 800), 120);
  assert.equal(wheelStep(1, 2, 100, 800), MAX_STEP_PX);
});

test('stored values are clamped and junk falls back to the default', () => {
  assert.deepEqual(cleanScroll({ speed: 5 }), { speed: SCROLL_MIN });
  assert.deepEqual(cleanScroll({ speed: 9999 }), { speed: SCROLL_MAX });
  assert.deepEqual(cleanScroll({ speed: 'fast' }), DEFAULT_SCROLL);
  assert.deepEqual(cleanScroll(undefined), DEFAULT_SCROLL);
});
