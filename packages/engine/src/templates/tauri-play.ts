/**
 * A Tauri 2 desktop app: a glass-box game launcher with a playable Infinite Clicker in it.
 *
 * Written for the request that kept ending in "I didn't catch that" - "create a Tauri desktop app
 * with a glass box that has a clickable game called Infinite Clicker" - and it needs no model. The
 * front end is plain HTML/CSS/JS (no bundler, no framework), so what is written is all there is.
 *
 * Generated from a working app (Nova.Play); keep it in step by regenerating rather than editing
 * the strings by hand. Binary icons cannot be written by a text template, so scripts/ensure-icons.mjs
 * makes one on the first dev/build and lets tauri icon expand it.
 */

import type { TemplateFile, TemplateOptions } from './types';

/** "night-orb" -> "night_orb"; a Rust crate name cannot start with a digit. */
function libName(id: string): string {
  const snake = id.replace(/-/g, '_').replace(/[^a-z0-9_]/g, '');
  return /^[a-z]/.test(snake) ? snake : `app_${snake}`;
}

const fill = (o: TemplateOptions) => (text: string) =>
  text
    .replace(/\{\{LIB\}\}/g, libName(o.id))
    .replace(/\{\{NAME\}\}/g, o.name)
    .replace(/\{\{ID\}\}/g, libName(o.id).replace(/_/g, '-'));
const F_UI_INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{NAME}}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="orb orb-a" aria-hidden="true"></div>
  <div class="orb orb-b" aria-hidden="true"></div>
  <div class="orb orb-c" aria-hidden="true"></div>

  <main class="stage">
    <!-- Library: the glass box with the games in it -->
    <section id="library" class="view" aria-labelledby="lib-title">
      <header class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <h1 id="lib-title">{{NAME}}</h1>
      </header>

      <div class="glass box">
        <h2 class="box-title">Games</h2>
        <ul class="games">
          <li>
            <button class="game-tile" id="open-clicker" type="button">
              <span class="tile-art" aria-hidden="true">+1</span>
              <span class="tile-text">
                <span class="tile-name">Infinite Clicker</span>
                <span class="tile-desc">Click the button. The number goes up. How far can you get?</span>
              </span>
              <span class="tile-best" id="tile-best"></span>
            </button>
          </li>
        </ul>
      </div>
    </section>

    <!-- Infinite Clicker, opened inside the app -->
    <section id="clicker" class="view" hidden aria-labelledby="game-title">
      <div class="glass game-card">
        <div class="game-top">
          <button class="back" id="back" type="button">&larr; Games</button>
          <h2 id="game-title">Infinite Clicker</h2>
          <button class="ghost" id="reset" type="button">Reset</button>
        </div>

        <output id="count" class="count" aria-live="polite">0</output>
        <p id="goal" class="goal">of 1,000,000</p>

        <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="1000000" aria-valuenow="0" id="meter">
          <span id="meter-fill"></span>
        </div>

        <button id="click-me" class="click-me" type="button">
          <span class="click-me-label">Click me!</span>
        </button>

        <p id="status" class="status" aria-live="polite"></p>
        <div id="floaters" class="floaters" aria-hidden="true"></div>
      </div>
    </section>
  </main>

  <script type="module" src="app.js"></script>
</body>
</html>
`;
const F_UI_STYLES_CSS = String.raw`:root {
  --bg: #0b0b1a;
  --ink: #f4f3ff;
  --muted: #a9a6c8;
  --accent: #8b5cf6;
  --accent-2: #22d3ee;
  --glass: rgba(255, 255, 255, 0.07);
  --glass-edge: rgba(255, 255, 255, 0.18);
  --radius: 22px;
  color-scheme: dark;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }

