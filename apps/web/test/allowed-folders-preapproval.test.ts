/**
 * `isInsideAnyAllowedFolder` — the policy behind Do It mode's one exception
 * to "always confirm" (see the executor's own doc comment in `@atlas/engine`
 * for the mode-level gate; this is only the "is this path already permitted"
 * half of it).
 */

import { test, assert } from 'vitest';
import { isInsideAnyAllowedFolder, PREAPPROVABLE_PATH_ARGS } from '../src/atlas/useAtlas';

test('a path directly inside an allowed folder matches', () => {
  assert.isTrue(isInsideAnyAllowedFolder('D:\\Dev\\Atlas\\notes.txt', ['D:\\Dev']));
});

test('the allowed folder itself matches', () => {
  assert.isTrue(isInsideAnyAllowedFolder('D:\\Dev', ['D:\\Dev']));
});

test('a sibling folder that merely shares a prefix does not match', () => {
  // The bug class this guards: "D:\Dev" must not match "D:\Devious".
  assert.isFalse(isInsideAnyAllowedFolder('D:\\Devious\\file.txt', ['D:\\Dev']));
});

test('a path outside every allowed folder does not match', () => {
  assert.isFalse(isInsideAnyAllowedFolder('C:\\Windows\\System32\\evil.dll', ['D:\\Dev']));
});

test('forward slashes and a trailing separator are normalized the same way', () => {
  assert.isTrue(isInsideAnyAllowedFolder('D:/Dev/Atlas/notes.txt', ['D:\\Dev\\']));
});

test('comparison is case-insensitive, matching Windows paths', () => {
  assert.isTrue(isInsideAnyAllowedFolder('d:\\dev\\atlas\\notes.txt', ['D:\\Dev']));
});

test('an empty allowed-folders list matches nothing', () => {
  assert.isFalse(isInsideAnyAllowedFolder('D:\\Dev\\notes.txt', []));
});

test('every preapprovable skill checks at least one path argument', () => {
  for (const [id, args] of Object.entries(PREAPPROVABLE_PATH_ARGS)) {
    assert.isAbove(args.length, 0, `${id} lists no path args to check`);
  }
});

test('move and copy check both the source and the destination', () => {
  assert.deepEqual(PREAPPROVABLE_PATH_ARGS['files.move'], ['path', 'destDir']);
  assert.deepEqual(PREAPPROVABLE_PATH_ARGS['files.copy'], ['path', 'destDir']);
});

test('project.create gets the same softening as its twin files.createFolder', () => {
  assert.deepEqual(PREAPPROVABLE_PATH_ARGS['project.create'], ['path']);
  assert.deepEqual(PREAPPROVABLE_PATH_ARGS['files.createFolder'], ['path']);
});

test('dependency.install is deliberately never preapproved — it always asks', () => {
  assert.isUndefined(PREAPPROVABLE_PATH_ARGS['dependency.install']);
});
