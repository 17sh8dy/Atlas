import { test, assert } from 'vitest';
import { timeAgo } from '../src/lib/timeAgo';

const NOW = 1_700_000_000_000;

test('under 10 seconds reads as "just now"', () => {
  assert.equal(timeAgo(NOW - 4_000, NOW), 'just now');
});

test('seconds, minutes, hours and days each get their own unit', () => {
  assert.equal(timeAgo(NOW - 30_000, NOW), '30s ago');
  assert.equal(timeAgo(NOW - 5 * 60_000, NOW), '5m ago');
  assert.equal(timeAgo(NOW - 3 * 3_600_000, NOW), '3h ago');
  assert.equal(timeAgo(NOW - 2 * 86_400_000, NOW), '2d ago');
});

test('a week or older falls back to a date', () => {
  const result = timeAgo(NOW - 10 * 86_400_000, NOW);
  assert.notMatch(result, /ago$/);
});

test("never reports a negative age for a clock that hasn't caught up", () => {
  assert.equal(timeAgo(NOW + 5_000, NOW), 'just now');
});
