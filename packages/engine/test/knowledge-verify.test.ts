import { describe, expect, test } from 'vitest';
import { claimsIn, unbackedClaims } from '../src/knowledge/verify';

const REF = 'Atlas 2.0.3 counts tokens. The cloud cap is `atlas-tokens`. A correction is used after 20 samples. 1,000 tokens max.';

describe('K7 reply check', () => {
  test('numbers and code names present in the reference pass', () => {
    expect(unbackedClaims('After 20 samples it uses `atlas-tokens` on 2.0.3.', REF)).toEqual([]);
  });

  test('an invented number fails', () => {
    expect(unbackedClaims('It needs 50 samples.', REF)).toEqual(['50']);
  });

  test('a number is matched whole, not as a prefix of another', () => {
    expect(unbackedClaims('Used in 202 cases.', REF)).toEqual(['202']);
    expect(unbackedClaims('It needs 2 samples.', REF)).toEqual(['2']);
  });

  test('an invented setting name fails', () => {
    expect(unbackedClaims('Turn on `atlas.magic`.', REF)).toEqual(['atlas.magic']);
  });

  test('thousands separators agree and list markers are not claims', () => {
    expect(unbackedClaims('1) First\n2. Second\nUp to 1000 tokens.', REF)).toEqual([]);
    expect(claimsIn('1) First\n2. Second')).toEqual([]);
  });

  test('a number from the question itself is allowed', () => {
    expect(unbackedClaims('Yes, 7 is fine.', REF, 'is 7 ok?')).toEqual([]);
  });

  test('a reply with no specifics passes', () => {
    expect(unbackedClaims('It estimates when the model gives no count.', REF)).toEqual([]);
  });
});
