/**
 * Engine tests — run against a scripted Platform, so they exercise the real
 * registry, grammar, executor and kernel without touching the machine.
 */

import { test, assert, vi } from 'vitest';

import type {
  CapabilityName,
  EpisodicEvent,
  ExecutionMode,
  Fact,
  IntelligenceProvider,
  IntelligenceRegistry,
  Memory,
  Platform,
  ResultRow,
  Skill,
  SkillArgs,
  SkillContext,
  WebPage,
  WebSearchResult,
} from '@atlas/core';
import { Engine } from '../src/engine';
import { readAffirmation } from '../src/text/affirmation';
import { readSmallTalk } from '../src/text/smalltalk';
import { exactSiteName } from '../src/text/sites';
import { Grammar } from '../src/planner/grammar';
import { SkillRegistry } from '../src/skills/registry';
import { createCoreSkills } from '../src/skills/core-skills';
import { createWebSearchSkills } from '../src/skills/web-search-skills';
import { createUtilitySkills } from '../src/skills/utility-skills';
import { createTextSkills } from '../src/skills/text-skills';
import { createCalcSkills } from '../src/skills/calc-skills';
import { createNotesSkills } from '../src/skills/notes-skills';
import { createOsSkills } from '../src/skills/os-skills';
import { createNetworkSkills } from '../src/skills/network-skills';
import { createServiceSkills, resolveService } from '../src/skills/service-skills';
import { createEnvironmentSkills } from '../src/skills/environment-skills';
import { createStorageSkills } from '../src/skills/storage-skills';
import { createWindowSkills } from '../src/skills/window-skills';
import { createInputSkills } from '../src/skills/input-skills';
import { createUiaSkills } from '../src/skills/uia-skills';
import { createScreenSkills } from '../src/skills/screen-skills';
import { resolveWindow } from '../src/text/windows';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { createPhrasing, JOKES } from '../src/phrasing';
import { WorkingMemory } from '../src/working-memory';
import { recordEpisodes } from '../src/episodic';
import { SimpleIntelligenceRegistry } from '../src/intelligence-registry';
import { rankMatches, confidentMatch, editDistance } from '../src/text/fuzzy';
import { correctLeadingVerb } from '../src/text/verb-typo';
import { stripFiller, splitBrowserHint } from '../src/text/normalize';
import { resolveSite } from '../src/text/sites';

// ---- a machine we can script ------------------------------------------------

interface Journal {
  opened: string[];
  revealed: string[];
  launched: string[];
  urls: string[];
  urlsWithApp: Array<{ appId: string; url: string }>;
  hidden: number;
  created: string[];
  foldersCreated: string[];
  renamed: Array<{ path: string; newName: string }>;
  moved: Array<{ path: string; destDir: string }>;
  copied: Array<{ path: string; destDir: string }>;
  deleted: string[];
  systemTools: string[];
  clipboard: string;
  notifications: Array<{ title: string; body?: string }>;
  appended: Array<{ path: string; content: string }>;
  os: string[];
  services: Array<{ name: string; action: string }>;
  environmentSets: Array<{ name: string; value: string; scope: string }>;
  environmentDeletes: Array<{ name: string; scope: string }>;
  windowActions: Array<{ id: string; action: string }>;
  windowBounds: Array<{ id: string; bounds: Record<string, number> }>;
  endedProcesses: number[];
  mouseMoves: Array<{ x: number; y: number }>;
  clicks: Array<{ x: number; y: number; button: string; double: boolean }>;
  scrolls: number[];
  drags: Array<{ fromX: number; fromY: number; toX: number; toY: number; button: string }>;
  keysPressed: string[];
  hotkeys: Array<{ modifiers: string[]; key: string }>;
  typed: string[];
  uiaInvokes: Array<{ id: string; path: number[] }>;
  uiaExpands: Array<{ id: string; path: number[]; expand: boolean }>;
  uiaSetValues: Array<{ id: string; path: number[]; value: string }>;
  uiaFocuses: Array<{ id: string; path: number[] }>;
  screenCaptures: number;
  windowCaptures: string[];
}

/** Just enough of a PNG for `pngDimensions` to read a width/height back out of. */
function fakePng(width: number, height: number): ArrayBuffer {
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  return buf;
}

interface WebIndex {
  results: Record<string, WebSearchResult[]>;
  pages: Record<string, WebPage>;
  failSearch: boolean;
  failFetch: boolean;
  searchedQueries: string[];
  fetchedUrls: string[];
}

function makeWebIndex(): WebIndex {
  return {
    results: {},
    pages: {},
    failSearch: false,
    failFetch: false,
    searchedQueries: [],
    fetchedUrls: [],
  };
}

/** The machine's services, as both the listing and the detail view see them. */
const SERVICES = [
  {
    name: 'Appinfo',
    display: 'Application Information',
    state: 'RUNNING',
    running: true,
    protected: false,
  },
  { name: 'Spooler', display: 'Print Spooler', state: 'STOPPED', running: false, protected: false },
  {
    name: 'RpcSs',
    display: 'Remote Procedure Call (RPC)',
    state: 'RUNNING',
    running: true,
    protected: true,
  },
  {
    name: 'wuauserv',
    display: 'Windows Update',
    state: 'STOPPED',
    running: false,
    protected: false,
  },
  {
    name: 'WaaSMedicSvc',
    display: 'Windows Update Medic Service',
    state: 'STOPPED',
    running: false,
    protected: false,
  },
];

/**
 * A handful of environment variables, chosen for the case resolution has to
 * get right: `PATH` exists in both scopes with different values, and nothing
 * else does.
 */
const ENV_VARS = [
  { name: 'PATH', value: 'C:\\Users\\test\\bin', scope: 'user' as const },
  { name: 'PATH', value: 'C:\\Windows\\System32', scope: 'system' as const },
  { name: 'JAVA_HOME', value: 'C:\\Java\\jdk-21', scope: 'user' as const },
];

/** The Notepad window's UI Automation tree: a text field, then a button. */
const NOTEPAD_TREE = {
  path: [] as number[],
  role: 'window',
  name: 'Untitled - Notepad',
  automationId: '',
  enabled: true,
  x: 100,
  y: 100,
  width: 800,
  height: 600,
  children: [
    {
      path: [0],
      role: 'edit',
      name: 'Search',
      automationId: 'SearchBox',
      enabled: true,
      x: 110,
      y: 110,
      width: 200,
      height: 24,
      children: [],
    },
    {
      path: [1],
      role: 'button',
      name: 'Find Next',
      automationId: 'FindNextButton',
      enabled: true,
      x: 320,
      y: 110,
      width: 80,
      height: 24,
      children: [],
    },
  ],
};

/** A small desktop: two ordinary windows and one Atlas would filter as a utility window. */
const WINDOWS = [
  {
    id: '1001',
    title: 'Untitled - Notepad',
    className: 'Notepad',
    processName: 'notepad.exe',
    pid: 4001,
    x: 100,
    y: 100,
    width: 800,
    height: 600,
    minimized: false,
    maximized: false,
    active: true,
  },
  {
    id: '1002',
    title: 'general - Discord',
    className: 'Chrome_WidgetWin_1',
    processName: 'discord.exe',
    pid: 4002,
    x: 200,
    y: 150,
    width: 1000,
    height: 700,
    minimized: false,
    maximized: false,
    active: false,
  },
];

function makePlatform(capabilities: CapabilityName[], journal: Journal, web: WebIndex): Platform {
  return {
    id: 'test',
    capabilities: async () => capabilities,
    searchWeb: async (query) => {
      web.searchedQueries.push(query);
      if (web.failSearch) throw new Error('Search failed.');
      return web.results[query] ?? [];
    },
    fetchPage: async (url) => {
      web.fetchedUrls.push(url);
      if (web.failFetch) throw new Error('Fetch failed.');
      const page = web.pages[url];
      if (!page) throw new Error('Page not found.');
      return page;
    },
    // A tiny fake index, matched the same way `search_files` (`platform.rs`)
    // matches a real one: a case-insensitive substring against the whole file
    // name, nothing cleverer. `Japan_Vacation_2024.jpg` exists specifically so
    // a query like "japan vacation" — two real words, joined by an underscore
    // rather than the space the query has — fails this exact check and has to
    // fall through to `files.find`'s word-by-word strategy to be found at all.
    searchFiles: async (query, opts) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      const all = [
        { path: 'D:\\Docs\\tax-2025.pdf', name: 'tax-2025.pdf', ext: 'pdf', isDirectory: false },
        {
          path: 'D:\\Photos\\Japan_Vacation_2024.jpg',
          name: 'Japan_Vacation_2024.jpg',
          ext: 'jpg',
          isDirectory: false,
        },
      ];
      return all.filter((f) => f.name.toLowerCase().includes(needle)).slice(0, opts?.limit ?? 40);
    },
    openPath: async (p) => {
      journal.opened.push(p);
      return true;
    },
    revealPath: async (p) => {
      journal.revealed.push(p);
      return true;
    },
    openUrl: async (u) => {
      journal.urls.push(u);
      return true;
    },
    openUrlWithApp: async (appId, url) => {
      journal.urlsWithApp.push({ appId, url });
      return true;
    },
    listApps: async () => [
      { id: 'steam', name: 'Steam', target: 'steam.exe' },
      { id: 'code', name: 'Visual Studio Code', target: 'code.exe' },
      { id: 'code-insiders', name: 'Visual Studio Code Insiders', target: 'code-insiders.exe' },
      { id: 'discord', name: 'Discord', target: 'discord.exe' },
      { id: 'firefox', name: 'Firefox', target: 'firefox.exe' },
      { id: 'brave', name: 'Brave', target: 'brave.exe' },
      { id: 'steelseriesgg', name: 'SteelSeries GG', target: 'steelseries.lnk' },
      { id: 'crosshairx', name: 'CrosshairX', target: 'crosshairx.exe' },
      { id: 'notepad++', name: 'Notepad++', target: 'notepad++.exe' },
      { id: 'fortnite', name: 'Fortnite', target: 'FortniteClient.exe' },
      // Its name begins with the verb, which is the whole point: peeling a
      // stuttered "open" must never reach an app actually called Open Cut.
      // Not last in this list on purpose — a test below asserts what "the last
      // one" resolves to.
      { id: 'opencut', name: 'Open Cut', target: 'OpenCut.exe' },
      { id: 'obs', name: 'OBS Studio', target: 'obs64.exe' },
      // The exact shape of Brandon's bug: a PWA shortcut whose name begins
      // with the word someone means as a website.
      { id: 'gdocs', name: 'Google Docs', target: 'chrome_proxy.exe' },
      // A conjunction inside a real program's name — the case that makes
      // splitting on "and" before matching the whole string unsafe.
      { id: 'candc', name: 'Command and Conquer', target: 'cnc.exe' },
      { id: 'epic-games-launcher', name: 'Epic Games Launcher', target: 'EpicGamesLauncher.exe' },
    ],
    launchApp: async (id) => {
      journal.launched.push(id);
      return true;
    },
    systemInfo: async () => ({
      battery: { percent: 72, charging: false },
      cpuPercent: 12,
      memoryUsedBytes: 8 * 1024 ** 3,
      memoryTotalBytes: 32 * 1024 ** 3,
      disks: [{ mount: 'C:', usedBytes: 400 * 1024 ** 3, totalBytes: 1024 * 1024 ** 3 }],
      uptimeSeconds: 3600,
    }),
    writeClipboard: async (text) => {
      journal.clipboard = text;
      return true;
    },
    readClipboard: async () => journal.clipboard,
    notify: async (title, body) => {
      journal.notifications.push({ title, body });
      return true;
    },
    runningProcesses: async (limit) =>
      [
        { pid: 4242, name: 'chrome.exe', cpuPercent: 4, memoryBytes: 900 * 1024 ** 2 },
        { pid: 17, name: 'atlas-desktop.exe', cpuPercent: 1, memoryBytes: 120 * 1024 ** 2 },
        { pid: 99, name: 'explorer.exe', cpuPercent: 0, memoryBytes: 60 * 1024 ** 2 },
      ].slice(0, limit ?? 12),
    hideWindow: async () => {
      journal.hidden += 1;
    },
    createFile: async (path) => {
      journal.created.push(path);
      return true;
    },
    createFolder: async (path) => {
      journal.foldersCreated.push(path);
      return true;
    },
    renamePath: async (path, newName) => {
      journal.renamed.push({ path, newName });
      return true;
    },
    movePath: async (path, destDir) => {
      journal.moved.push({ path, destDir });
      return true;
    },
    copyPath: async (path, destDir) => {
      journal.copied.push({ path, destDir });
      return true;
    },
    deletePath: async (path) => {
      journal.deleted.push(path);
      return true;
    },
    readTextFile: async (path) => `contents of ${path}`,
    openSystemTool: async (id) => {
      journal.systemTools.push(id);
      return true;
    },

    // A wired desktop with no wireless hardware — the shape of the machine
    // this was built on, and the one most likely to be got wrong.
    //
    // ⚠️ The address is invented, and has to stay that way. `net.rs` says it
    // of its own fixtures — "committing someone's actual hardware address to a
    // repository is not worth a fixture" — and this file quietly did the
    // opposite: it carried the real Ethernet MAC of the machine it was written
    // on. Nothing here needs a true one; the parsing is what is under test.
    networkAdapters: async () => [
      {
        name: 'Ethernet',
        kind: 'Ethernet',
        connected: true,
        ipv4: '192.168.77.101',
        gateway: '192.168.77.1',
        mac: 'AA-BB-CC-DD-EE-FF',
      },
      { name: 'Loopback', kind: 'Adapter', connected: true, ipv4: '127.0.0.1' },
    ],
    wifiStatus: async () => ({ available: false, connected: false }),
    wifiNetworks: async () => [],
    networkReachable: async () => true,

    // A handful of real services, chosen for the cases resolution gets wrong:
    // two that share a prefix ("Windows Update" / "Windows Update Medic"), one
    // whose short name is nothing like its display name (Spooler), and one
    // that must never be stopped (RpcSs).
    listServices: async () => SERVICES.map((s) => ({ ...s })),
    // Derived from the same list rather than written out again, so the detail
    // view cannot drift into disagreeing with the listing about what is
    // running — which is a bug a hand-written fixture hides rather than shows.
    serviceDetail: async (name) => {
      const found = SERVICES.find((s) => s.name === name);
      if (!found) throw new Error(`no such service: ${name}`);
      return { ...found, startType: 'automatic' };
    },
    serviceControl: async (name, action) => {
      journal.services.push({ name, action });
      const found = SERVICES.find((s) => s.name === name);
      return {
        name,
        display: found?.display ?? name,
        state: action === 'stop' ? 'STOPPED' : 'RUNNING',
        running: action !== 'stop',
      };
    },

    listWindows: async () => WINDOWS.map((w) => ({ ...w })),
    activeWindow: async () => {
      const active = WINDOWS.find((w) => w.active);
      return active ? { ...active } : null;
    },
    focusWindow: async (id) => {
      journal.windowActions.push({ id, action: 'focus' });
      return WINDOWS.some((w) => w.id === id);
    },
    minimizeWindow: async (id) => {
      journal.windowActions.push({ id, action: 'minimize' });
      return WINDOWS.some((w) => w.id === id);
    },
    maximizeWindow: async (id) => {
      journal.windowActions.push({ id, action: 'maximize' });
      return WINDOWS.some((w) => w.id === id);
    },
    restoreWindow: async (id) => {
      journal.windowActions.push({ id, action: 'restore' });
      return WINDOWS.some((w) => w.id === id);
    },
    setWindowBounds: async (id, bounds) => {
      journal.windowBounds.push({ id, bounds: bounds as Record<string, number> });
      return WINDOWS.some((w) => w.id === id);
    },
    closeWindow: async (id) => {
      journal.windowActions.push({ id, action: 'close' });
      return WINDOWS.some((w) => w.id === id);
    },
    endProcess: async (pid) => {
      journal.endedProcesses.push(pid);
      return [4242, 17, 99].includes(pid);
    },

    moveMouse: async (x, y) => {
      journal.mouseMoves.push({ x, y });
      return true;
    },
    cursorPosition: async () => ({ x: 42, y: 84 }),
    mouseClick: async (x, y, button, double) => {
      journal.clicks.push({ x, y, button, double: double ?? false });
      return true;
    },
    mouseScroll: async (amount) => {
      journal.scrolls.push(amount);
      return true;
    },
    mouseDrag: async (fromX, fromY, toX, toY, button) => {
      journal.drags.push({ fromX, fromY, toX, toY, button: button ?? 'left' });
      return true;
    },
    pressKey: async (key) => {
      journal.keysPressed.push(key);
      return true;
    },
    hotkey: async (modifiers, key) => {
      journal.hotkeys.push({ modifiers, key });
      return true;
    },
    typeText: async (text) => {
      journal.typed.push(text);
      return true;
    },

    uiaTree: async (windowId) =>
      windowId === '1001' ? NOTEPAD_TREE : { ...NOTEPAD_TREE, children: [] },
    uiaFocusedElement: async () => ({
      path: [],
      role: 'edit',
      name: 'Focused Field',
      automationId: '',
      enabled: true,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      children: [],
    }),
    uiaInvoke: async (windowId, path) => {
      journal.uiaInvokes.push({ id: windowId, path });
      return windowId === '1001';
    },
    uiaSetExpanded: async (windowId, path, expand) => {
      journal.uiaExpands.push({ id: windowId, path, expand });
      return windowId === '1001';
    },
    uiaSetValue: async (windowId, path, value) => {
      journal.uiaSetValues.push({ id: windowId, path, value });
      // Only the text field at path [0] accepts a direct value — the shape
      // that forces `uia.typeInto` to fall back for anything else.
      return windowId === '1001' && path.length === 1 && path[0] === 0;
    },
    uiaFocus: async (windowId, path) => {
      journal.uiaFocuses.push({ id: windowId, path });
      return windowId === '1001';
    },

    captureScreen: async () => {
      journal.screenCaptures += 1;
      return fakePng(1920, 1080);
    },
    captureWindow: async (id) => {
      journal.windowCaptures.push(id);
      return fakePng(800, 600);
    },
    listDisplays: async () => [
      {
        name: '\\\\.\\DISPLAY1',
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        workX: 0,
        workY: 0,
        workWidth: 1920,
        workHeight: 1040,
        primary: true,
        dpi: 96,
      },
    ],

    pathInfo: async (path) => ({
      path,
      name: path.split(/[\\/]/).pop() ?? path,
      ext: path.includes('.') ? path.split('.').pop()!.toLowerCase() : '',
      isDirectory: !path.includes('.'),
      sizeBytes: path.includes('.') ? 2048 : 0,
      modifiedAt: 1_700_000_000_000,
      entryCount: path.includes('.') ? undefined : 3,
    }),
    appendFile: async (path, content) => {
      journal.appended.push({ path, content });
      return true;
    },
    listDir: async (path, limit) =>
      [
        { path: `${path}\\src`, name: 'src', ext: '', isDirectory: true },
        {
          path: `${path}\\readme.md`,
          name: 'readme.md',
          ext: 'md',
          isDirectory: false,
          sizeBytes: 1024,
        },
      ].slice(0, limit ?? 100),
    knownFolder: async (id) => {
      if (id === 'music') throw new Error("You don't seem to have a Music folder.");
      return `C:\\Users\\test\\${id}`;
    },

    lockWorkstation: async () => {
      journal.os.push('lock');
      return true;
    },
    powerAction: async (action) => {
      journal.os.push(`power:${action}`);
      return true;
    },
    mediaKey: async (key) => {
      journal.os.push(`media:${key}`);
      return true;
    },
    setVolume: async (direction, steps) => {
      journal.os.push(`volume:${direction}:${steps ?? 5}`);
      return true;
    },
    toggleMute: async () => {
      journal.os.push('mute');
      return true;
    },
    displayOff: async () => {
      journal.os.push('display-off');
      return true;
    },
    emptyRecycleBin: async () => {
      journal.os.push('recycle-bin');
      return true;
    },

    listEnvironmentVariables: async () => ENV_VARS.map((v) => ({ ...v })),
    setEnvironmentVariable: async (name, value, scope) => {
      journal.environmentSets.push({ name, value, scope });
      return true;
    },
    deleteEnvironmentVariable: async (name, scope) => {
      journal.environmentDeletes.push({ name, scope });
      return true;
    },

    // A folder that's mostly one very large file — the shape that makes
    // "largest files" and "folder size" actually different questions.
    // "C:\huge" scripts the one folder too big to fully walk, so the
    // truncated-count message has something real to assert against.
    folderSize: async (path) => ({
      path,
      totalBytes: 5_368_709_120, // 5 GiB
      fileCount: 3,
      folderCount: 1,
      truncated: path === 'C:\\huge',
    }),
    largestFiles: async (path, limit) => ({
      files: [
        { path: `${path}\\video.mp4`, name: 'video.mp4', sizeBytes: 5_000_000_000 },
        { path: `${path}\\notes.txt`, name: 'notes.txt', sizeBytes: 2_048 },
      ].slice(0, limit ?? 10),
      truncated: false,
    }),
  };
}

/** A scripted Memory, backed by plain arrays so tests can inspect them directly. */
function makeMemory(): Memory {
  const facts: Fact[] = [];
  const episodes: EpisodicEvent[] = [];
  return {
    async facts(kind) {
      return kind ? facts.filter((f) => f.kind === kind) : [...facts];
    },
    async fact(kind, subject) {
      return facts.find((f) => f.kind === kind && f.subject === subject);
    },
    async remember(kind, subject, value) {
      const i = facts.findIndex((f) => f.kind === kind && f.subject === subject);
      if (i >= 0) facts.splice(i, 1);
      facts.push({ kind, subject, value, at: Date.now() });
    },
    async forget(kind, subject) {
      const i = facts.findIndex((f) => f.kind === kind && f.subject === subject);
      if (i >= 0) facts.splice(i, 1);
    },
    async episodes() {
      return [...episodes];
    },
    async record(type, label, data) {
      episodes.push({ type, label, at: Date.now(), data });
    },
    async forgetEpisode(at) {
      const i = episodes.findIndex((e) => e.at === at);
      if (i >= 0) episodes.splice(i, 1);
    },
    async clearEpisodes() {
      episodes.length = 0;
    },
  };
}

/** A scripted provider: records every prompt it's asked and replies on cue. */
function makeProvider(
  opts: {
    id?: string;
    reply?: string | ((prompt: string) => string);
    configured?: boolean;
    error?: string;
  } = {},
): IntelligenceProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: opts.id ?? 'test-provider',
    label: 'Test Provider',
    isConfigured: () => opts.configured ?? true,
    isLocal: () => true,
    prompts,
    ask(prompt, handlers) {
      prompts.push(prompt);
      if (opts.error) {
        handlers.onError(opts.error);
        return;
      }
      handlers.onDone(typeof opts.reply === 'function' ? opts.reply(prompt) : (opts.reply ?? 'ok'));
    },
  };
}

function makeIntelligence(provider: IntelligenceProvider | null): IntelligenceRegistry {
  return {
    register: () => {},
    get: () => provider,
    list: () => (provider ? [provider] : []),
    active: () => provider,
    setActive: () => {},
  };
}

