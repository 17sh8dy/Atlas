/**
 * "Add It? / Not Now": which folder gets offered when a path is refused.
 *
 * The example that started it: `Open D:\Oliver\ollie stuff\Base Games\ThirdParty\Epic`
 * failed with "That path is outside the folders Atlas can touch." and left the
 * person to go and find Settings. The offer must name the right folder, and must
 * never tee up a whole drive or the system as a one-click answer.
 */

import { assert, test } from 'vitest';
import type { PathInfo } from '@atlas/core';
import { folderToOffer, isSensitiveFolder } from '../src/atlas/folderOffer';

const info = (path: string, isDirectory: boolean): PathInfo => ({
  path,
  name: path.split('\\').pop() ?? '',
  ext: '',
  isDirectory,
  sizeBytes: 0,
});

/** A disk with the given folders and files. Anything else does not exist. */
function disk(dirs: string[], files: string[] = []) {
  return async (path: string): Promise<PathInfo> => {
    if (dirs.includes(path)) return info(path, true);
    if (files.includes(path)) return info(path, false);
    throw new Error('no such path');
  };
}

const HOME = ['C:\\Users\\Brandon'];
const EPIC = 'D:\\Oliver\\ollie stuff\\Base Games\\ThirdParty\\Epic';

test('a folder outside the allowed list is offered as itself', async () => {
  assert.equal(await folderToOffer({ path: EPIC }, HOME, disk([EPIC])), EPIC);
});

test('a file outside the list offers its folder, not the file', async () => {
  const file = `${EPIC}\\launcher.exe`;
  assert.equal(await folderToOffer({ path: file }, HOME, disk([], [file])), EPIC);
});

test('a path already inside an allowed folder is never offered', async () => {
  const inside = 'C:\\Users\\Brandon\\Documents';
  assert.isUndefined(await folderToOffer({ path: inside }, HOME, disk([inside])));
});

test('a path that does not exist is not offered — adding it would fail anyway', async () => {
  assert.isUndefined(await folderToOffer({ path: EPIC }, HOME, disk([])));
});

test('a quoted path, as Explorer copies it, still resolves', async () => {
  assert.equal(await folderToOffer({ path: `"${EPIC}"` }, HOME, disk([EPIC])), EPIC);
});

test('arguments that are not paths are ignored', async () => {
  assert.isUndefined(await folderToOffer({ name: 'notes', count: 3 }, HOME, disk([])));
});

test('the destination is offered when only it is outside', async () => {
  const src = 'C:\\Users\\Brandon\\a.txt';
  const dest = 'E:\\Backup';
  assert.equal(await folderToOffer({ path: src, destDir: dest }, HOME, disk([dest], [src])), dest);
});

test('a whole drive, the system and app data are never offered', async () => {
  for (const bad of [
    'D:\\',
    'D:',
    'C:\\Windows\\System32',
    'C:\\Program Files\\App',
    'C:\\ProgramData',
    'C:\\Users\\Brandon\\AppData\\Roaming\\Thing',
  ]) {
    assert.isTrue(isSensitiveFolder(bad), bad);
    assert.isUndefined(await folderToOffer({ path: bad }, HOME, disk([bad])), bad);
  }
});

test('an ordinary project folder is not treated as sensitive', () => {
  assert.isFalse(isSensitiveFolder('D:\\Dev\\Atlas'));
  assert.isFalse(isSensitiveFolder(EPIC));
});
