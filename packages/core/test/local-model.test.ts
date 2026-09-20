import { test, assert } from 'vitest';
import {
  DEFAULT_LOCAL_MODEL_ID,
  LOCAL_MODEL_PROFILES,
  localModelIdForTag,
  resolveActiveProviderId,
  sameOllamaTag,
} from '../src/models/local-model';

test('the main local model is Qwen3-8B', () => {
  assert.equal(DEFAULT_LOCAL_MODEL_ID, 'local:qwen3-8b');
  const main = LOCAL_MODEL_PROFILES.find((p) => p.id === DEFAULT_LOCAL_MODEL_ID);
  assert.equal(main?.label, 'Qwen3-8B');
  assert.equal(main?.ollamaTag, 'qwen3:8b');
  assert.equal(main?.role, 'everyday');
});

test('the two optional models are the large pair, each with its own role', () => {
  const byRole = Object.fromEntries(LOCAL_MODEL_PROFILES.map((p) => [p.role, p]));
  assert.equal(byRole.reasoning?.label, 'Qwen3-30B-A3B');
  assert.equal(byRole.reasoning?.ollamaTag, 'qwen3:30b');
  assert.equal(byRole.flagship?.label, 'Qwen3.5-35B');
  assert.equal(byRole.flagship?.ollamaTag, 'qwen3.5:35b');
  assert.lengthOf(LOCAL_MODEL_PROFILES, 3);
});

test('every profile has a distinct id and tag, and ids never collide with a cloud id shape', () => {
  const ids = LOCAL_MODEL_PROFILES.map((p) => p.id);
  const tags = LOCAL_MODEL_PROFILES.map((p) => p.ollamaTag);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(tags).size, tags.length);
  for (const id of ids) assert.match(id, /^local:/);
  // cloud providers are `cloud-<uuid>`, so the two id spaces cannot overlap
  for (const id of ids) assert.notMatch(id, /^cloud-/);
});

test('only the everyday model turns thinking off; the others keep their default', () => {
  const think = Object.fromEntries(LOCAL_MODEL_PROFILES.map((p) => [p.role, p.think]));
  assert.equal(think.everyday, false);
  assert.isUndefined(think.reasoning);
  assert.isUndefined(think.flagship);
});

test('an installed tag maps to its profile id, and an unknown tag gets its own', () => {
  assert.equal(localModelIdForTag('qwen3:8b'), 'local:qwen3-8b');
  assert.equal(localModelIdForTag('qwen3.5:35b'), 'local:qwen3.5-35b');
  assert.equal(localModelIdForTag('llama3.2:3b'), 'local:llama3.2:3b');
});

test('tag comparison treats a bare name as :latest and ignores case', () => {
  assert.isTrue(sameOllamaTag('qwen3:8b', 'QWEN3:8B'));
  assert.isTrue(sameOllamaTag('llama3', 'llama3:latest'));
  assert.isFalse(sameOllamaTag('qwen3:8b', 'qwen3:30b'));
});

const KNOWN = [...LOCAL_MODEL_PROFILES.map((p) => p.id), 'nova-intelligence', 'cloud-abc'];

test('a valid pick wins, whatever it is', () => {
  for (const chosen of KNOWN) {
    assert.equal(resolveActiveProviderId({ chosen, known: KNOWN, localEnabled: true }), chosen);
    assert.equal(resolveActiveProviderId({ chosen, known: KNOWN, localEnabled: false }), chosen);
  }
});

test('with local models on and no pick, the default is Qwen3-8B', () => {
  assert.equal(
    resolveActiveProviderId({ chosen: null, known: KNOWN, localEnabled: true }),
    'local:qwen3-8b',
  );
});

test('with local models off and no pick, nothing is connected — a normal state', () => {
  assert.isNull(resolveActiveProviderId({ chosen: null, known: KNOWN, localEnabled: false }));
});

test('a pick that no longer exists is treated as no pick, never as a failure', () => {
  // a removed cloud provider, or an id written by an older version of Atlas
  for (const stale of ['cloud-removed', 'legacy-provider', '']) {
    assert.equal(
      resolveActiveProviderId({ chosen: stale, known: KNOWN, localEnabled: true }),
      'local:qwen3-8b',
    );
    assert.isNull(resolveActiveProviderId({ chosen: stale, known: KNOWN, localEnabled: false }));
  }
});