interface Harness {
  engine: Engine;
  said: string[];
  spokenAloud: string[];
  rows: ResultRow[];
  journal: Journal;
  memory: Memory;
  web: WebIndex;
  confirmAnswer: boolean;
  confirmsAsked: string[];
  confirmDetails: Array<string | undefined>;
}

function harness(
  capabilities: CapabilityName[] = [
    'files',
    'fs',
    'apps',
    'system',
    'processes',
    'clipboard',
    'notifications',
    'os',
    'windows',
    'window-control',
    'input',
    'ui-automation',
    'screen',
    'network',
    'services',
    'environment',
    'storage',
  ],
  options: {
    provider?: IntelligenceProvider | null;
    mode?: ExecutionMode;
    isPreapproved?: (skill: Skill, args: SkillArgs) => Promise<boolean>;
  } = {},
): Harness {
  const journal: Journal = {
    opened: [],
    revealed: [],
    launched: [],
    urls: [],
    urlsWithApp: [],
    hidden: 0,
    created: [],
    foldersCreated: [],
    renamed: [],
    moved: [],
    copied: [],
    deleted: [],
    systemTools: [],
    clipboard: '',
    notifications: [],
    appended: [],
    os: [],
    services: [],
    environmentSets: [],
    environmentDeletes: [],
    windowActions: [],
    windowBounds: [],
    endedProcesses: [],
    mouseMoves: [],
    clicks: [],
    scrolls: [],
    drags: [],
    keysPressed: [],
    hotkeys: [],
    typed: [],
    uiaInvokes: [],
    uiaExpands: [],
    uiaSetValues: [],
    uiaFocuses: [],
    screenCaptures: 0,
    windowCaptures: [],
  };
  const web = makeWebIndex();
  const platform = makePlatform(capabilities, journal, web);
  const memory = makeMemory();
  const working = new WorkingMemory();

  const skills = new SkillRegistry({ capabilities: () => capabilities });
  skills.registerMany(createCoreSkills(platform, memory, skills));
  skills.registerMany(createWebSearchSkills(platform));
  skills.registerMany(createUtilitySkills());
  skills.registerMany(createTextSkills());
  skills.registerMany(createCalcSkills());
  skills.registerMany(createNotesSkills(memory));
  skills.registerMany(createOsSkills(platform));
  skills.registerMany(createNetworkSkills(platform));
  skills.registerMany(createServiceSkills(platform));
  skills.registerMany(createEnvironmentSkills(platform));
  skills.registerMany(createStorageSkills(platform));
  skills.registerMany(createWindowSkills(platform));
  skills.registerMany(createInputSkills(platform));
  skills.registerMany(createUiaSkills(platform));
  skills.registerMany(createScreenSkills(platform));

  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  grammar.addMany(createExtraGrammar());

  const intelligence =
    'provider' in options ? makeIntelligence(options.provider ?? null) : undefined;
  const engine = new Engine({
    skills,
    grammar,
    working,
    intelligence,
    getExecutionMode: () => options.mode ?? 'doIt',
    isPreapproved: options.isPreapproved,
  });
  recordEpisodes(engine.bus, memory, engine.skills);

  const h: Harness = {
    engine,
    web,
    said: [],
    spokenAloud: [],
    rows: [],
    journal,
    memory,
    confirmAnswer: true,
    confirmsAsked: [],
    confirmDetails: [],
  };
  return h;
}

function io(h: Harness) {
  return {
    say: (t: string, options?: { aloud?: boolean }) => {
      h.said.push(t);
      // Recorded separately so tests can assert what a *voice* would have
      // read, which is not the same as what appeared on screen.
      if (options?.aloud !== false) h.spokenAloud.push(t);
    },
    confirm: async (q: string, detail?: string) => {
      h.confirmsAsked.push(q);
      h.confirmDetails.push(detail);
      return h.confirmAnswer;
    },
    showResults: (items: ResultRow[]) => h.rows.push(...items),
  };
}

// ---- phrasing -----------------------------------------------------------------

test('phrasing: default output matches the original literals exactly', () => {
  const p = createPhrasing();
  assert.equal(p.opening('Steam'), 'Opening Steam.');
  assert.equal(p.revealing('a.txt'), 'Showing a.txt in its folder.');
  assert.equal(p.copied(), '📋 Copied.');
  assert.equal(p.declined(), 'Okay — left alone.');
  assert.equal(p.failed('nope'), '⚠️ nope');
  assert.equal(
    p.rightThen(['open steam', 'show the report']),
    'Right — open steam, then show the report.',
  );
});

test('phrasing: greeting reflects a personalization profile', () => {
  const p = createPhrasing({ userName: 'Sam', atlasName: 'Nova' });
  const g = p.greeting();
  assert.match(g, /Sam/);
  assert.match(g, /Nova/);
});

test('phrasing: a custom greeting overrides the generated one', () => {
  const p = createPhrasing({ greeting: 'Yo.' });
  assert.equal(p.greeting(), 'Yo.');
});

// ---- grammar ----------------------------------------------------------------

test('grammar: recognises an app launch', () => {
  const h = harness();
  const p = h.engine.grammar.parse('open steam');
  assert.equal(p?.steps[0].skill, 'app.open');
  assert.equal(p?.steps[0].args.name, 'steam');
});

test('grammar: a file path is not an app launch', () => {
  const h = harness();
  const p = h.engine.grammar.parse('open C:\\Users\\me\\tax-notes.txt');
  assert.equal(p?.steps[0].skill, 'files.open');
  assert.equal(p?.steps[0].args.path, 'C:\\Users\\me\\tax-notes.txt');
});

test('grammar: file searches beat app launches', () => {
  const h = harness();
  const p = h.engine.grammar.parse('find my tax pdf');
  assert.equal(p?.steps[0].skill, 'files.find');
  assert.equal(p?.steps[0].args.kind, 'document');
  assert.equal(p?.steps[0].args.query, 'tax');
});

test('grammar: referential targets are declined', () => {
  const h = harness();
  assert.equal(h.engine.grammar.parse('open it'), null);
  assert.equal(h.engine.grammar.parse('open that'), null);
});

test('grammar: questions do not become commands', () => {
  const h = harness();
  assert.equal(h.engine.grammar.parse('what is the capital of Peru?'), null);
  assert.equal(h.engine.grammar.parse('who invented the telescope'), null);
});

test('grammar: a question-safe rule may still answer', () => {
  const h = harness();
  const p = h.engine.grammar.parse('how much memory am I using?');
  assert.equal(p?.steps[0].skill, 'system.info');
});

test('a bare domain with no app of that name still opens as a url', async () => {
  const h = harness();
  // The grammar no longer claims a bare "name.tld" — only the layer that can
  // see the installed apps knows whether it is one. The end result is the same.
  await h.engine.ask('open github.com', io(h));
  assert.include(h.journal.urls, 'https://github.com');
  assert.lengthOf(h.journal.launched, 0);
});

test('a url with a scheme, a path or a www still goes straight to the browser', () => {
  const h = harness();
  for (const text of [
    'open https://example.com',
    'open www.example.com',
    'open example.com/docs',
  ]) {
    const p = h.engine.grammar.parse(text);
    assert.equal(p?.steps[0]!.skill, 'web.open', `"${text}" should be a link`);
  }
});

test('an installed app beats a domain-shaped name', async () => {
  const h = harness();
  await h.engine.ask('open steelseries.gg', io(h));
  assert.deepEqual(h.journal.launched, ['steelseriesgg']);
  assert.lengthOf(h.journal.urls, 0);
});

test('app names survive typos, spacing and punctuation', async () => {
  const h = harness();
  const launch = async (text: string) => {
    const fresh = harness();
    await fresh.engine.ask(text, io(fresh));
    return fresh.journal.launched;
  };

  assert.deepEqual(await launch('open steelseires.gg'), ['steelseriesgg'], 'transposed letters');
  assert.deepEqual(await launch('open crosshair x'), ['crosshairx'], 'spacing');
  assert.deepEqual(await launch('open CROSSHAIRX'), ['crosshairx'], 'case');
  assert.deepEqual(await launch('open steel series gg'), ['steelseriesgg'], 'split words');
  void h;
});

test('one small typo just launches the app', async () => {
  const h = harness();
  await h.engine.ask('open crosshairz', io(h));
  assert.deepEqual(h.journal.launched, ['crosshairx']);
});

test('a name too far off offers the nearest apps instead of a dead end', async () => {
  const h = harness();
  const result = await h.engine.skills.invoke('app.open', { name: 'crosshairzzz' }, io(h));
  assert.isTrue(result.ok);
  assert.isAbove(h.rows.length, 0);
  assert.equal(h.rows[0]!.title, 'CrosshairX');
  assert.lengthOf(h.journal.launched, 0, 'a guess is offered, never launched');
});

test('a name matching nothing at all says so plainly', async () => {
  const h = harness();
  const result = await h.engine.skills.invoke('app.open', { name: 'zzzzqqqwx' }, io(h));
  assert.isFalse(result.ok);
  assert.include(result.error!, 'zzzzqqqwx');
});

test('grammar: a bare arithmetic expression is claimed', () => {
  const h = harness();
  const p = h.engine.grammar.parse("what's 12 * 7");
  assert.equal(p?.steps[0].skill, 'math.calculate');
  assert.equal(p?.steps[0].args.expression, '12 * 7');
});

test('grammar: unit conversion claims both phrasings', () => {
  const h = harness();
  const p1 = h.engine.grammar.parse('convert 10 miles to km');
  assert.equal(p1?.steps[0].skill, 'math.convert');
  assert.equal(p1?.steps[0].args.value, 10);
  assert.equal(p1?.steps[0].args.from, 'miles');
  assert.equal(p1?.steps[0].args.to, 'km');

  const p2 = h.engine.grammar.parse('how many km in 10 miles');
  assert.equal(p2?.steps[0].skill, 'math.convert');
  assert.equal(p2?.steps[0].args.to, 'km');
  assert.equal(p2?.steps[0].args.from, 'miles');
});

test("grammar: unit conversion doesn't shadow a system memory question", () => {
  const h = harness();
  const p = h.engine.grammar.parse('how much memory am I using?');
  assert.equal(p?.steps[0].skill, 'system.info');
});

test('grammar: time and date are question-safe', () => {
  const h = harness();
  assert.equal(h.engine.grammar.parse('what time is it')?.steps[0].skill, 'time.now');
  assert.equal(h.engine.grammar.parse("what's the date")?.steps[0].skill, 'time.now');
});

test('grammar: a system tool resolves before a generic app-open guess', () => {
  const h = harness();
  const p = h.engine.grammar.parse('open task manager');
  assert.equal(p?.steps[0].skill, 'system.openTool');
  assert.equal(p?.steps[0].args.tool, 'task-manager');
});

test('grammar: file and folder creation resolve with the literal path', () => {
  const h = harness();
  const p1 = h.engine.grammar.parse('create a file called D:\\Dev\\notes.txt');
  assert.equal(p1?.steps[0].skill, 'files.create');
  assert.equal(p1?.steps[0].args.path, 'D:\\Dev\\notes.txt');

  const p2 = h.engine.grammar.parse('make a new folder at D:\\Dev\\Projects');
  assert.equal(p2?.steps[0].skill, 'files.createFolder');
  assert.equal(p2?.steps[0].args.path, 'D:\\Dev\\Projects');
});

test('grammar: rename, move, copy, delete, and read-text all resolve', () => {
  const h = harness();
  assert.equal(
    h.engine.grammar.parse('rename D:\\Dev\\a.txt to b.txt')?.steps[0].skill,
    'files.rename',
  );
  assert.equal(
    h.engine.grammar.parse('move D:\\Dev\\a.txt to D:\\Archive')?.steps[0].skill,
    'files.move',
  );
  assert.equal(
    h.engine.grammar.parse('copy D:\\Dev\\a.txt to D:\\Backup')?.steps[0].skill,
    'files.copy',
  );
  assert.equal(h.engine.grammar.parse('delete D:\\Dev\\old.txt')?.steps[0].skill, 'files.delete');
  assert.equal(
    h.engine.grammar.parse('read D:\\Dev\\readme.txt')?.steps[0].skill,
    'files.readText',
  );
});

test('grammar: a quoted copy goes to the clipboard, a path copy goes to files', () => {
  const h = harness();
  const clip = h.engine.grammar.parse('copy "hello world"');
  assert.equal(clip?.steps[0].skill, 'clipboard.copy');

  const file = h.engine.grammar.parse('copy D:\\Dev\\a.txt to D:\\Backup');
  assert.equal(file?.steps[0].skill, 'files.copy');
});

test('grammar: teaching an alias is recognised even though the value is a path', () => {
  const h = harness();
  const p = h.engine.grammar.parse('remember my work folder is D:\\Dev');
  assert.equal(p?.steps[0].skill, 'memory.remember');
  assert.equal(p?.steps[0].args.subject, 'work folder');
  assert.equal(p?.steps[0].args.value, 'D:\\Dev');
});

test('grammar: opening a file-noun target with no known alias still parses to files.openAlias', () => {
  const h = harness();
  const p = h.engine.grammar.parse('open my work folder');
  assert.equal(p?.steps[0].skill, 'files.openAlias');
  assert.equal(p?.steps[0].args.subject, 'work folder');
});

test('working memory: "the second one" resolves against the last shown list', async () => {
  const h = harness();
  await h.engine.ask('list my apps', io(h));
  await h.engine.ask('open the second one', io(h));
  assert.deepEqual(h.journal.launched, ['code']);
});

test('working memory: "the last one" resolves to the end of the list', async () => {
  const h = harness();
  await h.engine.ask('list my apps', io(h));
  await h.engine.ask('open the last one', io(h));
  assert.deepEqual(h.journal.launched, ['epic-games-launcher']);
});

test('working memory: bare "it" resolves an unambiguous single result', async () => {
  const h = harness();
  await h.engine.ask('find my tax pdf', io(h));
  await h.engine.ask('open it', io(h));
  assert.deepEqual(h.journal.opened, ['D:\\Docs\\tax-2025.pdf']);
});

test('episodic: a successful command is recorded, keyed by skill id', async () => {
  const h = harness();
  await h.engine.ask('open steam', io(h));
  const events = await h.memory.episodes();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'app.open');
  assert.equal(events[0].label, 'Opening Steam.');
});

test('episodic: a failed step is not recorded', async () => {
  const h = harness();
  await h.engine.ask('open nonexistent-app-xyz', io(h));
  assert.deepEqual(await h.memory.episodes(), []);
});

test('episodic: a skill with no message falls back to its label', async () => {
  const h = harness();
  await h.engine.ask('find my tax pdf', io(h));
  const events = await h.memory.episodes();
  assert.equal(events[0]?.label, 'Find files');
});

test('episodic: a readout skill (aloud: false) is recorded by its label, not its raw message', async () => {
  const h = harness();
  await h.engine.ask('system status', io(h));
  const events = await h.memory.episodes();
  assert.equal(events[0]?.type, 'system.info');
  assert.equal(events[0]?.label, 'System status');
  // The metrics themselves stay in the transcript, not duplicated into a
  // history line meant to read as "what Atlas did".
  assert.notInclude(events[0]?.label ?? '', 'CPU');
});

// Collapsing repeats into a count is `MemoryStore`'s job, covered by
// packages/data's tests — here we only need each successful command to
// reach `record()` once.
test('episodic: two separate commands are both recorded', async () => {
  const h = harness();
  await h.engine.ask('open steam', io(h));
  await h.engine.ask('open discord', io(h));
  const events = await h.memory.episodes();
  assert.equal(events.length, 2);
});

test('grammar: with nothing shown yet, referential targets are still declined', () => {
  const h = harness();
  assert.equal(h.engine.grammar.parse('open the second one'), null);
});

test('grammar: web and YouTube search resolve, but a file search still wins first', () => {
  const h = harness();
  const web = h.engine.grammar.parse('search for cute puppies');
  assert.equal(web?.steps[0].skill, 'web.search');

  const yt = h.engine.grammar.parse('search youtube for lofi beats');
  assert.equal(yt?.steps[0].skill, 'web.searchYoutube');

  const file = h.engine.grammar.parse('search for my tax pdf');
  assert.equal(file?.steps[0].skill, 'files.find');
});

test('triage: questions are not actionable', () => {
  const h = harness();
  assert.equal(h.engine.grammar.looksActionable('what is a black hole?'), false);
  assert.equal(h.engine.grammar.looksActionable('open the report'), true);
});

// ---- registry ---------------------------------------------------------------

test('registry: unknown skills are refused', () => {
  const h = harness();
  const r = h.engine.skills.validate('does.notExist', {});
  assert.equal(r.ok, false);
});

test('registry: missing required args are refused', () => {
  const h = harness();
  const r = h.engine.skills.validate('app.open', {});
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /needs/);
});

test('registry: args are coerced against the declared type', () => {
  const h = harness();
  const r = h.engine.skills.validate('files.find', { query: 'tax', limit: '5' });
  assert.equal(r.ok, true);
  assert.equal((r as { args: Record<string, unknown> }).args.limit, 5);
});

test('registry: undeclared args are dropped, not passed through', () => {
  const h = harness();
  const r = h.engine.skills.validate('app.open', { name: 'steam', sneaky: 'rm -rf' });
  assert.equal(r.ok, true);
  assert.equal((r as { args: Record<string, unknown> }).args.sneaky, undefined);
});

test('registry: skills needing an absent capability are hidden', () => {
  const withApps = harness(['apps']);
  const without = harness(['files']);
  assert.ok(withApps.engine.skills.available().some((s) => s.id === 'app.open'));
  assert.ok(!without.engine.skills.available().some((s) => s.id === 'app.open'));
});

test('registry: the AI catalog only lists available skills', () => {
  const h = harness(['files']);
  const catalog = h.engine.skills.catalog();
  assert.ok(catalog.includes('files.find'));
  assert.ok(!catalog.includes('app.open'));
});

test('registry: skills with no capability requirement are always available', () => {
  const h = harness([]);
  assert.ok(h.engine.skills.available().some((s) => s.id === 'math.calculate'));
  assert.ok(h.engine.skills.available().some((s) => s.id === 'math.convert'));
  assert.ok(h.engine.skills.available().some((s) => s.id === 'time.now'));
});

test('registry: files.delete is always risk:confirm', () => {
  const h = harness();
  assert.equal(h.engine.skills.get('files.delete')?.risk, 'confirm');
});

test('registry: system tools are hidden without the system capability', () => {
  const withSystem = harness(['system']);
  const without = harness(['files']);
  assert.ok(withSystem.engine.skills.available().some((s) => s.id === 'system.openTool'));
  assert.ok(!without.engine.skills.available().some((s) => s.id === 'system.openTool'));
});

// ---- executor ----------------------------------------------------------------

test('executor: a safe skill runs without asking', async () => {
  const h = harness();
  await h.engine.ask('how much memory am I using?', io(h));
  assert.equal(h.confirmsAsked.length, 0);
  assert.match(h.said.join(' '), /CPU 12%/);
});

test('executor: a risky skill asks first', async () => {
  const h = harness();
  await h.engine.ask('delete D:\\Dev\\old.txt', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.deleted, ['D:\\Dev\\old.txt']);
});

test('executor: declining means nothing happens', async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('delete D:\\Dev\\old.txt', io(h));
  assert.deepEqual(h.journal.deleted, []);
  assert.match(h.said.join(' '), /left alone/i);
});

/**
 * The policy, pinned.
 *
 * Opening something you just named is not a decision worth taking twice, and
 * behind a voice it is not one extra click but a trip back to the keyboard.
 * This is the test that fails if "reaches outside Atlas" ever creeps back in
 * as the definition of risky.
 */
test('executor: opening what you just named runs without asking', async () => {
  const h = harness();
  await h.engine.ask('open steam', io(h));
  assert.equal(h.confirmsAsked.length, 0);
  assert.deepEqual(h.journal.launched, ['steam']);
});

test('executor: a declined step aborts the rest of the plan', async () => {
  const h = harness();
  h.confirmAnswer = false;
  const outcome = await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'files.delete', args: { path: 'D:\\Dev\\old.txt' } },
        { skill: 'files.open', args: { path: 'D:\\a.txt' } },
      ],
    },
    io(h),
  );
  assert.equal(outcome.aborted, true);
  assert.equal(h.journal.deleted.length, 0);
  assert.equal(h.journal.opened.length, 0);
});

test('executor: a failing step stops the ones after it', async () => {
  const h = harness();
  const outcome = await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'web.open', args: { url: 'ftp://nope' } },
        { skill: 'app.open', args: { name: 'steam' } },
      ],
    },
    io(h),
  );
  assert.equal(outcome.aborted, true);
  assert.deepEqual(h.journal.launched, []);
});

test('executor: a multi-step plan announces itself first', async () => {
  const h = harness();
  await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'system.info', args: {} },
        { skill: 'app.list', args: {} },
      ],
    },
    io(h),
  );
  assert.match(h.said[0], /^Right — .*, then /);
});

test('executor: files.delete requires confirmation, same as any other risky skill', async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('delete D:\\Dev\\old.txt', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.deleted, []);
});

// ---- isPreapproved: the "already permitted" exception to `doIt` -------------
//
// See the executor's own doc comment for why this exists at all — a plain
// file operation inside a folder the user already added to Allowed Folders,
// and only in `doIt`. Every assertion below is about the mode gate, not about
// what counts as "already permitted" — that policy lives entirely in
// whatever `isPreapproved` the caller supplies, which is `useAtlas`'s job,
// not the executor's.

test('isPreapproved: doIt runs a confirm-risk step with no card when preapproved', async () => {
  const h = harness(undefined, { isPreapproved: async () => true });
  await h.engine.ask('delete D:\\Dev\\old.txt', io(h));
  assert.equal(h.confirmsAsked.length, 0);
  assert.deepEqual(h.journal.deleted, ['D:\\Dev\\old.txt']);
});

test('isPreapproved: doIt still asks when it returns false', async () => {
  const h = harness(undefined, { isPreapproved: async () => false });
  await h.engine.ask('delete D:\\Dev\\old.txt', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.deleted, ['D:\\Dev\\old.txt']);
});

test('isPreapproved: never consulted for a safe step', async () => {
  const calls: string[] = [];
  const h = harness(undefined, {
    isPreapproved: async (skill: Skill) => {
      calls.push(skill.id);
      return true;
    },
  });
  await h.engine.ask("what's my battery", io(h));
  assert.deepEqual(calls, []);
});

test('isPreapproved: confirmActions asks anyway — picking it means "ask me regardless"', async () => {
  const h = harness(undefined, { mode: 'confirmActions', isPreapproved: async () => true });
  await h.engine.ask('delete D:\\Dev\\old.txt', io(h));
  assert.equal(h.confirmsAsked.length, 1);
});

test('isPreapproved: planFirst still shows its one whole-plan card, not zero', async () => {
  const h = harness(undefined, { mode: 'planFirst', isPreapproved: async () => true });
  await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [{ skill: 'files.delete', args: { path: 'D:\\Dev\\old.txt' } }],
    },
    io(h),
  );
  assert.equal(h.confirmsAsked.length, 1);
});

