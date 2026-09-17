import { test, assert } from 'vitest';
import {
  ATLAS_ROLES,
  ATLAS_ROLE_META,
  DEFAULT_ATLAS_ROLE,
  isAtlasRole,
} from '../src/models/atlas-role';

test('the default is assistant, matching the greeting Atlas has always used', () => {
  assert.equal(DEFAULT_ATLAS_ROLE, 'assistant');
});

test('assistant reproduces the original greeting exactly', () => {
  const meta = ATLAS_ROLE_META[DEFAULT_ATLAS_ROLE];
  assert.equal(meta.greeting('Nova', 'Sam'), "Hey Sam — I'm Nova. What do you need?");
  assert.equal(meta.greeting('Nova'), "Hey — I'm Nova. What do you need?");
});

test('a stored value is only trusted when it names a real role', () => {
  for (const role of ATLAS_ROLES) assert.isTrue(isAtlasRole(role));
  for (const junk of ['', 'jarvis', 'HAL9000', undefined, null, 42]) {
    assert.isFalse(isAtlasRole(junk));
  }
});

test('every role has a usable greeting, with and without a name', () => {
  for (const role of ATLAS_ROLES) {
    const meta = ATLAS_ROLE_META[role];
    const withName = meta.greeting('Atlas', 'Sam');
    const withoutName = meta.greeting('Atlas');
    assert.isAbove(withName.length, 0, `${role} produced an empty greeting with a name`);
    assert.isAbove(withoutName.length, 0, `${role} produced an empty greeting without one`);
    // A role that ignores the name entirely would be indistinguishable from
    // one that never learned it — every role besides the fixed default
    // sentence structure should read differently once a name is known.
    if (role !== DEFAULT_ATLAS_ROLE) {
      assert.include(withName, 'Sam', `${role} doesn't use the name it was given`);
    }
  }
});

test('no two roles share an icon or a label', () => {
  assert.equal(new Set(ATLAS_ROLES.map((r) => ATLAS_ROLE_META[r].icon)).size, ATLAS_ROLES.length);
  assert.equal(new Set(ATLAS_ROLES.map((r) => ATLAS_ROLE_META[r].label)).size, ATLAS_ROLES.length);
});

test('assistant has no farewell — the default role changes nothing about how Atlas already talked', () => {
  assert.isUndefined(ATLAS_ROLE_META[DEFAULT_ATLAS_ROLE].farewell);
});

test('every non-default role has a usable, distinct farewell, with and without a name', () => {
  const nonDefault = ATLAS_ROLES.filter((r) => r !== DEFAULT_ATLAS_ROLE);
  const withNames: string[] = [];
  for (const role of nonDefault) {
    const farewell = ATLAS_ROLE_META[role].farewell;
    assert.isDefined(farewell, `${role} has no farewell`);
    const withName = farewell!('Sam');
    const withoutName = farewell!();
    assert.isAbove(withName.length, 0, `${role} produced an empty farewell with a name`);
    assert.isAbove(withoutName.length, 0, `${role} produced an empty farewell without one`);
    assert.include(withName, 'Sam', `${role}'s farewell doesn't use the name it was given`);
    withNames.push(withName);
  }
  assert.equal(new Set(withNames).size, nonDefault.length, 'two roles produced the same farewell');
});
