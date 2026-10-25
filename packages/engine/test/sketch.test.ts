/**
 * Sketches (docs/PLAN-2.0.5.md V7): a connected model draws as SVG code; Atlas checks, rebuilds and shows it.
 * The SVG is untrusted, so most of this file is hostile input that must come out harmless or be refused.
 */
import { describe, expect, it } from 'vitest';
import type { Platform } from '@atlas/core';
import { Engine, type EngineIO } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { SkillRegistry } from '../src/skills/registry';
import { createCoreSkills } from '../src/skills/core-skills';
import { createSketchSkills } from '../src/skills/sketch-skills';
import { createPhrasing } from '../src/phrasing';
import { extractSvg, readSketchRequest, sanitizeSvg, svgDataUrl } from '../src/general/sketch';

const GOOD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#f4f1ea"/><polygon points="100,200 200,100 300,200" fill="#b5523b"/><rect x="120" y="200" width="160" height="110" fill="#e8d5b0" stroke="#333" stroke-width="3"/><circle cx="200" cy="260" r="20" fill="#3a6ea5"/><text x="200" y="350" text-anchor="middle" font-size="20">House &amp; home</text></svg>';

describe('reading a request to draw', () => {
  const yes: Array<[string, string]> = [
    ['draw me a house', 'a house'],
    ['Sketch a logo for my bakery', 'a logo for my bakery'],
    ['can you draw a cat wearing a hat?', 'a cat wearing a hat'],
    ['doodle a rocket', 'a rocket'],
    ['make me a diagram of how login works', 'how login works'],
    ['create a simple logo for my game', 'my game'],
    ['illustrate a mountain at sunset', 'a mountain at sunset'],
  ];
  for (const [text, subject] of yes) {
    it(text, () => expect(readSketchRequest(text)?.subject).toBe(subject));
  }
  it('is not fooled by figures of speech, builds or files', () => {
    for (const t of [
      'draw a card',
      'draw conclusions from this',
      'draw the curtains',
      'create an image file in D:\\Dev',
      'make me a snake game',
      'create a folder called Pictures',
      'open the drawing app',
      'what is a drawing',
    ]) {
      expect(readSketchRequest(t), t).toBeNull();
    }
  });
  it('flags a request for a photo', () => {
    expect(readSketchRequest('draw me a photorealistic dragon')?.photo).toBe(true);
    expect(readSketchRequest('draw me a dragon')?.photo).toBe(false);
  });
});

describe('the sanitiser accepts an ordinary drawing and rebuilds it', () => {
  it('keeps shapes, colours, gradients and text', () => {
    const r = sanitizeSvg(GOOD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.svg).toContain('<polygon');
      expect(r.svg).toContain('House &amp; home');
      expect(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    }
  });
  it('finds the svg inside a fence and a sentence', () => {
    expect(extractSvg('Sure! Here you go:\n```svg\n' + GOOD + '\n```\nEnjoy.')).toBe(GOOD);
    expect(extractSvg('no drawing here')).toBeNull();
  });
  it('always has a viewBox and no fixed pixel size', () => {
    const r = sanitizeSvg('<svg width="9000" height="9000"><circle cx="5" cy="5" r="4"/></svg>');
    expect(r.ok && r.svg).toContain('viewBox="0 0 400 400"');
    expect(r.ok && r.svg).not.toContain('9000');
  });
  it('allows references inside the drawing', () => {
    const r = sanitizeSvg(
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
    );
    expect(r.ok).toBe(true);
  });
});

