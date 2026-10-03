/**
 * What `powershell.run` will not run, whoever asks and whatever mode Atlas is in.
 *
 * PowerShell is the one tool that can do anything, so it is the last resort: Atlas has a skill
 * for nearly everything a person would reach for it to do, and each of those skills has its own
 * checks. This policy keeps the script tool from becoming a way round them. It is a seatbelt, not
 * the safety: the real protections are that the person reads the WHOLE script on a card before it
 * runs (no mode softens that), that it runs under the emergency stop with a time limit, and that
 * any file path it names must be inside Allowed Folders.
 *
 * A blocklist cannot catch every way to say a thing in PowerShell, and this one does not pretend
 * to. It refuses the obvious classes, and it refuses the constructs that exist to hide what a
 * script does (encoded commands, built-up command names), so the card in front of the person is
 * not misleading.
 *
 * ⚠️ The same table lives in `apps/desktop/src-tauri/src/powershell.rs`, where the refusal is
 * enforced next to the machine. This copy exists to refuse before a card is drawn. A test reads
 * that file and fails if the two drift apart.
 */

export const MAX_SCRIPT_CHARS = 6000;

export interface DenyRule {
  reason: string;
  /** Whole words: matched with a boundary on each side. */
  words: readonly string[];
  /** Plain fragments: matched anywhere. */
  parts: readonly string[];
}

