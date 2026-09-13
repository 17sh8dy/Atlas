import { test, assert } from 'vitest';
import { formatVersion } from '../src/pages/settings/About';

test('a trailing .0 patch is dropped', () => {
  assert.equal(formatVersion('0.85.0'), '0.85');
});

test('a real patch number is kept in full', () => {
  assert.equal(formatVersion('0.85.3'), '0.85.3');
});

test('a version with no patch at all is left alone', () => {
  assert.equal(formatVersion('0.85'), '0.85');
});
