/**
 * SET C (2.0.2 round 2): written before any round-2 change, covering skills the earlier sets never touched.
 * `none` means "the deterministic layer should NOT claim this": it is a request for a model or a question to
 * ask back, and a skill match is a wrong answer. Measured first, then used to guide fixes; the next set (D)
 * is the untouched one.
 */
import type { Held } from './heldout';

const h = (skill: string, ...texts: string[]): Held[] => texts.map((text) => ({ text, skill }));

export const HELD_OUT_C: Held[] = [
  ...h('files.createFolder', 'make a new folder called Invoices on my desktop', 'create a directory named backups in documents'),
  ...h('files.rename', 'rename old.txt to new.txt', 'change the name of draft.docx to final.docx'),
  ...h('files.copy', 'copy report.pdf to my desktop', 'make a copy of notes.txt in documents'),
  ...h('files.move', 'move budget.xlsx to my documents folder', 'put photo.png into the pictures folder'),
  ...h('files.delete', 'delete the file old-notes.txt', 'get rid of temp.log'),
  ...h('files.zip', 'compress my projects folder into a zip', 'make a zip of the photos folder'),
  ...h('files.unzip', 'unzip archive.zip', 'extract backup.zip to my desktop'),
  ...h('files.info', 'how big is resume.pdf', 'when was report.docx last modified'),
  ...h('files.hash', 'what is the sha256 of installer.exe', 'get the checksum of setup.exe'),
  ...h('files.open', 'open report.pdf', 'open the file notes.txt'),
  ...h('files.reveal', 'show report.pdf in explorer', 'reveal the downloads folder in file explorer'),
  ...h('files.compareFolders', 'compare my two photo folders', 'what is different between folder a and folder b'),
  ...h('files.organize', 'organize my downloads folder', 'sort my downloads into folders by type'),
  ...h('storage.largestFolders', 'which folders use the most space', 'show my biggest folders'),
  ...h('storage.folderSize', 'how much space does my videos folder take'),
  ...h('system.endProcess', 'kill chrome', 'force quit notepad'),
  ...h('system.powerPlan', 'switch to the high performance power plan', 'use the balanced power plan'),
  ...h('system.startupApps', 'what runs when my pc starts', 'show my startup programs'),
  ...h('system.printers', 'what printers do i have', 'list my printers'),
  ...h('system.audioDevices', 'what speakers am i using', 'which microphone is selected'),
  ...h('system.wallpaper', 'change my wallpaper', 'set my desktop background'),
  ...h('system.shutdownIn', 'shut down my pc in 30 minutes', 'turn off the computer in an hour'),
  ...h('system.settingsPage', 'open bluetooth settings', 'take me to the display settings'),
  ...h('net.wifi', 'what wifi am i connected to', 'which network am i on'),
  ...h('net.dnsLookup', 'look up the ip of github.com', 'what is the dns record for example.com'),
  ...h('net.traceroute', 'trace the route to google.com', 'run a traceroute to 8.8.8.8'),
  ...h('git.commit', 'commit my changes with the message fix typo', 'git commit -m update readme'),
  ...h('git.push', 'push my commits to github', 'git push'),
  ...h('git.diff', 'show me what i changed', 'git diff'),
  ...h('git.checkout', 'switch to the dev branch', 'check out the main branch'),
  ...h('git.stash', 'stash my changes', 'put my work aside with git stash'),
  ...h('project.tree', 'show the file tree of this project', 'what is the structure of my project'),
  ...h('project.todos', 'find the todos in my code', 'list all the TODO comments'),
  ...h('code.search', 'search my code for useState', 'find where handleClick is used'),
  ...h('clipboard.copy', 'copy hello world to my clipboard', 'put this on the clipboard: abc123'),
  ...h('clipboard.history', 'show my clipboard history', 'what have i copied lately'),
  ...h('text.count', 'count the words in this: the quick brown fox', 'how many characters in hello world'),
  ...h('text.case', 'make this uppercase: hello there', 'convert to title case: the old man'),
  ...h('util.base64', 'base64 encode hello', 'decode this base64: aGVsbG8='),
  ...h('util.json', 'format this json: {"a":1,"b":2}', 'pretty print this json {"x":[1,2]}'),
  ...h('time.weekday', 'what day of the week is december 25 2026', 'what day was july 4 1990'),
  ...h('time.between', 'how many days between january 1 and march 1', 'days from today until new year'),
  ...h('reminder.cancel', 'cancel my reminder about the dentist', 'delete the reminder to call mom'),
  ...h('todo.list', 'show my todo list', 'what is on my to-do list'),
  ...h('todo.done', 'mark buy milk as done', 'check off call dentist from my todo list'),
  ...h('alarm.set', 'wake me up at 6:30', 'set an alarm for 5 am tomorrow'),
  ...h('calendar.add', 'add a meeting with sam to my calendar tomorrow at 2pm', 'schedule lunch on friday at noon'),
  ...h('web.searchImages', 'search for pictures of golden retrievers', 'find images of the eiffel tower'),
  ...h('media.playOn', 'play bohemian rhapsody on spotify', 'put on some jazz on youtube music'),
  ...h('window.place', 'snap this window to the left', 'put the active window on the right half'),
  ...h('screen.captureWindow', 'screenshot this window', 'capture just the active window'),
  ...h('app.list|system.software', 'what apps do i have installed', 'list my installed programs'),
  ...h('engine.help', 'what can you do', 'help'),
  // Not for the deterministic layer: these should NOT be claimed by a skill.
  ...h('none', 'arrange the quarterly synergy deck into a mood board', 'write a poem about the ocean', 'what is the capital of Peru', 'why is the sky blue', 'tell me a joke', 'summarize the plot of hamlet', 'draft an email to my landlord about the leak', 'plan a three day trip to rome', 'explain how recursion works'),
];