// ---- execution mode -----------------------------------------------------------
//
// `ExecutionMode` decides *when* a confirm step's question is put to the
// user, never *whether* — see the executor's own doc comment. `doIt` and
// `confirmActions` are the identical per-step loop and are covered together;
// `planFirst` is the one that actually changes behaviour.

test('mode: confirmActions asks per step, exactly like doIt', async () => {
  const h = harness(undefined, { mode: 'confirmActions' });
  await h.engine.ask('delete D:\\Dev\\old.txt', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.deleted, ['D:\\Dev\\old.txt']);
});

test('mode: planFirst never shows a plan card for an all-safe plan', async () => {
  const h = harness(undefined, { mode: 'planFirst' });
  await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'system.info', args: {} },
        { skill: 'app.list', args: {} },
      ],
    },
    io(h),
  );
  assert.equal(h.confirmsAsked.length, 0);
  // Falls through to the ordinary multi-step announcement instead.
  assert.match(h.said[0]!, /^Right — .*, then /);
});

test('mode: planFirst asks once for a plan containing a consequential step, not once per step', async () => {
  const h = harness(undefined, { mode: 'planFirst' });
  const outcome = await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'system.info', args: {} },
        { skill: 'files.delete', args: { path: 'D:\\Dev\\old.txt' } },
      ],
    },
    io(h),
  );
  // One approval for the whole plan — not one for the plan and a second for
  // the delete step, which is the batching this mode exists to provide.
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.deleted, ['D:\\Dev\\old.txt']);
  assert.isTrue(outcome.ok);
});

test("mode: planFirst's single approval names every step, marking the consequential ones", async () => {
  const h = harness(undefined, { mode: 'planFirst' });
  await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'system.info', args: {} },
        { skill: 'files.delete', args: { path: 'D:\\Dev\\old.txt' } },
      ],
    },
    io(h),
  );
  const [detail] = h.confirmDetails;
  assert.match(detail!, /1\. System status/);
  assert.match(detail!, /2\. ⚠ Delete/);
});

test("mode: declining planFirst's approval cancels the whole plan, nothing runs", async () => {
  const h = harness(undefined, { mode: 'planFirst' });
  h.confirmAnswer = false;
  const outcome = await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'system.info', args: {} },
        { skill: 'files.delete', args: { path: 'D:\\Dev\\old.txt' } },
      ],
    },
    io(h),
  );
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.deleted, []);
  assert.equal(outcome.ran, 0);
  assert.isTrue(outcome.aborted);
  assert.match(h.said.join(' '), /left alone/i);
});

test('mode: planFirst marks a step consequential via riskFor, not just static risk', async () => {
  const h = harness(undefined, { mode: 'planFirst' });
  const outcome = await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'input.hotkey', args: { combo: 'ctrl+c' } },
        { skill: 'input.hotkey', args: { combo: 'alt+f4' } },
      ],
    },
    io(h),
  );
  // One approval for the whole plan, asked at all only because the second
  // step's `riskFor` — its static `risk` is `safe`, same as the first step —
  // makes it consequential.
  assert.equal(h.confirmsAsked.length, 1);
  const [detail] = h.confirmDetails;
  assert.match(detail!, /1\. Press a key combination/);
  assert.match(detail!, /2\. ⚠ Press a key combination/);
  assert.isTrue(outcome.ok);
  assert.deepEqual(h.journal.hotkeys, [
    { modifiers: ['ctrl'], key: 'c' },
    { modifiers: ['alt'], key: 'f4' },
  ]);
});

test('mode: planFirst shows no card at all for a plan of ordinary input steps', async () => {
  const h = harness(undefined, { mode: 'planFirst' });
  await h.engine.run(
    {
      source: 'direct',
      intent: 'test',
      confidence: 1,
      steps: [
        { skill: 'input.hotkey', args: { combo: 'ctrl+c' } },
        { skill: 'input.pressKey', args: { key: 'enter' } },
      ],
    },
    io(h),
  );
  assert.deepEqual(h.confirmsAsked, []);
});

test('mode: planFirst still refuses a NEVER_STOP call outright, without ever drawing a plan card', async () => {
  // The refusal tier sits below every execution mode — see `Skill.guard`.
  // A plan containing a call that must not happen at all should never reach
  // Plan First's approval card in the first place.
  const h = harness(undefined, { mode: 'planFirst' });
  h.confirmAnswer = true;
  await h.engine.ask('stop the rpcss service', io(h));
  assert.deepEqual(h.journal.services, []);
  assert.deepEqual(h.confirmsAsked, [], 'a plan card was drawn in front of a refusal');
});

test('engine.help: "what can you do?" is answered, not treated as a question with no provider', async () => {
  const h = harness();
  await h.engine.ask('what can you do?', io(h));
  assert.equal(h.rows.length, h.engine.skills.available().length);
  assert.equal(h.said.length, 0); // spoken:true — the row list is the answer, not a repeated sentence
});

test('engine.help: the list can never drift from the registry, because it reads it live', async () => {
  const h = harness();
  const before = h.engine.skills.available().length;
  h.engine.skills.register({
    id: 'test.extra',
    label: 'A skill added after construction',
    domain: 'test',
    description: 'Only exists to prove help reads the registry live.',
    risk: 'safe',
    run: () => ({ ok: true }),
  });
  await h.engine.ask('help', io(h));
  assert.equal(h.rows.length, before + 1);
  assert.isTrue(h.rows.some((r) => r.title === 'A skill added after construction'));
});

// ---- web search ---------------------------------------------------------------

const FORTNITE_RESULTS: WebSearchResult[] = [
  {
    title: 'Fortnite Chapter 6 Season 1 patch notes',
    url: 'https://www.epicgames.com/fortnite/patch-notes',
    snippet: 'The latest update adds a new map region and weapons.',
  },
  {
    title: 'Fortnite update — everything new',
    url: 'https://example.com/fortnite-news',
    snippet: 'A rundown of the newest Fortnite changes.',
  },
];

test('grammar: "search the internet for X" runs a real search, not a browser shortcut', async () => {
  const h = harness();
  h.web.results['the latest Fortnite update'] = FORTNITE_RESULTS;
  await h.engine.ask('search the internet for the latest Fortnite update', io(h));
  assert.deepEqual(h.web.searchedQueries, ['the latest Fortnite update']);
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[0]?.title, FORTNITE_RESULTS[0]?.title);
  assert.deepEqual(h.journal.urls, []); // unlike web.search, nothing opens a browser tab
});

test('grammar: "research X" is the same deterministic path', async () => {
  const h = harness();
  h.web.results['best budget laptops'] = FORTNITE_RESULTS;
  await h.engine.ask('research best budget laptops', io(h));
  assert.deepEqual(h.web.searchedQueries, ['best budget laptops']);
  assert.equal(h.rows.length, 2);
});

test('research.search renders no results honestly rather than an empty list', async () => {
  const h = harness();
  await h.engine.ask('search the internet for xyzzy plugh nonsense', io(h));
  assert.equal(h.rows.length, 0);
  assert.match(h.said.join(' '), /No web results/);
});

test('research.search fails gracefully when the network is unreachable', async () => {
  const h = harness();
  h.web.failSearch = true;
  const outcome = await h.engine.ask('search the internet for anything', io(h));
  assert.equal(outcome.ok, false);
  // The manager hides which backend broke: the user hears a calm, generic
  // sentence, not a provider's raw error.
  assert.match(h.said.join(' '), /couldn.t get a web search to answer/);
});

test('research.open extracts a page and rejects non-http(s) links', async () => {
  const h = harness();
  h.web.pages['https://example.com/article'] = {
    title: 'An Article',
    url: 'https://example.com/article',
    text: 'The article body.',
  };
  const good = await h.engine.skills.invoke(
    'research.open',
    { url: 'https://example.com/article' },
    {
      say: () => {},
      confirm: async () => true,
    },
  );
  assert.equal(good.ok, true);
  assert.match(String(good.message), /The article body\./);

  const bad = await h.engine.skills.invoke(
    'research.open',
    { url: 'file:///etc/passwd' },
    {
      say: () => {},
      confirm: async () => true,
    },
  );
  assert.equal(bad.ok, false);
});

test('research.open fails gracefully rather than crashing when a page is unreachable', async () => {
  const h = harness();
  const outcome = await h.engine.skills.invoke(
    'research.open',
    { url: 'https://example.com/missing' },
    {
      say: () => {},
      confirm: async () => true,
    },
  );
  assert.equal(outcome.ok, false);
  assert.isString(outcome.error);
});

test('conversation: a freshness question with no provider still searches and shows sources', async () => {
  const h = harness(undefined, { provider: null });
  h.web.results['what happened in the latest Fortnite update?'] = FORTNITE_RESULTS;
  await h.engine.ask('what happened in the latest Fortnite update?', io(h));
  // The rewritten query goes first; when it finds nothing, the person's own
  // words are tried before giving up.
  assert.equal(h.web.searchedQueries.length, 2);
  assert.match(h.web.searchedQueries[0] ?? '', /fortnite update/i);
  assert.equal(h.web.searchedQueries[1], 'what happened in the latest Fortnite update?');
  assert.equal(h.rows.length, 2);
  assert.match(h.said.join(' '), /Found 2 results/);
  // No model to use them, so no pages were fetched.
  assert.deepEqual(h.web.fetchedUrls, []);
});

test('conversation: a freshness question with a provider augments the prompt and appends sources', async () => {
  const provider = makeProvider({ reply: 'Fortnite added a new map region. [1]' });
  const h = harness(undefined, { provider });
  h.web.results['what happened in the latest Fortnite update?'] = FORTNITE_RESULTS;

  await h.engine.ask('what happened in the latest Fortnite update?', io(h));

  // The provider was asked with the search results folded in, not the bare question.
  assert.equal(provider.prompts.length, 1);
  assert.match(provider.prompts[0] ?? '', /WEB EVIDENCE/);
  assert.match(provider.prompts[0] ?? '', /epicgames\.com/);
  assert.match(provider.prompts[0] ?? '', /untrusted text from the internet/);

  // Raw result rows are NOT also dumped — the synthesized answer is the answer.
  assert.equal(h.rows.length, 0);

  // The model's own answer plus a deterministic sources footer both reach the user.
  const said = h.said.join('\n');
  assert.match(said, /Fortnite added a new map region/);
  assert.match(said, /Sources \(/);
  assert.match(said, /epicgames\.com/);
});

test('conversation: an ordinary question is never searched or sent through augmentation', async () => {
  const provider = makeProvider({ reply: 'Lima is the capital of Peru.' });
  const h = harness(undefined, { provider });
  await h.engine.ask('what is the capital of Peru?', io(h));
  assert.deepEqual(h.web.searchedQueries, []);
  assert.equal(provider.prompts[0], 'what is the capital of Peru?');
});

test('conversation: a failed search falls through to the plain provider reply instead of a dead end', async () => {
  const provider = makeProvider({ reply: 'I don’t have current info, but generally...' });
  const h = harness(undefined, { provider });
  h.web.failSearch = true;
  await h.engine.ask('what is the latest Fortnite news?', io(h));
  assert.equal(provider.prompts.length, 1);
  assert.equal(provider.prompts[0], 'what is the latest Fortnite news?'); // not augmented — nothing to augment with
  assert.match(h.said.join(' '), /generally/i);
});

test('conversation: without the network capability, freshness questions skip search entirely', async () => {
  const provider = makeProvider({ reply: 'plain answer' });
  const h = harness(['files', 'fs', 'apps', 'system', 'clipboard', 'windows'], { provider });
  await h.engine.ask('what is the latest Fortnite news?', io(h));
  assert.deepEqual(h.web.searchedQueries, []);
  assert.equal(provider.prompts[0], 'what is the latest Fortnite news?');
});

// ---- intelligence registry -----------------------------------------------------

test('SimpleIntelligenceRegistry: active() is null until a provider is both selected and configured', () => {
  const registry = new SimpleIntelligenceRegistry();
  registry.register(makeProvider({ id: 'local:qwen3-8b', configured: false }));

  assert.isNull(registry.active()); // nothing selected yet
  registry.setActive('local:qwen3-8b');
  assert.isNull(registry.active()); // selected, but this scripted provider reports unconfigured
});

test('SimpleIntelligenceRegistry: a configured, selected provider becomes active', () => {
  const registry = new SimpleIntelligenceRegistry();
  registry.register(makeProvider({ id: 'local:qwen3-8b', configured: true }));
  registry.setActive('local:qwen3-8b');
  assert.equal(registry.active()?.id, 'local:qwen3-8b');
});

test('SimpleIntelligenceRegistry: list() reflects every registered provider', () => {
  const registry = new SimpleIntelligenceRegistry();
  // The registry itself stays generic — it is a map. What keeps Atlas to one
  // provider is that exactly one is ever registered, which
  // `no-other-cloud-ai.test.ts` checks by reading the wiring.
  registry.register(makeProvider({ id: 'local:qwen3-8b' }));
  registry.register(makeProvider({ id: 'second' }));
  assert.deepEqual(
    registry.list().map((p) => p.id),
    ['local:qwen3-8b', 'second'],
  );
});

test('conversation: a real provider error (not the two known sentinels) reaches the user verbatim', async () => {
  const provider = makeProvider({
    error: 'The local model server is running but has no model loaded yet.',
  });
  const h = harness(undefined, { provider });
  await h.engine.ask('what is the capital of Peru?', io(h));
  assert.match(h.said.join(' '), /no model loaded/);
});

test('conversation: the offline/not-configured sentinels still get their friendly messages', async () => {
  const offline = makeProvider({ error: 'offline' });
  const h1 = harness(undefined, { provider: offline });
  await h1.engine.ask('what is the capital of Peru?', io(h1));
  assert.match(h1.said.join(' '), /couldn't reach that provider/);
});

// ---- skills ------------------------------------------------------------------

test('app.open prefers an exact name over a longer substring match', async () => {
  const h = harness();
  await h.engine.ask('open visual studio code', io(h));
  assert.deepEqual(h.journal.launched, ['code']);
});

test('app.open finds Discord, Notepad++, Fortnite, and Epic Games directly', async () => {
  const h = harness();
  await h.engine.ask('open discord', io(h));
  await h.engine.ask('open notepad++', io(h));
  await h.engine.ask('open fortnite', io(h));
  assert.deepEqual(h.journal.launched, ['discord', 'notepad++', 'fortnite']);
});

test('app.open resolves colloquial VS Code names via the alias table', async () => {
  const h = harness();
  await h.engine.ask('open vscode', io(h));
  await h.engine.ask('open vs code', io(h));
  assert.deepEqual(h.journal.launched, ['code', 'code']);
});

// ---- app.open's bounded attempt ladder (planner/attempts.ts) ----------------
//
// app.open tries up to three relevant, ordered strategies before asking the
// user — see the module doc on `attemptGoal`. These tests exercise that
// ladder directly, examples A-F from the design: success stops immediately,
// a failure falls through to the next *relevant* strategy, and exhausting
// every strategy asks rather than invents something unrelated to try.

test('Example A/F — a confident match launches on the first attempt and tries nothing else', async () => {
  const h = harness();
  const result = await h.engine.skills.invoke('app.open', { name: 'fortnite' }, io(h));

  assert.isTrue(result.ok);
  assert.deepEqual(h.journal.launched, ['fortnite']);
  // No other strategy left a mark: no URL opened, no "did you mean" card shown.
  assert.lengthOf(h.journal.urls, 0);
  assert.lengthOf(h.rows, 0);
});

test('Example B — no single installed app matches, but a relevant second attempt succeeds', async () => {
  const h = harness();
  // No app is named "obs and epic games launcher", so the first attempt
  // (installed-app) has nothing to launch — the second attempt (splitting a
  // sentence naming two real, installed programs) is what actually resolves it.
  const result = await h.engine.skills.invoke(
    'app.open',
    { name: 'obs and epic games launcher' },
    io(h),
  );

  assert.isTrue(result.ok);
  assert.sameMembers(h.journal.launched, ['obs', 'epic-games-launcher']);
});

test('Example B — no installed app or multi-target reading, but a known destination resolves it', async () => {
  const h = harness();
  // Not installed, not two names joined by "and" — the third attempt (a
  // domain-shaped name) is the relevant one left, and it succeeds.
  const result = await h.engine.skills.invoke('app.open', { name: 'example.com' }, io(h));

  assert.isTrue(result.ok);
  assert.lengthOf(h.journal.launched, 0);
  assert.deepEqual(h.journal.urls, ['https://example.com']);
});

test('Example C/D — every relevant strategy declines, so Atlas asks instead of guessing', async () => {
  const h = harness();
  const result = await h.engine.skills.invoke('app.open', { name: 'zzzzqqqwx' }, io(h));

  assert.isFalse(result.ok);
  assert.include(result.error!, 'zzzzqqqwx');
  // Nothing was launched and no URL was opened — every attempt genuinely
  // declined rather than one of them guessing and failing quietly.
  assert.lengthOf(h.journal.launched, 0);
  assert.lengthOf(h.journal.urls, 0);
});

test('Example E — a name close to an installed app is offered, never invented commands elsewhere', async () => {
  const h = harness();
  const result = await h.engine.skills.invoke('app.open', { name: 'crosshairzzz' }, io(h));

  assert.isTrue(result.ok);
  assert.isAbove(h.rows.length, 0, 'the near-match card is how Atlas asks here');
  assert.lengthOf(h.journal.launched, 0, 'an offer is not a launch');
  // The bounded ladder has exactly three relevant strategies for app.open —
  // none of which is "search the web" or "search files" — so neither ran.
  assert.lengthOf(h.web.searchedQueries, 0);
  assert.lengthOf(h.journal.opened, 0);
  assert.lengthOf(h.journal.revealed, 0);
});

test('memory.remember + files.openAlias: teach a name, then open what it means', async () => {
  const h = harness();
  await h.engine.ask('remember my work folder is D:\\Dev', io(h));
  const fact = await h.memory.fact('alias', 'work folder');
  assert.equal(fact?.value, 'D:\\Dev');

  await h.engine.ask('open my work folder', io(h));
  assert.deepEqual(h.journal.opened, ['D:\\Dev']);
});

test('files.openAlias explains itself when the name was never taught', async () => {
  const h = harness();
  await h.engine.ask('open my mystery folder', io(h));
  assert.equal(h.journal.opened.length, 0);
  assert.match(h.said.join(' '), /don't know what "mystery folder" refers to/);
});

test('web.open refuses a non-http scheme', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke(
    'web.open',
    { url: 'file:///etc/passwd' },
    {
      say: () => {},
      confirm: async () => true,
    },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(h.journal.urls, []);
});

test('files.find renders actionable rows', async () => {
  const h = harness();
  await h.engine.ask('find my tax pdf', io(h));
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].title, 'tax-2025.pdf');
  assert.equal(h.rows[0].actions?.[0].skill, 'files.open');
});

test('files.find falls back to matching every word once the exact phrase fails', async () => {
  // "Japan_Vacation_2024.jpg" is real, but nothing in the fake index has the
  // literal substring "japan vacation" — the underscore is in the way. The
  // phrase search (`attemptGoal`'s first, more precise strategy) has to
  // decline before the word-by-word one (its fallback) ever runs.
  const h = harness();
  await h.engine.ask('find my japan vacation photos', io(h));
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].title, 'Japan_Vacation_2024.jpg');
});

test('files.find never tries the word-by-word fallback for a single-word query', async () => {
  // One word is exactly what the phrase search already tried — running it
  // again as its own "fallback" would just be the same search twice.
  const h = harness();
  const single = await h.engine.skills.invoke('files.find', { query: 'tax' }, io(h));
  assert.equal((single.data as unknown[]).length, 1);

  // A query where not even one word matches anything must still say so
  // plainly, not silently claim success with nothing found.
  const nothing = await h.engine.skills.invoke('files.find', { query: 'nonexistent words' }, io(h));
  assert.equal(nothing.message, 'Nothing named like “nonexistent words”.');
});

test('files.find says so plainly when there is nothing', async () => {
  const h = harness();
  await h.engine.ask('find my holiday photos', io(h));
  assert.match(h.said.join(' '), /Nothing named like/);
});

test('math.calculate evaluates arithmetic and rejects nonsense', async () => {
  const h = harness();
  const good = await h.engine.skills.invoke('math.calculate', { expression: '2 + 2 * 3' }, io(h));
  assert.equal(good.data, 8);
  // The expression is restated in the message, not just the answer — "8."
  // alone means nothing a minute later, in the transcript or in history.
  assert.include(good.message ?? '', '2 + 2 * 3');
  assert.include(good.message ?? '', '8');
  const bad = await h.engine.skills.invoke('math.calculate', { expression: '2 +' }, io(h));
  assert.equal(bad.ok, false);
});

test('math.convert converts between compatible units', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke('math.convert', { value: 1, from: 'km', to: 'm' }, io(h));
  assert.equal(r.data, 1000);
  const bad = await h.engine.skills.invoke(
    'math.convert',
    { value: 1, from: 'km', to: 'kg' },
    io(h),
  );
  assert.equal(bad.ok, false);
});

test('files.delete sends the path to the platform once approved', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('delete D:\\Dev\\old.txt', io(h));
  assert.deepEqual(h.journal.deleted, ['D:\\Dev\\old.txt']);
});

test('files.readText returns the file contents', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke('files.readText', { path: 'D:\\Dev\\readme.txt' }, io(h));
  assert.equal(r.data, 'contents of D:\\Dev\\readme.txt');
});

// ---- conversation ---------------------------------------------------------------

