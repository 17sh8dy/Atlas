/**
 * The shared frame every ready-made project sits in.
 *
 * A template written with this supplies only what is its own: the rules (`logic.js`, pure, no
 * screen, so Node can test it), the interface (`ui.js`, `body`, `css`) and the checks (`test.js`).
 * Everything else is the same in every project and written once here: the black-and-purple theme,
 * a tiny UI kit (storage that cannot throw, a toast, the stat chips), the Electron window,
 * `package.json`, `Play.cmd` and a README. That is what keeps twenty projects consistent, and what
 * lets the next one be a few hundred lines rather than a few thousand.
 *
 * ⚠️ These are `String.raw` templates holding JavaScript, CSS and HTML. No backtick and no
 * dollar-brace anywhere inside them (build strings with `+`), because either would end or
 * interpolate the TypeScript literal around it. `templates.test.ts` writes every project to disk,
 * syntax-checks each .js file and runs its own `test.js`, so a slip fails here rather than in
 * someone's folder.
 */

import type { AppTemplate, TemplateFile, TemplateGroup, TemplateOptions } from './types';

export const BASE_CSS = String.raw`:root {
  --bg: #07040d; --bg2: #0d0818; --panel: #120b20; --line: #2a1c45;
  --text: #ece6fa; --dim: #9a8cb8; --purple: #a855f7; --purple2: #7c3aed;
  --glow: rgba(168, 85, 247, 0.5); --good: #34d399; --bad: #f87171; --gold: #fbbf24;
  color-scheme: dark;
}
* { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: #3b2766 transparent; }
html, body { height: 100%; }
body {
  margin: 0; color: var(--text); font: 15px/1.5 "Segoe UI", system-ui, sans-serif;
  background: radial-gradient(1000px 600px at 50% 0%, #1a0d33 0%, var(--bg) 65%) fixed;
}
.app { min-height: 100%; display: flex; flex-direction: column; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
.top h1 { margin: 0; font-size: 18px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--purple); }
.stats { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { padding: 3px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--dim); font-size: 13px; white-space: nowrap; }
.chip b { color: var(--text); font-variant-numeric: tabular-nums; }
main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 20px; }
main.wide { align-items: stretch; justify-content: flex-start; }
.btn { padding: 8px 16px; border-radius: 9px; border: 1px solid var(--line); background: var(--bg2); color: var(--text); font: inherit; cursor: pointer; }
.btn:hover:not(:disabled) { border-color: var(--purple2); background: #1a1030; }
.btn.primary { background: linear-gradient(135deg, var(--purple2), var(--purple)); border-color: transparent; color: #fff; font-weight: 600; }
.btn.primary:hover:not(:disabled) { filter: brightness(1.1); background: linear-gradient(135deg, var(--purple2), var(--purple)); }
.btn.danger { color: #fca5a5; border-color: #7f1d1d; }
.btn.small { padding: 4px 10px; font-size: 13px; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn.on { background: var(--purple2); border-color: var(--purple); color: #fff; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: center; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
input, select, textarea { background: var(--bg2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: inherit; }
input:focus, select:focus, textarea:focus, .btn:focus-visible, button:focus-visible { outline: 2px solid var(--purple); outline-offset: 1px; }
input[type="range"] { padding: 0; accent-color: var(--purple); }
input[type="checkbox"] { accent-color: var(--purple); width: 16px; height: 16px; }
label { color: var(--dim); }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.15em; color: var(--purple); margin: 0 0 8px; }
.hint { color: var(--dim); font-size: 13px; text-align: center; }
.mono { font-family: Consolas, "Cascadia Mono", monospace; }
.good { color: var(--good); } .bad { color: var(--bad); } .dim { color: var(--dim); }
.toast { position: fixed; left: 50%; bottom: 20px; transform: translate(-50%, 20px); max-width: 80vw; padding: 10px 16px; background: #1f1238; border: 1px solid var(--purple2); border-radius: 10px; opacity: 0; pointer-events: none; transition: opacity 0.25s, transform 0.25s; z-index: 50; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.stage { position: relative; }
.overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: rgba(7, 4, 13, 0.78); border-radius: inherit; text-align: center; }
.overlay[hidden] { display: none; }
.overlay h3 { margin: 0; font-size: 26px; color: var(--purple); }
canvas { display: block; max-width: 100%; border-radius: 12px; border: 1px solid var(--line); background: #0a0613; touch-action: none; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

/** Small helpers every project's ui.js uses. `window.kit`. */
export const KIT_JS = String.raw`/* The little UI kit every page here shares. */
(function (root) {
  'use strict';
  var PREFIX = '{{ID}}.';
  var toastTimer = 0;
  var kit = {
    $: function (id) { return document.getElementById(id); },
    el: function (tag, cls, text) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    },
    // Storage that cannot throw: private windows, blocked storage and corrupt values all fall back.
    load: function (key, fallback) {
      try {
        var raw = localStorage.getItem(PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    save: function (key, value) {
      try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) { /* storage can be unavailable */ }
    },
    toast: function (text) {
      var t = kit.$('toast');
      if (!t) return;
      t.textContent = text;
      t.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
    },
    // Rebuild the chips in the header: kit.stats([['Score', 12], ['Best', 40]])
    stats: function (pairs) {
      var host = kit.$('stats');
      if (!host) return;
      while (host.children.length > pairs.length) host.removeChild(host.lastChild);
      while (host.children.length < pairs.length) {
        var chip = kit.el('span', 'chip');
        chip.appendChild(document.createTextNode(''));
        chip.appendChild(kit.el('b'));
        host.appendChild(chip);
      }
      pairs.forEach(function (p, i) {
        host.children[i].firstChild.nodeValue = p[0] + ' ';
        host.children[i].lastChild.textContent = String(p[1]);
      });
    },
    // A button row: kit.buttons(host, [['New game', fn, 'primary'], ...])
    buttons: function (host, list) {
      list.forEach(function (b) {
        var btn = kit.el('button', 'btn' + (b[2] ? ' ' + b[2] : ''), b[0]);
        btn.type = 'button';
        btn.addEventListener('click', b[1]);
        host.appendChild(btn);
      });
    },
    pad: function (n) { return n < 10 ? '0' + n : String(n); },
    today: function () { var d = new Date(); return d.getFullYear() + '-' + kit.pad(d.getMonth() + 1) + '-' + kit.pad(d.getDate()); },
    // Save text as a file the person can keep.
    download: function (name, text, type) {
      var url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    },
    // Keys are ignored while the person is typing in a field.
    typing: function (e) { var t = e.target; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
  };
  root.kit = kit;
})(window);
`;

/** A seeded random generator the generated test.js files share, so tests are repeatable. */
export const TEST_KIT = String.raw`const assert = require('assert');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }
function done() { console.log('\n' + passed + ' checks passed'); }
// mulberry32: a small seeded random generator, so every run plays out the same.
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
`;

const MAIN_JS = String.raw`// The desktop window around the app. Everything it does happens in index.html.
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: {{W}},
    height: {{H}},
    minWidth: 480,
    minHeight: 420,
    backgroundColor: '#07040d',
    autoHideMenuBar: true,
    title: '{{NAME}}',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
`;

const PACKAGE_JSON = String.raw`{
  "name": "{{ID}}",
  "version": "1.0.0",
  "description": "{{NAME}}",
  "main": "main.js",
  "private": true,
  "scripts": {
    "start": "electron .",
    "test": "node test.js"
  },
  "devDependencies": {
    "electron": "^33.2.0"
  }
}
`;

const PLAY_CMD = [
  '@echo off',
  'cd /d "%~dp0"',
  'if exist "node_modules\\electron\\dist\\electron.exe" (',
  '  start "" "node_modules\\electron\\dist\\electron.exe" .',
  ') else (',
  '  start "" "index.html"',
  ')',
  '',
].join('\r\n');

export interface WebAppSpec {
  id: string;
  label: string;
  summary: string;
  group: Extract<TemplateGroup, 'game' | 'tool'>;
  /** Words that mean this project in a request. */
  words: readonly string[];
  tip?: string;
  /** Window size. */
  size?: [number, number];
  /** Put the page's own content area full width (lists, boards) rather than centred. */
  wide?: boolean;
  /** The inside of <main>. */
  body: string;
  /** Extra CSS on top of the shared theme. */
  css: string;
  /** Pure rules. Exports itself the way the clicker's game.js does. */
  logic: string;
  /** What draws it and turns input into calls. */
  ui: string;
  /** Plain-Node checks of `logic`. Prefixed with the shared test kit. */
  test: string;
  /** What to say about the files, for the README. */
  notes?: string;
}

const fill = (text: string, o: TemplateOptions, extra: Record<string, string> = {}) => {
  let out = text.replace(/\{\{NAME\}\}/g, o.name).replace(/\{\{ID\}\}/g, o.id);
  for (const [k, v] of Object.entries(extra)) out = out.split('{{' + k + '}}').join(v);
  return out;
};

function indexHtml(spec: WebAppSpec): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:">
  <title>{{NAME}}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="app">
    <header class="top"><h1>{{NAME}}</h1><div class="stats" id="stats"></div></header>
    <main id="main"${spec.wide ? ' class="wide"' : ''}>
${spec.body}
    </main>
    <div class="toast" id="toast" role="status"></div>
  </div>
  <script src="kit.js"></script>
  <script src="logic.js"></script>
  <script src="ui.js"></script>
</body>
</html>
`;
}

