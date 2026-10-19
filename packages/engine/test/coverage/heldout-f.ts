/**
 * SET F: written after the plausibility guard was designed from set E's wrong answers. Never tuned against.
 * Measured with the engine's believability check on, exactly as the engine runs.
 */
import type { Held } from './heldout';

const h = (skill: string, ...texts: string[]): Held[] => texts.map((text) => ({ text, skill }));

export const HELD_OUT_F: Held[] = [
  ...h('app.open', 'open firefox', 'start up steam please', 'i want to open calculator', 'launch obs'),
  ...h('system.volumeSet', 'set volume to 45', 'turn the volume down to 10'),
  ...h('system.lock', 'lock my laptop'),
  ...h('system.battery|system.info', 'battery level', 'how charged is my laptop'),
  ...h('system.processes', 'show running processes', 'what is using my cpu'),
  ...h('system.theme', 'enable dark mode', 'switch to light mode'),
  ...h('net.ip', 'what is my external ip'),
  ...h('net.online', 'is the internet working'),
  ...h('web.search|research.search', 'search google for rust async tutorials'),
  ...h('web.searchMaps', 'show me hotels near the airport on the map'),
  ...h('math.calculate', 'what is 99 plus 101', 'calculate 7 * 8 * 9'),
  ...h('math.convert', 'convert 5 gallons to liters', 'convert 72 fahrenheit to celsius'),
  ...h('util.uuid', 'make me a uuid'),
  ...h('time.timer', 'start a 5 minute timer', 'set a timer for 90 seconds'),
  ...h('time.inZone', 'what time is it in berlin'),
  ...h('reminder.set', 'remind me to stretch in 30 minutes', 'remind me to buy milk at 5pm'),
  ...h('reminder.list', 'list my reminders'),
  ...h('todo.add', 'add call mom to my todo list'),
  ...h('notes.add', 'take a note that the meeting moved to 4'),
  ...h('files.find', 'find budget.xlsx', 'look for my resume'),
  ...h('files.createFolder', 'create a folder called Projects on my desktop'),
  ...h('files.copy', 'copy notes.txt to my desktop'),
  ...h('files.move', 'move report.docx to my documents folder'),
  ...h('files.unzip', 'unzip backup.zip'),
  ...h('files.duplicates', 'find duplicate files in my pictures'),
  ...h('storage.largestFolders', 'show the biggest folders'),
  ...h('storage.folderSize', 'how big is my music folder'),
  ...h('git.status', 'git status'),
  ...h('git.diff', 'git diff'),
  ...h('git.commit', 'git commit -m wip'),
  ...h('git.checkout', 'switch to the main branch'),
  ...h('test.run', 'run the tests'),
  ...h('dependency.installAll', 'install dependencies', 'npm install'),
  ...h('project.startServer', 'start the dev server'),
  ...h('window.list', 'show all open windows'),
  ...h('screen.capture', 'take a screenshot'),
  ...h('media.control', 'pause the music', 'next song'),
  ...h('clipboard.read', 'what is on my clipboard'),
  ...h('terminal.open', 'open claude code', 'run cargo test in a terminal'),
  ...h('dev.tools', 'is rust installed', 'is git installed'),
  ...h('none', 'write an apology letter to a customer', 'what is a black hole', 'give me workout ideas', 'tell me something funny', 'why is the ocean salty', 'recommend a movie for tonight', 'rewrite my bio to sound more confident', 'what do you think about pineapple on pizza'),
];