test('with no provider, a question leads with what still works', async () => {
  const h = harness();
  await h.engine.ask('what is the capital of Peru?', io(h));
  const said = h.said.join(' ');
  // Never opens on what is missing. It names the one route that would
  // actually answer the question, and the actions that work regardless.
  assert.notMatch(said, MODEL_EXCUSE);
  assert.match(said, /can't answer that one/i);
  assert.match(said, /search the web/i);
  assert.match(said, /\d+ actions/);
});

test('a crashing skill is contained, not fatal', async () => {
  const h = harness();
  h.engine.skills.register({
    id: 'test.explode',
    label: 'Explode',
    domain: 'test',
    description: 'Throws.',
    params: {},
    run() {
      throw new Error('boom');
    },
  });
  const r = await h.engine.skills.invoke(
    'test.explode',
    {},
    { say: () => {}, confirm: async () => true },
  );
  assert.equal(r.ok, false);
  assert.match(r.error!, /boom/);
});

// ---- the wider catalog --------------------------------------------------------

test('catalog: the shipped pack offers at least fifty actions on a full desktop', () => {
  const h = harness();
  assert.isAtLeast(h.engine.skills.available().length, 50);
});

test('catalog: every skill has a label, a description and a domain', () => {
  const h = harness();
  for (const skill of h.engine.skills.all()) {
    assert.isNotEmpty(skill.label, `${skill.id} has no label`);
    assert.isNotEmpty(skill.description, `${skill.id} has no description`);
    assert.isNotEmpty(skill.domain, `${skill.id} has no domain`);
  }
});

test('catalog: the utility pack survives a machine with no capabilities at all', () => {
  const h = harness([]);
  const ids = h.engine.skills.available().map((s) => s.id);
  assert.include(ids, 'util.password');
  assert.include(ids, 'math.percent');
  assert.notInclude(ids, 'files.find');
});

// ---- grammar: the new phrasings ------------------------------------------------

test('grammar: new phrasings reach the skill they name', () => {
  const h = harness();
  const cases: Array<[string, string]> = [
    ['generate a password', 'util.password'],
    ['make me a 32 character password', 'util.password'],
    ['generate 5 passwords', 'util.password'],
    ['generate a uuid', 'util.uuid'],
    ['random number between 1 and 10', 'util.random'],
    ['flip a coin', 'util.coin'],
    ['roll 2d20', 'util.dice'],
    ['roll a dice', 'util.dice'],
    ['encode hello world in base64', 'util.base64'],
    ['base64 decode aGVsbG8=', 'util.base64'],
    ['convert #7c5cff to rgb', 'util.color'],
    ['how many words are in "the quick brown fox"', 'text.count'],
    ['uppercase "hello world"', 'text.case'],
    ["what's 15% of 240", 'math.percent'],
    ['20 is what percent of 80', 'math.percent'],
    ['percent change from 50 to 75', 'math.percent'],
    ['average of 3, 7 and 11', 'math.average'],
    ['what time is it in tokyo', 'time.inZone'],
    ['how many days until christmas', 'time.until'],
    ['set a timer for 10 minutes', 'time.timer'],
    ["what's running", 'system.processes'],
    ["what's on my clipboard", 'clipboard.read'],
    ['notify me "the build is done"', 'notify.send'],
    ['what do you remember', 'memory.list'],
    ['forget my work folder', 'memory.forget'],
    ['open any browser', 'web.openBrowser'],
    ['find images of red pandas', 'web.searchImages'],
    ['directions to Denver airport', 'web.searchMaps'],
    ['wikipedia the Voyager program', 'web.searchWikipedia'],
  ];

  for (const [text, skill] of cases) {
    const p = h.engine.grammar.parse(text);
    assert.isNotNull(p, `no plan for "${text}"`);
    assert.equal(p!.steps[0]!.skill, skill, `"${text}" went to the wrong skill`);
  }
});

test('grammar: the new rules do not steal the phrasings that were there first', () => {
  const h = harness();
  const unchanged: Array<[string, string]> = [
    ['what time is it', 'time.now'],
    ['open steam', 'app.open'],
    ['find my tax pdf', 'files.find'],
    ['find pictures of my wedding', 'files.find'],
    ['convert 10 miles to km', 'math.convert'],
    ['what is 12 * 7', 'math.calculate'],
    ['system status', 'system.info'],
    ['remember my work folder is D:\\Dev', 'memory.remember'],
    ['open task manager', 'system.openTool'],
  ];
  for (const [text, skill] of unchanged) {
    const p = h.engine.grammar.parse(text);
    assert.isNotNull(p, `no plan for "${text}"`);
    assert.equal(p!.steps[0]!.skill, skill, `"${text}" was hijacked`);
  }
});

test('grammar: the timer rule reads the unit, not just the number', () => {
  const h = harness();
  const seconds = (text: string) => h.engine.grammar.parse(text)!.steps[0]!.args.seconds;
  assert.equal(seconds('set a timer for 90 seconds'), 90);
  assert.equal(seconds('set a timer for 10 minutes'), 600);
  assert.equal(seconds('set a timer for 2 hours'), 7200);
  assert.equal(
    h.engine.grammar.parse('remind me in 5 minutes to stretch')!.steps[0]!.args.label,
    'stretch',
  );
});

test('grammar: an unquoted count question is left to conversation', () => {
  const h = harness();
  assert.isNull(h.engine.grammar.parse('how many words are in the English language'));
});

// ---- utility skills ------------------------------------------------------------

test('utility: a generated password is the requested length and mixes character classes', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke('util.password', { length: 24 }, io(h));
  assert.isTrue(r.ok);
  const password = String(r.data);
  assert.lengthOf(password, 24);
  assert.match(password, /[a-z]/);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[0-9]/);

  const second = await h.engine.skills.invoke('util.password', { length: 24 }, io(h));
  assert.notEqual(String(second.data), password);
});

test('utility: several passwords can be asked for at once', async () => {
  const h = harness();
  const p = h.engine.grammar.parse('generate 5 passwords')!;
  assert.deepEqual(p.steps[0]!.args, { count: 5 });

  const r = await h.engine.skills.invoke('util.password', p.steps[0]!.args, io(h));
  const passwords = r.data as string[];
  assert.lengthOf(passwords, 5);
  assert.lengthOf(new Set(passwords), 5);
  assert.lengthOf(r.message!.split('\n'), 5);

  // The length still belongs to each password, not to the batch.
  const sized = h.engine.grammar.parse('generate 3 32 character passwords')!;
  assert.deepEqual(sized.steps[0]!.args, { count: 3, length: 32 });
  const long = h.engine.grammar.parse('make me a 32 character password')!;
  assert.deepEqual(long.steps[0]!.args, { length: 32 });
});

test('utility: password length is clamped rather than refused', async () => {
  const h = harness();
  const short = await h.engine.skills.invoke('util.password', { length: 2 }, io(h));
  assert.lengthOf(String(short.data), 8);
  const long = await h.engine.skills.invoke('util.password', { length: 5000 }, io(h));
  assert.lengthOf(String(long.data), 128);
});

test('utility: uuid is a v4 uuid', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke('util.uuid', {}, io(h));
  assert.match(
    String(r.data),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test('utility: a random number stays inside its range, either way round', async () => {
  const h = harness();
  for (let i = 0; i < 50; i++) {
    const r = await h.engine.skills.invoke('util.random', { min: 10, max: 1 }, io(h));
    const n = Number(r.data);
    assert.isAtLeast(n, 1);
    assert.isAtMost(n, 10);
  }
});

test('utility: dice roll the right number of dice with the right faces', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke('util.dice', { count: 3, sides: 20 }, io(h));
  const { rolls, total } = r.data as { rolls: number[]; total: number };
  assert.lengthOf(rolls, 3);
  for (const roll of rolls) {
    assert.isAtLeast(roll, 1);
    assert.isAtMost(roll, 20);
  }
  assert.equal(
    total,
    rolls.reduce((a, b) => a + b, 0),
  );
});

test('utility: base64 round-trips text, including non-ASCII', async () => {
  const h = harness();
  const encoded = await h.engine.skills.invoke('util.base64', { text: 'héllo — wörld' }, io(h));
  assert.isTrue(encoded.ok);
  const decoded = await h.engine.skills.invoke(
    'util.base64',
    { text: String(encoded.data), mode: 'decode' },
    io(h),
  );
  assert.equal(decoded.data, 'héllo — wörld');
});

test('utility: base64 says so when the input is not base64', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke(
    'util.base64',
    { text: 'not base 64!!', mode: 'decode' },
    io(h),
  );
  assert.isFalse(r.ok);
});

test('utility: colours convert between hex, rgb and hsl', async () => {
  const h = harness();
  const fromHex = await h.engine.skills.invoke('util.color', { color: '#7c5cff' }, io(h));
  assert.deepEqual(fromHex.data, { hex: '#7c5cff', r: 124, g: 92, b: 255 });
  assert.include(fromHex.message, 'rgb(124, 92, 255)');

  const fromRgb = await h.engine.skills.invoke('util.color', { color: 'rgb(124, 92, 255)' }, io(h));
  assert.include(fromRgb.message, '#7c5cff');

  const shorthand = await h.engine.skills.invoke('util.color', { color: '#fff' }, io(h));
  assert.include(shorthand.message, '#ffffff');

  const nonsense = await h.engine.skills.invoke('util.color', { color: 'octarine' }, io(h));
  assert.isFalse(nonsense.ok);
});

test('utility: text counts words, characters and lines', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke('text.count', { text: 'one two three\nfour' }, io(h));
  assert.deepEqual(r.data, { words: 4, characters: 18, withoutSpaces: 15, lines: 2 });
});

test('utility: case conversion covers all four styles', async () => {
  const h = harness();
  const at = async (style: string, text: string) =>
    String((await h.engine.skills.invoke('text.case', { text, style }, io(h))).data);

  assert.equal(await at('upper', 'hello world'), 'HELLO WORLD');
  assert.equal(await at('lower', 'HELLO World'), 'hello world');
  assert.equal(await at('title', 'the great escape'), 'The Great Escape');
  assert.equal(await at('sentence', 'first thing. second thing.'), 'First thing. Second thing.');
});

test('utility: percentages answer all three questions', async () => {
  const h = harness();
  const of = await h.engine.skills.invoke('math.percent', { a: 15, b: 240, mode: 'of' }, io(h));
  assert.equal(of.data, 36);

  const is = await h.engine.skills.invoke('math.percent', { a: 20, b: 80, mode: 'is' }, io(h));
  assert.equal(is.data, 25);

  const change = await h.engine.skills.invoke(
    'math.percent',
    { a: 50, b: 75, mode: 'change' },
    io(h),
  );
  assert.equal(change.data, 50);
  assert.include(change.message, 'increase');

  const drop = await h.engine.skills.invoke(
    'math.percent',
    { a: 80, b: 60, mode: 'change' },
    io(h),
  );
  assert.include(drop.message, 'decrease');

  const zero = await h.engine.skills.invoke('math.percent', { a: 5, b: 0, mode: 'is' }, io(h));
  assert.isFalse(zero.ok);
});

test('utility: averages report the mean and the spread', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke('math.average', { numbers: '3, 7 and 11' }, io(h));
  assert.deepEqual(r.data, { mean: 7, sum: 21, count: 3 });

  const empty = await h.engine.skills.invoke('math.average', { numbers: 'nothing here' }, io(h));
  assert.isFalse(empty.ok);
});

test('utility: the time in another city resolves city names and zones alike', async () => {
  const h = harness();
  const city = await h.engine.skills.invoke('time.inZone', { place: 'tokyo' }, io(h));
  assert.isTrue(city.ok);
  assert.equal((city.data as { zone: string }).zone, 'Asia/Tokyo');

  const zone = await h.engine.skills.invoke('time.inZone', { place: 'Asia/Kolkata' }, io(h));
  assert.isTrue(zone.ok);

  const nowhere = await h.engine.skills.invoke('time.inZone', { place: 'Rivendell' }, io(h));
  assert.isFalse(nowhere.ok);
});

test('utility: days-until counts to a date and to a named holiday', async () => {
  const h = harness();
  const holiday = await h.engine.skills.invoke('time.until', { occasion: 'christmas' }, io(h));
  assert.isTrue(holiday.ok);
  const days = (holiday.data as { days: number }).days;
  assert.isAtLeast(days, 0);
  assert.isAtMost(days, 366);

  const nonsense = await h.engine.skills.invoke(
    'time.until',
    { occasion: 'the twelfth of never' },
    io(h),
  );
  assert.isFalse(nonsense.ok);
});

// ---- platform-backed additions --------------------------------------------------

test('timer: notifies when it finishes, and refuses an unreasonable one', async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    const set = await h.engine.skills.invoke('time.timer', { seconds: 600, label: 'tea' }, io(h));
    assert.isTrue(set.ok);
    assert.include(set.message, '10 minutes');
    assert.lengthOf(h.journal.notifications, 0);

    await vi.advanceTimersByTimeAsync(600 * 1000);
    assert.lengthOf(h.journal.notifications, 1);
    assert.equal(h.journal.notifications[0]!.body, 'tea');

    const tooLong = await h.engine.skills.invoke('time.timer', { seconds: 60 * 60 * 48 }, io(h));
    assert.isFalse(tooLong.ok);
  } finally {
    vi.useRealTimers();
  }
});

test('processes: running processes come back as rows, heaviest first', async () => {
  const h = harness();
  const r = await h.engine.skills.invoke('system.processes', {}, io(h));
  assert.isTrue(r.ok);
  assert.equal(h.rows[0]!.title, 'chrome.exe');
  assert.include(h.rows[0]!.subtitle, 'MB');
  assert.include(h.rows[0]!.subtitle, 'pid 4242');
});

test('clipboard: reading reports what writing put there, and says when it is empty', async () => {
  const h = harness();
  const empty = await h.engine.skills.invoke('clipboard.read', {}, io(h));
  assert.include(empty.message, 'empty');

  await h.engine.skills.invoke('clipboard.copy', { text: 'ship it' }, io(h));
  const read = await h.engine.skills.invoke('clipboard.read', {}, io(h));
  assert.equal(read.data, 'ship it');
});

test('notifications: a message is posted, an empty one is refused', async () => {
  const h = harness();
  const sent = await h.engine.skills.invoke('notify.send', { message: 'build done' }, io(h));
  assert.isTrue(sent.ok);
  assert.deepEqual(h.journal.notifications[0], { title: 'Atlas', body: 'build done' });

  const empty = await h.engine.skills.invoke('notify.send', { message: '   ' }, io(h));
  assert.isFalse(empty.ok);
});

test('memory: what Atlas remembers can be listed and forgotten', async () => {
  const h = harness();
  const empty = await h.engine.skills.invoke('memory.list', {}, io(h));
  assert.include(empty.message, "haven't been told");

  await h.engine.ask('remember my work folder is D:\\Dev', io(h));
  await h.engine.skills.invoke('memory.list', {}, io(h));
  assert.equal(h.rows[0]!.title, 'work folder');

  const forgotten = await h.engine.skills.invoke(
    'memory.forget',
    { subject: 'work folder' },
    io(h),
  );
  assert.isTrue(forgotten.ok);
  assert.lengthOf(await h.memory.facts('alias'), 0);

  const again = await h.engine.skills.invoke('memory.forget', { subject: 'work folder' }, io(h));
  assert.isFalse(again.ok);
});

test('browser: "any browser" launches an installed one, and a named one is honoured', async () => {
  const h = harness();
  const any = await h.engine.skills.invoke('web.openBrowser', {}, io(h));
  assert.isTrue(any.ok);
  // Brave and Firefox are both in the fixture's installed-apps list now;
  // `BROWSER_NAMES`' own priority order (core-skills.ts) puts Brave first.
  assert.deepEqual(h.journal.launched, ['brave']);

  const named = await h.engine.skills.invoke('web.openBrowser', { name: 'firefox' }, io(h));
  assert.isTrue(named.ok);

  const missing = await h.engine.skills.invoke('web.openBrowser', { name: 'netscape' }, io(h));
  assert.isFalse(missing.ok);
});

test('web shortcuts: each builds the URL it promises', async () => {
  const h = harness();
  await h.engine.skills.invoke('web.searchImages', { query: 'red pandas' }, io(h));
  await h.engine.skills.invoke('web.searchMaps', { place: 'Kyoto' }, io(h));
  await h.engine.skills.invoke('web.searchMaps', { place: 'Kyoto', directions: true }, io(h));
  await h.engine.skills.invoke('web.searchWikipedia', { query: 'Voyager program' }, io(h));

  assert.include(h.journal.urls[0], 'tbm=isch&q=red%20pandas');
  assert.include(h.journal.urls[1], 'maps/search/?api=1&query=Kyoto');
  assert.include(h.journal.urls[2], 'maps/dir/?api=1&destination=Kyoto');
  assert.include(h.journal.urls[3], 'wikipedia.org/w/index.php?search=Voyager%20program');
});

// ---- the second fifty ---------------------------------------------------------

test('catalog: a full desktop offers a hundred actions', () => {
  const h = harness();
  assert.isAtLeast(h.engine.skills.available().length, 100);
});

test('catalog: every skill id is unique', () => {
  const h = harness();
  const ids = h.engine.skills.all().map((s) => s.id);
  assert.lengthOf(new Set(ids), ids.length);
});

test('grammar: the second fifty are reachable by phrasing', () => {
  const h = harness();
  const cases: Array<[string, string]> = [
    ['in "a-b-c" replace - with +', 'text.replace'],
    ['sort these lines: b\na', 'text.sortLines'],
    ['remove duplicate lines: a\na', 'text.dedupe'],
    ['tidy up:   spaced   ', 'text.trim'],
    ['extract the emails from "a@b.com and c@d.com"', 'text.extract'],
    ['slugify "My First Post!"', 'text.slug'],
    ['most common words in "one two two"', 'text.frequency'],
    ['lorem ipsum 20 words', 'text.lorem'],
    ['url encode hello world', 'util.urlEncode'],
    ['sha256 of abc', 'util.hash'],
    ['255 in hex', 'util.hex'],
    ['format this json: {"a":1}', 'util.json'],
    ['decode this jwt: aaa.bbb.ccc', 'util.jwt'],
    ['1994 in roman numerals', 'util.roman'],
    ['tip on 84.50', 'math.tip'],
    ['20% tip on 120 split 4 ways', 'math.tip'],
    ['monthly payment on 25000 at 6% over 5 years', 'math.interest'],
    ['aspect ratio of 1920x1080', 'math.aspect'],
    ['resize 1920x1080 to width 1280', 'math.aspect'],
    ['how many mb in 4.7 gb', 'math.bytes'],
    ['is 97 prime', 'math.primes'],
    ['factor 360', 'math.primes'],
    ['0.375 as a fraction', 'math.fraction'],
    ['time difference between london and tokyo', 'time.zoneDiff'],
    ['how old is someone born 1994-03-05', 'time.age'],
    ['days between 2026-01-01 and 2026-08-17', 'time.between'],
    ['what day of the week is 2026-12-25', 'time.weekday'],
    ['timestamp 1767225600', 'time.unix'],
    ['note that the router password is on the fridge', 'notes.add'],
    ['read my notes', 'notes.list'],
    ['clear my notes', 'notes.clear'],
    ['add buy milk to my todo list', 'todo.add'],
    ["what's on my todo list", 'todo.list'],
    ['tick off buy milk', 'todo.done'],
    ['lock my pc', 'system.lock'],
    ['restart my computer', 'system.power'],
    ['turn the volume up', 'system.volume'],
    ['louder', 'system.volume'],
    ['mute', 'system.mute'],
    ['pause the music', 'media.control'],
    ['turn off the screen', 'system.displayOff'],
    ['empty the recycle bin', 'system.emptyRecycleBin'],
    ['open my downloads', 'files.openKnown'],
    ['clear my clipboard', 'clipboard.clear'],
    ['uppercase my clipboard', 'clipboard.transform'],
    ['how much battery do I have', 'system.battery'],
    ['how much free space do I have', 'system.disk'],
    ['how long has my pc been on', 'system.uptime'],
  ];

  for (const [text, skill] of cases) {
    const p = h.engine.grammar.parse(text);
    assert.isNotNull(p, `no plan for "${text}"`);
    assert.equal(p!.steps[0]!.skill, skill, `"${text}" went to the wrong skill`);
  }
});

test('grammar: path-bearing file phrasings still reach their skill', () => {
  const h = harness();
  const cases: Array<[string, string]> = [
    ['how big is D:\\Dev\\notes.txt', 'files.info'],
    ['peek at D:\\Dev\\notes.txt', 'files.peek'],
    ['what is in D:\\Dev', 'files.list'],
    ['append "shipped" to D:\\Dev\\log.txt', 'files.append'],
    ['save my clipboard to D:\\Dev\\snippet.txt', 'clipboard.save'],
  ];
  for (const [text, skill] of cases) {
    const p = h.engine.grammar.parse(text);
    assert.isNotNull(p, `no plan for "${text}"`);
    assert.equal(p!.steps[0]!.skill, skill, `"${text}" went to the wrong skill`);
  }
});

test('grammar: the new rules leave the old phrasings alone', () => {
  const h = harness();
  const unchanged: Array<[string, string]> = [
    ['what time is it', 'time.now'],
    ['what time is it in tokyo', 'time.inZone'],
    ['open steam', 'app.open'],
    ['find my tax pdf', 'files.find'],
    ['remember my work folder is D:\\Dev', 'memory.remember'],
    ['convert 10 miles to km', 'math.convert'],
    ['how many days until christmas', 'time.until'],
    ["what's 15% of 240", 'math.percent'],
    ['flip a coin', 'util.coin'],
    ['hide', 'atlas.hide'],
  ];
  for (const [text, skill] of unchanged) {
    const p = h.engine.grammar.parse(text);
    assert.isNotNull(p, `no plan for "${text}"`);
    assert.equal(p!.steps[0]!.skill, skill, `"${text}" was hijacked`);
  }
});

// ---- text and encoding ---------------------------------------------------------

test('text: reshaping skills do what they say', async () => {
  const h = harness();
  const run = (id: string, args: Record<string, unknown>) =>
    h.engine.skills.invoke(id, args, io(h));

  const replaced = await run('text.replace', { text: 'a-b-c', find: '-', replace: '+' });
  assert.equal(replaced.data, 'a+b+c');

  const sorted = await run('text.sortLines', { text: 'pear\napple\nbanana' });
  assert.deepEqual(sorted.data, ['apple', 'banana', 'pear']);

  const deduped = await run('text.dedupe', { text: 'a\nb\na\nb' });
  assert.deepEqual(deduped.data, ['a', 'b']);

  const tidied = await run('text.trim', { text: '  hello   \n\n\n\nworld  ' });
  assert.equal(tidied.data, 'hello\n\nworld');

  const emails = await run('text.extract', { text: 'ping a@b.com or a@b.com', what: 'emails' });
  assert.deepEqual(emails.data, ['a@b.com']);

  const slug = await run('text.slug', { text: 'My First Post!' });
  assert.equal(slug.data, 'my-first-post');

  const frequency = await run('text.frequency', { text: 'ship it ship it ship' });
  assert.deepEqual((frequency.data as Array<[string, number]>)[0], ['ship', 3]);

  const lorem = await run('text.lorem', { words: 5 });
  assert.lengthOf(String(lorem.data).replace(/\.$/, '').split(' '), 5);
});