describe('hostile drawings are refused, never cleaned up and shown', () => {
  const hostile: Array<[string, string]> = [
    ['script element', '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>'],
    ['event handler', '<svg viewBox="0 0 10 10"><rect width="5" height="5" onclick="x()"/></svg>'],
    [
      'odd-case event handler',
      '<svg viewBox="0 0 10 10"><rect width="5" height="5" OnLoAd = "x()"/></svg>',
    ],
    [
      'onload on the root',
      '<svg viewBox="0 0 10 10" onload="x()"><rect width="5" height="5"/></svg>',
    ],
    [
      'foreignObject',
      '<svg viewBox="0 0 10 10"><foreignObject><div>hi</div></foreignObject></svg>',
    ],
    ['external image', '<svg viewBox="0 0 10 10"><image href="https://evil.example/x.png"/></svg>'],
    [
      'use with a link',
      '<svg viewBox="0 0 10 10"><use href="https://evil.example/x.svg#a"/></svg>',
    ],
    [
      'xlink href',
      '<svg viewBox="0 0 10 10"><rect xlink:href="javascript:alert(1)" width="1" height="1"/></svg>',
    ],
    [
      'javascript url in fill',
      '<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="javascript:alert(1)"/></svg>',
    ],
    [
      'spaced javascript url',
      '<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="java\nscript:alert(1)"/></svg>',
    ],
    [
      'data url',
      '<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="url(data:image/svg+xml;base64,AAAA)"/></svg>',
    ],
    [
      'external url()',
      '<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="url(https://evil.example/a#b)"/></svg>',
    ],
    [
      'style attribute',
      '<svg viewBox="0 0 10 10"><rect width="5" height="5" style="fill:url(//evil)"/></svg>',
    ],
    [
      'style element',
      '<svg viewBox="0 0 10 10"><style>@import "https://evil.example/a.css";</style></svg>',
    ],
    [
      'animate with a handler',
      '<svg viewBox="0 0 10 10"><animate attributeName="x" onbegin="x()"/></svg>',
    ],
    [
      'set element',
      '<svg viewBox="0 0 10 10"><set attributeName="href" to="javascript:alert(1)"/></svg>',
    ],
    [
      'doctype entity',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///c:/windows/win.ini">]><svg viewBox="0 0 10 10"><text>&x;</text></svg>',
    ],
    ['cdata', '<svg viewBox="0 0 10 10"><text><![CDATA[<script>x()</script>]]></text></svg>'],
    ['processing instruction', '<?xml-stylesheet href="evil.css"?><svg viewBox="0 0 10 10"/>'],
    [
      'character reference smuggling',
      '<svg viewBox="0 0 10 10"><text>&#106;avascript:</text></svg>',
    ],
    ['unknown element', '<svg viewBox="0 0 10 10"><iframe src="x"/></svg>'],
    ['unknown attribute', '<svg viewBox="0 0 10 10"><rect width="5" height="5" data-x="1"/></svg>'],
    ['two roots', '<svg viewBox="0 0 10 10"/><svg viewBox="0 0 10 10"/>'],
    ['unclosed', '<svg viewBox="0 0 10 10"><g><rect width="1" height="1"/></svg>'],
    ['mismatched', '<svg viewBox="0 0 10 10"><g><rect width="1" height="1"/></rect></svg>'],
    ['text outside text element', '<svg viewBox="0 0 10 10">hello</svg>'],
    [
      'angle bracket in attribute',
      '<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="<script>"/></svg>',
    ],
  ];
  for (const [name, svg] of hostile) {
    it(name, () => {
      const r = sanitizeSvg(svg);
      expect(r.ok, name).toBe(false);
    });
  }
  it('refuses a drawing that is too large or too busy', () => {
    expect(sanitizeSvg(`<svg viewBox="0 0 10 10">${'<circle r="1"/>'.repeat(900)}</svg>`).ok).toBe(
      false,
    );
    expect(
      sanitizeSvg(`<svg viewBox="0 0 10 10"><path d="${'M0 0 L1 1 '.repeat(20000)}"/></svg>`).ok,
    ).toBe(false);
  });
  it('never lets an accepted drawing carry anything it should not', () => {
    const r = sanitizeSvg(GOOD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.svg).not.toMatch(/script|onload|onclick|javascript:|<style|href/i);
      expect(decodeURIComponent(svgDataUrl(r.svg))).toContain('<svg');
    }
  });
});

// ---- through the engine ---------------------------------------------------------------------------------

type Reply = string | { error: string };

