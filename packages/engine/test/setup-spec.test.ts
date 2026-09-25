import { test, assert } from 'vitest';
import { parseSpec, readPosition, setupKey, describeItem } from '../src/setup/spec';

test('a full recording spec becomes five checked items', () => {
  const { items, unknown } = parseSpec(
    'open OBS and Discord, close Chrome, put Discord on the left, check my mic is the MV7, make sure D: has 50 GB free',
  );
  assert.deepEqual(unknown, []);
  assert.deepEqual(items, [
    { kind: 'open', app: 'OBS' },
    { kind: 'open', app: 'Discord' },
    { kind: 'close', app: 'Chrome' },
    { kind: 'place', app: 'Discord', position: 'left' },
    { kind: 'mic', expect: 'MV7' },
    { kind: 'storage', drive: 'D:', minGb: 50 },
  ]);
});

test('"and" between two instructions splits; "and" between two names does not', () => {
  assert.deepEqual(parseSpec('open OBS and close Chrome').items, [
    { kind: 'open', app: 'OBS' },
    { kind: 'close', app: 'Chrome' },
  ]);
  assert.deepEqual(
    parseSpec('open OBS, Discord and Spotify').items.map((i) => (i as { app: string }).app),
    ['OBS', 'Discord', 'Spotify'],
  );
});

test('placements read the words people use', () => {
  assert.equal(readPosition('the top right corner'), 'top-right');
  assert.equal(readPosition('left half'), 'left');
  assert.equal(readPosition('middle'), 'center');
  assert.equal(readPosition('full screen'), 'maximize');
  assert.deepEqual(parseSpec('Spotify on the right of display 2').items, [
    { kind: 'place', app: 'Spotify', position: 'right', display: 2 },
  ]);
});

test('storage defaults to 20 GB on C: only when a drive or size is actually named', () => {
  assert.deepEqual(parseSpec('at least 100gb on the D drive').items, [
    { kind: 'storage', drive: 'D:', minGb: 100 },
  ]);
  assert.deepEqual(parseSpec('check free space on E:').items, [
    { kind: 'storage', drive: 'E:', minGb: 20 },
  ]);
});

test('anything not understood is reported, never guessed at', () => {
  const { items, unknown } = parseSpec('open OBS, make me a sandwich');
  assert.deepEqual(items, [{ kind: 'open', app: 'OBS' }]);
  assert.deepEqual(unknown, ['make me a sandwich']);
});

test('setup names normalise to one key', () => {
  assert.equal(setupKey('my Recording setup'), 'recording');
  assert.equal(setupKey('to stream'), 'streaming');
  assert.equal(setupKey('to code'), 'coding');
  assert.equal(setupKey('the morning routine'), 'morning');
  assert.equal(
    describeItem({ kind: 'storage', drive: 'D:', minGb: 50 }),
    'At least 50 GB free on D:',
  );
});
