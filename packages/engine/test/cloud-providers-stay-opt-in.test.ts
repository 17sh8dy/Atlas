/**
 * Cloud providers stay optional, opt-in, and never touch a plaintext key —
 * checked by reading the source, not asserted.
 *
 * ── What this file replaces ─────────────────────────────────────────────────
 * Until 2026-09-11 this file was `no-other-cloud-ai.test.ts`, guaranteeing
 * "Cortex is the only cloud AI, full stop." Brandon reversed that decision
 * explicitly, asking for OpenAI-compatible/Anthropic/Gemini providers a
 * person can add themselves — see `docs/ARCHITECTURE.md` §6.3 and
 * `cloud_intelligence.rs`'s module doc. Deleting the old guard outright would
 * have thrown away the discipline of "checked, not asserted" along with the
 * policy it enforced; this file keeps that discipline and checks the new
 * policy instead:
 *
 *   1. Cortex is still registered unconditionally, exactly once — cloud
 *      providers are *additional*, never a replacement.
 *   2. A cloud provider only ever exists because a person configured one —
 *      the registration loop iterates a runtime list, there is no hard-coded
 *      provider the way `ask_claude`/`ask_openai` once were.
 *   3. An API key is representable in exactly one place — Windows Credential
 *      Manager (`secrets.rs`) — and `CloudProviderConfig`, the shape that
 *      *does* go through the plain `Storage` JSON file, has no field that
 *      could hold one.
 *   4. The required Nova/Atlas disclosure is actually shipped in the UI, not
 *      just planned.
 *
 * The online-voice guarantee (`no-other-cloud-ai.test.ts`'s other job) is
 * untouched by any of this — Brandon's request was about conversation
 * models, not speech — so those removed symbols are still checked below.
 */

import { test, assert } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git', '.turbo', 'build']);
const EXTENSIONS = ['.ts', '.tsx', '.rs'];

/** This file names every one of them on purpose, so it excludes itself. */
const SELF = 'cloud-providers-stay-opt-in.test.ts';

/** Still removed on purpose — a request about conversation models, not online voice. */
const REMOVED_VOICE_SYMBOLS = [
  'synthesizeSpeechOnline',
  'transcribeSpeechOnline',
  'synthesize_speech_online',
  'transcribe_speech_online',
];

/** A field shaped like a secret — if `CloudProviderConfig` ever grows one, it can reach `storage.json`. */
const SECRET_SHAPED_FIELDS = /\b(apiKey|api_key|secretKey|secret_key)\b\s*[:?]/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (EXTENSIONS.some((e) => entry.endsWith(e)) && entry !== SELF) found.push(full);
  }
  return found;
}

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
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
}

const FILES = sourceFiles(REPO_ROOT);
const rel = (f: string) => relative(REPO_ROOT, f).split(sep).join('/');

test('the scan actually reaches the code it claims to', () => {
  assert.isAbove(FILES.length, 50);
  const paths = FILES.map(rel);
  assert.include(paths, 'packages/platform/src/providers.ts');
  assert.include(paths, 'apps/desktop/src-tauri/src/cloud_intelligence.rs');
  assert.include(paths, 'apps/desktop/src-tauri/src/secrets.rs');
  assert.include(paths, 'apps/web/src/atlas/useAtlas.ts');
});

test('online-voice symbols removed in an earlier pass have not come back', () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const source = executableSource(file);
    for (const symbol of REMOVED_VOICE_SYMBOLS) {
      if (source.includes(symbol)) offenders.push(`${rel(file)} → ${symbol}`);
    }
  }
  assert.deepEqual(offenders, [], `These were removed on purpose:\n${offenders.join('\n')}`);
});

test('Cortex is still registered unconditionally, exactly once', () => {
  const wiring = readFileSync(join(REPO_ROOT, 'apps/web/src/atlas/useAtlas.ts'), 'utf8');
  const cortexRegistrations = wiring.match(/intelligence\.register\(createCortexProvider\(/g) ?? [];
  assert.lengthOf(cortexRegistrations, 1, 'Cortex must be registered exactly once, unconditionally');
});

test('a cloud provider is only ever registered from a runtime, user-owned list', () => {
  const wiring = readFileSync(join(REPO_ROOT, 'apps/web/src/atlas/useAtlas.ts'), 'utf8');
  // The whole guarantee: no `intelligence.register(createCloudProvider({...}))`
  // with a literal object — only ever a loop over something the user built,
  // named `cloudProviders` so this stays connected to the prop actually
  // threaded down from Settings rather than some other array that happened
  // to be lying around.
  assert.match(
    wiring,
    /for \(const config of cloudProviders\)\s*\{\s*intelligence\.register\(createCloudProvider\(config\)\);/,
    'a cloud provider must come from iterating a runtime list, never a hard-coded registration',
  );
  const hardCoded = wiring.match(/createCloudProvider\(\{/);
  assert.isNull(hardCoded, 'createCloudProvider must never be called with a literal config object');
});

test('CloudProviderConfig has no field shaped like a secret', () => {
  const model = readFileSync(
    join(REPO_ROOT, 'packages/core/src/models/cloud-provider.ts'),
    'utf8',
  );
  assert.notMatch(
    model,
    SECRET_SHAPED_FIELDS,
    'a key-shaped field here would flow straight into the plain-JSON Storage port',
  );
});

test('the plain-JSON settings writer for cloud providers never mentions a key', () => {
  const settings = executableSource(
    join(REPO_ROOT, 'packages/data/src/cloud-provider-settings.ts'),
  );
  assert.notMatch(settings, SECRET_SHAPED_FIELDS);
});

test('Credential Manager is the only place an API key is read or written', () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    if (rel(file) === 'apps/desktop/src-tauri/src/secrets.rs') continue;
    const source = executableSource(file);
    for (const symbol of ['CredWriteW', 'CredReadW', 'CredDeleteW']) {
      if (source.includes(symbol)) offenders.push(`${rel(file)} → ${symbol}`);
    }
  }
  assert.deepEqual(offenders, [], `Only secrets.rs may touch Credential Manager:\n${offenders.join('\n')}`);
});

test('a saved provider key is written through save_secret, never storage_set', () => {
  const providers = executableSource(join(REPO_ROOT, 'packages/platform/src/providers.ts'));
  assert.match(providers, /invoke<void>\('save_secret'/);
  // A narrow, deliberate check: the function that takes a raw key string
  // must not also be capable of writing it to the plain settings store.
  const fn = providers.slice(providers.indexOf('export async function saveProviderSecret'));
  assert.notInclude(fn.slice(0, fn.indexOf('\n}')), 'storage_set');
});

test('the required Nova/Atlas disclosure is actually shown, not just planned', () => {
  const ui = readFileSync(
    join(REPO_ROOT, 'apps/web/src/pages/settings/intelligence/CloudProviders.tsx'),
    'utf8',
  );
  assert.include(ui, 'does not provide, pay for, include, or maintain');
  assert.include(ui, 'own valid access and API keys');
});

test('a cloud provider is inert until both enabled and selected, same as Cortex', () => {
  // `SimpleIntelligenceRegistry.active()` already treats a registered-but-
  // unconfigured provider as nothing selected (see its own coverage in
  // engine.test.ts); this pins the fact that a cloud provider's
  // `isConfigured()` is wired to the same per-provider `enabled` flag, not a
  // global switch.
  const providers = readFileSync(join(REPO_ROOT, 'packages/platform/src/providers.ts'), 'utf8');
  assert.match(providers, /isConfigured:\s*\(\)\s*=>\s*config\.enabled/);
});