html, body { height: 100%; margin: 0; }
body {
  background: radial-gradient(1200px 800px at 15% 10%, #1a1240 0%, var(--bg) 60%);
  color: var(--ink);
  font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  overflow: hidden;
}

/* Soft colour behind the glass; this is what the blur has to work with. */
.orb { position: fixed; border-radius: 50%; filter: blur(70px); opacity: 0.55; pointer-events: none; }
.orb-a { width: 420px; height: 420px; background: var(--accent); top: -120px; left: -80px; }
.orb-b { width: 380px; height: 380px; background: var(--accent-2); bottom: -140px; right: -60px; opacity: 0.4; }
.orb-c { width: 260px; height: 260px; background: #ec4899; top: 40%; left: 55%; opacity: 0.25; }

.stage {
  position: relative;
  height: 100%;
  display: grid;
  place-items: center;
  padding: 32px;
}
.view { width: min(760px, 100%); }

.brand { display: flex; align-items: center; gap: 12px; margin: 0 4px 18px; }
.brand h1 { margin: 0; font-size: 1.4rem; font-weight: 650; letter-spacing: 0.01em; }
.brand-mark {
  width: 26px; height: 26px; border-radius: 8px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 0 18px rgba(139, 92, 246, 0.6);
}

.glass {
  background: var(--glass);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius);
  backdrop-filter: blur(24px) saturate(140%);
  -webkit-backdrop-filter: blur(24px) saturate(140%);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.box { padding: 22px; }
.box-title { margin: 0 0 14px; font-size: 0.85rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.games { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }

.game-tile {
  width: 100%;
  display: flex; align-items: center; gap: 16px;
  padding: 16px;
  text-align: left;
  color: inherit; font: inherit;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--glass-edge);
  border-radius: 16px;
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}
.game-tile:hover { transform: translateY(-2px); background: rgba(255, 255, 255, 0.09); border-color: rgba(139, 92, 246, 0.7); }
.game-tile:focus-visible, button:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 3px; }

.tile-art {
  flex: none; width: 64px; height: 64px; border-radius: 16px;
  display: grid; place-items: center;
  font-size: 1.4rem; font-weight: 800;
  background: linear-gradient(135deg, var(--accent), #ec4899);
  box-shadow: 0 8px 24px rgba(139, 92, 246, 0.45);
}
.tile-text { display: grid; gap: 4px; flex: 1; }
.tile-name { font-size: 1.1rem; font-weight: 650; }
.tile-desc { color: var(--muted); font-size: 0.92rem; }
.tile-best { color: var(--accent-2); font-variant-numeric: tabular-nums; font-weight: 600; }

/* Game view */
.game-card { position: relative; padding: 22px 26px 34px; text-align: center; overflow: hidden; }
.game-top { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; }
.game-top h2 { margin: 0; font-size: 1.05rem; font-weight: 650; }
.back, .ghost {
  justify-self: start;
  background: transparent; color: var(--muted); font: inherit;
  border: 1px solid var(--glass-edge); border-radius: 999px;
  padding: 6px 14px; cursor: pointer;
}
.ghost { justify-self: end; }
.back:hover, .ghost:hover { color: var(--ink); border-color: var(--ink); }

.count {
  display: block;
  margin-top: 28px;
  font-size: clamp(3.2rem, 11vw, 6rem);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  background: linear-gradient(180deg, #fff, #c4b5fd);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.count.bump { animation: bump 0.14s ease-out; }
@keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.06); } 100% { transform: scale(1); } }

.goal { margin: 8px 0 18px; color: var(--muted); }

.meter {
  width: min(420px, 80%); height: 8px; margin: 0 auto 34px;
  border-radius: 999px; background: rgba(255, 255, 255, 0.1); overflow: hidden;
}
.meter span {
  display: block; height: 100%; width: 0;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  border-radius: inherit;
  /* A 1-in-a-million step is sub-pixel; keep the bar visible once the game is started. */
  min-width: 0;
}

.click-me {
  position: relative;
  padding: 22px 64px;
  font: inherit; font-size: 1.5rem; font-weight: 750; letter-spacing: 0.02em;
  color: #fff;
  background: linear-gradient(135deg, var(--accent) 0%, #ec4899 55%, var(--accent-2) 120%);
  background-size: 160% 160%;
  border: 0; border-radius: 999px;
  cursor: pointer;
  box-shadow: 0 14px 40px rgba(139, 92, 246, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.4);
  transition: transform 0.08s ease, box-shadow 0.15s ease, background-position 0.4s ease;
  animation: pulse 2.6s ease-in-out infinite;
}
.click-me:hover { background-position: 100% 50%; box-shadow: 0 18px 54px rgba(236, 72, 153, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.5); }
.click-me:active:not(:disabled) { transform: scale(0.95); }
.click-me:disabled { cursor: default; filter: grayscale(0.6); animation: none; opacity: 0.8; }
@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.025); } }

