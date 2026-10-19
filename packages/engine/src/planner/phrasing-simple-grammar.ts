/**
 * Families of ordinary phrasing for skills that take no argument, or one obvious one, found missing by the
 * held-out set (`test/coverage/heldout.ts`). A table, not a pile of rules: each row is one intent with the
 * ways people say it, and every row routes to a skill that already exists with the arguments it already takes.
 *
 * Nothing here is clever. A row either matches a whole sentence or does not; none looks inside a longer
 * sentence, so "remind me not to roll a die" is never read as a dice roll.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

const END = String.raw`\s*[?.!]*$`;
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');
const NUMBER_WORDS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const re = (body: string) => new RegExp(String.raw`^\s*(?:please\s+)?${body}${END}`, 'i');

interface Simple {
  name: string;
  patterns: RegExp[];
  build: (m: RegExpExecArray) => ReturnType<typeof plan> | null;
  /** The `questionSafe` intent, for rows that are questions ("when did my pc restart"). */
  question?: string;
}

const SIMPLE: Simple[] = [
  { name: 'uptimeWhen', question: 'uptime', patterns: [re(String.raw`(?:when\s+did\s+(?:my\s+|the\s+)?(?:pc|computer|laptop|machine)\s+(?:last\s+)?(?:restart|reboot|start|boot)(?:ed)?(?:\s+up)?|how\s+long\s+(?:has\s+it\s+been\s+)?since\s+(?:i|my\s+(?:pc|computer))\s+(?:last\s+)?(?:restart|reboot)ed)`)], build: () => plan(step('system.uptime', {}), 'uptime') },
  { name: 'batteryLeft', question: 'battery', patterns: [re(String.raw`(?:how\s+much\s+(?:charge|battery|power)\s+(?:is|do\s+i\s+have)\s+(?:there\s+)?left|battery\s+(?:percentage|percent|status|life)|how\s+much\s+(?:charge|battery)\s+(?:is\s+left|do\s+i\s+have))`)], build: () => plan(step('system.battery', {}), 'battery') },
  { name: 'diskFull', question: 'disk', patterns: [re(String.raw`(?:how\s+full\s+is\s+(?:my\s+|the\s+)?(?:[a-z]\s+)?(?:drive|disk|hard\s+drive)(?:\s+[a-z])?|do\s+i\s+have\s+enough\s+(?:space|storage|room)(?:\s+left)?)`)], build: () => plan(step('system.disk', {}), 'disk') },
  { name: 'silencePc', patterns: [re(String.raw`(?:silence|quiet)\s+(?:my\s+|the\s+)?(?:pc|computer|laptop|speakers?)`), re(String.raw`(?:shut|turn|switch)\s+(?:off|out)\s+(?:the\s+|my\s+)?(?:sound|audio)`), re(String.raw`(?:turn|switch)\s+(?:the\s+|my\s+)?(?:sound|audio)\s+off`)], build: () => plan(step('system.mute', { state: 'mute' }), 'mute') },
  { name: 'whatProgramsRun', question: 'processes', patterns: [re(String.raw`(?:what|which)\s+(?:programs|apps|applications|processes)\s+(?:are\s+)?running(?:\s+(?:right\s+now|on\s+(?:my|this)\s+(?:pc|computer)))?`), re(String.raw`show\s+(?:me\s+)?what(?:['’]s|\s+is)\s+running(?:\s+on\s+(?:my|this)\s+(?:pc|computer))?`)], build: () => plan(step('system.processes', {}), 'processes') },
  { name: 'coinFlip', patterns: [re(String.raw`(?:heads\s+or\s+tails|toss\s+a\s+coin|flip\s+me\s+a\s+coin)`)], build: () => plan(step('util.coin', {}), 'coin') },
  {
    name: 'diceRoll',
    patterns: [re(String.raw`(?:roll|throw|toss)\s+(?:me\s+)?(a|an|one|two|three|four|five|six|\d)\s+(?:six[- ]sided\s+)?(?:dice|die)`)],
    build: (m) => {
      const word = m[1]!.toLowerCase();
      const count = NUMBER_WORDS[word] ?? (Number(word) || 1);
      return plan(step('util.dice', count > 1 ? { count } : {}), 'dice');
    },
  },
  { name: 'tellTime', question: 'time', patterns: [re(String.raw`(?:tell\s+me\s+the\s+time|what\s+is\s+the\s+time|got\s+the\s+time|do\s+you\s+have\s+the\s+time)`)], build: () => plan(step('time.now', {}), 'time') },
  { name: 'timeInPlace', question: 'time-in', patterns: [re(String.raw`(?:the\s+)?(?:current|local)\s+time\s+(?:in|at)\s+(.+?)`)], build: (m) => plan(step('time.inZone', { place: tidy(m[1]!) }), 'time-in') },
  { name: 'remindersHave', question: 'reminder-list', patterns: [re(String.raw`(?:what\s+reminders\s+do\s+i\s+have(?:\s+(?:set|coming\s+up))?|(?:do\s+i\s+have\s+)?any\s+reminders(?:\s+(?:set|coming\s+up))?)`)], build: () => plan(step('reminder.list', {}), 'reminder-list') },
  { name: 'todoOnList', patterns: [re(String.raw`(?:put|add)\s+(.+?)\s+(?:on|to)\s+(?:my\s+|the\s+)?(?:to[- ]?do(?:s)?(?:\s+list)?|tasks?(?:\s+list)?)`)], build: (m) => plan(step('todo.add', { text: tidy(m[1]!) }), 'todo-add') },
  { name: 'noteThat', patterns: [re(String.raw`(?:make\s+a\s+note\s+(?:that|of|to)|jot\s+(?:down|this\s+down)|write\s+(?:this\s+)?down|note\s+down)\s*[:,-]?\s*(.+?)`)], build: (m) => {
      // "jot down 'x' into the open window" is typing into a window, not a note: leave it to the planner.
      if (/\b(?:into|in|to|on)\s+(?:the\s+|my\s+|this\s+|that\s+)?(?:open\s+|active\s+|current\s+)?(?:window|app|document|file|box|field|editor|notepad|word)\b/i.test(m[1]!)) return null;
      return plan(step('notes.add', { text: tidy(m[1]!) }), 'note-add');
    },
  },
  { name: 'gitState', patterns: [re(String.raw`(?:show\s+(?:me\s+)?(?:the\s+)?git\s+(?:state|changes)|what(?:['’]s|\s+is)\s+the\s+git\s+state)`)], build: () => plan(step('git.status', {}), 'git-status') },
  { name: 'gitBranchIs', question: 'git-branch', patterns: [re(String.raw`(?:which|what)\s+(?:git\s+)?branch\s+(?:is\s+this(?:\s+(?:project|repo|repository))?(?:\s+on)?|am\s+i\s+on|are\s+we\s+on)`)], build: () => plan(step('git.branch', {}), 'git-branch') },
  { name: 'gitHistory', patterns: [re(String.raw`(?:git\s+history|show\s+(?:me\s+)?(?:the\s+)?(?:last|latest|recent)\s+(?:few\s+)?commits|show\s+(?:me\s+)?(?:the\s+)?commit\s+(?:log|history))`)], build: () => plan(step('git.log', { limit: 10 }), 'git-log') },
  { name: 'testSuite', patterns: [re(String.raw`(?:run|execute|start)\s+(?:the\s+|my\s+|all\s+(?:the\s+|my\s+)?)?(?:test\s+suite|tests)`)], build: () => plan(step('test.run', {}), 'test-run') },
  { name: 'runBuild', patterns: [re(String.raw`(?:run\s+a\s+build|compile\s+(?:the\s+|my\s+)?(?:project|app|code))`)], build: () => plan(step('build.run', {}), 'build') },
  { name: 'installAllPackages', patterns: [re(String.raw`(?:npm\s+install|pnpm\s+install|yarn(?:\s+install)?|install\s+(?:all\s+)?(?:the\s+|my\s+)?(?:packages|modules|dependencies))`)], build: () => plan(step('dependency.installAll', {}), 'install-deps') },
  { name: 'whereDidIPut', patterns: [re(String.raw`(?:where\s+did\s+i\s+(?:put|save|leave|store)|look\s+for\s+a\s+file\s+called|locate)\s+(?:my\s+|the\s+)?(.+?)`)], build: (m) => plan(step('files.find', { query: tidy(m[1]!) }), 'find-files') },
  { name: 'recentlyOpened', patterns: [re(String.raw`(?:what\s+files\s+did\s+i\s+(?:open|use|work\s+on)\s+(?:recently|lately)|show\s+(?:me\s+)?recent\s+(?:documents|files))`)], build: () => plan(step('files.recent', { target: 'documents', hours: 168 }), 'files-recent') },
  { name: 'spaceHogs', patterns: [re(String.raw`(?:find\s+(?:my\s+)?(?:largest|biggest)\s+files|which\s+files\s+are\s+(?:taking\s+up|using|eating)\s+(?:the\s+)?(?:most\s+)?(?:space|storage))`)], build: () => plan(step('storage.largestFiles', { path: 'home' }), 'largest-files') },
  { name: 'duplicatePhotos', patterns: [re(String.raw`(?:any|are\s+there\s+(?:any\s+)?)\s*duplicate\s+(?:photos|pictures|images|files)`)], build: () => plan(step('files.duplicates', { target: 'downloads' }), 'duplicates') },
  { name: 'clearBin', patterns: [re(String.raw`(?:clear\s+(?:out\s+)?(?:the\s+|my\s+)?(?:recycle\s+bin|trash)|empty\s+(?:the\s+|my\s+)?trash)`)], build: () => plan(step('system.emptyRecycleBin', {}), 'recycle-bin') },
  { name: 'allWindows', patterns: [re(String.raw`(?:show\s+me\s+all\s+(?:of\s+)?my\s+windows|which\s+apps\s+are\s+open|what\s+apps\s+(?:do\s+i\s+have\s+)?open)`)], build: () => plan(step('window.list', {}), 'window-list') },
  { name: 'captureScreen', patterns: [re(String.raw`(?:capture\s+my\s+screen|snap\s+a\s+screenshot|snap\s+(?:my\s+)?screen)`)], build: () => plan(step('screen.capture', {}), 'screenshot') },
  { name: 'stopMusic', patterns: [re(String.raw`(?:stop|halt)\s+(?:the\s+|my\s+)?(?:music|song|track|playback)`)], build: () => plan(step('media.control', { key: 'play-pause' }), 'media') },
  { name: 'countdown', patterns: [re(String.raw`(?:start\s+)?a\s+countdown\s+(?:of|for)\s+(\d+)\s*(seconds?|minutes?|mins?)`)], build: (m) => plan(step('time.timer', { seconds: Number(m[1]) * (/^m/i.test(m[2]!) ? 60 : 1) }), 'timer') },
];

export function createSimplePhrasingGrammar(): GrammarRule[] {
  return SIMPLE.map((s, i) => ({
    name: s.name,
    order: -11.55 + i * 0.0001,
    pathSafe: true,
    ...(s.question ? { questionSafe: [s.question] } : {}),
    test(_lower: string, raw: string) {
      for (const p of s.patterns) {
        const m = p.exec(raw);
        if (m) return s.build(m);
      }
      return null;
    },
  }));
}