test('encoding: hashes, bases, json, jwt and roman numerals', async () => {
  const h = harness();
  const run = (id: string, args: Record<string, unknown>) =>
    h.engine.skills.invoke(id, args, io(h));

  // The published SHA-256 test vector for "abc".
  const hash = await run('util.hash', { text: 'abc' });
  assert.equal(hash.data, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  const url = await run('util.urlEncode', { text: 'a b&c' });
  assert.equal(url.data, 'a%20b%26c');
  const back = await run('util.urlEncode', { text: 'a%20b%26c', mode: 'decode' });
  assert.equal(back.data, 'a b&c');

  const hex = await run('util.hex', { value: '255' });
  assert.deepEqual(hex.data, { decimal: 255, hex: '0xff', binary: '0b11111111' });
  const fromHex = await run('util.hex', { value: '0xff', to: 'decimal' });
  assert.equal((fromHex.data as { decimal: number }).decimal, 255);

  const json = await run('util.json', { text: '{"b":1,"a":[2]}' });
  assert.include(String(json.data), '\n  ');
  const bad = await run('util.json', { text: '{nope}' });
  assert.isFalse(bad.ok);

  const roman = await run('util.roman', { value: '1994' });
  assert.equal(roman.data, 'MCMXCIV');
  const number = await run('util.roman', { value: 'MCMXCIV' });
  assert.equal(number.data, 1994);
  const notRoman = await run('util.roman', { value: 'IIII' });
  assert.isFalse(notRoman.ok);

  const jwt = await run('util.jwt', {
    // {"alg":"HS256"} . {"sub":"atlas"} . signature
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdGxhcyJ9.sig',
  });
  assert.include(String(jwt.data), 'atlas');
  assert.include(jwt.message!, 'signature is not checked');
});

// ---- calculators ---------------------------------------------------------------

test('calculators: money, sizes and numbers', async () => {
  const h = harness();
  const run = (id: string, args: Record<string, unknown>) =>
    h.engine.skills.invoke(id, args, io(h));

  const tip = await run('math.tip', { bill: 100, percent: 20, people: 4 });
  assert.deepEqual(tip.data, { tip: 20, total: 120, each: 30 });

  const loan = await run('math.interest', { amount: 25000, rate: 6, years: 5, mode: 'loan' });
  const payment = (loan.data as { payment: number }).payment;
  assert.isAtLeast(payment, 480);
  assert.isAtMost(payment, 490);

  const savings = await run('math.interest', {
    amount: 1000,
    rate: 100,
    years: 1,
    mode: 'savings',
  });
  assert.isAbove((savings.data as { final: number }).final, 2000);

  const ratio = await run('math.aspect', { width: 1920, height: 1080 });
  assert.include(ratio.message!, '16:9');
  const scaled = await run('math.aspect', { width: 1920, height: 1080, toWidth: 1280 });
  assert.deepEqual(scaled.data, { width: 1280, height: 720 });

  const bytes = await run('math.bytes', { value: 1, from: 'gb', to: 'mb' });
  assert.equal(bytes.data, 1024);

  const prime = await run('math.primes', { value: 97 });
  assert.deepEqual(prime.data, { prime: true });
  const composite = await run('math.primes', { value: 360 });
  assert.deepEqual((composite.data as { factors: number[] }).factors, [2, 2, 2, 3, 3, 5]);

  const fraction = await run('math.fraction', { value: '0.375' });
  assert.equal(fraction.data, '3/8');
  const decimal = await run('math.fraction', { value: '3/8' });
  assert.equal(decimal.data, 0.375);
});

test('dates: ages, gaps, weekdays and timestamps', async () => {
  const h = harness();
  const run = (id: string, args: Record<string, unknown>) =>
    h.engine.skills.invoke(id, args, io(h));

  const between = await run('time.between', { from: '2026-01-01', to: '2026-01-31' });
  assert.equal((between.data as { days: number }).days, 30);

  const weekday = await run('time.weekday', { date: '2026-12-25' });
  assert.equal(weekday.data, 'Friday');

  const unix = await run('time.unix', { value: '0' });
  assert.isFalse(unix.ok, 'a bare 0 is not a timestamp we should guess at');
  const stamp = await run('time.unix', { value: '1767225600' });
  assert.include(String(stamp.data), '2026-');

  const age = await run('time.age', { date: '2000-01-01' });
  assert.isAtLeast((age.data as { years: number }).years, 26);
  const unborn = await run('time.age', { date: '2999-01-01' });
  assert.isFalse(unborn.ok);

  const diff = await run('time.zoneDiff', { from: 'london', to: 'tokyo' });
  assert.isTrue(diff.ok);
  assert.isAtLeast(Math.abs((diff.data as { hours: number }).hours), 8);
});

test('dates: ages and gaps are written out, not left in numeric-slash form', async () => {
  // "1/1/2000" read aloud comes out as a fraction, not a date — see
  // `spokenDate` in calc-skills.ts. Both skills used the bare
  // `toLocaleDateString()` default until this was caught.
  const h = harness();
  const run = (id: string, args: Record<string, unknown>) =>
    h.engine.skills.invoke(id, args, io(h));

  const age = await run('time.age', { date: '2000-01-01' });
  assert.match(age.message!, /January 1, 2000/);
  assert.notMatch(age.message!, /\d{1,2}\/\d{1,2}\/\d{4}/);

  const between = await run('time.between', { from: '2026-01-01', to: '2026-01-31' });
  assert.match(between.message!, /January 1, 2026/);
  assert.match(between.message!, /January 31, 2026/);
  assert.notMatch(between.message!, /\d{1,2}\/\d{1,2}\/\d{4}/);
});

test('aloud: a unix timestamp is shown but never spoken', async () => {
  // Same family as the password and the walls of data above: a raw
  // timestamp and an ISO string are for the eyes, and a phonemiser renders
  // the ISO form as noise rather than words.
  const h = harness();
  await h.engine.ask('timestamp 1767225600', io(h));
  assert.isNotEmpty(h.said);
  assert.deepEqual(h.spokenAloud, []);
});

// ---- notes and to-dos -----------------------------------------------------------

test('notes: written down, read back, cleared', async () => {
  const h = harness();
  await h.engine.ask('note that the router password is on the fridge', io(h));
  await h.engine.ask('write down buy stamps', io(h));

  await h.engine.skills.invoke('notes.list', {}, io(h));
  assert.lengthOf(h.rows, 2);
  assert.equal(h.rows[0]!.title, 'the router password is on the fridge');

  const cleared = await h.engine.skills.invoke('notes.clear', {}, io(h));
  assert.isTrue(cleared.ok);
  assert.lengthOf(await h.memory.facts('note'), 0);
});

test('todo: added, listed, ticked off', async () => {
  const h = harness();
  await h.engine.ask('add buy milk to my todo list', io(h));
  await h.engine.ask('remind me to renew the domain', io(h));

  const done = await h.engine.skills.invoke('todo.done', { text: 'milk' }, io(h));
  assert.isTrue(done.ok);

  await h.engine.skills.invoke('todo.list', {}, io(h));
  const titles = h.rows.map((r) => r.title);
  assert.include(titles.join(' | '), '✓ buy milk');

  const missing = await h.engine.skills.invoke('todo.done', { text: 'nothing like this' }, io(h));
  assert.isFalse(missing.ok);
});

// ---- the machine -----------------------------------------------------------------

test('os: each control calls its own command, and the dangerous ones ask first', async () => {
  const h = harness();
  await h.engine.skills.invoke('system.lock', {}, io(h));
  await h.engine.skills.invoke('system.volume', { direction: 'down', steps: 3 }, io(h));
  await h.engine.skills.invoke('system.mute', {}, io(h));
  await h.engine.skills.invoke('media.control', { key: 'next' }, io(h));
  await h.engine.skills.invoke('system.displayOff', {}, io(h));

  assert.deepEqual(h.journal.os, ['lock', 'volume:down:3', 'mute', 'media:next', 'display-off']);

  const power = h.engine.skills.get('system.power')!;
  assert.equal(power.risk, 'confirm');
  assert.equal(h.engine.skills.get('system.emptyRecycleBin')!.risk, 'confirm');
  assert.equal(h.engine.skills.get('system.volume')!.risk, 'safe');

  const bad = await h.engine.skills.invoke('system.power', { action: 'explode' }, io(h));
  assert.isFalse(bad.ok);
});

test('os: skills disappear on a machine without the capability', () => {
  const h = harness(['files', 'fs']);
  const ids = h.engine.skills.available().map((s) => s.id);
  assert.notInclude(ids, 'system.lock');
  assert.notInclude(ids, 'media.control');
  assert.include(ids, 'util.password');
});

// ---- files and clipboard ----------------------------------------------------------

test('files: inspecting, listing, peeking and appending', async () => {
  const h = harness();
  const run = (id: string, args: Record<string, unknown>) =>
    h.engine.skills.invoke(id, args, io(h));

  const info = await run('files.info', { path: 'D:\\Dev\\notes.txt' });
  assert.include(info.message!, 'notes.txt');
  assert.include(info.message!, '2.0 KB');
  // Written out ("changed November 14, 2023 at 3:33 PM"), not left as
  // `toLocaleString()`'s bare "11/14/2023, 3:33:20 PM" — a numeric date read
  // aloud comes out as a fraction, not a day.
  assert.match(info.message!, /changed [A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2}/);

  await run('files.list', { path: 'D:\\Dev' });
  assert.equal(h.rows[0]!.title, 'src');

  const peek = await run('files.peek', { path: 'D:\\Dev\\notes.txt', lines: 1 });
  assert.include(peek.message!, 'contents of');

  const appended = await run('files.append', { path: 'D:\\Dev\\log.txt', text: 'shipped' });
  assert.isTrue(appended.ok);
  assert.deepEqual(h.journal.appended, [{ path: 'D:\\Dev\\log.txt', content: 'shipped' }]);

  const known = await run('files.openKnown', { folder: 'downloads' });
  assert.isTrue(known.ok);
  assert.include(h.journal.opened.join(' '), 'downloads');

  const absent = await run('files.openKnown', { folder: 'music' });
  assert.isFalse(absent.ok);
  assert.include(absent.error!, 'Music folder');
});

test('clipboard: clear, append, transform and save', async () => {
  const h = harness();
  const run = (id: string, args: Record<string, unknown>) =>
    h.engine.skills.invoke(id, args, io(h));

  await run('clipboard.copy', { text: 'first' });
  await run('clipboard.append', { text: 'second' });
  assert.equal(h.journal.clipboard, 'first\nsecond');

  await run('clipboard.transform', { style: 'upper' });
  assert.equal(h.journal.clipboard, 'FIRST\nSECOND');
  await run('clipboard.transform', { style: 'single-line' });
  assert.equal(h.journal.clipboard, 'FIRST SECOND');

  const saved = await run('clipboard.save', { path: 'D:\\Dev\\snippet.txt' });
  assert.isTrue(saved.ok);
  assert.include(h.journal.created.join(' '), 'snippet.txt');

  await run('clipboard.clear', {});
  assert.equal(h.journal.clipboard, '');
  const empty = await run('clipboard.transform', { style: 'upper' });
  assert.isFalse(empty.ok);
});

test('system: battery, disk and uptime read the same snapshot', async () => {
  const h = harness();
  const battery = await h.engine.skills.invoke('system.battery', {}, io(h));
  assert.include(battery.message!, '72%');

  const disk = await h.engine.skills.invoke('system.disk', {}, io(h));
  assert.include(disk.message!, 'C:');
  assert.include(disk.message!, 'free');

  const uptime = await h.engine.skills.invoke('system.uptime', {}, io(h));
  assert.include(uptime.message!, '1 hour');
});

// ---- content policy -------------------------------------------------------
//
// The requirement these cover is not "Atlas says no" — it is that Atlas says
// no *before the machine does anything*. So most of them assert on the journal
// and on the scripted platform's own record of what it was asked to do, not
// just on what came back.

test('policy: an explicit search is refused before a single keystroke reaches a browser', async () => {
  const h = harness();
  const outcome = await h.engine.ask('search the web for porn', io(h));

  assert.isFalse(outcome.ok);
  assert.equal(outcome.error, 'refused:explicit');
  assert.deepEqual(h.web.searchedQueries, []); // nothing was searched
  assert.deepEqual(h.journal.urls, []); // no tab, no query string
  assert.deepEqual(h.confirmsAsked, []); // and no card offering to do it
  assert.match(h.said.join(' '), /don't search for, open, or play pornography/);
});

test('policy: an explicit destination is refused rather than opened', async () => {
  const h = harness();
  await h.engine.ask('open pornhub.com', io(h));
  assert.deepEqual(h.journal.urls, []);
  assert.deepEqual(h.journal.launched, []);
});

test('policy: the refusal offers no workaround', async () => {
  const h = harness();
  await h.engine.ask('find me porn videos', io(h));
  const text = h.said.join(' ').toLowerCase();
  for (const hint of ['instead', 'try ', 'you could', 'another site', 'setting', 'incognito']) {
    assert.notInclude(text, hint);
  }
});

test('policy: intent is read, not just a domain blacklist', async () => {
  const h = harness();
  // Names no blocked site and no banned noun — and is still plainly a request
  // to go and fetch explicit material.
  await h.engine.ask('show me naked women', io(h));
  assert.deepEqual(h.journal.urls, []);
  assert.match(h.said.join(' '), /pornography/);
});

test('policy: sexual content involving minors is refused in any phrasing', async () => {
  for (const phrasing of [
    'search for child porn',
    'find sexual images of children',
    'what is the best site for underage nudes',
  ]) {
    const h = harness();
    const outcome = await h.engine.ask(phrasing, io(h));
    assert.equal(outcome.error, 'refused:minors', phrasing);
    assert.deepEqual(h.web.searchedQueries, []);
    assert.deepEqual(h.journal.urls, []);
    assert.match(
      h.said.join(' '),
      /won't search for, open, or help with anything sexual involving/,
    );
  }
});

test('policy: the critical refusal is not softened by a stated reason', async () => {
  const h = harness();
  await h.engine.ask('find child abuse images for my research paper', io(h));
  assert.match(h.said.join(' '), /in any form or for any stated reason/);
});

test('policy: educational and medical requests are not treated as pornography', async () => {
  for (const request of [
    'search the web for sexual health information',
    'search the web for symptoms of an sti',
    'search the web for teen puberty education resources',
  ]) {
    const h = harness();
    h.web.results[request.replace('search the web for ', '')] = FORTNITE_RESULTS;
    const outcome = await h.engine.ask(request, io(h));
    assert.notEqual(outcome.error, 'refused:explicit', request);
    assert.notEqual(outcome.error, 'refused:minors', request);
    assert.equal(h.web.searchedQueries.length, 1, request);
  }
});

test('policy: looking a subject up in a reference work still works', async () => {
  const h = harness();
  await h.engine.ask('look up pornography on wikipedia', io(h));
  assert.equal(h.journal.urls.length, 1);
  assert.match(h.journal.urls[0]!, /wikipedia/i);
});

test('policy: a question about the subject is conversation, not a refused action', async () => {
  const h = harness();
  const outcome = await h.engine.ask('what is pornography?', io(h));
  assert.notEqual(outcome.error, 'refused:explicit');
  assert.notMatch(h.said.join(' '), /I don't search for, open, or play/);
});

test('policy: the registry refuses even when called directly', async () => {
  const h = harness();
  // The path conversation's own web search takes — straight to the registry,
  // past both the engine and the executor.
  const result = await h.engine.skills.invoke('web.search', { query: 'porn' }, io(h));
  assert.isFalse(result.ok);
  assert.match(String(result.error), /don't search for, open, or play pornography/);
  assert.deepEqual(h.journal.urls, []);
});

test('policy: a refused plan is never announced or confirmed', async () => {
  const h = harness();
  const outcome = await h.engine.run(
    {
      source: 'grammar',
      intent: 'test.explicit',
      steps: [
        { skill: 'web.open', args: { url: 'https://xvideos.com' } },
        { skill: 'clipboard.copy', args: { text: 'after' } },
      ],
      confidence: 1,
    },
    io(h),
  );

  assert.isFalse(outcome.ok);
  assert.equal(outcome.ran, 0);
  assert.isTrue(outcome.aborted);
  assert.deepEqual(h.confirmsAsked, []); // no confirm card for the first step
  assert.notMatch(h.said.join(' '), /Right —/); // and no "here's what I'll do"
  assert.deepEqual(h.journal.urls, []);
  assert.equal(h.journal.clipboard, ''); // the rest of the plan never ran
});

test('policy: a clicked result row is screened like anything else', async () => {
  const h = harness();
  const outcome = await h.engine.run(
    {
      source: 'grammar',
      intent: 'row.click',
      steps: [{ skill: 'research.open', args: { url: 'https://pornhub.com/view' } }],
      confidence: 1,
    },
    io(h),
  );
  assert.isFalse(outcome.ok);
  assert.deepEqual(h.web.fetchedUrls, []);
});

test('policy: explicit results from a legitimate search are dropped, not rendered', async () => {
  const h = harness();
  h.web.results['best free movies'] = [
    FORTNITE_RESULTS[0]!,
    {
      title: 'Free XXX videos — watch now',
      url: 'https://xvideos.com/free',
      snippet: 'Thousands of free porn videos.',
    },
    {
      title: 'Adult movies streaming',
      url: 'https://totally-unknown-host.example/adult',
      snippet: 'Watch explicit adult video content free.',
    },
  ];

  await h.engine.ask('search the internet for best free movies', io(h));

  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0]?.title, FORTNITE_RESULTS[0]?.title);
  // The unknown host proves the filter is not just the hostname list.
  assert.notInclude(JSON.stringify(h.rows), 'totally-unknown-host');
});

test('policy: a fetched page that turns out to be explicit is not read back', async () => {
  const h = harness();
  h.web.pages['https://redirector.example/go'] = {
    title: 'Free porn videos',
    url: 'https://pornhub.com/view',
    text: 'Explicit body text that must never be returned.',
  };
  const result = await h.engine.skills.invoke(
    'research.open',
    { url: 'https://redirector.example/go' },
    io(h),
  );
  assert.isFalse(result.ok);
  assert.notInclude(JSON.stringify(result), 'must never be returned');
});

test('policy: the bus records the reason and never the request', async () => {
  const h = harness();
  const seen: unknown[] = [];
  h.engine.bus.on('engine:refused', (payload) => seen.push(payload));

  await h.engine.ask('search the web for porn', io(h));

  assert.deepEqual(seen, [{ reason: 'explicit' }]);
  assert.notInclude(JSON.stringify(seen), 'porn');
});

test("policy: the user's own words are not censored, only destinations", async () => {
  const h = harness();
  // Writing and storing text is not fetching it. A note about a sexual health
  // appointment is the user's own writing, and blocking it would make this a
  // maturity filter — which it deliberately is not.
  const note = await h.engine.skills.invoke(
    'notes.add',
    { text: 'ask the doctor about sex and contraception' },
    io(h),
  );
  assert.isTrue(note.ok);

  const words = await h.engine.skills.invoke('text.count', { text: 'porn' }, io(h));
  assert.isTrue(words.ok);
});

test('policy: ordinary commands are untouched by any of this', async () => {
  const h = harness();
  await h.engine.ask('google cast iron pans', io(h));
  assert.equal(h.journal.urls.length, 1);
  assert.match(h.journal.urls[0]!, /cast/i);
});

// ---- casual language, typos, and sites ------------------------------------
//
// The bar these hold is not "Atlas answers" but "Atlas acts, locally". Every
// one of them asserts the machine actually did something — a URL opened, an
// app launched — and several assert that the external-model paragraph did
// NOT appear, because that message showing up for "open youtube" was the
// original complaint.

const MODEL_EXCUSE = /needs an external model|optional and off by default/;

test('sites: "open youtube" opens YouTube rather than hunting for an app', async () => {
  const h = harness();
  await h.engine.ask('open youtube', io(h));
  assert.lengthOf(h.journal.urls, 1);
  assert.match(h.journal.urls[0]!, /youtube\.com/);
  assert.notMatch(h.said.join(' '), MODEL_EXCUSE);
});

test('sites: a misspelled site still resolves', async () => {
  for (const phrasing of ['open youtub', 'open youtbe', 'go to youtbe', 'open yotube']) {
    const h = harness();
    await h.engine.ask(phrasing, io(h));
    assert.lengthOf(h.journal.urls, 1, phrasing);
    assert.match(h.journal.urls[0]!, /youtube\.com/, phrasing);
  }
});

test('sites: "go to" and "visit" reach a site the same way "open" does', async () => {
  for (const phrasing of ['go to reddit', 'visit github', 'take me to wikipedia']) {
    const h = harness();
    await h.engine.ask(phrasing, io(h));
    assert.lengthOf(h.journal.urls, 1, phrasing);
  }
});

test('sites: an installed app beats a site of the same name', async () => {
  const h = harness();
  // Discord is both a program on this machine and discord.com. The one that
  // is installed is the one that was meant.
  await h.engine.ask('open discord', io(h));
  assert.deepEqual(h.journal.launched, ['discord']);
  assert.lengthOf(h.journal.urls, 0);
});

test('sites: "on Google" is a destination, not part of the name', async () => {
  const h = harness();
  await h.engine.ask('yo and open Youtube on Google', io(h));
  assert.lengthOf(h.journal.urls, 1);
  assert.match(h.journal.urls[0]!, /youtube\.com/);
  assert.notMatch(h.said.join(' '), MODEL_EXCUSE);
});

test('sites: an unknown name with a browser named means look it up', async () => {
  const h = harness();
  await h.engine.ask('open kingfisher nesting habits on google', io(h));
  assert.lengthOf(h.journal.urls, 1);
  assert.match(h.journal.urls[0]!, /google\.com\/search/);
  assert.match(h.journal.urls[0]!, /kingfisher/i);
});

// ---- naming an actual browser, not just "the internet" ---------------------
//
// "on Google"/"in my browser" above are stand-ins for the default handler —
// there is only ever one reasonable reading. "on Brave" is different: it
// names a real, distinct application, and honouring it means resolving that
// name against `listApps()` (`resolveAppName`, the same resolver `app.open`
// uses) and handing the URL to *that* app directly — `platform.openUrl`
// only ever reaches the OS default, which may not be the one asked for.

test('sites: "on Brave" opens the site with Brave specifically, not the default handler', async () => {
  const h = harness();
  await h.engine.ask('open youtube on brave', io(h));
  assert.lengthOf(h.journal.urls, 0);
  assert.lengthOf(h.journal.urlsWithApp, 1);
  assert.equal(h.journal.urlsWithApp[0]!.appId, 'brave');
  assert.match(h.journal.urlsWithApp[0]!.url, /youtube\.com/);
});

test('sites: an unknown name with a specific browser named still looks it up, in that browser', async () => {
  const h = harness();
  await h.engine.ask('open kingfisher nesting habits on firefox', io(h));
  assert.lengthOf(h.journal.urls, 0);
  assert.lengthOf(h.journal.urlsWithApp, 1);
  assert.equal(h.journal.urlsWithApp[0]!.appId, 'firefox');
  assert.match(h.journal.urlsWithApp[0]!.url, /google\.com\/search/);
  assert.match(h.journal.urlsWithApp[0]!.url, /kingfisher/i);
});

test('sites: a named browser that is not installed is a clean error, not a fallback to the default', async () => {
  const h = harness();
  const outcome = await h.engine.ask('open youtube on vivaldi', io(h));
  assert.isFalse(outcome.ok);
  assert.lengthOf(h.journal.urls, 0);
  assert.lengthOf(h.journal.urlsWithApp, 0);
  assert.match(h.said.join(' '), /vivaldi/i);
});

test('casual: greetings and politeness are stripped, not answered', async () => {
  for (const phrasing of [
    'hey can you open youtube',
    'please open youtube',
    'can you go to youtube for me',
    'yo open youtube',
    'could you please open youtube thanks',
    'hey atlas, open youtube',
  ]) {
    const h = harness();
    await h.engine.ask(phrasing, io(h));
    assert.lengthOf(h.journal.urls, 1, phrasing);
    assert.match(h.journal.urls[0]!, /youtube\.com/, phrasing);
    assert.notMatch(h.said.join(' '), MODEL_EXCUSE, phrasing);
  }
});

test('casual: filler stripping does not eat meaningful words', () => {
  // "not" and "my" change the instruction; "all" changes its scope.
  assert.equal(stripFiller('please do not open steam'), 'do not open steam');
  assert.equal(stripFiller('hey open my downloads folder'), 'open my downloads folder');
  assert.equal(stripFiller('can you delete all my notes'), 'delete all my notes');
  // A message that is only filler is left alone — there is no instruction in it.
  assert.equal(stripFiller('hey'), 'hey');
  assert.equal(stripFiller('thanks'), 'thanks');
});

test('casual: a browser hint is told apart from a specific browser name', () => {
  // "Google"/"the web"/"my browser" are stand-ins for "the default handler" —
  // there is no app to resolve, so `browser` stays undefined even though a
  // hint was there.
  assert.deepEqual(splitBrowserHint('youtube on google'), {
    text: 'youtube',
    wantsBrowser: true,
    browser: undefined,
  });
  assert.deepEqual(splitBrowserHint('youtube in my browser'), {
    text: 'youtube',
    wantsBrowser: true,
    browser: undefined,
  });
  // A real, distinct application is named — this is what a caller resolves
  // against `listApps()` rather than handing to the OS default handler.
  assert.deepEqual(splitBrowserHint('youtube on brave'), {
    text: 'youtube',
    wantsBrowser: true,
    browser: 'brave',
  });
  assert.deepEqual(splitBrowserHint('youtube using Firefox'), {
    text: 'youtube',
    wantsBrowser: true,
    browser: 'firefox',
  });
  // No hint at all.
  assert.deepEqual(splitBrowserHint('youtube'), { text: 'youtube', wantsBrowser: false });
});

test('casual: a filler-wrapped request still routes to the right skill', async () => {
  const h = harness();
  await h.engine.ask('hey can you open steam please', io(h));
  assert.deepEqual(h.journal.launched, ['steam']);
});

test('apps: misspelled installed names still launch', async () => {
  const cases: Array<[string, string]> = [
    ['open disocrd', 'discord'],
    ['open fortnigt', 'fortnite'],
    ['open steem', 'steam'],
    ['open firefx', 'firefox'],
  ];
  for (const [phrasing, id] of cases) {
    const h = harness();
    await h.engine.ask(phrasing, io(h));
    assert.deepEqual(h.journal.launched, [id], phrasing);
  }
});

test('apps: a short name is not fuzzily turned into a different one', async () => {
  const h = harness();
  // Four letters, one edit from several things. Guessing here is a coin flip,
  // so nothing should launch.
  await h.engine.ask('open codz', io(h));
  assert.lengthOf(h.journal.launched, 0);
});

test('errors: an unresolvable instruction asks, it does not blame a missing model', async () => {
  const h = harness();
  await h.engine.ask('open zzzqqq', io(h));
  const said = h.said.join(' ');
  assert.notMatch(said, MODEL_EXCUSE);
  assert.match(said, /couldn't (?:work out|figure out)/i);
});

test('errors: a real question is answered honestly, without blaming a model', async () => {
  const h = harness();
  await h.engine.ask('what is the capital of Peru?', io(h));
  const said = h.said.join(' ');
  // The reply Atlas cannot give is still a reply. What it must not be is an
  // explanation of an unconfigured setting the user never asked about.
  assert.notMatch(said, MODEL_EXCUSE);
  assert.match(said, /can't answer that one/i);
  assert.match(said, /search the web/i);
});

// ---- leading-verb typo correction (text/verb-typo.ts) -----------------------
//
// "openn fortnite" and "launh fortnite" used to miss every grammar rule —
// each one is anchored on a literal verb — and, whenever a provider happened
// to be configured, land on "I couldn't reach that provider," which is an
// implementation detail leaking out over a single mistyped letter.
// `correctLeadingVerb` fixes only the first word, only when exactly one real
// verb is close enough to be unambiguous, and runs before any grammar rule
// sees the text — so what happens next, confirmation gates included, is
// exactly what would have happened had the verb been spelled correctly.

test('typos: an obvious typo in the verb still opens the right app', async () => {
  const cases = ['openn fortnite', 'open fortnitee', 'launh fortnite', 'launh fortnitee'];
  for (const phrasing of cases) {
    const h = harness();
    await h.engine.ask(phrasing, io(h));
    assert.deepEqual(h.journal.launched, ['fortnite'], phrasing);
  }
});

test('typos: a typo that used to fall through to the provider error no longer does', async () => {
  const offline = makeProvider({ error: 'offline' });
  const h = harness(undefined, { provider: offline });
  await h.engine.ask('openn fortnite', io(h));
  assert.deepEqual(h.journal.launched, ['fortnite']);
  // The provider was never even asked — the typo never left tier 1.
  assert.equal(offline.prompts.length, 0);
  assert.notMatch(h.said.join(' '), /couldn't reach that provider/);
});

test('typos: an already-correct verb is never second-guessed', async () => {
  const h = harness();
  await h.engine.ask('open fortnite', io(h));
  assert.deepEqual(h.journal.launched, ['fortnite']);
});

test('typos: a typo too short to correct safely falls through exactly as before', async () => {
  // Four letters and under gets no typo budget at all (`typoBudget`) — the
  // same conservatism `fuzzy.ts` already applies to app names, applied here
  // to verbs: "og" is a coin flip between "go" and nothing, not a correction.
  const h = harness();
  const result = await h.engine.ask('og to my downloads', io(h));
  assert.lengthOf(h.journal.launched, 0);
  assert.isFalse(result.ok);
});

// ---- mechanism-wrapper stripping (text/normalize.ts) ------------------------
//
// "use keyboard and mouse control to open Chrome" used to miss `appOpen` the
// same way a greeting does — the verb isn't the first word — fall through
// triage into the AI planner, and land on "I couldn't reach that provider"
// whenever no provider was configured or the one configured was offline.
// Naming a mechanism is not a reason to need a model: "open Chrome" already
// means launch it however gets there fastest.

test('mechanism wrapper: "use keyboard and mouse control to open X" still opens X, no provider asked', async () => {
  const offline = makeProvider({ error: 'offline' });
  const h = harness(undefined, { provider: offline });
  await h.engine.ask('use keyboard and mouse control to open steam', io(h));
  assert.deepEqual(h.journal.launched, ['steam']);
  assert.equal(offline.prompts.length, 0);
  assert.notMatch(h.said.join(' '), /couldn't reach that provider/);
});

test('mechanism wrapper: other phrasings of the same wrapper all resolve the same way', async () => {
  const cases = [
    'using the mouse and keyboard to open discord',
    'via keyboard control to open fortnite',
    'with the mouse to open steam',
  ];
  const targets = ['discord', 'fortnite', 'steam'];
  for (let i = 0; i < cases.length; i++) {
    const h = harness();
    await h.engine.ask(cases[i], io(h));
    assert.deepEqual(h.journal.launched, [targets[i]], cases[i]);
  }
});

test('mechanism wrapper: a literal coordinate instruction still resolves correctly once wrapped', async () => {
  const h = harness();
  await h.engine.ask('use the mouse to click at 500, 300', io(h));
  assert.deepEqual(h.journal.clicks, [{ x: 500, y: 300, button: 'left', double: false }]);
});

test("typos: a destructive verb, typo'd, still asks before deleting — same gate as spelled correctly", async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('delet D:\\Dev\\old.txt', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.deleted, []);
});

test("typos: approving a typo'd destructive verb deletes, once confirmed — nothing bypassed the gate", async () => {
  const h = harness();
  await h.engine.ask('delet D:\\Dev\\old.txt', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.deleted, ['D:\\Dev\\old.txt']);
});

test('verb-typo: declines rather than guessing when two verbs tie', () => {
  // "mtake" is one edit from both "take" and "make" — verified by brute
  // force over the real vocabulary, not hand-picked to look plausible.
  // Guessing here means guessing which of two different actions was meant,
  // which this module refuses to do.
  assert.isNull(correctLeadingVerb('mtake fortnite'));
});

test('verb-typo: only the first word is ever touched', () => {
  assert.equal(correctLeadingVerb('openn my launh folder'), 'open my launh folder');
});

test('verb-typo: an exact verb is returned as-is with nothing to correct', () => {
  assert.isNull(correctLeadingVerb('open fortnite'));
  assert.isNull(correctLeadingVerb(''));
});

test('fuzzy: the matcher is shared, not app-specific', () => {
  const fruit = [{ name: 'Pineapple' }, { name: 'Blueberry' }];
  assert.equal(confidentMatch(rankMatches(fruit, 'pineaple', (f) => f.name))?.name, 'Pineapple');
  assert.equal(confidentMatch(rankMatches(fruit, 'bluberry', (f) => f.name))?.name, 'Blueberry');
  assert.isNull(confidentMatch(rankMatches(fruit, 'zzzzzzzz', (f) => f.name)));
  // aliases are just more names for the same item
  const sites = [{ name: 'X', aliases: ['twitter'] }];
  assert.isNotNull(confidentMatch(rankMatches(sites, 'twiter', (s) => [s.name, ...s.aliases])));
});

test('fuzzy: transpositions cost one, which is what rescues real typos', () => {
  assert.equal(editDistance('youtbe', 'youtube', 3), 1);
  assert.equal(editDistance('steelseires', 'steelseries', 3), 1);
});

test('sites: resolveSite refuses to guess between equally close names', () => {
  assert.equal(resolveSite('youtube')?.name, 'YouTube');
  assert.equal(resolveSite('yt')?.name, 'YouTube');
  assert.equal(resolveSite('twitter')?.name, 'X');
  assert.isNull(resolveSite('qwertyuiop'));
});

test('policy: the tidied text is screened too, so filler is not a way around it', async () => {
  const h = harness();
  const outcome = await h.engine.ask('hey can you please open pornhub for me', io(h));
  assert.equal(outcome.error, 'refused:explicit');
  assert.lengthOf(h.journal.urls, 0);
});

// ---- affirmations --------------------------------------------------------------
//
// A confirmation can be answered out loud, which needs the small closed set of
// ways people say yes and no. Deterministic on purpose: this is not a job that
// wants a model, and a model that occasionally reads "no" as agreement would be
// answering "shall I delete this?" on your behalf.

test('affirmation: plain yes and no', () => {
  assert.equal(readAffirmation('yes'), 'yes');
  assert.equal(readAffirmation('no'), 'no');
  assert.equal(readAffirmation('yeah'), 'yes');
  assert.equal(readAffirmation('nope'), 'no');
  assert.equal(readAffirmation('do it'), 'yes');
  assert.equal(readAffirmation('cancel'), 'no');
});

test('affirmation: punctuation and case are noise', () => {
  assert.equal(readAffirmation('Yes!'), 'yes');
  assert.equal(readAffirmation('  YES.  '), 'yes');
  assert.equal(readAffirmation('No, thanks'), 'no');
  assert.equal(readAffirmation("Don't"), 'no');
});

test('affirmation: a whole sentence is not an answer', () => {
  // The point of the null: "no, open Firefox instead" is an instruction that
  // begins with a refusal, and reading it as a bare "no" throws the rest away.
  assert.equal(readAffirmation('no, open firefox instead'), null);
  assert.equal(readAffirmation('yes and then open steam'), null);
  assert.equal(readAffirmation('what can you do?'), null);
  assert.equal(readAffirmation(''), null);
});

test('affirmation: never matches a word inside another', () => {
  // The reason the table is whole-utterance rather than prefix-matched.
  assert.equal(readAffirmation('yesterday'), null);
  assert.equal(readAffirmation('notes'), null);
  assert.equal(readAffirmation('november'), null);
});

// ---- opening things by name ----------------------------------------------------
//
// Every case here is one Brandon actually hit. "open File Explorer" offered to
// be taught what File Explorer meant, and "open open steam" said the same — both
// because a rule claimed the phrase before the rule that could have handled it.

test('the shells open, despite their names containing file words', async () => {
  const h = harness();
  await h.engine.ask('open file explorer', io(h));
  assert.deepEqual(h.journal.systemTools, ['file-explorer']);
});

test('this pc and the recycle bin open too', async () => {
  const h = harness();
  await h.engine.ask('open this pc', io(h));
  await h.engine.ask('open the recycle bin', io(h));
  assert.deepEqual(h.journal.systemTools, ['this-pc', 'recycle-bin']);
});

test('emptying the recycle bin is still not opening it', () => {
  const h = harness();
  // The word "recycle bin" appears in both, so the open rule has to decline
  // the destructive phrasing or it would quietly swallow it.
  assert.equal(
    h.engine.grammar.parse('empty the recycle bin')?.steps[0].skill,
    'system.emptyRecycleBin',
  );
});

test('a stuttered verb still opens the app', async () => {
  const h = harness();
  await h.engine.ask('open open steam', io(h));
  assert.deepEqual(h.journal.launched, ['steam']);
});

test('peeling a stuttered verb never steals from an app named after one', async () => {
  const h = harness();
  await h.engine.ask('open open cut', io(h));
  // "Open Cut" matches on the first attempt, so the retry never runs.
  assert.deepEqual(h.journal.launched, ['opencut']);
});

test('a remembered name still needs the possessive that taught it', () => {
  const h = harness();
  assert.equal(h.engine.grammar.parse('open my work folder')?.steps[0].skill, 'files.openAlias');
  // Without "my" this is a request to open something called that, not a
  // lookup of a name Atlas was taught.
  assert.notEqual(h.engine.grammar.parse('open file explorer')?.steps[0].skill, 'files.openAlias');
});

test('a remembered name no longer has to be about files', () => {
  const h = harness();
  const parsed = h.engine.grammar.parse('open my gaming rig');
  assert.equal(parsed?.steps[0].skill, 'files.openAlias');
  assert.equal(parsed?.steps[0].args.subject, 'gaming rig');
});

test('plain file talk still belongs to the file rules', () => {
  const h = harness();
  // The veto that was too blunt still has to fire when the target really is
  // nothing but a file noun.
  assert.notEqual(h.engine.grammar.parse('open documents')?.steps[0].skill, 'app.open');
});

test('a target made only of file nouns is still file talk', () => {
  const h = harness();
  // Two file nouns, not one — the veto strips all of them, so this stays away
  // from app.open even though removing the first would leave "folder" behind.
  assert.notEqual(h.engine.grammar.parse('open invoice folder')?.steps[0].skill, 'app.open');
  assert.notEqual(h.engine.grammar.parse('open the pdf document')?.steps[0].skill, 'app.open');
});

// ---- the policy, after opening stopped being confirm-gated ---------------------
//
// Thirteen skills moved from `risk: 'confirm'` to `safe`, and most of them are
// the outward-reaching ones — web.search, searchImages, web.open, openBrowser.
// A confirm card used to put a human between an explicit query and the browser.
// It no longer does, so these pin that the card was never what was stopping it:
// the policy sits at the registry, below risk, and is unaffected by the change.

test('policy: every skill that stopped asking still refuses explicit work', async () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['web.search', { query: 'porn' }],
    ['web.searchImages', { query: 'porn' }],
    ['web.searchYoutube', { query: 'porn' }],
    ['web.open', { url: 'https://xvideos.com' }],
    // `name`, not `url`: this skill opens *a browser*, never a destination, so
    // its only destination-shaped argument is the one it actually takes.
    ['web.openBrowser', { name: 'porn' }],
    ['app.open', { name: 'porn' }],
  ];

  for (const [skill, args] of cases) {
    const h = harness();
    const result = await h.engine.skills.invoke(skill, args, io(h));
    assert.isFalse(result.ok, `${skill} ran when it should have refused`);
    assert.match(String(result.error), /don't search for, open, or play pornography/, skill);
    assert.deepEqual(h.journal.urls, [], `${skill} reached the browser`);
    assert.deepEqual(h.web.searchedQueries, [], `${skill} reached a search`);
  }
});

test('policy: a now-unconfirmed search is still refused end to end', async () => {
  const h = harness();
  // Previously a card stood between this and the browser. Now nothing does
  // except the policy, which is the point of the test.
  const outcome = await h.engine.ask('search for images of porn', io(h));
  assert.isFalse(outcome.ok);
  assert.deepEqual(h.confirmsAsked, []);
  assert.deepEqual(h.web.searchedQueries, []);
  assert.deepEqual(h.journal.urls, []);
});

/**
 * Voice hears the refusal.
 *
 * The refusal goes out through `io.say`, which is the same channel the spoken
 * reply reads from — so in the voice screen it is heard, not merely displayed.
 * That matters because the alternative is the failure confirmations had: a
 * message that exists only on a card, and an assistant that appears to have
 * gone quiet for no reason.
 */
test('policy: a refusal is said, so voice mode hears it too', async () => {
  const h = harness();
  await h.engine.ask('play some porn', io(h));
  assert.isNotEmpty(h.said, 'the refusal never reached the channel speech reads');
  assert.match(h.said.join(' '), /don't search for, open, or play pornography/);
});

test('policy: a spoken request is screened exactly like a typed one', async () => {
  // Voice reaches the engine through the same `ask` a keystroke does — there
  // is no second entry point — so this pins that equivalence rather than the
  // transport. If a voice-only path is ever added, this is the test that has
  // to be given a reason to still pass.
  const h = harness();
  const typed = await h.engine.ask('search the web for porn', io(h));
  const spoken = await h.engine.ask('Search the web for porn.', io(h));
  assert.equal(typed.error, 'refused:explicit');
  assert.equal(spoken.error, 'refused:explicit');
});

// ---- the network (Phase 11's first pack) ---------------------------------------
//
// All reads, so all `safe` — none of these should produce a confirmation card.
// The fixture is a wired desktop with no wireless, because that is the machine
// this was written on and it is the case an implementation is most likely to
// answer wrongly.

test('network: the IP answer picks the adapter carrying traffic', async () => {
  const h = harness();
  await h.engine.ask('what is my ip address', io(h));
  // Loopback also has an address; the one with a gateway is the answer.
  assert.match(h.said.join(' '), /192\.168\.77\.101/);
  assert.notMatch(h.said.join(' '), /127\.0\.0\.1/);
  assert.deepEqual(h.confirmsAsked, []);
});

test('network: no wireless hardware is said plainly, not reported as disconnected', async () => {
  const h = harness();
  await h.engine.ask('what wifi am I on', io(h));
  // "Wi-Fi is off" would be untrue on a machine that has none.
  assert.match(h.said.join(' '), /doesn.t have Wi-Fi/i);
});

test('network: no saved networks is an answer, not a failure', async () => {
  const h = harness();
  assert.equal(
    h.engine.grammar.parse('what wifi networks do I have saved')?.steps[0]?.skill,
    'net.savedNetworks',
  );
  const outcome = await h.engine.ask('what wifi networks do I have saved', io(h));
  assert.isTrue(outcome.ok);
  assert.match(h.said.join(' '), /No saved Wi-Fi networks/i);
});

test('network: being online is reported', async () => {
  const h = harness();
  await h.engine.ask('am I online', io(h));
  assert.match(h.said.join(' '), /connection is working/i);
});

test('network: adapters come back as rows', async () => {
  const h = harness();
  await h.engine.ask('show my network adapters', io(h));
  assert.isNotEmpty(h.rows);
});

test('network: "ip" never matches inside another word', () => {
  const h = harness();
  // The reason those \b boundaries are in the rule. Without them this rule
  // claims anything containing "zip", "clip" or "recipe".
  const parsed = h.engine.grammar.parse('unzip my downloads');
  assert.notEqual(parsed?.steps[0].skill, 'net.ip');
});

test('network: reading the network never asks permission', async () => {
  const h = harness();
  for (const skill of ['net.adapters', 'net.ip', 'net.wifi', 'net.savedNetworks', 'net.online']) {
    assert.equal(h.engine.skills.get(skill)?.risk, 'safe', skill);
  }
});

// ---- services (Phase 11's second pack) -----------------------------------------
//
// The first group that can change the machine, so these cover three things the
// network pack had no way to: that a friendly name resolves to the right
// service, that an ambiguous one asks rather than guesses, and that the tier
// above `confirm` — refused outright — actually holds.

test('services: running ones are what "what services are running" means', async () => {
  const h = harness();
  await h.engine.ask('what services are running', io(h));
  // Two of the five fixtures are running. Answering with all five would be
  // answering a question nobody asked.
  assert.equal(h.rows.length, 2);
  assert.deepEqual(h.confirmsAsked, []);
});

test('services: "list all services" really does mean all of them', async () => {
  const h = harness();
  await h.engine.ask('list all services', io(h));
  assert.equal(h.rows.length, 5);
});

test('services: a friendly name finds the service behind it', async () => {
  const h = harness();
  await h.engine.ask('is the print spooler service running', io(h));
  // "Print Spooler" is the display name; "Spooler" is what Windows takes.
  // ⚠️ The clause, not the bare setting: `sc` reports "automatic", and
  // interpolating that straight in says "starts automatic". The real app said
  // exactly that before this was fixed.
  assert.match(h.said.join(' '), /Print Spooler is stopped, and starts automatically\./);
});

test('services: an ambiguous name offers the candidates instead of guessing', async () => {
  const h = harness();
  await h.engine.ask('is the update service running', io(h));
  // "Windows Update" and "Windows Update Medic Service" both contain it, and
  // neither is a better reading than the other. Picking one silently is how
  // the wrong service gets stopped.
  assert.equal(h.rows.length, 2);
  assert.notMatch(h.said.join(' '), /is (running|stopped)/);
});

test('services: an exact display name beats the longer one it is a prefix of', async () => {
  const h = harness();
  // "Windows Update" is also the start of "Windows Update Medic Service", so
  // a resolver that stopped at the prefix pass would call this ambiguous. An
  // exact name is not ambiguous, whatever else it happens to prefix.
  await h.engine.ask('is the windows update service running', io(h));
  assert.deepEqual(h.rows, []);
  assert.match(h.said.join(' '), /Windows Update is stopped/);
});

test('services: resolution prefers an exact short name over a partial display match', () => {
  const services = [
    {
      name: 'Spooler',
      display: 'Print Spooler',
      state: 'STOPPED',
      running: false,
      protected: false,
    },
    {
      name: 'PrintNotify',
      display: 'Printer Extensions and Notifications',
      state: 'RUNNING',
      running: true,
      protected: false,
    },
  ];
  const match = resolveService(services, 'spooler');
  assert.equal(match.kind, 'one');
  assert.equal(match.kind === 'one' ? match.entry.name : '', 'Spooler');
});

test('services: "the X service" is stripped down to X before resolving', () => {
  const services = [
    {
      name: 'Spooler',
      display: 'Print Spooler',
      state: 'STOPPED',
      running: false,
      protected: false,
    },
  ];
  for (const phrasing of ['the print spooler service', 'Print Spooler', 'spooler', 'the spooler']) {
    assert.equal(resolveService(services, phrasing).kind, 'one', phrasing);
  }
});

test('services: starting one asks first, then does it', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('start the print spooler service', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.services, [{ name: 'Spooler', action: 'start' }]);
  assert.match(h.said.join(' '), /Print Spooler is running now/);
});

test('services: declining the card leaves the machine alone', async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('stop the print spooler service', io(h));
  assert.deepEqual(h.journal.services, []);
});

/**
 * The tier above `confirm`.
 *
 * The roadmap's risk model has three levels, not two: read, confirm, and
 * refused outright. Until this pack the third had no way to be expressed —
 * every dangerous action could only be put behind a card. A card in front of
 * "stop RPC" is worse than useless: it is the specific mechanism by which
 * people learn to click through the cards that matter.
 */
test('services: a service the machine cannot lose is refused, not confirmed', async () => {
  const h = harness();
  h.confirmAnswer = true; // Even with a willing user.
  await h.engine.ask('stop the rpcss service', io(h));

  assert.deepEqual(h.journal.services, [], 'it reached the machine anyway');
  assert.deepEqual(h.confirmsAsked, [], 'a card was drawn in front of a refusal');
  assert.match(h.said.join(' '), /won.t stop/i);
});

test('services: the refusal also holds for a name the guard cannot see', async () => {
  const h = harness();
  h.confirmAnswer = true;
  // "remote procedure call" is the display name, so the guard's list of short
  // names does not match it — the check against the *resolved* service is what
  // catches this one, which is why both exist.
  const outcome = await h.engine.ask('stop the remote procedure call service', io(h));
  assert.isFalse(outcome.ok);
  assert.deepEqual(h.journal.services, []);
});

test('services: the guard holds even when a skill is invoked directly', async () => {
  // The executor checks the guard so no card is drawn; the registry checks it
  // so a caller that never went through the executor is still covered. This
  // pins the second one, which is the guarantee.
  const h = harness();
  const result = await h.engine.skills.invoke('service.stop', { name: 'rpcss' }, io(h));
  assert.isFalse(result.ok);
  assert.deepEqual(h.journal.services, []);
});

/**
 * ⚠️ The collision that decided the grammar's ordering.
 *
 * `systemPower` claims /restart.*windows/, and "restart the Windows Update
 * service" contains both. At any order below it, asking to restart a service
 * would have restarted the computer.
 */
test('services: "restart the windows update service" does not reboot the machine', async () => {
  const h = harness();
  const parsed = h.engine.grammar.parse('restart the windows update service');
  assert.equal(parsed?.steps[0]?.skill, 'service.restart');
});

test('services: a process question is still a process question', () => {
  const h = harness();
  // The word "service" is what separates the two. Without it this is about
  // what is running on the machine, which Atlas already answers.
  assert.equal(h.engine.grammar.parse('what is running')?.steps[0]?.skill, 'system.processes');
});

test('services: reading them never asks permission, changing them always does', () => {
  const h = harness();
  assert.equal(h.engine.skills.get('service.list')?.risk, 'safe');
  assert.equal(h.engine.skills.get('service.status')?.risk, 'safe');
  for (const id of ['service.start', 'service.stop', 'service.restart']) {
    assert.equal(h.engine.skills.get(id)?.risk, 'confirm', id);
  }
});

test('services: with no services capability the skills are not merely disabled', () => {
  // Hidden, not disabled — a planner that cannot see them cannot propose them.
  const h = harness(['files', 'fs', 'apps', 'system', 'processes', 'os', 'windows', 'network']);
  const ids = h.engine.skills.available().map((s) => s.id);
  assert.notInclude(ids, 'service.list');
  assert.notInclude(ids, 'service.stop');
});

// ---- environment (the third Phase 11 pack) -------------------------------------
//
// The first pack where the same verb splits into two skills by risk tier
// rather than one skill with a dynamic badge — `environment.set` (your own,
// safe) and `environment.setSystem` (every account, confirm) — because
// `Skill.risk` is checked before anything runs and cannot vary per call.

test('environment: "list my environment variables" means the user scope only', async () => {
  const h = harness();
  await h.engine.ask('list my environment variables', io(h));
  // PATH and JAVA_HOME are both in the user scope; PATH's system entry isn't.
  assert.equal(h.rows.length, 2);
});

test('environment: listing all shows every scope, PATH twice included', async () => {
  const h = harness();
  await h.engine.ask('list all environment variables', io(h));
  assert.equal(h.rows.length, 3);
});

test('environment: a variable defined in both scopes reports both values', async () => {
  const h = harness();
  await h.engine.ask('what is the PATH environment variable', io(h));
  assert.match(h.said.join(' '), /user:.*C:\\Users\\test\\bin/);
  assert.match(h.said.join(' '), /system:.*C:\\Windows\\System32/);
});

test('environment: a variable in one scope only reports just that one', async () => {
  const h = harness();
  await h.engine.ask('what is the JAVA_HOME environment variable', io(h));
  assert.match(h.said.join(' '), /user.*C:\\Java\\jdk-21/);
});

test('environment: an unknown name is an answer, not a crash', async () => {
  const h = harness();
  const outcome = await h.engine.ask('what is the NONESUCH environment variable', io(h));
  assert.isFalse(outcome.ok);
});

test('environment: setting your own variable asks nothing', async () => {
  const h = harness();
  await h.engine.ask('set the environment variable FOO to bar', io(h));
  assert.deepEqual(h.confirmsAsked, []);
  assert.deepEqual(h.journal.environmentSets, [{ name: 'FOO', value: 'bar', scope: 'user' }]);
});

test('environment: a value with spaces and punctuation survives to the platform call', async () => {
  const h = harness();
  await h.engine.ask('set the environment variable FOO to C:\\Program Files\\Java;%PATH%', io(h));
  assert.deepEqual(h.journal.environmentSets, [
    { name: 'FOO', value: 'C:\\Program Files\\Java;%PATH%', scope: 'user' },
  ]);
});

test('environment: setting a system variable asks first', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('set the system environment variable FOO to bar', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.environmentSets, [{ name: 'FOO', value: 'bar', scope: 'system' }]);
});

test('environment: declining the card leaves the machine alone', async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('set the system environment variable FOO to bar', io(h));
  assert.deepEqual(h.journal.environmentSets, []);
});

test('environment: removing your own variable asks nothing', async () => {
  const h = harness();
  await h.engine.ask('remove the environment variable FOO', io(h));
  assert.deepEqual(h.confirmsAsked, []);
  assert.deepEqual(h.journal.environmentDeletes, [{ name: 'FOO', scope: 'user' }]);
});

test('environment: removing a system variable asks first', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('remove the system environment variable FOO', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.environmentDeletes, [{ name: 'FOO', scope: 'system' }]);
});