.status { min-height: 1.4em; margin: 22px 0 0; color: var(--accent-2); }

.floaters { position: absolute; inset: 0; pointer-events: none; }
.floater {
  position: absolute; transform: translate(-50%, -50%);
  font-weight: 800; font-size: 1.3rem; color: #fff;
  text-shadow: 0 0 12px rgba(139, 92, 246, 0.9);
  animation: floatup 0.8s ease-out forwards;
}
@keyframes floatup {
  from { opacity: 1; transform: translate(-50%, -50%); }
  to   { opacity: 0; transform: translate(-50%, -140px); }
}

@media (prefers-reduced-motion: reduce) {
  .click-me, .count.bump, .floater { animation: none; }
  .floater { display: none; }
}
`;
const F_UI_APP_JS = String.raw`import { MAX, nextCount, formatCount, loadCount, saveCount } from "./game.js";

const $ = (id) => document.getElementById(id);
const library = $("library");
const clicker = $("clicker");
const countEl = $("count");
const meter = $("meter");
const meterFill = $("meter-fill");
const statusEl = $("status");
const clickBtn = $("click-me");
const floaters = $("floaters");
const tileBest = $("tile-best");

let count = loadCount(window.localStorage);
let saveTimer = 0;

function render() {
  countEl.textContent = formatCount(count);
  const pct = (count / MAX) * 100;
  meterFill.style.width = pct + "%";
  meter.setAttribute("aria-valuenow", String(count));
  tileBest.textContent = count > 0 ? formatCount(count) : "";
  const done = count >= MAX;
  clickBtn.disabled = done;
  clickBtn.querySelector(".click-me-label").textContent = done ? "Maxed out!" : "Click me!";
  statusEl.textContent = done ? "You reached 1,000,000. Reset to play again." : "";
}

// Saving on every click would hit storage up to a few hundred times a second.
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCount(window.localStorage, count), 250);
}

function floatPlusOne(x, y) {
  const el = document.createElement("span");
  el.className = "floater";
  el.textContent = "+1";
  const box = floaters.getBoundingClientRect();
  el.style.left = x - box.left + "px";
  el.style.top = y - box.top + "px";
  floaters.appendChild(el);
  el.addEventListener("animationend", () => el.remove(), { once: true });
}

clickBtn.addEventListener("click", (e) => {
  if (count >= MAX) return;
  count = nextCount(count);
  render();
  scheduleSave();
  // Keyboard clicks have no pointer position; float from the button's centre.
  const r = clickBtn.getBoundingClientRect();
  const x = e.detail === 0 ? r.left + r.width / 2 : e.clientX;
  const y = e.detail === 0 ? r.top : e.clientY;
  floatPlusOne(x, y);
  countEl.classList.remove("bump");
  void countEl.offsetWidth; // restart the animation
  countEl.classList.add("bump");
});

function show(view) {
  library.hidden = view !== "library";
  clicker.hidden = view !== "clicker";
  if (view === "clicker") clickBtn.focus();
}

$("open-clicker").addEventListener("click", () => show("clicker"));
$("back").addEventListener("click", () => show("library"));
$("reset").addEventListener("click", () => {
  count = 0;
  saveCount(window.localStorage, count);
  render();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !clicker.hidden) show("library");
});
window.addEventListener("pagehide", () => saveCount(window.localStorage, count));

