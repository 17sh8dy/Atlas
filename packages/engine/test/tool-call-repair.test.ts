/**
 * A small model forgets the closing brace of the outer action object. qwen3.5:9b did exactly this
 * on a "write index.html" step: `{"skill":…,"args":{…}` with one `}` for args and none for the
 * action. The parser found only the inner args object and rejected the reply twice, so the agent
 * stopped having built nothing. The fixture is that model's real reply, unedited.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, expect, test } from 'vitest';
import { parseToolCall } from '../src/agent/tool-call';

test("qwen's real reply with the outer brace missing is read as the action it was", () => {
  const reply = readFileSync(join(__dirname, 'fixtures-qwen-missing-brace.txt'), 'utf8');
  expect(() => JSON.parse(reply)).toThrow(); // the fixture really is invalid JSON
  const parsed = parseToolCall(reply);
  assert.equal(parsed.kind, 'action');
  if (parsed.kind !== 'action') return;
  expect(parsed.action.skill).toBe('files.create');
  expect(String(parsed.action.args.path)).toMatch(/index\.html$/);
  expect(String(parsed.action.args.content)).toContain('<!DOCTYPE html>');
  expect(parsed.notes).toContain('missing closing brace added');
});

test('only the outermost closer is put back, wherever the closed child sits', () => {
  const a = parseToolCall('{"skill":"a.b","args":{"x":{"y":1}}');
  expect(a.kind === 'action' && a.action.skill).toBe('a.b');
  const b = parseToolCall('{"skill":"a.b","args":{"list":[1,2,3]}');
  expect(b.kind === 'action' && b.action.args).toEqual({ list: [1, 2, 3] });
  // Missing the args closer as well: that is a reply that stopped, not one that forgot a brace.
  assert.equal(parseToolCall('{"skill":"a.b","args":{"list":[1,2,3]').kind, 'invalid');
});

test('a reply cut off INSIDE a string is still reported as cut off, never completed', () => {
  const cut = parseToolCall('{"skill":"files.create","args":{"path":"D:\\\\x.html","content":"<html><body>hel');
  assert.equal(cut.kind, 'invalid');
  if (cut.kind === 'invalid') assert.equal(cut.reason, 'truncated');
  // Stops right after a comma or a colon: nothing is invented to fill the gap.
  assert.equal(parseToolCall('{"skill":"a.b","args":{"x":1,').kind, 'invalid');
  assert.equal(parseToolCall('{"skill":"a.b","args":').kind, 'invalid');
});

test('a well-formed reply, a fenced one and stray closers behave exactly as before', () => {
  const ok = parseToolCall('{"skill":"a.b","args":{"x":1}}');
  expect(ok.kind === 'action' && ok.notes).toEqual([]);
  const fenced = parseToolCall('```json\n{"skill":"a.b","args":{"x":1}}\n```');
  expect(fenced.kind === 'action' && fenced.action.skill).toBe('a.b');
  assert.equal(parseToolCall('{"skill":"a.b"}}').kind, 'action');
});
