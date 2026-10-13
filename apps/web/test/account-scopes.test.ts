import { test, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Least privilege, pinned: Atlas asks the account service for `support` and nothing else
// (`identity` is granted to every token by the server). A future sync feature has to add
// `sync` here deliberately, with its own design — not inherit it.
test('Atlas requests only the support scope', () => {
  const source = readFileSync(resolve(__dirname, '../src/account/novaAccount.ts'), 'utf8');
  const match = /scopes:\s*\[([^\]]*)\]/.exec(source);
  assert.isNotNull(match, 'no scopes list found');
  const asked = match![1]!.split(',').map((s) => s.replace(/['"\s]/g, '')).filter(Boolean);
  assert.deepEqual(asked, ['support']);
});