render();
`;
const F_UI_GAME_JS = String.raw`// Infinite Clicker rules, kept free of the DOM so they can be tested in Node.

export const MAX = 1_000_000;
export const STORAGE_KEY = "launcher.infiniteClicker.count";

// One click adds exactly 1 and the count stops at MAX.
export function nextCount(count) {
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.min(Math.floor(count) + 1, MAX);
}

// Anything that is not a whole number in 0..MAX (a hand-edited or corrupt save) becomes 0.
export function parseSaved(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return n <= MAX ? n : MAX;
}

export function formatCount(n) {
  return n.toLocaleString("en-US");
}

export function loadCount(storage) {
  try {
    return parseSaved(storage.getItem(STORAGE_KEY));
  } catch {
    return 0;
  }
}

export function saveCount(storage, count) {
  try {
    storage.setItem(STORAGE_KEY, String(count));
  } catch {
    /* storage can be unavailable; the game still works for this session */
  }
}
`;
const F_UI_GAME_TEST_MJS = String.raw`// Run with: node ui/game.test.mjs
import assert from "node:assert/strict";
import { MAX, nextCount, parseSaved, formatCount, loadCount, saveCount } from "./game.js";

assert.equal(MAX, 1_000_000);
assert.equal(nextCount(0), 1);
assert.equal(nextCount(41), 42);
assert.equal(nextCount(MAX - 1), MAX);
assert.equal(nextCount(MAX), MAX, "never passes the cap");
assert.equal(nextCount(NaN), 0);
assert.equal(nextCount(-5), 0);

let n = 0;
for (let i = 0; i < MAX + 10; i++) n = nextCount(n);
assert.equal(n, MAX, "a million and ten clicks land exactly on the cap");

assert.equal(parseSaved("123"), 123);
assert.equal(parseSaved("-4"), 0);
assert.equal(parseSaved("abc"), 0);
assert.equal(parseSaved(null), 0);
assert.equal(parseSaved("99999999"), MAX);

assert.equal(formatCount(1000000), "1,000,000");

const mem = new Map();
const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
saveCount(storage, 7);
assert.equal(loadCount(storage), 7);
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
assert.equal(loadCount(broken), 0);
saveCount(broken, 1); // must not throw

console.log("game.test: all passed");
`;
const F_SRC_TAURI_CARGO_TOML = String.raw`[package]
name = "{{ID}}"
version = "0.1.0"
description = "{{NAME}} - a glass-box game launcher"
authors = ["Nova"]
edition = "2021"
rust-version = "1.77"

[lib]
name = "{{LIB}}_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }

[profile.release]
codegen-units = 1
lto = true
opt-level = "s"
panic = "abort"
strip = true
`;
const F_SRC_TAURI_BUILD_RS = String.raw`fn main() {
    tauri_build::build()
}
`;
const F_SRC_TAURI_SRC_MAIN_RS = String.raw`// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    {{LIB}}_lib::run()
}
`;
const F_SRC_TAURI_SRC_LIB_RS = String.raw`// The games are plain web code in ../ui; the Rust side only hosts the window.
// Nothing here is exposed to the page, so a game cannot reach the machine.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running {{NAME}}");
}
`;
const F_SRC_TAURI_TAURI_CONF_JSON = String.raw`{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "{{NAME}}",
  "version": "0.1.0",
  "identifier": "com.atlas.{{ID}}",
  "build": {
    "frontendDist": "../ui"
  },
  "app": {
    "windows": [
      {
        "title": "{{NAME}}",
        "width": 1040,
        "height": 700,
        "minWidth": 720,
        "minHeight": 520,
        "center": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.ico"]
  }
}
`;
const F_SRC_TAURI_CAPABILITIES_DEFAULT_JSON = String.raw`{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Window basics only; games get no native access.",
  "windows": ["main"],
  "permissions": ["core:default"]
}
`;
const F_SCRIPTS_MAKE_ICON_MJS = String.raw`// Writes app-icon.png (1024x1024 purple-to-cyan rounded square) with no dependencies,
// for tauri icon to expand into the platform icon set.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 1024;
const R = 220;
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  const row = y * (S * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < S; x++) {
    const t = (x + y) / (2 * S);
    // Distance outside the rounded rectangle, for an anti-aliased edge.
    const cx = Math.min(Math.max(x, R), S - 1 - R);
    const cy = Math.min(Math.max(y, R), S - 1 - R);
    const d = Math.hypot(x - cx, y - cy) - R;
    const a = Math.max(0, Math.min(1, 0.5 - d));
    const i = row + 1 + x * 4;
    raw[i] = Math.round(139 + (34 - 139) * t);
    raw[i + 1] = Math.round(92 + (211 - 92) * t);
    raw[i + 2] = Math.round(246 + (238 - 246) * t);
    raw[i + 3] = Math.round(255 * a);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync("app-icon.png", png);
console.log("wrote app-icon.png", png.length, "bytes");
`;
const PACKAGE_JSON = String.raw`{
  "name": "{{ID}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "{{NAME}} - a glass-box game launcher with Infinite Clicker",
  "scripts": {
    "predev": "node scripts/ensure-icons.mjs",
    "dev": "tauri dev",
    "prebuild": "node scripts/ensure-icons.mjs",
    "build": "tauri build",
    "test": "node ui/game.test.mjs"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.1.0"
  }
}
`;
const ENSURE_ICONS = String.raw`// Tauri needs real icon files to compile. A text template cannot write a PNG, so the first
// dev/build makes one (scripts/make-icon.mjs) and lets tauri icon expand it. Does nothing once
// src-tauri/icons/icon.ico exists, so you can replace the icon with your own at any time.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync("src-tauri/icons/icon.ico")) {
  const run = (cmd) => {
    const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  run("node scripts/make-icon.mjs");
  run("npx tauri icon app-icon.png");
}
`;
const GITIGNORE = String.raw`node_modules/
src-tauri/target/
src-tauri/gen/
app-icon.png
`;
const PLAY_CMD = String.raw`@echo off
cd /d "%~dp0"
if exist "src-tauri\target\release\{{ID}}.exe" (
  start "" "src-tauri\target\release\{{ID}}.exe"
) else (
  if not exist node_modules call npm install
  call npm run dev
)
`;

export function tauriPlayFiles(o: TemplateOptions): TemplateFile[] {
  const f = fill(o);
  return [
    { path: 'package.json', content: f(PACKAGE_JSON) },
    { path: '.gitignore', content: GITIGNORE },
    { path: 'Play.cmd', content: f(PLAY_CMD).replace(/\r?\n/g, '\r\n') },
    { path: 'scripts/ensure-icons.mjs', content: ENSURE_ICONS },
    { path: 'ui/index.html', content: f(F_UI_INDEX_HTML) },
    { path: 'ui/styles.css', content: f(F_UI_STYLES_CSS) },
    { path: 'ui/app.js', content: f(F_UI_APP_JS) },
    { path: 'ui/game.js', content: f(F_UI_GAME_JS) },
    { path: 'ui/game.test.mjs', content: f(F_UI_GAME_TEST_MJS) },
    { path: 'src-tauri/Cargo.toml', content: f(F_SRC_TAURI_CARGO_TOML) },
    { path: 'src-tauri/build.rs', content: f(F_SRC_TAURI_BUILD_RS) },
    { path: 'src-tauri/src/main.rs', content: f(F_SRC_TAURI_SRC_MAIN_RS) },
    { path: 'src-tauri/src/lib.rs', content: f(F_SRC_TAURI_SRC_LIB_RS) },
    { path: 'src-tauri/tauri.conf.json', content: f(F_SRC_TAURI_TAURI_CONF_JSON) },
    { path: 'src-tauri/capabilities/default.json', content: f(F_SRC_TAURI_CAPABILITIES_DEFAULT_JSON) },
    { path: 'scripts/make-icon.mjs', content: f(F_SCRIPTS_MAKE_ICON_MJS) },
  ];
}
