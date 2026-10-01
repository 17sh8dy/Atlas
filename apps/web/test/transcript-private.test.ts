import { assert, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A result list marked `private` (clipboard history) must never reach disk with the
 * conversation, and must not be read aloud. This pins the three places that do that, so
 * removing one fails here rather than quietly saving someone's clipboard.
 */
const src = readFileSync(resolve(__dirname, '../src/atlas/useAtlas.ts'), 'utf8');

test('the saved transcript drops private result lists', () => {
  assert.match(src, /e\.kind === 'results' && e\.meta\?\.private/);
  assert.match(src, /storage\.set\(TRANSCRIPT_KEY, keep\.slice/);
});

test('a private list is not read aloud item by item', () => {
  assert.match(src, /meta\?\.private \? \(meta\.title \?\? ''\) : summarizeForSpeech/);
});

test('clipboard history asks for exactly that', () => {
  const skill = readFileSync(resolve(__dirname, '../../../packages/engine/src/skills/clipboard-history-skills.ts'), 'utf8');
  assert.match(skill, /private: true/);
});
