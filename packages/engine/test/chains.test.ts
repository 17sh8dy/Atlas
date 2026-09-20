/**
 * Sentences that chain several actions: "open Chrome, go to YouTube and search
 * for cats". Each clause must still earn its step by matching a real rule on
 * its own — chaining never invents an action, it only stops at two.
 */
import { describe, expect, test } from 'vitest';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}

const skills = (text: string) =>
  grammar()
    .parse(text)
    ?.steps.map((s) => s.skill);

describe('chains of more than two', () => {
  test('three clauses split into three steps', () => {
    expect(skills('open notepad, open calculator and open paint')).toEqual([
      'app.open',
      'app.open',
      'app.open',
    ]);
  });

  test('then / after that / and then all connect', () => {
    for (const t of [
      'open steam and then open discord',
      'open steam then open discord',
      'open steam, then open discord',
      'open steam after that open discord',
    ]) {
      expect(skills(t), t).toEqual(['app.open', 'app.open']);
    }
  });

  test('a name with "and" in it is still one name', () => {
    expect(skills('search for salt and pepper')).toEqual(['web.search']);
  });
});

describe('open a browser, then go somewhere', () => {
  test('"go to a website" names an action and leaves the site to be asked', () => {
    const plan = grammar().parse('open chrome and go to a website');
    expect(plan?.steps.map((s) => s.skill)).toEqual(['web.open']);
    expect(plan?.steps[0]?.args).toMatchObject({ browser: 'chrome' });
    expect(plan?.steps[0]?.args?.url).toBeUndefined();
  });

  test('a named site opens in the browser that was named', () => {
    const plan = grammar().parse('open brave and go to youtube.com');
    const web = plan?.steps.find((s) => s.skill === 'web.open');
    expect(web?.args).toMatchObject({ browser: 'brave' });
  });

  test('two clauses that do not both stand alone are not chained', () => {
    expect(skills('open steam and blorp the wibble')).not.toContain('blorp');
  });
});
