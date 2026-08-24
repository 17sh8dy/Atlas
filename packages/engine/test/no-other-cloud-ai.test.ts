/**
 * The guarantee, enforced by reading the source.
 *
 * "Cortex is the only cloud AI" is a promise about the whole product, not
 * about one module, so the only honest way to test it is to go and look at
 * every file. A unit test of the registry would pass happily while a second
 * provider sat in `platform/` waiting to be registered.
 *
 * This scans the repository for two things:
 *
 *   1. **Hostnames.** If `api.openai.com` appears in shipped code, something
 *      talks to OpenAI, whatever the surrounding architecture claims.
 *   2. **Symbols that were deliberately removed.** `createClaudeProvider`,
 *      `ask_openai`, `synthesizeSpeechOnline` and friends. Their absence is
 *      the thing being protected; a reappearance means someone brought a path
 *      back, and this fails before it ships rather than after.
 *
 * ── What is deliberately not scanned ────────────────────────────────────────
 * Comments, and Rust `#[cfg(test)]` blocks. `intelligence.rs` legitimately
 * names these hosts twice: once in a doc comment explaining what was removed
 * and why, and once in the fixture list of `anything_that_is_not_loopback_is
 * _refused`, which is the test that proves they are refused. Failing the
 * build because a file documents its own history — or because a test asserts
 * a host is rejected — would teach the next person to delete the
 * documentation rather than the dependency.
 *
 * The stripping is line-based and deliberately simple. It can be defeated by
 * someone determined to hide a hostname inside a block comment mid-line, but
 * that is not the failure mode this guards against: the realistic one is a
 * provider added in good faith by someone who did not know the rule.
 */

import { test, assert } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git', '.turbo', 'build']);
const EXTENSIONS = ['.ts', '.tsx', '.rs'];

/** This file names every one of them on purpose, so it excludes itself. */
const SELF = 'no-other-cloud-ai.test.ts';

/** Anything here means a request is leaving for somebody else's model. */
const CLOUD_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'openrouter.ai',
  'api.groq.com',
  'api.together.xyz',
];

/** Removed on purpose. Their return would mean a path came back with them. */
const REMOVED_SYMBOLS = [
  'ask_claude',
  'ask_openai',
  'createClaudeProvider',
  'createOpenAIProvider',
  'readProviderKey',
  'readProviderKeys',
  'writeProviderKey',
  'synthesizeSpeechOnline',
  'transcribeSpeechOnline',
  'synthesize_speech_online',
  'transcribe_speech_online',
];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (EXTENSIONS.some((e) => entry.endsWith(e)) && entry !== SELF) found.push(full);
  }
  return found;
}

/**
 * The file with comments and Rust test modules taken out.
 *
 * Everything from `#[cfg(test)]` to the end of a `.rs` file is dropped —
 * fixtures asserting that a host is *refused* are evidence for this rule, not
 * against it.
 */
function executableSource(path: string): string {
  let text = readFileSync(path, 'utf8');

  if (path.endsWith('.rs')) {
    const testMod = text.indexOf('#[cfg(test)]');
    if (testMod !== -1) text = text.slice(0, testMod);
  }

  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(
        t.startsWith('//') ||
        t.startsWith('*') ||
        t.startsWith('/*') ||
        t.startsWith('*/')
      );
    })
    .join('\n');
}

const FILES = sourceFiles(REPO_ROOT);

test('the scan actually reaches the code it claims to', () => {
  // A guard that silently walks an empty tree passes forever. Anchor it.
  assert.isAbove(FILES.length, 50);
  const rel = FILES.map((f) => relative(REPO_ROOT, f).split(sep).join('/'));
  assert.include(rel, 'packages/platform/src/providers.ts');
  assert.include(rel, 'apps/desktop/src-tauri/src/intelligence.rs');
  assert.include(rel, 'apps/web/src/atlas/useAtlas.ts');
});

test('no cloud AI host appears anywhere in the shipped source', () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const source = executableSource(file);
    for (const host of CLOUD_HOSTS) {
      if (source.includes(host)) {
        offenders.push(`${relative(REPO_ROOT, file).split(sep).join('/')} → ${host}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Cortex is meant to be the only one:\n${offenders.join('\n')}`);
});

test('the removed provider and online-voice symbols have not come back', () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const source = executableSource(file);
    for (const symbol of REMOVED_SYMBOLS) {
      if (source.includes(symbol)) {
        offenders.push(`${relative(REPO_ROOT, file).split(sep).join('/')} → ${symbol}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `These were removed on purpose:\n${offenders.join('\n')}`);
});

test('exactly one provider is ever registered, and it is Cortex', () => {
  const wiring = readFileSync(join(REPO_ROOT, 'apps/web/src/atlas/useAtlas.ts'), 'utf8');
  const registrations = wiring.match(/intelligence\.register\(/g) ?? [];
  assert.lengthOf(registrations, 1);
  assert.include(wiring, 'createCortexProvider');
});
