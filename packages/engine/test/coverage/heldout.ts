/**
 * A HELD-OUT set: phrasings written after the main corpus was tuned, never used to decide what to fix
 * before the first measurement. This is the number to trust for "how well does it handle sentences it was
 * not built around"; the main corpus is a regression guard and will always flatter the grammar.
 *
 * Expected skills use `a|b` for two correct doors. Where a sentence is genuinely ambiguous the expectation
 * says so. Sentences that do not reach their skill are NOT edited out: they are the measured gap.
 */

export interface Held {
  text: string;
  skill: string;
}

const h = (skill: string, ...texts: string[]): Held[] => texts.map((text) => ({ text, skill }));

export const HELD_OUT: Held[] = [
  ...h('app.open', 'pull up spotify', 'bring up the calculator', 'can you fire up photoshop', 'i want to use discord', 'get steam going', 'open up obs', 'launch my browser'),
  ...h('system.volumeSet', 'turn it down to 20', 'volume 40', 'make the volume 70 percent'),
  ...h('system.mute', 'silence my pc', 'shut off the sound', 'turn the sound off'),
  ...h('system.lock', 'lock the screen', 'lock this computer'),
  ...h('system.sleep', 'go to sleep', 'put my pc to sleep'),
  ...h('system.battery|system.info', 'how much charge is left', 'battery percentage'),
  ...h('system.disk|system.info|storage.folderSize', 'how full is my c drive', 'do i have enough space left'),
  ...h('system.uptime', 'when did my pc last restart', 'how long since i rebooted'),
  ...h('system.processes', 'what programs are running', 'show me what is running on my pc'),
  ...h('net.ip', 'tell me my ip', 'what is my public ip address'),
  ...h('net.online', 'do i have internet', 'is the internet down'),
  ...h('net.ping', 'ping cloudflare.com', 'is google.com reachable'),
  ...h('web.search|research.search', 'google how to boil an egg', 'look up the weather in denver', 'search for cheap flights to rome'),
  ...h('web.searchYoutube', 'play some jazz on youtube', 'youtube search for guitar lessons'),
  ...h('web.open|app.open', 'go to twitter', 'take me to netflix', 'open gmail'),
  ...h('math.calculate', 'what is 9 times 8', 'how much is 120 divided by 4', '2+2'),
  ...h('math.percent', 'what is 20 percent of 150', '15% of 300'),
  ...h('math.convert', 'how many kilometers is 10 miles', 'convert 3 feet to meters'),
  ...h('util.password', 'give me a random password', 'create a secure password'),
  ...h('util.coin', 'heads or tails'),
  ...h('util.dice', 'roll two dice', 'throw a die'),
  ...h('time.now', 'what is the time', 'tell me the time'),
  ...h('time.timer', 'timer for 3 minutes', 'start a countdown of 90 seconds'),
  ...h('time.inZone', 'what time is it in london', 'current time in sydney'),
  ...h('reminder.set', 'remind me tomorrow at 9 to submit the report', 'remind me to drink water in an hour'),
  ...h('reminder.list', 'what reminders do i have', 'any reminders'),
  ...h('todo.add', 'put laundry on my to do list', 'add call the dentist to my tasks'),
  ...h('notes.add', 'make a note that the wifi password is on the fridge', 'jot down: ideas for the trip'),
  ...h('git.status', 'what changed in my repo', 'show me the git state'),
  ...h('git.branch', 'which git branch is this', 'what branch is this project on'),
  ...h('git.log', 'show the last few commits', 'git history'),
  ...h('test.run', 'run the test suite', 'execute my tests'),
  ...h('build.run', 'compile the project', 'run a build'),
  ...h('dependency.installAll', 'npm install', 'install all packages'),
  ...h('files.find', 'where did i put my invoice', 'look for a file called notes.txt', 'locate report.pdf'),
  ...h('files.recent', 'what files did i open recently', 'show me recent documents'),
  ...h('storage.largestFiles', 'which files are taking the most space', 'find my largest files'),
  ...h('files.duplicates', 'look for duplicate files', 'any duplicate photos'),
  ...h('system.emptyRecycleBin', 'clear the recycle bin', 'empty trash'),
  ...h('window.list', 'show me all my windows', 'which apps are open'),
  ...h('screen.capture', 'capture my screen', 'snap a screenshot'),
  ...h('media.control', 'pause', 'skip this song', 'play the previous track', 'stop the music'),
  ...h('media.nowPlaying', 'what song is playing', 'whats playing right now'),
  ...h('clipboard.read', 'what did i copy', 'show my clipboard'),
  ...h('terminal.open', 'launch opencode', 'start claude code', 'run cargo test in powershell'),
  ...h('dev.tools', 'do i have git installed', 'is python installed', 'which version of node do i have'),
];

/**
 * SET B: written AFTER set A was used to add rules, so this one has never informed a fix. Its score is the
 * honest estimate of how well the deterministic layer handles sentences it was not shaped around.
 */
export const HELD_OUT_B: Held[] = [
  ...h('app.open', 'start up chrome', 'could you get notepad open', 'i would like to open word', 'pop open task manager'),
  ...h('system.volumeSet', 'set sound to 25', 'bring the volume down to 10'),
  ...h('system.lock', 'secure my computer', 'lock it down'),
  ...h('system.theme', 'switch to dark theme', 'enable light mode'),
  ...h('system.processes', 'what is hogging my cpu', 'list running programs'),
  ...h('net.speedTest', 'how fast is my internet', 'check my download speed'),
  ...h('net.ip', 'whats my ip', 'show me my ip address'),
  ...h('web.search|research.search', 'search for pasta recipes', 'google the population of canada'),
  ...h('web.searchWikipedia', 'wikipedia ada lovelace', 'look up ada lovelace on wikipedia'),
  ...h('math.calculate', 'whats 14 plus 29', 'calculate 81 / 9'),
  ...h('math.convert', 'convert 20 celsius to fahrenheit', 'how many pounds is 5 kg'),
  ...h('util.uuid', 'give me a uuid', 'new guid please'),
  ...h('time.now', 'what time is it right now', 'whats the time'),
  ...h('time.timer', 'set a 15 minute timer', 'timer 45 seconds'),
  ...h('reminder.set', 'remind me to take out the trash at 8pm', 'remind me in 2 hours to check the oven'),
  ...h('todo.add', 'add water the plants to my todo list', 'add pick up dry cleaning to my to-do list'),
  ...h('notes.add', 'note: call plumber', 'take a note that rent is due friday'),
  ...h('git.status', 'git status please', 'what is the git status'),
  ...h('git.pull', 'git pull', 'pull from origin'),
  ...h('test.run', 'run my unit tests', 'run the tests please'),
  ...h('build.run', 'build the project please', 'build this project'),
  ...h('files.find', 'find the file report.docx', 'search for budget.xlsx'),
  ...h('storage.folderSize', 'how big is the downloads folder', 'size of my documents folder'),
  ...h('system.emptyRecycleBin', 'empty my recycle bin', 'empty the trash can'),
  ...h('window.list', 'list my open windows', 'what is open right now'),
  ...h('screen.capture', 'take a screenshot', 'grab a screenshot'),
  ...h('media.control', 'next track', 'pause music', 'resume playback'),
  ...h('clipboard.read', 'read the clipboard', 'paste what is on my clipboard'),
  ...h('terminal.open', 'open opencode in a terminal', 'start codex'),
  ...h('dev.tools', 'is node installed', 'do i have docker'),
];
