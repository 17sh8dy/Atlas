/**
 * The words people use for the same thing.
 *
 * "Launch", "start", "fire up" and "bring up" all mean open; "folder" and "directory" are one noun. A
 * skill's own text says "Open an app", so a request that says "fire up" shares no word with it and the
 * router cannot rank it. This table closes that gap on the RETRIEVAL side: a query is widened with the
 * other members of each group it touches before it is scored.
 *
 * One table, used twice — by `CapabilityIndex` to find candidates, and by the paraphrase layer
 * (`planner/paraphrase.ts`) to rewrite an unfamiliar verb into the one the grammar knows. Keeping it in
 * one place is what stops the two from drifting apart.
 *
 * It is data, not logic. It never decides what to DO; it only widens what is considered. Every group
 * lists the canonical word first. Adding a group cannot remove a capability or change a grammar rule.
 */

/** Each row is one meaning; the first word is the canonical form. */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // verbs
  ['open', 'launch', 'start', 'run', 'boot', 'fire', 'bring', 'pull', 'load', 'spin', 'begin'],
  ['close', 'quit', 'exit', 'shut', 'stop', 'end', 'kill', 'terminate'],
  ['find', 'search', 'locate', 'look', 'seek', 'hunt', 'discover', 'where'],
  ['show', 'display', 'list', 'view', 'see', 'reveal', 'print'],
  ['delete', 'remove', 'erase', 'trash', 'discard', 'wipe', 'clear'],
  ['copy', 'duplicate', 'clone', 'replicate', 'backup'],
  ['move', 'relocate', 'transfer', 'shift'],
  ['rename', 'retitle', 'relabel'],
  ['create', 'make', 'new', 'add', 'generate', 'build'],
  ['install', 'setup', 'get', 'download'],
  ['check', 'verify', 'test', 'inspect', 'diagnose', 'validate', 'confirm', 'audit'],
  ['fix', 'repair', 'correct', 'resolve', 'patch', 'debug'],
  ['edit', 'change', 'modify', 'update', 'alter', 'tweak', 'adjust', 'replace'],
  ['read', 'view', 'open', 'cat', 'inspect'],
  ['compare', 'diff', 'differ', 'contrast'],
  ['organize', 'sort', 'tidy', 'arrange', 'group', 'clean'],
  ['type', 'enter', 'input', 'write'],
  ['click', 'press', 'tap', 'push', 'select', 'choose'],
  ['scroll', 'page', 'pan'],
  ['save', 'store', 'keep', 'remember', 'record'],
  ['send', 'email', 'mail', 'message'],
  ['restart', 'reboot', 'relaunch', 'reload'],
  ['pause', 'suspend', 'hold', 'freeze'],
  ['resume', 'continue', 'unpause'],
  ['zip', 'compress', 'archive', 'pack'],
  ['unzip', 'extract', 'decompress', 'unpack'],
  // nouns
  ['folder', 'directory', 'dir', 'path'],
  ['file', 'document', 'doc'],
  ['app', 'application', 'program', 'software', 'tool', 'exe'],
  ['window', 'tab', 'pane'],
  ['terminal', 'shell', 'console', 'powershell', 'cmd', 'prompt', 'command'],
  ['picture', 'image', 'photo', 'screenshot', 'pic', 'jpg', 'png'],
  ['video', 'movie', 'clip', 'recording', 'footage', 'mp4'],
  ['music', 'song', 'audio', 'track', 'sound'],
  ['error', 'bug', 'problem', 'failure', 'crash', 'broken', 'issue', 'exception', 'fault'],
  ['project', 'repo', 'repository', 'codebase', 'workspace'],
  ['dependency', 'package', 'library', 'module'],
  ['server', 'service', 'daemon'],
  ['memory', 'ram'],
  ['disk', 'drive', 'storage', 'space'],
  ['largest', 'biggest', 'heaviest', 'huge', 'large', 'big'],
  ['smallest', 'tiniest', 'little', 'small'],
  ['duplicate', 'dupe', 'copies', 'identical'],
  ['network', 'internet', 'wifi', 'connection', 'online'],
  ['setting', 'preference', 'option', 'config', 'configuration'],
  ['website', 'site', 'webpage', 'page', 'url', 'link'],
  ['browser', 'chrome', 'brave', 'edge', 'firefox'],
  ['reminder', 'alarm', 'timer', 'alert'],
];

/** Words that carry no request of their own: manners and padding around the real instruction. */
export const FILLER_PREFIXES: readonly RegExp[] = [
  /^(?:hey|hi|hello|ok(?:ay)?|yo)\s+atlas[,!.]?\s+/i,
  /^atlas[,!.:]?\s+/i,
  /^(?:please|pls|kindly)[,]?\s+/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:go\s+ahead\s+and\s+)?/i,
  /^(?:i\s+(?:want|need|would\s+like|'d\s+like|’d\s+like)\s+(?:you\s+)?to\s+)/i,
  /^(?:i\s+(?:want|need|would\s+like)\s+(?:you\s+to\s+)?)/i,
  /^(?:go\s+ahead\s+and\s+)/i,
  /^(?:just\s+)/i,
  /^(?:how\s+about\s+(?:you\s+)?)/i,
  /^(?:let'?s|let’s)\s+/i,
];

export const FILLER_SUFFIXES: readonly RegExp[] = [
  /[,]?\s+(?:for\s+me|for\s+us)\s*[?.!]*$/i,
  /[,]?\s+(?:please|pls|thanks|thank\s+you|thx)\s*[?.!]*$/i,
  /[,]?\s+(?:right\s+now|now|real\s+quick|quickly|asap)\s*[?.!]*$/i,
  /\s*\?+$/,
];

/** Multi-word and slangy ways to say a simple verb, rewritten to the verb the grammar knows. */
export const PHRASAL_VERBS: readonly (readonly [RegExp, string])[] = [
  [/^(?:fire\s+up|boot\s+up|spin\s+up|bring\s+up|pull\s+up|kick\s+off|crank\s+up)\s+/i, 'open '],
  [/^(?:get)\s+(.+?)\s+(?:running|started|going|up(?:\s+and\s+running)?|open)$/i, 'open $1'],
  [/^(?:shut\s+down|shut\s+off|close\s+out|quit\s+out\s+of)\s+/i, 'close '],
  [/^(?:get\s+rid\s+of|throw\s+away|toss)\s+/i, 'delete '],
  [/^(?:look\s+for|hunt\s+for|dig\s+up|track\s+down|where(?:'|’)?s|where\s+is|where\s+are)\s+/i, 'find '],
];