export const DENY_RULES: readonly DenyRule[] = [
  // BEGIN DENY
  {
    reason: 'It asks for administrator rights, which Atlas never uses for a script.',
    words: ['runas', 'gsudo', 'sudo'],
    parts: [],
  },
  {
    reason: 'It hides what it runs (encoded or built-up commands), so nobody could check it.',
    words: ['-encodedcommand', '-enc', '-ec', 'invoke-expression', 'iex', 'invoke-command', 'icm', 'add-type'],
    parts: ['&(', '& (', '& $', '&$', '& "', "& '", '&"', "&'", '.(', '[scriptblock]', 'scriptblock]::create', 'assembly]::load', 'dllimport', 'frombase64string'],
  },
  {
    reason: 'It downloads from or talks to the internet. Atlas has its own web tools for that.',
    words: ['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'curl', 'wget', 'start-bitstransfer'],
    parts: ['downloadstring', 'downloadfile', 'system.net.http', 'net.sockets', 'webclient', 'httpclient', 'tcpclient'],
  },
  {
    reason: 'It would erase files permanently. Deleting goes through the Recycle Bin skills instead.',
    words: ['remove-item', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase', 'clear-recyclebin'],
    parts: ['io.file]::delete', 'io.directory]::delete'],
  },
  {
    reason: 'It touches disks, boot settings, backups or file permissions.',
    words: ['format-volume', 'clear-disk', 'remove-partition', 'initialize-disk', 'new-partition', 'set-partition', 'set-disk', 'diskpart', 'bcdedit', 'bootrec', 'vssadmin', 'wbadmin', 'cipher', 'fsutil', 'chkdsk', 'sfc', 'dism', 'takeown', 'icacls', 'cacls'],
    parts: [],
  },
  {
    reason: 'It changes Windows security, services, startup or scheduled tasks.',
    words: ['set-executionpolicy', 'set-mppreference', 'add-mppreference', 'disable-netfirewallrule', 'set-netfirewallprofile', 'netsh', 'new-service', 'set-service', 'remove-service', 'sc', 'sc.exe', 'register-scheduledtask', 'unregister-scheduledtask', 'set-scheduledtask', 'schtasks', 'enable-psremoting', 'wmic'],
    parts: ['currentversion\\run', '\\startup\\'],
  },
  {
    reason: 'It touches the registry. Atlas has its own read-only registry skill.',
    words: ['reg', 'reg.exe', 'regedit'],
    parts: ['hklm:', 'hkcu:', 'hkcr:', 'hkey_', 'registry::'],
  },
  {
    reason: 'It would end programs, stop services, or shut the PC down. Those have their own skills with their own checks.',
    words: ['stop-process', 'spps', 'kill', 'taskkill', 'stop-computer', 'restart-computer', 'shutdown', 'logoff', 'stop-service', 'restart-service', 'start-service', 'suspend-service'],
    parts: [],
  },
  {
    reason: 'It starts other programs or shells. Opening things has its own skill.',
    words: ['start-process', 'start', 'saps', 'invoke-item', 'ii', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec'],
    parts: ['system32\\', 'syswow64\\'],
  },
  {
    reason: 'It reads or handles passwords and credentials.',
    words: ['get-credential', 'convertto-securestring', 'convertfrom-securestring', 'cmdkey', 'vaultcmd', 'net', 'net1'],
    parts: ['credential manager', 'sekurlsa', 'ntds.dit', 'mimikatz', 'lsass'],
  },
  {
    reason: 'It sends keystrokes or mouse input. That has its own gated skills.',
    words: [],
    parts: ['sendkeys', 'sendinput', 'mouse_event', 'keybd_event', 'setcursorpos', 'user32'],
  },
  {
    reason: 'It changes system-wide environment settings.',
    words: ['setx'],
    parts: ['environmentvariabletarget]::machine', 'setenvironmentvariable'],
  },
  // END DENY
];

/** Lowercase, backticks (PowerShell's escape character) gone, whitespace collapsed. */
export function normalizeScript(script: string): string {
  return script.toLowerCase().replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Blank out what is inside quotes, so text like Write-Output "kill the bugs" or a folder called
 * "net" is not mistaken for a command. A double-quoted string that contains `$(` is left alone,
 * because PowerShell runs whatever is inside it.
 */
export function maskStrings(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const quote = text[i]!;
    if (quote !== "'" && quote !== '"') {
      out += quote;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === quote) {
        if (text[j + 1] === quote) {
          j += 2; // a doubled quote is a quote character inside the string
          continue;
        }
        break;
      }
      j++;
    }
    const inner = text.slice(i + 1, j);
    const live = quote === '"' && inner.includes('$(');
    out += quote + (live ? inner : ' '.repeat(inner.length)) + (j < text.length ? quote : '');
    i = j + 1;
  }
  return out;
}

/** A character that continues a command or word in PowerShell. */
const WORD_CHAR = /[a-z0-9_\-$.\\/]/;
/** After a word. A slash continues a path ("net\reg" is two folders, not the net command). */
const AFTER_CHAR = /[a-z0-9_\-\\/]/;

function hasWord(haystack: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(word, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + word.length] ?? '';
    // The word has to stand alone: "rd" is not inside "records", "$rd" is a variable, and
    // "-enc" is not "-encoding".
    if ((!before || !WORD_CHAR.test(before)) && (!after || !AFTER_CHAR.test(after))) return true;
    from = at + 1;
  }
}

/** Why this script must not run at all, or null. */
export function powershellRefusal(script: string): string | null {
  if (!script.trim()) return 'There is nothing to run.';
  if (script.length > MAX_SCRIPT_CHARS) {
    return `That script is ${script.length} characters long. Anything over ${MAX_SCRIPT_CHARS} is too long to review properly; split it up.`;
  }
  const text = normalizeScript(script);
  const code = maskStrings(text);
  for (const rule of DENY_RULES) {
    if (rule.words.some((w) => hasWord(code, w)) || rule.parts.some((p) => text.includes(p))) {
      return `I won't run that: ${rule.reason}`;
    }
  }
  return null;
}

/** Does a drive-letter or UNC path start at `i`? */
function pathStartsAt(text: string, i: number): boolean {
  const c = text[i] ?? '';
  const before = i === 0 ? '' : text[i - 1]!;
  if (/[A-Za-z]/.test(c) && text[i + 1] === ':' && /[\\/]/.test(text[i + 2] ?? '')) {
    return !/[A-Za-z0-9]/.test(before);
  }
  return c === '\\' && text[i + 1] === '\\' && before !== '\\';
}

/**
 * Drive-letter and UNC paths written out in a script, so each can be checked against Allowed
 * Folders. A path ends at a quote, pipe or similar, or where the next path begins, so two paths on
 * one line are two paths and the second cannot hide behind the first.
 */
export function embeddedPaths(script: string): string[] {
  const stops = new Set(['"', "'", '`', '|', ';', ',', '<', '>', '*', '?', '\r', '\n', ')']);
  const found: string[] = [];
  let i = 0;
  while (i < script.length) {
    if (!pathStartsAt(script, i)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < script.length && !stops.has(script[j]!)) {
      if (/\s/.test(script[j]!) && pathStartsAt(script, j + 1)) break;
      j++;
    }
    const path = script.slice(i, j).replace(/[\s.]+$/, '');
    if (path.length > 2 && !found.includes(path)) found.push(path);
    i = Math.max(j, i + 1);
  }
  return found;
}
