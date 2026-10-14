import { test, assert, describe } from 'vitest';
import { redactSecrets, KEY_HIDDEN } from '../src/redact';

describe('keeping credentials out of what is written down', () => {
  const keys = [
    'sk-proj-abcdefghijklmnopqrstuvwx',
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrSt',
    'hf_abcdefghijklmnopqrstuvwxyzABCD',
    'tvly-dev-abcdefghijklmnop',
    'AIzaSyA-abcdefghijklmnopqrstuvwxyz0123',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
  ];

  test.each(keys)('%s is hidden and the sentence around it is kept', (k) => {
    const out = redactSecrets(`my key is ${k} please save it`);
    assert.notInclude(out, k);
    assert.include(out, KEY_HIDDEN);
    assert.match(out, /^my key is .* please save it$/);
  });

  test('named values and bearer headers are hidden', () => {
    assert.notInclude(redactSecrets('Authorization: Bearer abcdEFGH1234567890zzzz'), 'abcdEFGH1234567890zzzz');
    assert.notInclude(redactSecrets('api_key=Zx81hq92 and password: hunter2hunter2'), 'hunter2');
    assert.notInclude(redactSecrets('x-api-key: Qq77aa88bb99'), 'Qq77aa88bb99');
  });

  test('a private key block is hidden', () => {
    const out = redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----');
    assert.equal(out, KEY_HIDDEN);
  });

  test('a long random token is hidden', () => {
    const t = 'Zq8Lm3Xv9Tp2Wc7Rb5Nk1Hd4Jf6Gs0YaQe';
    assert.notInclude(redactSecrets(`value ${t} end`), t);
  });

  test('ordinary text, paths, URLs and digests are left alone', () => {
    const samples = [
      'Open the folder D:\\Dev\\Atlas and list the biggest files.',
      'https://github.com/17sh8dy/Atlas/releases/latest/download/latest.json',
      'sha256 a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      'The token expired yesterday, so sign in again.',
      'what is 12 times 12',
    ];
    for (const s of samples) assert.equal(redactSecrets(s), s);
  });
});