test('environment: reading is safe, and only the system-wide verbs confirm', () => {
  const h = harness();
  assert.equal(h.engine.skills.get('environment.list')?.risk, 'safe');
  assert.equal(h.engine.skills.get('environment.get')?.risk, 'safe');
  assert.equal(h.engine.skills.get('environment.set')?.risk, 'safe');
  assert.equal(h.engine.skills.get('environment.delete')?.risk, 'safe');
  assert.equal(h.engine.skills.get('environment.setSystem')?.risk, 'confirm');
  assert.equal(h.engine.skills.get('environment.deleteSystem')?.risk, 'confirm');
});

test('environment: with no environment capability the skills are not merely disabled', () => {
  const h = harness(['files', 'fs', 'apps', 'system', 'processes', 'os', 'windows', 'network']);
  const ids = h.engine.skills.available().map((s) => s.id);
  assert.notInclude(ids, 'environment.list');
  assert.notInclude(ids, 'environment.set');
});

// ---- storage (the fourth Phase 11 pack) ----------------------------------------
//
// `system.disk` says how full a drive is; this pack answers what's using the
// space inside one folder, and it's the first group where the destructive
// verb (`emptyFolder`) needed no new platform method at all — just `listDir`
// and `deletePath`, already on the port.

test('storage: a known folder name resolves through knownFolder', async () => {
  const h = harness();
  await h.engine.ask('how big is my downloads folder', io(h));
  assert.match(h.said.join(' '), /C:\\Users\\test\\downloads is using 5\.0 GB across 3 files/);
  assert.deepEqual(h.confirmsAsked, []);
});

