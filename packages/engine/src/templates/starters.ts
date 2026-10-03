/**
 * Plain starting points for the requests no ready-made game or tool covers: a desktop window
 * with nothing in it yet, and a one-page website. They exist so "build me an app" always ends with
 * something real on disk that opens, rather than with "I didn't catch that". They are honest
 * about being starters — the content is the person's (or a model's) to fill in.
 */

import type { TemplateFile, TemplateOptions } from './types';

const fill = (o: TemplateOptions) => (text: string) =>
  text.replace(/\{\{NAME\}\}/g, o.name).replace(/\{\{ID\}\}/g, o.id);

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

const DESKTOP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'">
  <title>{{NAME}}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>{{NAME}}</h1>
    <p>Your app is running. Edit <code>index.html</code>, <code>style.css</code> and <code>app.js</code> to make it yours.</p>
    <button id="hello" type="button">Click me</button>
    <p id="out" aria-live="polite"></p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

const DESKTOP_JS = String.raw`var clicks = 0;
document.getElementById('hello').addEventListener('click', function () {
  clicks += 1;
  document.getElementById('out').textContent = 'Clicked ' + clicks + (clicks === 1 ? ' time.' : ' times.');
});
`;

const DESKTOP_CSS = String.raw`:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0712; color: #ece6fa; font: 16px/1.5 "Segoe UI", system-ui, sans-serif; }
main { text-align: center; max-width: 36rem; padding: 2rem; }
h1 { color: #a855f7; margin-top: 0; }
code { background: #1a1030; padding: 0.1rem 0.4rem; border-radius: 4px; }
button { padding: 0.6rem 1.4rem; border: 0; border-radius: 8px; background: #7c3aed; color: #fff; font: inherit; cursor: pointer; }
button:hover { background: #8b5cf6; }
`;

const DESKTOP_MAIN = String.raw`const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    backgroundColor: '#0b0712',
    autoHideMenuBar: true,
    title: '{{NAME}}',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
`;

const DESKTOP_PACKAGE = String.raw`{
  "name": "{{ID}}",
  "version": "1.0.0",
  "description": "{{NAME}}",
  "main": "main.js",
  "private": true,
  "scripts": { "start": "electron ." },
  "devDependencies": { "electron": "^33.2.0" }
}
`;

const DESKTOP_README = `# {{NAME}}

A desktop app starter: a window, a page and a button. Double-click **Play.cmd** to open it
(run \`npm install\` once first to get the desktop window; without it the page opens in your browser).

- \`index.html\`, \`style.css\`, \`app.js\` - what you see
- \`main.js\` - the window around it
`;

export function desktopStarterFiles(o: TemplateOptions): TemplateFile[] {
  const f = fill(o);
  return [
    { path: 'index.html', content: f(DESKTOP_HTML) },
    { path: 'style.css', content: f(DESKTOP_CSS) },
    { path: 'app.js', content: f(DESKTOP_JS) },
    { path: 'main.js', content: f(DESKTOP_MAIN) },
    { path: 'package.json', content: f(DESKTOP_PACKAGE) },
    { path: 'Play.cmd', content: PLAY_CMD },
    { path: 'README.md', content: f(DESKTOP_README) },
  ];
}

const SITE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{NAME}}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="bar"><strong>{{NAME}}</strong><nav><a href="#about">About</a><a href="#contact">Contact</a></nav></header>
  <main>
    <section class="hero">
      <h1>{{NAME}}</h1>
      <p>One clear sentence about what this is and who it is for.</p>
      <a class="cta" href="#contact">Get in touch</a>
    </section>
    <section id="about">
      <h2>About</h2>
      <p>Say a little more here. Replace this text with your own.</p>
    </section>
    <section id="contact">
      <h2>Contact</h2>
      <p>Tell people how to reach you.</p>
    </section>
  </main>
  <footer>&copy; {{NAME}}</footer>
</body>
</html>
`;

const SITE_CSS = String.raw`:root { color-scheme: dark; --accent: #a855f7; }
* { box-sizing: border-box; }
body { margin: 0; background: #0b0712; color: #ece6fa; font: 17px/1.6 "Segoe UI", system-ui, sans-serif; }
.bar { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.5rem; border-bottom: 1px solid #2a1c45; }
.bar nav a { color: #c4b5fd; margin-left: 1.2rem; text-decoration: none; }
.bar nav a:hover { color: #fff; }
main { max-width: 52rem; margin: 0 auto; padding: 0 1.5rem; }
section { padding: 3rem 0; }
.hero { text-align: center; padding: 6rem 0 4rem; }
h1 { font-size: clamp(2.2rem, 6vw, 3.6rem); margin: 0 0 1rem; color: var(--accent); }
h2 { color: var(--accent); }
.cta { display: inline-block; margin-top: 1rem; padding: 0.7rem 1.6rem; border-radius: 10px; background: #7c3aed; color: #fff; text-decoration: none; }
.cta:hover { background: #8b5cf6; }
footer { text-align: center; padding: 2rem; color: #8b7fa8; border-top: 1px solid #2a1c45; }
`;

const SITE_README = `# {{NAME}}

A one-page website starter. Open \`index.html\` in a browser; edit it and refresh.
`;

export function websiteStarterFiles(o: TemplateOptions): TemplateFile[] {
  const f = fill(o);
  return [
    { path: 'index.html', content: f(SITE_HTML) },
    { path: 'style.css', content: f(SITE_CSS) },
    { path: 'README.md', content: f(SITE_README) },
  ];
}
