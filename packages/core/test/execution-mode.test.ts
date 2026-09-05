import { test, assert } from 'vitest';
import {
  DEFAULT_EXECUTION_MODE,
  EXECUTION_MODES,
  isExecutionMode,
  nextExecutionMode,
} from '../src/models/execution-mode';

test('the default is Do It?, matching the concept this replaces', () => {
  assert.equal(DEFAULT_EXECUTION_MODE, 'doIt');
});

test('cycling steps through all three modes and wraps', () => {
  const seen = [DEFAULT_EXECUTION_MODE];
  for (let i = 0; i < EXECUTION_MODES.length; i++) {
    seen.push(nextExecutionMode(seen[seen.length - 1]!));
  }
  // Back to the start after exactly one full lap.
  assert.equal(seen[seen.length - 1], DEFAULT_EXECUTION_MODE);
  assert.deepEqual(new Set(seen.slice(0, -1)), new Set(EXECUTION_MODES));
});

test('a stored value is only trusted when it names a real mode', () => {
  for (const mode of EXECUTION_MODES) assert.isTrue(isExecutionMode(mode));
  for (const junk of ['', 'plan-first', 'YOLO', undefined, null, 42]) {
    assert.isFalse(isExecutionMode(junk));
  }
});
