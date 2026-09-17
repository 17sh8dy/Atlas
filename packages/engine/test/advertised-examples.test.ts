/**
 * Every example Atlas shows you has to be something you can actually say.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * A `Skill` carries `examples`, and those strings are not decoration: the
 * capability browser ("What can you do?") prints them as the way to invoke
 * that action. So an example that the grammar does not parse is not a missing
 * nicety — it is the product telling you it can do something and then not
 * understanding you when you ask for it exactly as instructed.
 *
 * That is precisely what had happened to the mouse. `input.click` advertised
 * "click at 500, 300"; nothing in the grammar matched it. The intended route
 * was the AI planner — but Atlas's whole thesis is that it works with no
 * provider connected, and with none connected those skills were unreachable
 * while still being advertised. **The AI tier may make a phrasing better
 * understood. It may never be the only thing that makes a documented one
 * work.** This test is that rule, enforced.
 *
 * ── Why it parses rather than runs ──────────────────────────────────────────
 * Running an example would mean clicking real coordinates and opening real
 * apps. What is in question is understanding, not execution — whether the
 * sentence reaches the right skill — so this stops at the plan. That the
 * skills themselves work against the real machine is `platform.rs`'s live
 * tests' job.
 */

import { test, assert } from 'vitest';
import type { Platform, Skill } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createCoreSkills } from '../src/skills/core-skills';
import { createWebSearchSkills } from '../src/skills/web-search-skills';
import { createUtilitySkills } from '../src/skills/utility-skills';
import { createTextSkills } from '../src/skills/text-skills';
import { createCalcSkills } from '../src/skills/calc-skills';
import { createNotesSkills } from '../src/skills/notes-skills';
import { createOsSkills } from '../src/skills/os-skills';
import { createNetworkSkills } from '../src/skills/network-skills';
import { createServiceSkills } from '../src/skills/service-skills';
import { createEnvironmentSkills } from '../src/skills/environment-skills';
import { createStorageSkills } from '../src/skills/storage-skills';
import { createWindowSkills } from '../src/skills/window-skills';
import { createInputSkills } from '../src/skills/input-skills';
import { createUiaSkills } from '../src/skills/uia-skills';
import { createScreenSkills } from '../src/skills/screen-skills';

/**
 * Only the declarations are read — never `run` — so a platform that can do
 * nothing at all is exactly the right one to build the catalog with.
 */
const NOTHING = new Proxy({}, { get: () => undefined }) as Platform;
const memory = { record: async () => {}, episodes: async () => [], forget: async () => {} };

function everySkill(): Skill[] {
  const working = new WorkingMemory();
  return [
    ...createCoreSkills({ platform: NOTHING, working, memory } as never),
    ...createWebSearchSkills(NOTHING),
    ...createUtilitySkills(),
    ...createTextSkills(),
    ...createCalcSkills(),
    ...createNotesSkills(),
    ...createOsSkills(NOTHING),
    ...createNetworkSkills(NOTHING),
    ...createServiceSkills(NOTHING),
    ...createEnvironmentSkills(NOTHING),
    ...createStorageSkills(NOTHING),
    ...createWindowSkills(NOTHING),
    ...createInputSkills(NOTHING),
    ...createUiaSkills(NOTHING),
    ...createScreenSkills(NOTHING),
  ];
}

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}

/**
 * Known-bad examples, each with the reason it is still here.
 *
 * This list is debt, stated out loud. It is not a place to silence a failing
 * example — it is the record of which advertised phrasings do not work yet,
 * so the number can be counted, argued about, and driven down. Adding to it
 * should feel worse than fixing the rule.
 *
 * Everything here has the same shape: the sentence refers to something the
 * grammar cannot see. "this" and "that" mean the clipboard or the last set of
 * search results, and resolving them needs a notion of conversational
 * referents the planner does not have; "a bit" needs a sense of degree. Those
 * are real features, not missing regexes, which is exactly why none of them
 * got a bodged rule today.
 *
 * Down from 24 when this file was written. The rest were real bugs and are
 * fixed: the whole `uia.*` pack, both mouse-coordinate forms, three of the
 * four environment-variable skills, window move/resize, per-window
 * screenshots, and `calculate 200 / 8 + 1`, which a lone `/` had been
 * misreading as a file path.
 */
const NOT_YET_REACHABLE = new Map<string, string>([
  ['read that article', '“that article” is the previous search’s result — needs conversational referents'],
  ['most common words in this', '“this” is the clipboard — no referent resolution yet'],
  ['format this json', '“this” is the clipboard — no referent resolution yet'],
  ['decode this jwt', '“this” is the clipboard — no referent resolution yet'],
  ['turn it down a bit', '“a bit” is a degree, not a number — system.volume takes steps'],
  ['where are my screenshots', 'question-shaped, and files.find is not question-safe for it'],
]);

/**
 * Examples that are understood, but by a different skill than the one
 * advertising them. Worse than not understanding: the person gets a confident
 * wrong action rather than an honest miss. Each line names what actually runs.
 */
