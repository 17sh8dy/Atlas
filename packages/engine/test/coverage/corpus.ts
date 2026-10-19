/**
 * The phrasing corpus: plain requests with the skill each one SHOULD reach, expanded by common wrappers.
 *
 * This is the measuring stick behind every coverage claim (`docs/CAPABILITY-COVERAGE.md`). It is written by
 * hand from what people ask for, not generated from the grammar, so it can disagree with the grammar, which
 * is the point. A case that misses is not hidden: it is counted as "needs a model", and one that reaches the
 * wrong skill is counted as wrong and listed by name.
 *
 * Adding a case is the way to add coverage honestly: add the phrasing, run `pnpm --filter @atlas/engine test
 * coverage`, and either it reaches its skill or the report says it does not.
 */

export interface Base {
  area: string;
  text: string;
  /** The skill a correct understanding starts with; `a|b` accepts either (two doors to the same result). */
  skill: string;
  /** A question or a bare noun phrase: polite wrappers like "please …" would make it unnatural. */
  question?: boolean;
}

const b = (area: string, skill: string, ...texts: string[]): Base[] => texts.map((text) => ({ area, skill, text }));
const q = (area: string, skill: string, ...texts: string[]): Base[] => texts.map((text) => ({ area, skill, text, question: true }));

export const BASES: Base[] = [
  // apps
  ...b('apps', 'app.open', 'open steam', 'launch discord', 'start spotify', 'open notepad', 'open chrome', 'launch the calculator'),
  ...q('apps', 'app.isRunning', 'is steam running', 'is discord open'),
  ...b('apps', 'app.restart', 'restart discord'),

  // files
  ...b('files', 'files.find', 'find my resume', 'find the file budget.xlsx', 'where is my tax return'),
  ...b('files', 'files.createFolder', 'create a folder called Projects on the desktop'),
  ...b('files', 'storage.largestFiles', 'show my biggest files', 'what are the largest files on my D drive'),
  ...b('files', 'files.duplicates', 'find duplicate files in my downloads'),
  ...b('files', 'system.emptyRecycleBin', 'empty the recycle bin'),
  ...b('files', 'files.recent', 'show my recent files'),
  ...b('files', 'storage.folderSize', 'how big is my downloads folder'),
  ...b('files', 'files.zip', 'zip my documents folder'),

  // system
  ...b('system', 'system.mute', 'mute the volume', 'mute my computer'),
  ...b('system', 'system.volumeSet', 'set the volume to 30', 'turn the volume to 50 percent'),
  ...q('system', 'system.battery|system.info', "what's my battery level", 'how much battery do I have left'),
  ...q('system', 'system.disk|system.info', 'how much disk space do I have', 'how much free space is on C'),
  ...b('system', 'system.lock', 'lock my pc', 'lock the computer'),
  ...b('system', 'system.sleep', 'put the computer to sleep', 'sleep the pc'),
  ...b('system', 'system.theme', 'turn on dark mode', 'switch to light mode'),
  ...q('system', 'system.processes', 'what is using the most memory', 'show running processes'),
  ...q('system', 'system.uptime', 'how long has my pc been on'),
  ...q('system', 'system.specs', 'what are my pc specs', 'what cpu do I have'),
  ...b('system', 'system.displayOff', 'turn off the screen'),
  ...b('system', 'system.doNotDisturb', 'turn on do not disturb'),
  ...b('system', 'system.brightness', 'set the brightness to 60'),

  // network
  ...q('network', 'net.ip', "what's my ip address", 'what is my ip'),
  ...b('network', 'net.ping', 'ping google.com', 'ping 8.8.8.8'),
  ...b('network', 'net.speedTest', 'run a speed test', 'test my internet speed'),
  ...q('network', 'net.online', 'am I online', 'is my internet working'),
  ...b('network', 'net.flushDns', 'flush dns'),

  // web
  ...b('web', 'web.search|research.search', 'search google for cats', 'google best pizza near me', 'search the web for rust tutorials'),
  ...b('web', 'web.searchYoutube', 'search youtube for lofi music', 'find lofi beats on youtube'),
  ...b('web', 'web.searchWikipedia', 'search wikipedia for nikola tesla'),
  ...b('web', 'web.open|app.open', 'open youtube', 'go to github.com', 'open reddit'),
  ...b('web', 'web.searchMaps', 'show me maps of paris', 'find pizza on the map'),

  // text and math
  ...q('text-math', 'math.percent', 'what is 15% of 80'),
  ...b('text-math', 'math.calculate', 'calculate 12 * 7', 'what is 45 + 19'),
  ...b('text-math', 'math.convert', 'convert 5 miles to km', 'convert 100 fahrenheit to celsius'),
  ...b('text-math', 'util.password', 'generate a password', 'make me a strong password'),
  ...b('text-math', 'util.coin', 'flip a coin'),
  ...b('text-math', 'util.dice', 'roll a dice', 'roll a d20'),
  ...b('text-math', 'util.uuid', 'make a uuid', 'generate a uuid'),
  ...q('text-math', 'time.now', 'what time is it', "what's the date today"),
  ...b('text-math', 'time.timer', 'set a timer for 5 minutes', 'start a 10 minute timer'),
  ...q('text-math', 'time.until', 'how many days until christmas'),
  ...q('text-math', 'time.inZone', 'what time is it in tokyo'),

  // reminders, notes, tasks
  ...b('memory-tasks', 'reminder.set', 'remind me to call mom at 5pm', 'remind me in 20 minutes to stretch'),
  ...b('memory-tasks', 'todo.add', 'add milk to my todo list', 'add buy eggs to my to-do list'),
  ...b('memory-tasks', 'notes.add', 'take a note: buy eggs', 'note that the meeting is at 3'),
  ...b('memory-tasks', 'reminder.list', 'list my reminders', 'show my reminders'),
  ...b('memory-tasks', 'notes.list', 'show my notes', 'list my notes'),
  ...b('memory-tasks', 'alarm.set', 'set an alarm for 7am'),

  // development
  ...b('terminal-dev', 'git.status', 'git status', 'show the git status'),
  ...q('terminal-dev', 'git.branch', 'what branch am I on'),
  ...b('terminal-dev', 'git.log', 'show git log', 'show the commit history'),
  ...b('terminal-dev', 'git.pull', 'pull the latest changes', 'git pull'),
  ...b('terminal-dev', 'test.run', 'run the tests', 'run my tests'),
  ...b('terminal-dev', 'build.run', 'build the project', 'build my project'),
  ...b('terminal-dev', 'dependency.installAll', 'install dependencies', 'install the dependencies'),
  ...b('terminal-dev', 'terminal.open', 'open opencode', 'open claude code in powershell', 'run npm test in a terminal', 'type opencode in the PowerShell window'),
  ...q('terminal-dev', 'dev.tools', 'is git installed', 'do I have node', 'is opencode installed'),
  ...q('terminal-dev', 'terminal.read', 'what did the terminal print'),

  // windows and screen
  ...q('windows-ui', 'window.list', 'list open windows', 'what windows are open'),
  ...q('windows-ui', 'window.active', 'what window is active'),
  ...b('windows-ui', 'screen.capture', 'take a screenshot', 'screenshot my screen'),
  ...b('windows-ui', 'window.close', 'close this window'),

  // media and clipboard
  ...b('media', 'media.control', 'pause the music', 'next song', 'skip this track', 'resume the music'),
  ...q('media', 'media.nowPlaying', "what's playing", 'what song is this'),
  ...q('clipboard', 'clipboard.read', "what's on my clipboard", 'read my clipboard'),
  ...b('clipboard', 'clipboard.clear', 'clear my clipboard'),

  // atlas itself
  ...b('atlas', 'workflow.remember', 'remember that as my morning routine'),
  ...q('atlas', 'workflow.saved', 'what workflows have I saved'),
  ...b('atlas', 'agent.solve', 'figure out how to free up space on my D drive'),
];

