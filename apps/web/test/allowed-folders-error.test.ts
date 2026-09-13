/**
 * `folderErrorMessage` — Tauri rejects a `Result<T, String>` command's error
 * with the raw string itself, never wrapped in an `Error`, so the previous
 * `e instanceof Error ? e.message : fallback` always fell through to the
 * fallback. This is what "Couldn't add that folder." for every failure
 * turned out to be.
 */

import { test, assert } from 'vitest';
import { folderErrorMessage } from '../src/pages/settings/General';

test('a plain string rejection (the real Tauri shape) is shown as-is', () => {
  assert.equal(
    folderErrorMessage("That folder doesn't exist.", "Couldn't add that folder."),
    "That folder doesn't exist.",
  );
});

test('an Error instance is still handled, in case a future call site throws one', () => {
  assert.equal(
    folderErrorMessage(new Error("That isn't a folder."), "Couldn't add that folder."),
    "That isn't a folder.",
  );
});

test('an empty string falls back rather than showing nothing', () => {
  assert.equal(folderErrorMessage('', "Couldn't add that folder."), "Couldn't add that folder.");
});

test('anything unrecognisable falls back to the caller-supplied message', () => {
  assert.equal(
    folderErrorMessage(undefined, "Couldn't add that folder."),
    "Couldn't add that folder.",
  );
  assert.equal(
    folderErrorMessage({ weird: true }, "Couldn't remove that folder."),
    "Couldn't remove that folder.",
  );
});