test('storage: a folder too big to fully walk says so rather than guessing', async () => {
  const h = harness();
  const result = await h.engine.skills.invoke('storage.folderSize', { path: 'C:\\huge' }, io(h));
  assert.isTrue(result.ok);
  assert.match(result.message ?? '', /too much there to fully measure/);
});

test('storage: largest files come back as rows, biggest first', async () => {
  const h = harness();
  await h.engine.ask('what are the largest files in my downloads folder', io(h));
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[0]!.title, 'video.mp4');
});

test('storage: emptying a folder deletes everything directly inside it', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('empty my downloads folder', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.deleted, [
    'C:\\Users\\test\\downloads\\src',
    'C:\\Users\\test\\downloads\\readme.md',
  ]);
});

test('storage: declining the card leaves the folder alone', async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('empty my downloads folder', io(h));
  assert.deepEqual(h.journal.deleted, []);
});

test('storage: reading is safe, emptying confirms', () => {
  const h = harness();
  assert.equal(h.engine.skills.get('storage.folderSize')?.risk, 'safe');
  assert.equal(h.engine.skills.get('storage.largestFiles')?.risk, 'safe');
  assert.equal(h.engine.skills.get('storage.emptyFolder')?.risk, 'confirm');
});

test('storage: with no storage capability the skills are not merely disabled', () => {
  const h = harness(['files', 'fs', 'apps', 'system', 'processes', 'os', 'windows', 'network']);
  const ids = h.engine.skills.available().map((s) => s.id);
  assert.notInclude(ids, 'storage.folderSize');
  assert.notInclude(ids, 'storage.emptyFolder');
});

// ---- windows (the first pack past Phase 11's original ten) --------------------
//
// Reads and cosmetic changes (list, focus, minimize/maximize/restore, move) are
// `safe`; closing a window is `confirm`, the same "does this change something
// closing a window won't undo" test everything else in this codebase uses —
// applied here to something that is *literally* closing a window.

test('windows: listing shows both, and asks nothing', async () => {
  const h = harness();
  await h.engine.ask('what windows do I have open', io(h));
  assert.equal(h.rows.length, 2);
  assert.deepEqual(h.confirmsAsked, []);
});

test('windows: the active one is reported by title and process', async () => {
  const h = harness();
  await h.engine.ask('what window is active', io(h));
  assert.match(h.said.join(' '), /Untitled - Notepad \(notepad\.exe\)/);
});

test('windows: focusing a named window resolves it and asks nothing', async () => {
  const h = harness();
  await h.engine.ask('focus the notepad window', io(h));
  assert.deepEqual(h.journal.windowActions, [{ id: '1001', action: 'focus' }]);
  assert.deepEqual(h.confirmsAsked, []);
  assert.match(h.said.join(' '), /Switched to Untitled - Notepad/);
});

test('windows: minimize, maximize and restore all resolve by title', async () => {
  const h = harness();
  await h.engine.ask('minimize the discord window', io(h));
  await h.engine.ask('maximize the discord window', io(h));
  await h.engine.ask('restore the discord window', io(h));
  assert.deepEqual(
    h.journal.windowActions,
    ['minimize', 'maximize', 'restore'].map((action) => ({ id: '1002', action })),
  );
});

test('windows: moving one leaves out whatever dimension was not given', async () => {
  const h = harness();
  const outcome = await h.engine.skills.invoke(
    'window.move',
    { name: 'notepad', width: 800, height: 600 },
    io(h),
  );
  assert.isTrue(outcome.ok);
  assert.deepEqual(h.journal.windowBounds, [{ id: '1001', bounds: { width: 800, height: 600 } }]);
});

test('windows: closing one asks first, and does nothing if declined', async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('close the notepad window', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.windowActions, []);
});

test('windows: closing one runs once approved', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('close the notepad window', io(h));
  assert.deepEqual(h.journal.windowActions, [{ id: '1001', action: 'close' }]);
});

test('windows: resolution offers candidates rather than guessing between two', () => {
  const windows = [
    { ...WINDOWS[0]!, id: 'a', title: 'Report - Word', processName: 'winword.exe' },
    { ...WINDOWS[0]!, id: 'b', title: 'Budget - Word', processName: 'winword.exe' },
  ];
  const match = resolveWindow(windows, 'word');
  assert.equal(match.kind, 'many');
});

test('windows: resolution matches a candidate by its own id, not just by title', () => {
  const windows = [
    { ...WINDOWS[0]!, id: 'calc-a', title: 'Calculator', processName: 'CalculatorApp.exe' },
    { ...WINDOWS[0]!, id: 'calc-b', title: 'Calculator', processName: 'ApplicationFrameHost.exe' },
  ];
  const match = resolveWindow(windows, 'calc-b');
  assert.deepEqual(match, { kind: 'one', entry: windows[1] });
});

test('windows: a disambiguation card is clickable, not just speakable — two windows share a title', async () => {
  const candidates = [
    { ...WINDOWS[0]!, id: 'calc-a', title: 'Calculator', processName: 'CalculatorApp.exe' },
    { ...WINDOWS[0]!, id: 'calc-b', title: 'Calculator', processName: 'ApplicationFrameHost.exe' },
  ];
  const minimized: string[] = [];
  const platform = {
    capabilities: async () => ['window-control'],
    listWindows: async () => candidates,
    minimizeWindow: async (id: string) => {
      minimized.push(id);
      return true;
    },
  } as unknown as Platform;
  const minimize = createWindowSkills(platform).find((s) => s.id === 'window.minimize')!;

  const rows: ResultRow[] = [];
  const ctx: SkillContext = {
    say: () => {},
    confirm: async () => true,
    showResults: (items) => rows.push(...items),
  };
  const offered = await minimize.run({ name: 'calculator' }, ctx);
  assert.isTrue(offered.ok);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.actions?.[0]),
    [
      { label: 'Minimize', skill: 'window.minimize', args: { name: 'calc-a' } },
      { label: 'Minimize', skill: 'window.minimize', args: { name: 'calc-b' } },
    ],
  );

  // What clicking the second row actually does: re-run the same skill with
  // that exact id, landing on that window and not the other one.
  const clicked = await minimize.run(rows[1]!.actions![0]!.args, ctx);
  assert.isTrue(clicked.ok);
  assert.deepEqual(minimized, ['calc-b']);
});

test('windows: "close" alone still dismisses Atlas, not a window', () => {
  const h = harness();
  const parsed = h.engine.grammar.parse('close');
  assert.equal(parsed?.steps[0]?.skill, 'atlas.hide');
});

test('windows: reading and repositioning never ask permission; closing always does', () => {
  const h = harness();
  for (const id of [
    'window.list',
    'window.active',
    'window.focus',
    'window.minimize',
    'window.maximize',
    'window.restore',
    'window.move',
  ]) {
    assert.equal(h.engine.skills.get(id)?.risk, 'safe', id);
  }
  assert.equal(h.engine.skills.get('window.close')?.risk, 'confirm');
});

test('windows: with no window-control capability the skills are hidden, not disabled', () => {
  const h = harness(['files', 'fs', 'apps', 'system', 'processes', 'os', 'windows', 'network']);
  const ids = h.engine.skills.available().map((s) => s.id);
  assert.notInclude(ids, 'window.list');
  assert.notInclude(ids, 'window.close');
});

// ---- ending a process ----------------------------------------------------------

test('process: ending one the session cannot lose is refused, not confirmed', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('end explorer.exe', io(h));
  assert.deepEqual(h.journal.endedProcesses, [], 'it reached the machine anyway');
  assert.deepEqual(h.confirmsAsked, [], 'a card was drawn in front of a refusal');
  assert.match(h.said.join(' '), /won.t end/i);
});

test('process: an ordinary one asks first, then ends', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('end chrome.exe', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.endedProcesses, [4242]);
});

test('process: declining the card leaves it running', async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('force close process 4242', io(h));
  assert.deepEqual(h.journal.endedProcesses, []);
});

// ---- synthetic input -------------------------------------------------------------
//
// A click, a key press, typed text — these are mechanisms, not consequences,
// so all of them are `safe`, the same way `window.focus` is despite also
// "operating a window". The one exception is a specific *hotkey* that is a
// known equivalent of an already-`confirm` named action — see the Alt+F4
// tests below.

test('input: moving the mouse and reading its position ask nothing', async () => {
  // No one-shot grammar for coordinates — same scoping decision as
  // `window.move` — so this goes through the registry directly, the way that
  // skill's own test does.
  const h = harness();
  await h.engine.skills.invoke('input.moveMouse', { x: 500, y: 300 }, io(h));
  assert.deepEqual(h.journal.mouseMoves, [{ x: 500, y: 300 }]);
  assert.deepEqual(h.confirmsAsked, []);
});

test('input: scrolling is safe and direction maps to sign', async () => {
  const h = harness();
  await h.engine.ask('scroll down', io(h));
  await h.engine.ask('scroll up 5', io(h));
  assert.deepEqual(h.journal.scrolls, [-3, 5]);
  assert.deepEqual(h.confirmsAsked, []);
});

test('input: pressing a named key runs immediately, asking nothing', async () => {
  const h = harness();
  await h.engine.ask('press enter', io(h));
  assert.deepEqual(h.confirmsAsked, []);
  assert.deepEqual(h.journal.keysPressed, ['enter']);
});

test('input: a hotkey splits into modifiers and one key, asking nothing', async () => {
  const h = harness();
  await h.engine.ask('press ctrl+shift+s', io(h));
  assert.deepEqual(h.confirmsAsked, []);
  assert.deepEqual(h.journal.hotkeys, [{ modifiers: ['ctrl', 'shift'], key: 's' }]);
});

test('input: alt+f4 still asks first — it closes the foreground app, same as window.close', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('press alt+f4', io(h));
  assert.equal(h.confirmsAsked.length, 1);
  assert.deepEqual(h.journal.hotkeys, [{ modifiers: ['alt'], key: 'f4' }]);
});

test('input: alt+f4 is caught whatever the case or modifier order', async () => {
  const h = harness();
  h.confirmAnswer = true;
  await h.engine.ask('press F4+ALT', io(h));
  assert.equal(h.confirmsAsked.length, 1);
});

test('input: declining alt+f4 sends nothing', async () => {
  const h = harness();
  h.confirmAnswer = false;
  await h.engine.ask('press alt+f4', io(h));
  assert.deepEqual(h.journal.hotkeys, []);
});

test('input: typed quoted text is sent verbatim, quotes stripped, asking nothing', async () => {
  const h = harness();
  await h.engine.ask('type "hello there"', io(h));
  assert.deepEqual(h.confirmsAsked, []);
  assert.deepEqual(h.journal.typed, ['hello there']);
});

test('input: click and drag both run immediately', async () => {
  const h = harness();
  await h.engine.skills.invoke('input.click', { x: 10, y: 20 }, io(h));
  assert.deepEqual(h.journal.clicks, [{ x: 10, y: 20, button: 'left', double: false }]);
  await h.engine.skills.invoke('input.drag', { fromX: 0, fromY: 0, toX: 5, toY: 5 }, io(h));
  assert.deepEqual(h.journal.drags, [{ fromX: 0, fromY: 0, toX: 5, toY: 5, button: 'left' }]);
  assert.deepEqual(h.confirmsAsked, []);
});

test('input: risk matches consequence, not input method', () => {
  const h = harness();
  for (const id of [
    'input.moveMouse',
    'input.cursorPosition',
    'input.scroll',
    'input.click',
    'input.drag',
    'input.pressKey',
    'input.hotkey',
    'input.typeText',
  ]) {
    assert.equal(h.engine.skills.get(id)?.risk, 'safe', id);
  }
  // The static declaration is `safe` — it's `riskFor` that escalates the one
  // combination that isn't.
  const hotkey = h.engine.skills.get('input.hotkey');
  assert.equal(hotkey?.riskFor?.({ combo: 'ctrl+c' }), undefined);
  assert.equal(hotkey?.riskFor?.({ combo: 'alt+f4' }), 'confirm');
});

test('input: with no input capability the skills are hidden, not disabled', () => {
  const h = harness([
    'files',
    'fs',
    'apps',
    'system',
    'processes',
    'os',
    'windows',
    'window-control',
    'network',
  ]);
  const ids = h.engine.skills.available().map((s) => s.id);
  assert.notInclude(ids, 'input.click');
  assert.notInclude(ids, 'input.moveMouse');
});

// ---- UI Automation ---------------------------------------------------------------
//
// Reading the tree, and what's focused, are `safe` — and so, now, is every
// action. UIA is the more precise way to click/type than a raw coordinate
// is, so it would be backwards for it to ask more often than `input.*` does;
// see that section's own comment for the mechanism-vs-consequence reasoning
// this shares.

test('uia: the tree resolves the window by name and lists its controls', async () => {
  const h = harness();
  const outcome = await h.engine.skills.invoke('uia.tree', { window: 'notepad' }, io(h));
  assert.isTrue(outcome.ok);
  // Root + text field + button.
  assert.equal(h.rows.length, 3);
  assert.deepEqual(h.confirmsAsked, []);
});

test('uia: an unknown window name is a clean error, not a crash', async () => {
  const h = harness();
  const outcome = await h.engine.skills.invoke('uia.tree', { window: 'nonexistent' }, io(h));
  assert.isFalse(outcome.ok);
});

test('uia: invoking a control resolves the window and acts', async () => {
  // No one-shot grammar for a window-plus-path action — same scoping
  // decision as `window.move` and `input.click` — so this is the AI
  // planner's job in the real app; here it goes through the registry
  // directly, the way those skills' own tests do.
  const h = harness();
  const outcome = await h.engine.skills.invoke(
    'uia.invoke',
    { window: 'notepad', path: '1' },
    io(h),
  );
  assert.isTrue(outcome.ok);
  assert.deepEqual(h.journal.uiaInvokes, [{ id: '1001', path: [1] }]);
});

test('uia: setValue is tried first, and reported as typing either way', async () => {
  const h = harness();
  const outcome = await h.engine.skills.invoke(
    'uia.typeInto',
    { window: 'notepad', path: '0', text: 'hello' },
    io(h),
  );
  assert.isTrue(outcome.ok);
  assert.deepEqual(h.journal.uiaSetValues, [{ id: '1001', path: [0], value: 'hello' }]);
  // The direct path worked, so the keystroke fallback must never have run.
  assert.deepEqual(h.journal.uiaFocuses, []);
  assert.deepEqual(h.journal.typed, []);
});

test('uia: typeInto falls back to focus-plus-keystrokes when setValue fails', async () => {
  const h = harness();
  const outcome = await h.engine.skills.invoke(
    'uia.typeInto',
    { window: 'notepad', path: '1', text: 'hello' },
    io(h),
  );
  assert.isTrue(outcome.ok);
  assert.deepEqual(h.journal.uiaSetValues, [{ id: '1001', path: [1], value: 'hello' }]);
  assert.deepEqual(h.journal.uiaFocuses, [{ id: '1001', path: [1] }]);
  assert.deepEqual(h.journal.typed, ['hello']);
});

test('uia: expand and collapse both resolve the window and act immediately', async () => {
  const h = harness();
  await h.engine.skills.invoke('uia.expand', { window: 'notepad', path: '1' }, io(h));
  await h.engine.skills.invoke('uia.collapse', { window: 'notepad', path: '1' }, io(h));
  assert.deepEqual(h.journal.uiaExpands, [
    { id: '1001', path: [1], expand: true },
    { id: '1001', path: [1], expand: false },
  ]);
});

