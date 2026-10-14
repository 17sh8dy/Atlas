import { describe, test, assert } from 'vitest';
import {
  CLOUD_DECLARED_CAPABILITIES,
  LONG_CONTEXT_TOKENS,
  NOVA_INTELLIGENCE_CAPABILITIES,
  UNKNOWN_CAPABILITIES,
  canConverse,
  capabilitiesFromOllama,
  supports,
} from '../src/models/provider-capabilities';

const FEATURES = ['structuredOutput', 'toolCalling', 'longContext', 'vision', 'coding'] as const;

describe('unknown is conservative', () => {
  test('nothing is supported until it is positively known', () => {
    for (const f of [...FEATURES, 'conversation'] as const) {
      assert.isFalse(supports(UNKNOWN_CAPABILITIES, f), f);
      assert.isFalse(supports(null, f), f);
      assert.isFalse(supports(undefined, f), f);
    }
  });

  test('a model never described can still be talked to; only an explicit no excludes one', () => {
    assert.isTrue(canConverse(UNKNOWN_CAPABILITIES));
    assert.isTrue(canConverse(null));
    assert.isFalse(canConverse(NOVA_INTELLIGENCE_CAPABILITIES));
  });

  test('the shared descriptors cannot be altered by accident', () => {
    assert.isTrue(Object.isFrozen(UNKNOWN_CAPABILITIES));
    assert.isTrue(Object.isFrozen(NOVA_INTELLIGENCE_CAPABILITIES));
    assert.isTrue(Object.isFrozen(CLOUD_DECLARED_CAPABILITIES));
  });
});

describe('what a server reports', () => {
  test('tool calling and vision are read from the list, and absence in a list is no', () => {
    const caps = capabilitiesFromOllama({ capabilities: ['completion', 'tools'], contextTokens: 40_960 });
    assert.equal(caps.toolCalling, 'yes');
    assert.equal(caps.vision, 'no');
    assert.equal(caps.conversation, 'yes');
    assert.equal(caps.longContext, 'yes');
    assert.equal(caps.source, 'reported');
  });

  test('a server that sends no list leaves the feature unknown, never no', () => {
    const caps = capabilitiesFromOllama({ capabilities: null, contextTokens: 8_192 });
    assert.equal(caps.toolCalling, 'unknown');
    assert.equal(caps.vision, 'unknown');
    assert.equal(caps.longContext, 'no');
    assert.isFalse(supports(caps, 'toolCalling'));
  });

  test('context is long at the threshold and not below it', () => {
    assert.equal(capabilitiesFromOllama({ contextTokens: LONG_CONTEXT_TOKENS }).longContext, 'yes');
    assert.equal(capabilitiesFromOllama({ contextTokens: LONG_CONTEXT_TOKENS - 1 }).longContext, 'no');
  });

  test('an embedding-only model is not a conversation partner', () => {
    assert.isFalse(canConverse(capabilitiesFromOllama({ capabilities: ['embedding'] })));
  });

  test('a catalogue declaration stands until the server says otherwise', () => {
    const declared = capabilitiesFromOllama(null, { conversation: 'yes', source: 'declared' });
    assert.equal(declared.conversation, 'yes');
    assert.equal(declared.toolCalling, 'unknown');
    assert.equal(declared.source, 'declared');
  });

  test('structured output and coding are never inferred from a report', () => {
    const caps = capabilitiesFromOllama({
      capabilities: ['completion', 'tools', 'vision', 'thinking'],
      contextTokens: 262_144,
    });
    assert.equal(caps.structuredOutput, 'unknown');
    assert.equal(caps.coding, 'unknown');
  });
});

describe('provider kinds', () => {
  test('a cloud endpoint is declared to converse and nothing more', () => {
    assert.equal(CLOUD_DECLARED_CAPABILITIES.conversation, 'yes');
    for (const f of FEATURES) assert.equal(CLOUD_DECLARED_CAPABILITIES[f], 'unknown', f);
    assert.equal(CLOUD_DECLARED_CAPABILITIES.source, 'declared');
  });

  test('Nova Intelligence is declared unable to do any of it', () => {
    for (const f of [...FEATURES, 'conversation'] as const) {
      assert.equal(NOVA_INTELLIGENCE_CAPABILITIES[f], 'no', f);
    }
  });
});
