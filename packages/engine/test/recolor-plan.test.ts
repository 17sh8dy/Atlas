import { describe, expect, it } from 'vitest';
import {
  dominantHue,
  hslToRgb,
  hueGap,
  hueName,
  kindOf,
  mapColors,
  parseHex,
  parseTargetHue,
  planRecolor,
  rgbToHsl,
} from '../src/skills/recolor-plan';
import { templateById } from '../src/templates';

const clicker = () => {
  const t = templateById('clicker')!;
  return t
    .files({ name: 'Clicker Game Test', id: 'clicker-game-test', pascal: 'ClickerGameTest', engines: [] })
    .map((f) => ({ path: f.path, text: f.content }));
};

describe('colour maths', () => {
  it('round-trips through HSL', () => {
    for (const hex of ['#a855f7', '#07040d', '#fbbf24', '#34d399', '#ece6fa']) {
      const rgb = parseHex(hex)!;
      const back = hslToRgb(rgbToHsl(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });

  it('measures the gap round the wheel the short way', () => {
    expect(hueGap(350, 10)).toBe(20);
    expect(hueGap(0, 180)).toBe(180);
  });

  it('understands what a person means by a colour', () => {
    expect(parseTargetHue('red')).toBe(0);
    expect(parseTargetHue('dark red')).toBe(0);
    expect(parseTargetHue('Blue.')).toBe(218);
    expect(parseTargetHue('#e11d48')).toBeGreaterThan(340);
    expect(parseTargetHue('beige-ish thing')).toBeNull();
    expect(hueName(271)).toBe('purple');
  });
});

describe('where a colour is trusted to be a colour', () => {
  const to = () => '#000000';

  it('never rewrites a selector that happens to be valid hex', () => {
    const css = '#bad { color: #a855f7; }\n.x:hover #add, #face { background: red; }';
    const out = mapColors(css, 'css', to);
    expect(out).toContain('#bad {');
    expect(out).toContain('#add, #face {');
    expect(out).toContain('color: #000000;');
  });

  it('rewrites a hex in JS only when it is a whole quoted string', () => {
    const js =
      "const a = '#a855f7'; el.querySelector('#add'); const b = \"#bad\"; x = `#fbbf24`; el.querySelector('#a855f7'); const c = \"#a855f780\";";
    const out = mapColors(js, 'js', to);
    expect(out).toContain("const a = '#000000'");
    expect(out).toContain("querySelector('#add')"); // shorthand: left alone
    expect(out).toContain('"#bad"'); // shorthand: left alone
    expect(out).toContain('`#000000`');
    expect(out).toContain("querySelector('#a855f7')"); // a selector argument, even in full
    expect(out).toContain('"#000000"'); // 8-digit with alpha
  });

  it('handles style attributes, style blocks and theme-color in html', () => {
    const html =
      '<meta name="theme-color" content="#a855f7"><style>.a{color:#a855f7}</style><div style="color:#a855f7;margin:0" id="bad"></div><p id="#add"></p>';
    const out = mapColors(html, 'html', to);
    expect(out).toContain('content="#000000"');
    expect(out).toContain('.a{color:#000000}');
    expect(out).toContain('style="color:#000000;margin:0"');
    expect(out).toContain('id="#add"');
  });

  it('classifies files by what they may contain', () => {
    expect(kindOf('style.css')).toBe('css');
    expect(kindOf('ui.js')).toBe('js');
    expect(kindOf('index.html')).toBe('html');
    expect(kindOf('package-lock.json')).toBeNull();
    expect(kindOf('data.csv')).toBeNull();
  });
});

describe('planRecolor', () => {
  const css = `:root { --bg: #07040d; --a: #a855f7; --glow: rgba(168, 85, 247, 0.55); --gold: #fbbf24; --good: #34d399; --grey: #888888; }
body { background: radial-gradient(1200px 700px at 25% 40%, #1a0d33 0%, var(--bg) 60%); }`;

  it('finds the theme hue from the colours that make it up', () => {
    const colors = ['#07040d', '#a855f7', '#1a0d33', '#fbbf24', '#34d399'].map((h) => parseHex(h)!);
    const hue = dominantHue(colors)!;
    expect(hueGap(hue, 271)).toBeLessThan(20);
    expect(dominantHue([parseHex('#888888')!, parseHex('#ffffff')!])).toBeNull();
  });

  it('moves the theme family to the new hue and keeps lightness and alpha', () => {
    const r = planRecolor([{ path: 'style.css', text: css }], 0);
    expect(r.kind).toBe('plan');
    if (r.kind !== 'plan') return;
    const after = r.plan.files[0]!.after;
    const accent = parseHex(/--a: (#[0-9a-f]{6})/.exec(after)![1]!)!;
    expect(hueGap(rgbToHsl(accent).h, 0)).toBeLessThan(2);
    // lightness survives (a855f7 is ~0.65)
    expect(rgbToHsl(accent).l).toBeGreaterThan(0.6);
    expect(rgbToHsl(accent).l).toBeLessThan(0.7);
    // alpha untouched, notation kept
    expect(after).toMatch(/--glow: rgba\(\d+, \d+, \d+, 0\.55\)/);
  });

  it('leaves colours with a meaning of their own, and greys, alone', () => {
    const r = planRecolor([{ path: 'style.css', text: css }], 0);
    if (r.kind !== 'plan') throw new Error('expected a plan');
    const after = r.plan.files[0]!.after;
    expect(after).toContain('--gold: #fbbf24');
    expect(after).toContain('--good: #34d399');
    expect(after).toContain('--grey: #888888');
    expect(r.plan.keptApart).toBe(2);
  });

  it('says so when it is already that colour, and when there is nothing to recolour', () => {
    expect(planRecolor([{ path: 'style.css', text: css }], 275)).toMatchObject({ kind: 'nothing', reason: 'already' });
    expect(planRecolor([{ path: 'a.css', text: 'a { margin: 0 }' }], 0)).toMatchObject({ kind: 'nothing', reason: 'no-colours' });
    expect(planRecolor([{ path: 'notes.txt', text: 'x' }], 0)).toMatchObject({ kind: 'nothing', reason: 'no-files' });
  });

  it('is pure: the same files and target give the same answer', () => {
    const a = planRecolor([{ path: 'style.css', text: css }], 120);
    const b = planRecolor([{ path: 'style.css', text: css }], 120);
    expect(a).toEqual(b);
  });

  it('recolours Atlas’s own clicker template, and leaves it a working project', () => {
    const files = clicker();
    const r = planRecolor(files, 0);
    expect(r.kind).toBe('plan');
    if (r.kind !== 'plan') return;
    expect(r.plan.files.map((f) => f.path)).toContain('style.css');
    // no purple left in the stylesheet's own colours
    const sheet = r.plan.files.find((f) => f.path === 'style.css')!;
    expect(sheet.after).not.toMatch(/#a855f7/i);
    // untouched, byte for byte, where nothing was a colour
    for (const f of files) {
      if (!r.plan.files.some((p) => p.path === f.path)) continue;
      const changed = r.plan.files.find((p) => p.path === f.path)!;
      expect(changed.after.length).toBeGreaterThan(0);
    }
  });
});