test('uia: risk matches consequence — reading and acting are both safe', () => {
  const h = harness();
  for (const id of [
    'uia.tree',
    'uia.focusedElement',
    'uia.invoke',
    'uia.expand',
    'uia.collapse',
    'uia.setValue',
    'uia.typeInto',
  ]) {
    assert.equal(h.engine.skills.get(id)?.risk, 'safe', id);
  }
});

// ---- clicking a control without naming a window ----------------------------
//
// "click play" used to have no route at all — every uia.* grammar rule
// required "... in the X window", and asking for a window every time there
// was obviously only one open would be the kind of theatre the rest of this
// pack avoids. `targetWindowId` (uia-skills.ts) now resolves an omitted
// `window` itself: the one other window when there's exactly one, the same
// disambiguation card a named-but-ambiguous query already gets when there's
// more than one, and a clean error when there's none. Built directly against
// a minimal `Platform`, the same way the window-skills disambiguation test
// above does, because the point here is `targetWindowId`'s own decision, not
// the full engine pipeline.

test('uia: no window named, exactly one other window open — acts on it directly', async () => {
  const invoked: Array<{ id: string; path: number[] }> = [];
  const platform = {
    capabilities: async () => ['ui-automation', 'window-control'],
    listWindows: async () => [{ ...WINDOWS[0]! }],
    uiaTree: async () => ({
      path: [],
      role: 'pane',
      name: 'root',
      automationId: '',
      enabled: true,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      children: [
        {
          path: [0],
          role: 'button',
          name: 'Play',
          automationId: '',
          enabled: true,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          children: [],
        },
      ],
    }),
    uiaInvoke: async (id: string, path: number[]) => {
      invoked.push({ id, path });
      return true;
    },
  } as unknown as Platform;
  const invoke = createUiaSkills(platform).find((s) => s.id === 'uia.invoke')!;

  const ctx: SkillContext = { say: () => {}, confirm: async () => true, showResults: () => {} };
  const outcome = await invoke.run({ control: 'play' }, ctx);
  assert.isTrue(outcome.ok);
  assert.deepEqual(invoked, [{ id: '1001', path: [0] }]);
});

test('uia: no window named, none open — a clean error, not a guess', async () => {
  const platform = {
    capabilities: async () => ['ui-automation', 'window-control'],
    listWindows: async () => [],
  } as unknown as Platform;
  const invoke = createUiaSkills(platform).find((s) => s.id === 'uia.invoke')!;

  const ctx: SkillContext = { say: () => {}, confirm: async () => true, showResults: () => {} };
  const outcome = await invoke.run({ control: 'play' }, ctx);
  assert.isFalse(outcome.ok);
});

test('uia: no window named, two open — the same disambiguation card an ambiguous name gets', async () => {
  const platform = {
    capabilities: async () => ['ui-automation', 'window-control'],
    listWindows: async () => [{ ...WINDOWS[0]! }, { ...WINDOWS[1]! }],
  } as unknown as Platform;
  const invoke = createUiaSkills(platform).find((s) => s.id === 'uia.invoke')!;

  const rows: ResultRow[] = [];
  const ctx: SkillContext = {
    say: () => {},
    confirm: async () => true,
    showResults: (items) => rows.push(...items),
  };
  const outcome = await invoke.run({ control: 'play' }, ctx);
  assert.isTrue(outcome.ok);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.actions?.[0]),
    [
      { label: 'Select', skill: 'uia.invoke', args: { control: 'play', window: '1001' } },
      { label: 'Select', skill: 'uia.invoke', args: { control: 'play', window: '1002' } },
    ],
  );
});

test('uia grammar: "click <name>" with no window reaches uia.invoke, not the AI planner', async () => {
  const offline = makeProvider({ error: 'offline' });
  const h = harness(undefined, { provider: offline });
  await h.engine.ask('click play', io(h));
  // The default fixture has two windows open, so this lands on the same
  // disambiguation card the skill-level test above exercises directly —
  // the point here is only that grammar routed it there at all, and never
  // asked the (offline) provider.
  assert.isAbove(h.rows.length, 0);
  assert.equal(offline.prompts.length, 0);
  assert.notMatch(h.said.join(' '), /couldn't reach that provider/);
});

test('uia: with no ui-automation capability the skills are hidden, not disabled', () => {
  const h = harness([
    'files',
    'fs',
    'apps',
    'system',
    'processes',
    'os',
    'windows',
    'window-control',
    'input',
    'network',
  ]);
  const ids = h.engine.skills.available().map((s) => s.id);
  assert.notInclude(ids, 'uia.tree');
  assert.notInclude(ids, 'uia.invoke');
});

// ---- screen capture ---------------------------------------------------------------
//
// Read-only and reversible in the sense that matters — nothing on the
// machine changes — so everything here is `safe`.

test('screen: capturing the whole screen reports its real dimensions', async () => {
  const h = harness();
  const outcome = await h.engine.ask('take a screenshot', io(h));
  assert.equal(h.journal.screenCaptures, 1);
  assert.isTrue(outcome.ok);
  assert.match(h.said.join(' '), /1920.1080/);
});

test('screen: a screenshot is never read aloud', () => {
  const h = harness();
  assert.equal(h.engine.skills.get('screen.capture')?.aloud, false);
});

test('screen: capturing a window resolves it by name first', async () => {
  const h = harness();
  const outcome = await h.engine.skills.invoke(
    'screen.captureWindow',
    { window: 'notepad' },
    io(h),
  );
  assert.isTrue(outcome.ok);
  assert.deepEqual(h.journal.windowCaptures, ['1001']);
});

test('screen: listing displays never asks permission', async () => {
  const h = harness();
  await h.engine.ask('what monitors do I have', io(h));
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.confirmsAsked, []);
});

test('screen: every skill in this pack is a safe read', () => {
  const h = harness();
  for (const id of ['screen.capture', 'screen.captureWindow', 'screen.listDisplays']) {
    assert.equal(h.engine.skills.get(id)?.risk, 'safe', id);
  }
});

test('screen: with no screen capability the skills are hidden, not disabled', () => {
  const h = harness([
    'files',
    'fs',
    'apps',
    'system',
    'processes',
    'os',
    'windows',
    'window-control',
    'input',
    'ui-automation',
    'network',
  ]);
  const ids = h.engine.skills.available().map((s) => s.id);
  assert.notInclude(ids, 'screen.capture');
  assert.notInclude(ids, 'screen.listDisplays');
});

// ---- opening more than one thing -----------------------------------------------

test('opening several: two apps named in one sentence both launch', async () => {
  const h = harness();
  await h.engine.ask('open obs and epic games', io(h));
  assert.deepEqual(h.journal.launched, ['obs', 'epic-games-launcher']);
});

test('opening several: commas work too, and three is the ceiling', async () => {
  const h = harness();
  await h.engine.ask('open steam, discord and firefox', io(h));
  assert.deepEqual(h.journal.launched, ['steam', 'discord', 'firefox']);

  const g = harness();
  await g.engine.ask('open steam, discord, firefox and obs', io(g));
  // Four is past the cap, so none of it happens rather than an arbitrary
  // three of it — a partial answer here is worse than none.
  assert.deepEqual(g.journal.launched, []);
});

test('opening several: a real name containing "and" is never split', async () => {
  const h = harness();
  await h.engine.ask('open command and conquer', io(h));
  // Splitting first would have launched nothing and offered "Comm" and
  // "Conquer" as guesses. The whole string matches, so it never gets there.
  assert.deepEqual(h.journal.launched, ['candc']);
});

test('opening several: all or nothing', async () => {
  const h = harness();
  await h.engine.ask('open steam and somethingthatisnotinstalled', io(h));
  // Opening one of the two and saying so leaves someone working out which
  // half happened, in front of a window they did not choose.
  assert.deepEqual(h.journal.launched, []);
});

test('opening several: the same app named twice opens once', async () => {
  const h = harness();
  await h.engine.ask('open steam and steam', io(h));
  assert.deepEqual(h.journal.launched, ['steam']);
});

// ---- two different instructions in one sentence ---------------------------------
//
// `appOpen` is deliberately the greediest rule — "anything shaped like open X"
// — which is exactly what let it swallow a second, unrelated instruction as
// if it were part of an app's name. `Grammar.tryCompound` re-parses each half
// of an "X and Y" / "X then Y" sentence on its own, and only accepts the split
// when both halves independently earn a plan through the ordinary chain.

test('compound: "open X and search youtube for Y" is two commands, not one', async () => {
  const h = harness();
  await h.engine.ask('open steam and search youtube for fortnite', io(h));
  assert.deepEqual(h.journal.launched, ['steam']);
  assert.lengthOf(h.journal.urls, 1);
  assert.match(h.journal.urls[0]!, /youtube\.com\/results\?search_query=fortnite/);
});

test('compound: the order can run the other way too', async () => {
  const h = harness();
  await h.engine.ask('search youtube for fortnite and open steam', io(h));
  assert.deepEqual(h.journal.launched, ['steam']);
  assert.lengthOf(h.journal.urls, 1);
  assert.match(h.journal.urls[0]!, /youtube\.com\/results\?search_query=fortnite/);
});

test('compound: "then" works as the connector too', async () => {
  const h = harness();
  await h.engine.ask('open discord then search for tide times', io(h));
  assert.deepEqual(h.journal.launched, ['discord']);
  assert.lengthOf(h.journal.urls, 1);
  assert.match(h.journal.urls[0]!, /google\.com\/search\?q=tide/);
});

test('compound: two apps named together stays one launch, not a split', async () => {
  const h = harness();
  const plan = h.engine.grammar.parse('open obs and epic games');
  // Still a single app.open step — resolveSeveral, not the compound path —
  // because "epic games" alone (no leading verb) can't stand as its own plan.
  assert.equal(plan?.steps.length, 1);
  assert.equal(plan?.steps[0]?.skill, 'app.open');
});

test('compound: a lone "and" inside a real query is never split', async () => {
  const h = harness();
  const plan = h.engine.grammar.parse('search the web for cats and dogs');
  // "dogs" alone matches no rule, so the split is declined and the whole
  // phrase stays one query.
  assert.equal(plan?.steps.length, 1);
  assert.equal(plan?.steps[0]?.args.query, 'cats and dogs');
});

test('compound: free-text skills are never second-guessed', async () => {
  const h = harness();
  // A todo's own text legitimately contains "and" — this must never be read
  // as two instructions, whatever it starts with.
  const plan = h.engine.grammar.parse('remind me to open the garage and turn off the lights');
  assert.equal(plan?.steps.length, 1);
  assert.equal(plan?.steps[0]?.skill, 'todo.add');
  assert.equal(plan?.steps[0]?.args.text, 'open the garage and turn off the lights');
});

// ---- what is worth reading aloud -----------------------------------------------
//
// Speaking every reply is fine right up until the reply is a password. These
// assert on `spokenAloud` rather than `said`: the message is still shown in
// every case, and the only question is whether a voice would read it.

test('aloud: a generated password is shown but never spoken', async () => {
  const h = harness();
  await h.engine.ask('generate a password', io(h));
  // It is on screen…
  assert.isNotEmpty(h.said);
  // …and it is the one kind of output that must not leave the screen.
  assert.deepEqual(h.spokenAloud, []);
});

test('aloud: walls of data are shown but not read', async () => {
  for (const request of ['system status', 'what apps do I have installed', "what's running"]) {
    const h = harness();
    await h.engine.ask(request, io(h));
    assert.deepEqual(h.spokenAloud, [], `"${request}" would have been read aloud`);
  }
});

test('aloud: an ordinary answer is still spoken', async () => {
  const h = harness();
  await h.engine.ask('open steam', io(h));
  // The whole feature would be pointless if it silenced everything.
  assert.isNotEmpty(h.spokenAloud);
  assert.match(h.spokenAloud.join(' '), /Steam/);
});

test('aloud: a refusal is always spoken, whatever the skill declared', async () => {
  const h = harness();
  await h.engine.ask('search the web for porn', io(h));
  // Refusals come from the engine, not from a skill, so nothing can mute
  // them — which is deliberate: a silent refusal reads as a failure.
  assert.match(h.spokenAloud.join(' '), /don't search for, open, or play pornography/);
});

// ---- a site named exactly what you said ----------------------------------------

test('"open google" opens Google, not Google Docs', async () => {
  const h = harness();
  await h.engine.ask('open google', io(h));
  // The installed match was only a prefix of a longer, different product.
  assert.deepEqual(h.journal.launched, []);
  assert.deepEqual(h.journal.urls, ['https://www.google.com']);
});

test('an exactly-named installed app still beats the site', async () => {
  const h = harness();
  await h.engine.ask('open steam', io(h));
  // "installed apps win" is still the rule; this is one narrow exception to it.
  assert.deepEqual(h.journal.launched, ['steam']);
  assert.deepEqual(h.journal.urls, []);
});

test('naming the longer product still opens the longer product', async () => {
  const h = harness();
  await h.engine.ask('open google docs', io(h));
  assert.deepEqual(h.journal.launched, ['gdocs']);
});

test('an alias never outranks an installed application', () => {
  // "drive" is an alias for Google Drive, but someone with Drive installed who
  // says "open drive" wants the program — so only a site's own name counts.
  assert.isNull(exactSiteName('drive'));
  assert.isNotNull(exactSiteName('google'));
  assert.isNotNull(exactSiteName('GOOGLE'));
});

test('"find pdf files" searches for PDFs, not for the word "files"', () => {
  const h = harness();
  const parsed = h.engine.grammar.parse('find pdf files');
  assert.equal(parsed?.steps[0]?.skill, 'files.find');
  // Stripping only the first type word left "files" as the search term, which
  // found nothing and said so with complete confidence.
  assert.equal(parsed?.steps[0]?.args.query, '');
  // `detectKind` buckets pdf under the broader 'document' kind.
  assert.equal(parsed?.steps[0]?.args.kind, 'document');
});

test('a named file search keeps the name', () => {
  const h = harness();
  const parsed = h.engine.grammar.parse('find my tax pdf');
  assert.equal(parsed?.steps[0]?.args.query, 'tax');
  assert.equal(parsed?.steps[0]?.args.kind, 'document');
});

// ---- small talk -------------------------------------------------------------
//
// The tier that answers "hi". Its whole risk is that it might answer
// something else too, so roughly half of these tests are about what it must
// NOT claim.

test('smalltalk: a greeting is greeted, not lectured about providers', async () => {
  const h = harness();
  await h.engine.ask('hi', io(h));
  const said = h.said.join(' ');
  assert.notMatch(said, MODEL_EXCUSE);
  assert.match(said, /what can i do for you/i);
});

test('smalltalk: every social kind gets a real answer with no provider at all', async () => {
  const cases: Array<[string, RegExp]> = [
    ['hey', /what can i do for you/i],
    ['how are you?', /all good here/i],
    ['thanks', /any time/i],
    ['bye', /see you/i],
    ['who are you?', /assistant that runs entirely on this machine/i],
    ['tell me a joke', /\S/],
    ['nice one', /glad that helped/i],
  ];
  for (const [text, expected] of cases) {
    const h = harness();
    const outcome = await h.engine.ask(text, io(h));
    const said = h.said.join(' ');
    assert.equal(outcome.mode, 'chat', text);
    assert.isTrue(outcome.ok, text);
    assert.notMatch(said, MODEL_EXCUSE, text);
    assert.match(said, expected, text);
  }
});

test('smalltalk: a joke is one Atlas actually knows', async () => {
  const h = harness();
  await h.engine.ask('tell me a joke', io(h));
  assert.include(JOKES, h.said[0]);
});

test('smalltalk: "how are you" survives a greeting in front of it', async () => {
  const h = harness();
  await h.engine.ask('hey, how are you?', io(h));
  // Stripped down to the question rather than answered as the "hey" it opens
  // with — the second-pass rule `readAffirmation` follows too.
  assert.match(h.said.join(' '), /all good here/i);
});

test('smalltalk: identity reports the real number of actions', async () => {
  const h = harness();
  await h.engine.ask('who are you?', io(h));
  assert.include(h.said.join(' '), String(h.engine.skills.available().length));
});

test('smalltalk: it speaks as whoever Personalization says it is', () => {
  const p = createPhrasing({ atlasName: 'Nova', userName: 'Sam' });
  assert.match(p.smallTalk('greeting', 10), /Sam/);
  assert.match(p.smallTalk('identity', 10), /Nova/);
});

test('smalltalk: replies vary rather than repeating one line forever', () => {
  const p = createPhrasing();
  const three = [
    p.smallTalk('greeting', 5),
    p.smallTalk('greeting', 5),
    p.smallTalk('greeting', 5),
  ];
  assert.equal(new Set(three).size, 3);
  // ...but a fresh Phrasing always opens the same way, so this is testable.
  assert.equal(createPhrasing().smallTalk('greeting', 5), three[0]);
});

test('smalltalk: a role\'s farewell replaces the generic goodbye rotation', () => {
  const pilot = createPhrasing({ role: 'pilot', userName: 'Sam' });
  assert.equal(pilot.smallTalk('goodbye', 0), "Standing down, Sam. Call when you're ready.");
  // A role's farewell is fixed, not rotated — three "bye"s in a row from the
  // same pilot say the same thing, unlike the generic rotation above.
  assert.equal(pilot.smallTalk('goodbye', 0), pilot.smallTalk('goodbye', 0));
});

test('smalltalk: assistant (and no role at all) keeps the original goodbye rotation', () => {
  const noRole = createPhrasing({ userName: 'Sam' });
  const assistant = createPhrasing({ role: 'assistant', userName: 'Sam' });
  const GENERIC = ["See you — Ctrl+Space and I'm back.", 'Bye. I’ll be here.', 'See you.'];
  assert.include(GENERIC, noRole.smallTalk('goodbye', 0));
  assert.include(GENERIC, assistant.smallTalk('goodbye', 0));
});

// --- the guard rail: small talk must never eat an instruction ----------------

test('smalltalk: a greeting in front of a command still runs the command', async () => {
  const h = harness();
  await h.engine.ask('hey, open steam', io(h));
  // The greeting came off in `normalizeRequest` and the grammar matched on
  // the retry, exactly as it did before this tier existed. Lowercase because
  // that is the text the second parse attempt is handed.
  assert.deepEqual(h.journal.launched, ['steam']);
  assert.notMatch(h.said.join(' '), /what can i do for you/i);
});

test('smalltalk: a courtesy wrapped around a command is not a social message', () => {
  // The classifier is what stands between "thanks" the whole utterance and
  // "thanks" the word someone happened to end an instruction with.
  assert.equal(readSmallTalk('thanks'), 'thanks');
  assert.isNull(readSmallTalk('open steam thanks'));
  assert.isNull(readSmallTalk('hey open steam'));
  assert.isNull(readSmallTalk('say good night to the dog'));
});

test('smalltalk: only a whole utterance counts', () => {
  // Each of these contains a social word and is not a social message.
  for (const text of [
    'hide the window',
    'open my notes',
    'thanks folder',
    'find the file called hello',
    'search the web for how are you',
    'remind me to say good night',
  ]) {
    assert.isNull(readSmallTalk(text), text);
  }
});

test('smalltalk: the classifier reads the kinds it claims to', () => {
  assert.equal(readSmallTalk('Hey!'), 'greeting');
  assert.equal(readSmallTalk("how's it going"), 'howAreYou');
  assert.equal(readSmallTalk('hows it going'), 'howAreYou');
  assert.equal(readSmallTalk('Thank you so much!'), 'thanks');
  assert.equal(readSmallTalk('good night'), 'goodbye');
  assert.equal(readSmallTalk('what are you?'), 'identity');
  assert.equal(readSmallTalk('can you tell me a joke'), 'joke');
  assert.equal(readSmallTalk('nonsense here'), null);
});

test('smalltalk: a real question is still a question, not small talk', async () => {
  // The tier sits after triage, so a genuine question falls past it into
  // conversation exactly as before.
  assert.isNull(readSmallTalk('what is the capital of France?'));
  const h = harness();
  const outcome = await h.engine.ask('what is the capital of France?', io(h));
  assert.equal(outcome.error, 'not-configured');
});

test('smalltalk: a failed command reports the failure, it does not chat', async () => {
  const h = harness();
  const outcome = await h.engine.ask('open zzzqqq', io(h));
  // Still a command, still an honest error about the app — the social tier
  // sits behind the executor and never gets a look at this.
  assert.equal(outcome.mode, 'command');
  assert.match(h.said.join(' '), /couldn't figure out which app/i);
  assert.notMatch(h.said.join(' '), /what can i do for you|any time/i);
});

// ---- "what can you help me with" -------------------------------------------

test('help: the ways people actually ask all reach engine.help', () => {
  const h = harness();
  for (const text of [
    'what can you do?',
    'what can you help me with?',
    'what can you help with?',
    'what else can you do?',
    'what can i ask you?',
    'show me what you can do',
    'list your capabilities',
    'help',
  ]) {
    assert.equal(h.engine.grammar.parse(text)?.steps[0]?.skill, 'engine.help', text);
  }
});

test('help: it lists real skills, and small talk never intercepts it', async () => {
  const h = harness();
  await h.engine.ask('what can you help me with?', io(h));
  assert.isAbove(h.rows.length, 0);
  assert.notMatch(h.said.join(' '), /what can i do for you/i);
});

test('escalation: the model is asked only for what the local tiers cannot do', async () => {
  const provider = makeProvider({ reply: 'an answer from the model' });
  const h = harness(undefined, { provider });

  // Each of these is handled by a tier that sits above the provider.
  await h.engine.ask('open steam', io(h)); // grammar
  await h.engine.ask('hi', io(h)); // small talk
  await h.engine.ask('what can you do?', io(h)); // grammar -> engine.help
  await h.engine.ask('what is 12 * 7', io(h)); // grammar -> calculator
  assert.deepEqual(provider.prompts, [], 'nothing above should have reached the model');

  // This one genuinely needs a model.
  await h.engine.ask('why is the sky blue?', io(h));
  assert.lengthOf(provider.prompts, 1);
  assert.match(h.said.join(' '), /an answer from the model/);
});

test('escalation: with the model off, everything local still works', async () => {
  const h = harness(undefined, { provider: null });

  await h.engine.ask('open steam', io(h));
  assert.deepEqual(h.journal.launched, ['steam']);

  await h.engine.ask('hello', io(h));
  assert.match(h.said.join(' '), /what can i do for you|what do you need|what are we doing/i);

  await h.engine.ask('what can you do?', io(h));
  assert.isAbove(h.rows.length, 0);
});

test('engine.help: every row carries the domain its surface groups on', async () => {
  const h = harness();
  await h.engine.ask('what can you do?', io(h));

  assert.isAbove(h.rows.length, 50);
  // A row without a group would land in an "Other" bucket in the browser —
  // present, but filed under nothing. The grouping is only useful if it is
  // total.
  const ungrouped = h.rows.filter((r) => !r.group);
  assert.deepEqual(ungrouped, [], `${ungrouped.length} rows have no domain`);

  // And the rows are the real catalog, not a curated subset.
  assert.equal(h.rows.length, h.engine.skills.available().length);
  const groups = new Set(h.rows.map((r) => r.group));
  assert.isAbove(groups.size, 5);
  assert.include([...groups], 'files');
  assert.include([...groups], 'system');
});
