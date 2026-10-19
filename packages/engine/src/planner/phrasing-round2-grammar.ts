/**
 * Round 2 of the phrasing table (2.0.2): the misreadings and misses the held-out set C showed, for skills
 * the earlier sets never touched. Same discipline as `phrasing-simple-grammar.ts`: a row matches a WHOLE
 * sentence or nothing, routes to an existing skill with the arguments it already takes, and where the old
 * grammar claimed the sentence wrongly this row simply comes first with the right answer.
 *
 * What is deliberately NOT here: sentences that lack what the skill needs ("compare my two photo folders"
 * names no folders). Those are not phrasing gaps; they need a question back or a model, and guessing would
 * only convert a miss into a wrong answer.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

const END = String.raw`\s*[?.!]*$`;
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');
const unquote = (s: string) => tidy(s).replace(/^["'`]+|["'`]+$/g, '');
const re = (body: string) => new RegExp(String.raw`^\s*(?:please\s+)?${body}${END}`, 'i');

/** Extensions that mean "a file", so "open report.pdf" is a file and "open github.com" is not. */
const FILE_EXT = String.raw`(?:pdf|docx?|xlsx?|pptx?|txt|md|csv|json|log|png|jpe?g|gif|bmp|webp|svg|mp3|wav|flac|mp4|mkv|mov|avi|zip|rar|7z|exe|msi|iso|ps1|py|js|ts|html?)`;

interface Row {
  name: string;
  patterns: RegExp[];
  build: (m: RegExpExecArray) => ReturnType<typeof plan> | null;
  question?: string;
}