/** Ways people wrap a request. `{x}` is the plain request. */
export const WRAPPERS: ReadonlyArray<{ id: string; apply: (x: string) => string; questionOk: boolean; onlyQuestions?: true }> = [
  { id: 'plain', apply: (x) => x, questionOk: true },
  { id: 'please', apply: (x) => `please ${x}`, questionOk: false },
  { id: 'can-you', apply: (x) => `can you ${x} for me?`, questionOk: false },
  { id: 'hey-atlas', apply: (x) => `hey atlas, ${x}`, questionOk: true },
  { id: 'trailing-please', apply: (x) => `${x} please`, questionOk: false },
  { id: 'could-you', apply: (x) => `could you ${x}`, questionOk: false },
  { id: 'i-need', apply: (x) => `I need you to ${x}`, questionOk: false },
  { id: 'go-ahead', apply: (x) => `go ahead and ${x}`, questionOk: false },
  { id: 'question-mark', apply: (x) => `${x}?`, questionOk: true, onlyQuestions: true },
  { id: 'shouting', apply: (x) => `${x.toUpperCase()}!`, questionOk: true },
];

export interface Case {
  area: string;
  wrapper: string;
  text: string;
  base: string;
  skill: string;
}

export function expand(): Case[] {
  const out: Case[] = [];
  for (const base of BASES) {
    for (const w of WRAPPERS) {
      if (base.question && !w.questionOk) continue;
      if (!base.question && w.onlyQuestions) continue;
      out.push({ area: base.area, wrapper: w.id, text: w.apply(base.text), base: base.text, skill: base.skill });
    }
  }
  return out;
}