const REACHES_ANOTHER_SKILL = new Map<string, string>([
  ['how much disk space do I have left', 'system.info — which does report disks, so it answers, but not via system.disk'],
  ['search the web for tide times', 'research.search — arguably the better answer; the example is on the wrong skill'],
  ['open the first result and summarize it', 'app.open — a genuine misfire: it looks for an app called “the first result”'],
  ['convert 0xff to decimal', 'math.convert — a genuine misfire: unit conversion claims a base conversion'],
  ['find large files in documents', 'files.find — searches by name instead of by size'],
]);

const NEEDS_REAL_STATE = new Set<string>();

test('every example a skill advertises is parsed by the grammar', () => {
  const g = grammar();
  const failures: string[] = [];
  let checked = 0;

  for (const skill of everySkill()) {
    for (const example of skill.examples ?? []) {
      if (NEEDS_REAL_STATE.has(example) || NOT_YET_REACHABLE.has(example)) continue;
      checked += 1;
      const plan = g.parse(example);
      if (!plan || plan.steps.length === 0) {
        failures.push(`  ${skill.id}: “${example}” is understood by nothing`);
      }
    }
  }

  assert.isAbove(checked, 100, 'the sweep has stopped finding examples');
  assert.deepEqual(
    failures,
    [],
    `these are printed to the user as ways to ask, and none of them work:\n${failures.join('\n')}`,
  );
});

/**
 * The stronger half: understood is not the same as understood *correctly*.
 * An example reaching some other skill is arguably worse than reaching none —
 * the user gets a confident wrong action instead of an honest miss.
 */
test('every advertised example reaches the skill that advertised it', () => {
  const g = grammar();
  const wrong: string[] = [];

  for (const skill of everySkill()) {
    for (const example of skill.examples ?? []) {
      if (NEEDS_REAL_STATE.has(example) || REACHES_ANOTHER_SKILL.has(example)) continue;
      const plan = g.parse(example);
      if (!plan?.steps.length) continue; // the test above owns that failure
      if (!plan.steps.some((s) => s.skill === skill.id)) {
        wrong.push(`  ${skill.id}: “${example}” → ${plan.steps.map((s) => s.skill).join(' + ')}`);
      }
    }
  }

  assert.deepEqual(wrong, [], `examples that reach the wrong action:\n${wrong.join('\n')}`);
});

/**
 * A list of known-bad examples is only useful while it is true. An entry that
 * has quietly started working is a claim that Atlas is worse than it is, and
 * the next person to read it will not go back and check.
 */
test('nothing on the known-bad lists has quietly started working', () => {
  const g = grammar();
  const stale: string[] = [];

  for (const skill of everySkill()) {
    for (const example of skill.examples ?? []) {
      const plan = g.parse(example);
      const reaches = plan?.steps.some((s) => s.skill === skill.id) ?? false;
      if (NOT_YET_REACHABLE.has(example) && plan?.steps.length) {
        stale.push(`  “${example}” now parses — remove it from NOT_YET_REACHABLE`);
      }
      if (REACHES_ANOTHER_SKILL.has(example) && reaches) {
        stale.push(`  “${example}” now reaches ${skill.id} — remove it from REACHES_ANOTHER_SKILL`);
      }
    }
  }

  assert.deepEqual(stale, [], `the debt list is out of date:\n${stale.join('\n')}`);
});

/**
 * The mouse specifically, spelled out — because this is the regression that
 * prompted the whole file, and a named test says what broke far better than a
 * sweep that merely goes green.
 */
test('the mouse can be driven with no intelligence provider connected', () => {
  const g = grammar();
  const cases: [string, string, Record<string, unknown>][] = [
    ['move the mouse to 500, 300', 'input.moveMouse', { x: 500, y: 300 }],
    ['click at 500, 300', 'input.click', { x: 500, y: 300, button: 'left', double: false }],
    ['right-click at 20, 40', 'input.click', { x: 20, y: 40, button: 'right', double: false }],
    ['double click at 8, 9', 'input.click', { x: 8, y: 9, button: 'left', double: true }],
    [
      'drag from 100, 100 to 400, 400',
      'input.drag',
      { fromX: 100, fromY: 100, toX: 400, toY: 400 },
    ],
  ];

  for (const [text, skill, args] of cases) {
    const plan = g.parse(text);
    assert.isNotNull(plan, `“${text}” was not understood`);
    assert.equal(plan!.steps[0]!.skill, skill, `“${text}” went somewhere else`);
    for (const [k, v] of Object.entries(args)) {
      assert.deepEqual(plan!.steps[0]!.args[k], v, `“${text}” got ${k} wrong`);
    }
  }
});

/** Coordinates are the argument; a sentence without them must not be guessed at. */
test('a click with no coordinates is not invented', () => {
  const g = grammar();
  for (const text of ['click', 'click the play button', 'click play']) {
    const plan = g.parse(text);
    const clicks = plan?.steps.some((s) => s.skill === 'input.click') ?? false;
    assert.isFalse(clicks, `“${text}” must not click somewhere of its own choosing`);
  }
});