const ROWS: Row[] = [
  { name: 'openFileByName', patterns: [re(String.raw`(?:open|launch|show)\s+(?:the\s+)?(?:file\s+)?(?:called\s+|named\s+)?("?[^\s"]+\.${FILE_EXT}"?)`)], build: (m) => plan(step('files.open', { path: unquote(m[1]!) }), 'open-file') },
  { name: 'renameChangeName', patterns: [re(String.raw`change\s+the\s+name\s+of\s+(\S+)\s+to\s+(\S+)`)], build: (m) => plan(step('files.rename', { path: unquote(m[1]!), newName: unquote(m[2]!) }), 'rename-file') },
  { name: 'moveInto', patterns: [re(String.raw`put\s+(\S+\.${FILE_EXT})\s+(?:into|in|to)\s+(?:my\s+|the\s+)?(\w+)(?:\s+folder)?`)], build: (m) => plan(step('files.move', { path: unquote(m[1]!), destDir: m[2]!.toLowerCase() }), 'move-file') },
  { name: 'fileWhen', question: 'file-info', patterns: [re(String.raw`when\s+was\s+(\S+\.${FILE_EXT})\s+(?:last\s+)?(?:modified|changed|edited|created|saved)`)], build: (m) => plan(step('files.info', { path: unquote(m[1]!) }), 'file-info') },
  { name: 'fileChecksum', patterns: [re(String.raw`(?:get|show|give\s+me|what(?:['’]s|\s+is))\s+(?:the\s+)?(?:checksum|hash|sha-?\d*|md5)\s+(?:of|for)\s+(\S+)`)], build: (m) => plan(step('files.hash', { target: unquote(m[1]!) }), 'file-hash') },
  { name: 'revealInExplorer', patterns: [re(String.raw`(?:show|reveal|highlight|find)\s+(?:me\s+)?(?:the\s+)?(.+?)\s+in\s+(?:the\s+)?(?:file\s+)?explorer`)], build: (m) => plan(step('files.reveal', { path: unquote(m[1]!) }), 'reveal') },
  { name: 'biggestFolders', question: 'largest-folders', patterns: [re(String.raw`(?:(?:show|list|find)\s+(?:me\s+)?(?:my\s+|the\s+)?(?:biggest|largest|heaviest)\s+folders|which\s+folders\s+(?:use|take|are\s+using|take\s+up)\s+(?:up\s+)?the\s+most\s+(?:space|storage))`)], build: () => plan(step('storage.largestFolders', { path: 'home' }), 'largest-folders') },
  { name: 'folderTakes', question: 'folder-size', patterns: [re(String.raw`how\s+much\s+(?:space|storage|room)\s+does\s+(?:my\s+|the\s+)?(.+?)(?:\s+folder)?\s+(?:take|use|occupy|take\s+up)`)], build: (m) => plan(step('storage.folderSize', { path: tidy(m[1]!) }), 'folder-size') },
  { name: 'powerPlanUse', patterns: [re(String.raw`(?:use|switch\s+to|set|change\s+to)\s+(?:the\s+)?(balanced|high[- ]performance|power[- ]saver)\s+(?:power\s+)?(?:plan|mode)`)], build: (m) => plan(step('system.powerPlan', { plan: /high/i.test(m[1]!) ? 'high-performance' : /saver/i.test(m[1]!) ? 'power-saver' : 'balanced' }), 'power-plan') },
  { name: 'startupWhat', question: 'startup-apps', patterns: [re(String.raw`(?:what\s+(?:runs|starts|launches|opens)\s+when\s+(?:my\s+pc|the\s+computer|windows|i)\s+(?:starts?|boots?|logs?\s+in|turns?\s+on)(?:\s+up)?|show\s+(?:me\s+)?(?:my\s+)?startup\s+(?:programs|apps|items))`)], build: () => plan(step('system.startupApps', {}), 'startup-apps') },
  { name: 'whichNetwork', question: 'wifi', patterns: [re(String.raw`which\s+(?:wifi\s+)?network\s+am\s+i\s+(?:on|connected\s+to|using)`)], build: () => plan(step('net.wifi', {}), 'wifi') },
  { name: 'dnsRecordOf', question: 'dns', patterns: [re(String.raw`what(?:['’]s|\s+is)\s+the\s+(?:dns|ip)\s+(?:record|address)\s+(?:for|of)\s+(\S+)`)], build: (m) => plan(step('net.dnsLookup', { host: unquote(m[1]!) }), 'dns') },
  { name: 'pushToRemote', patterns: [re(String.raw`push\s+(?:my\s+|the\s+|all\s+)?(?:commits|changes|work|code)\s+(?:up\s+)?to\s+(?:github|origin|the\s+remote|remote|upstream)`)], build: () => plan(step('git.push', {}), 'git-push') },
  { name: 'whatIChanged', question: 'git-diff', patterns: [re(String.raw`(?:show|tell)\s+me\s+what\s+i\s+(?:just\s+)?(?:changed|modified|edited)`)], build: () => plan(step('git.diff', {}), 'git-diff') },
  { name: 'switchBranch', patterns: [re(String.raw`(?:switch|go|change)\s+to\s+(?:the\s+)?([\w./][\w./-]*)\s+branch`), re(String.raw`check\s*out\s+(?:the\s+)?([\w./][\w./-]*?)(?:\s+branch)?`)], build: (m) => plan(step('git.checkout', { branch: m[1]! }), 'git-checkout') },
  { name: 'stashAside', patterns: [re(String.raw`put\s+(?:my\s+)?(?:work|changes)\s+aside(?:\s+with\s+git\s+stash)?`)], build: () => plan(step('git.stash', { action: 'push' }), 'git-stash') },
  { name: 'projectStructure', question: 'project-tree', patterns: [re(String.raw`(?:show\s+(?:me\s+)?(?:the\s+)?(?:file\s+)?(?:tree|structure)\s+of\s+(?:this|my|the)\s+project|what(?:['’]s|\s+is)\s+the\s+structure\s+of\s+(?:this|my|the)\s+project)`)], build: () => plan(step('project.tree', {}), 'project-tree') },
  { name: 'searchCode', patterns: [re(String.raw`search\s+(?:my\s+|the\s+|this\s+)?(?:code|project|codebase)\s+for\s+(.+)`), re(String.raw`find\s+where\s+(\S+)\s+is\s+(?:used|called|defined|referenced)`)], build: (m) => plan(step('code.search', { query: unquote(m[1]!) }), 'code-search') },
  { name: 'copyToClipboard', patterns: [re(String.raw`copy\s+(.+?)\s+to\s+(?:my\s+|the\s+)?clipboard`), re(String.raw`put\s+(?:this\s+)?on\s+(?:my\s+|the\s+)?clipboard\s*[:,-]?\s*(.+)`)], build: (m) => plan(step('clipboard.copy', { text: unquote(m[1]!) }), 'clipboard-copy') },
  { name: 'countText', patterns: [re(String.raw`count\s+the\s+(?:words|characters|letters)\s+in\s+(?:this|that)?\s*[:,-]?\s*(.+)`), re(String.raw`how\s+many\s+(?:words|characters|letters)\s+(?:are\s+)?in\s+(?:this\s*[:,-]?\s*)?(.+)`)], build: (m) => plan(step('text.count', { text: unquote(m[1]!) }), 'text-count') },
  { name: 'changeCase', patterns: [re(String.raw`(?:make|turn|convert)\s+(?:this|that|it)\s+(upper|lower)\s*case\s*[:,-]?\s*(.+)`), re(String.raw`convert\s+to\s+(title|sentence|upper|lower)\s*case\s*[:,-]?\s*(.+)`)], build: (m) => plan(step('text.case', { text: unquote(m[2]!), style: m[1]!.toLowerCase() }), 'text-case') },
  { name: 'base64Decode', patterns: [re(String.raw`decode\s+(?:this\s+)?base-?64\s*[:,-]?\s*(\S+)`)], build: (m) => plan(step('util.base64', { text: unquote(m[1]!), mode: 'decode' }), 'base64') },
  { name: 'daysUntilFrom', question: 'days-until', patterns: [re(String.raw`days\s+(?:from\s+)?(?:today|now)\s+until\s+(.+)`)], build: (m) => plan(step('time.between', { from: 'today', to: unquote(m[1]!) }), 'days-between') },
  { name: 'putOnService', patterns: [re(String.raw`put\s+on\s+(?:some\s+)?(.+?)\s+on\s+(spotify|youtube)(?:\s+music)?`)], build: (m) => plan(step('media.playOn', { query: unquote(m[1]!), service: m[2]!.toLowerCase() }), 'play-on') },
  { name: 'startDevServer', patterns: [re(String.raw`(?:start|run|launch|boot\s+up|fire\s+up|spin\s+up)\s+(?:my\s+|the\s+|this\s+)?(?:project(?:['’]s)?\s+)?(?:dev(?:elopment)?\s+)?server`), re(String.raw`(?:run|start)\s+(?:my\s+|the\s+|this\s+)?(?:project|app)\s+in\s+dev(?:elopment)?\s+mode`)], build: () => plan(step('project.startServer', {}), 'start-server') },
  { name: 'themeSwitch', patterns: [re(String.raw`(?:turn|switch|change)\s+(?:on\s+|to\s+)?(?:the\s+)?(dark|light)\s+(?:mode|theme)(?:\s+(on|off))?`), re(String.raw`(?:enable|use)\s+(dark|light)\s+(?:mode|theme)`)], build: (m) => { const flip = /off/i.test(m[2] ?? ''); const dark = /dark/i.test(m[1]!) !== flip; return plan(step('system.theme', { mode: dark ? 'dark' : 'light' }), 'theme'); } },
  { name: 'volumeUpTo', patterns: [re(String.raw`(?:turn|bring|put|set|make)\s+(?:the\s+|my\s+)?(?:volume|sound)\s+(?:up\s+|down\s+)?(?:to|at)\s+(\d{1,3})\s*(?:%|percent)?`)], build: (m) => plan(step('system.volumeSet', { level: Math.min(100, Number(m[1])) }), 'volume-set') },
  { name: 'showMyNotes', question: 'note-list', patterns: [re(String.raw`show\s+me\s+my\s+notes`)], build: () => plan(step('notes.list', {}), 'note-list') },
  { name: 'largestOnPc', question: 'largest-files', patterns: [re(String.raw`(?:show|list|find)\s+(?:me\s+)?(?:the\s+)?(?:biggest|largest)\s+files\s+on\s+(?:my|this)\s+(?:pc|computer|laptop|machine)`)], build: () => plan(step('storage.largestFiles', { path: 'home' }), 'largest-files') },
  { name: 'localIp', question: 'ip', patterns: [re(String.raw`what(?:['’]s|\s+is)\s+my\s+(?:local|lan|internal|private)\s+ip(?:\s+address)?`)], build: () => plan(step('net.ip', {}), 'ip') },
  { name: 'connectedToInternet', question: 'online', patterns: [re(String.raw`am\s+i\s+(?:connected\s+to\s+the\s+internet|online|on\s+the\s+internet)`)], build: () => plan(step('net.online', {}), 'online') },
  { name: 'wordPercent', patterns: [re(String.raw`(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|five|fifteen|twenty[- ]five|seventy[- ]five)\s+percent\s+of\s+([\d.,]+)`)], build: (m) => { const W: Record<string, number> = { five: 5, ten: 10, fifteen: 15, twenty: 20, 'twenty five': 25, 'twenty-five': 25, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, 'seventy five': 75, 'seventy-five': 75, eighty: 80, ninety: 90 }; return plan(step('math.percent', { a: W[m[1]!.toLowerCase()]!, b: Number(m[2]!.replace(/,/g, '')), mode: 'of' }), 'percent'); } },
  { name: 'randomUuid', patterns: [re(String.raw`(?:generate|make|give\s+me|create)\s+(?:me\s+)?(?:a\s+)?(?:random\s+)?(?:uuid|guid)`)], build: () => plan(step('util.uuid', {}), 'uuid') },
  { name: 'whichFoldersBiggest', question: 'largest-folders', patterns: [re(String.raw`which\s+folders\s+are\s+(?:the\s+)?(?:biggest|largest|heaviest)`)], build: () => plan(step('storage.largestFolders', { path: 'home' }), 'largest-folders') },
  { name: 'laptopCharging', question: 'battery', patterns: [re(String.raw`is\s+(?:my\s+)?(?:laptop|pc|computer|battery)\s+(?:charging|plugged\s+in)`)], build: () => plan(step('system.battery', {}), 'battery') },
  { name: 'captureActiveWindow', patterns: [re(String.raw`(?:screenshot|capture|take\s+a\s+screenshot\s+of)\s+(?:just\s+)?(?:this|the\s+active|the\s+current)\s+window`)], build: () => plan(step('screen.captureWindow', { window: 'active' }), 'capture-window') },
];

export function createRound2PhrasingGrammar(): GrammarRule[] {
  return ROWS.map((r, i) => ({
    name: r.name,
    order: -11.54 + i * 0.0001,
    pathSafe: true,
    ...(r.question ? { questionSafe: [r.question] } : {}),
    test(_lower: string, raw: string) {
      for (const p of r.patterns) {
        const m = p.exec(raw);
        if (m) return r.build(m);
      }
      return null;
    },
  }));
}
