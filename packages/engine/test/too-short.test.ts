import { assert, test } from 'vitest';
import { Engine } from '../src/engine';

const reply = (e: unknown, t: string): string | null => (e as { tooShortReply(x: string): string | null }).tooShortReply(t);

test('a lone letter or keyboard mash gets quoted back with a question', () => {
  const e = Object.create(Engine.prototype);
  assert.equal(reply(e, 'g'), 'You just said “g” — what did you mean to type, or what do you need?');
  assert.match(reply(e, 'qwrt') ?? '', /You just said “qwrt”/);
  assert.match(reply(e, 'hjkl') ?? '', /You just said/);
});

test('real words and sentences are left alone', () => {
  const e = Object.create(Engine.prototype);
  assert.equal(reply(e, 'weather'), null);
  assert.equal(reply(e, 'what is a lagoon'), null);
  assert.equal(reply(e, 'how do you pronounce chicken'), null);
  assert.equal(reply(e, ''), null);
});

import { createCoverageGrammar } from '../src/planner/coverage-grammar';

test('pronounce and spell questions plan offline skills', () => {
  const rule = createCoverageGrammar().find((r) => r.name === 'tinyUtilities')!;
  const first = (t: string) => {
    const p = rule.test(t.toLowerCase(), t, {} as never) as { steps: Array<{ skill: string; args: { text: string } }> } | null;
    return p ? `${p.steps[0]!.skill}:${p.steps[0]!.args.text}` : null;
  };
  assert.equal(first('how do you pronounce chicken'), 'text.pronounce:chicken');
  assert.equal(first('How do you say quinoa?'), 'text.pronounce:quinoa');
  assert.equal(first('how is "choir" pronounced'), 'text.pronounce:choir');
  assert.equal(first('pronounce chicken'), 'text.pronounce:chicken');
  assert.equal(first('how do you spell necessary'), 'text.spell:necessary');
  assert.equal(first('how is necessary spelled?'), 'text.spell:necessary');
});