function rig(replies: Reply[] | null) {
  const asked: string[] = [];
  const saved: Array<{ path: string; content?: string }> = [];
  const platform = {
    knownFolder: async () => 'C:\\Users\\Test\\Pictures',
    createFolder: async () => true,
    createFile: async (path: string, content?: string) => {
      saved.push({ path, content });
      return true;
    },
  } as unknown as Platform;
  const memory = {
    fact: async () => undefined,
    facts: async () => [],
    remember: async () => {},
    record: async () => {},
    episodes: async () => [],
    forget: async () => {},
  } as never;
  const skills = new SkillRegistry({
    capabilities: () =>
      [
        'apps',
        'fs',
        'files',
        'storage',
        'network',
        'system',
        'os',
        'notifications',
        'clipboard',
        'processes',
        'window-control',
      ] as never,
  });
  skills.registerMany(createCoreSkills(platform, memory, skills, createPhrasing()) as never);
  skills.registerMany(createSketchSkills(platform));
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(new WorkingMemory()));
  grammar.addMany(createExtraGrammar());
  let n = 0;
  const provider = replies
    ? {
        active: () => ({
          id: 'ollama',
          label: 'Ollama',
          isConfigured: () => true,
          isLocal: () => true,
          ask: (
            p: string,
            h: { onDone(t: string): void; onError(r: string): void; onDelta(c: string): void },
          ) => {
            asked.push(p);
            const r = replies[Math.min(n++, replies.length - 1)]!;
            if (typeof r === 'string') h.onDone(r);
            else h.onError(r.error);
          },
        }),
      }
    : undefined;
  const engine = new Engine({ skills, grammar, intelligence: provider as never });
  const said: string[] = [];
  const sketches: Array<{ svg: string; note: string }> = [];
  const io: EngineIO = {
    say: (t, o) => {
      said.push(t);
      if (o?.sketch) sketches.push(o.sketch);
    },
    confirm: async () => true,
  };
  return { engine, io, said, sketches, asked, saved, skills };
}

describe('"draw me a house", through the engine', () => {
  it('shows a checked drawing with its note', async () => {
    const r = rig([`Here you go:\n\`\`\`svg\n${GOOD}\n\`\`\``]);
    await r.engine.ask('draw me a house', r.io);
    expect(r.sketches).toHaveLength(1);
    expect(r.sketches[0]!.note).toMatch(/depends on the model/);
    expect(r.sketches[0]!.svg).toContain('<polygon');
    expect(r.asked[0]).toMatch(/Only these elements/);
  });

  it('with no model it says so and draws nothing', async () => {
    const r = rig(null);
    await r.engine.ask('draw me a house', r.io);
    expect(r.sketches).toHaveLength(0);
    expect(r.said.join(' ')).toMatch(/needs a language model, and none is connected/);
  });

  it('will not pretend to make photos', async () => {
    const r = rig([GOOD]);
    await r.engine.ask('draw me a photorealistic dragon', r.io);
    expect(r.sketches).toHaveLength(0);
    expect(r.asked).toHaveLength(0);
    expect(r.said.join(' ')).toMatch(/can't make photo-style images/);
  });

  it('asks once more, saying what was wrong, when the first drawing is unusable', async () => {
    const r = rig(['<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>', GOOD]);
    await r.engine.ask('sketch a house', r.io);
    expect(r.asked).toHaveLength(2);
    expect(r.asked[1]).toMatch(/script/);
    expect(r.sketches).toHaveLength(1);
  });

  it('gives up honestly after two unusable answers, and shows nothing hostile', async () => {
    const r = rig(['<svg viewBox="0 0 10 10"><rect onclick="x()" width="1" height="1"/></svg>']);
    await r.engine.ask('draw a house', r.io);
    expect(r.sketches).toHaveLength(0);
    expect(r.said.join(' ')).toMatch(/did not give me a drawing I could use/);
  });

  it('says plainly when the model cannot be reached', async () => {
    const r = rig([{ error: 'offline' }]);
    await r.engine.ask('draw a house', r.io);
    expect(r.sketches).toHaveLength(0);
    expect(r.said.join(' ')).toMatch(/couldn't reach your language model/);
  });
});

describe('sketch.save', () => {
  it('writes a sanitised copy to Pictures\\Atlas Sketches', async () => {
    const r = rig(null);
    const out = await r.skills.invoke('sketch.save', { svg: GOOD, name: 'A house!' }, {
      signal: new AbortController().signal,
      say() {},
      confirm: async () => true,
      skills: r.skills,
    } as never);
    expect(out.ok).toBe(true);
    expect(r.saved[0]!.path).toMatch(
      /^C:\\Users\\Test\\Pictures\\Atlas Sketches\\a-house-\d+\.svg$/,
    );
    expect(r.saved[0]!.content).toContain('<polygon');
  });
  it('refuses to save a drawing that does not pass the check, even from a button', async () => {
    const r = rig(null);
    const out = await r.skills.invoke(
      'sketch.save',
      { svg: '<svg><script>x()</script></svg>', name: 'x' },
      {
        signal: new AbortController().signal,
        say() {},
        confirm: async () => true,
        skills: r.skills,
      } as never,
    );
    expect(out.ok).toBe(false);
    expect(r.saved).toHaveLength(0);
  });
});