function readme(spec: WebAppSpec): string {
  return `# {{NAME}}

${spec.summary.charAt(0).toUpperCase() + spec.summary.slice(1)}.

## Play

Double-click **Play.cmd**. It opens the desktop window if Electron is installed
(run \`npm install\` once to get it), and the page in your browser if it is not.

## Files

- \`logic.js\` - the rules; pure code with no screen in it
- \`ui.js\`, \`index.html\`, \`style.css\`, \`kit.js\` - what you see
- \`main.js\` - the desktop window
- \`test.js\` - run \`npm test\` to check the rules
${spec.notes ? '\n' + spec.notes + '\n' : ''}`;
}

/** Turn a spec into a template that writes a complete, runnable project. */
export function webApp(spec: WebAppSpec): AppTemplate {
  const [w, h] = spec.size ?? [980, 720];
  return {
    id: spec.id,
    label: spec.label,
    summary: spec.summary,
    group: spec.group,
    words: spec.words,
    desktop: true,
    launch: 'Play.cmd',
    tip: spec.tip ?? 'Run "npm test" in the folder to check its rules.',
    files(options: TemplateOptions): TemplateFile[] {
      return [
        { path: 'index.html', content: fill(indexHtml(spec), options) },
        { path: 'style.css', content: BASE_CSS + spec.css },
        { path: 'kit.js', content: fill(KIT_JS, options) },
        { path: 'logic.js', content: fill(spec.logic, options) },
        { path: 'ui.js', content: fill(spec.ui, options) },
        { path: 'test.js', content: fill(TEST_KIT + spec.test, options) },
        { path: 'main.js', content: fill(MAIN_JS, options, { W: String(w), H: String(h) }) },
        { path: 'package.json', content: fill(PACKAGE_JSON, options) },
        { path: 'Play.cmd', content: PLAY_CMD },
        { path: 'README.md', content: fill(readme(spec), options) },
      ];
    },
  };
}
