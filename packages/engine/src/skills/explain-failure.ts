/**
 * `diagnostics.explainFailure` — turn a raw error into likely causes and next steps, with no model.
 *
 * A table of well-known failure shapes, matched against the text the person pasted (and optional
 * context such as the command that failed). Every explanation quotes the line that triggered it, so
 * the reasoning is checkable; when nothing matches it says it does not recognise the error instead of
 * inventing one. The causes are the COMMON ones for that shape — they are leads, not a diagnosis.
 *
 * The same idea as `build-diagnose.ts`, but for any error text rather than a build's output.
 */

export interface FailureRule {
  id: string;
  /** What kind of failure this is, in a few words. */
  title: string;
  test: RegExp;
  causes: string[];
  fixes: string[];
}

const R = (id: string, title: string, test: RegExp, causes: string[], fixes: string[]): FailureRule => ({ id, title, test, causes, fixes });

export const FAILURE_RULES: readonly FailureRule[] = [
  R('missing-file', 'A file or folder was not found', /\b(?:ENOENT|no such file or directory|cannot find the (?:file|path)|system cannot find|FileNotFoundError|path .* does not exist)\b/i,
    ['The path is misspelled, or the file was moved or deleted.', 'The command ran from a different folder than you expected.', 'A relative path is being resolved against the wrong working directory.'],
    ['Check the exact path exists (“does D:\\… exist”).', 'Run the command from the project folder, or use a full path.', 'If a build step should have created it, look for an earlier error.']),
  R('permission', 'Permission denied', /\b(?:EACCES|EPERM|permission denied|access is denied|operation not permitted|UnauthorizedAccessException)\b/i,
    ['The file or folder is protected, or owned by another account.', 'A program has the file open and locked.', 'The action needs administrator rights.'],
    ['Close the program that has the file open and try again.', 'Check the folder is not read-only or inside Program Files.', 'Only if you trust the command, run it as administrator.']),
  R('file-locked', 'A file is in use', /\b(?:EBUSY|being used by another process|resource busy or locked|sharing violation|file is locked)\b/i,
    ['Another program (an editor, antivirus scan, sync client) has the file open.'],
    ['Close the program using it, wait a few seconds, then retry.', 'Pause cloud-sync or antivirus scanning on that folder if it keeps happening.']),
  R('port-in-use', 'A port is already in use', /\b(?:EADDRINUSE|address already in use|port \d+ is (?:already )?in use|only one usage of each socket address)\b/i,
    ['An earlier copy of the same server is still running.', 'Another program is using that port.'],
    ['Find what holds the port (“what is using port 3000”) and stop it, or choose a different port.']),
  R('module-missing', 'A module or package is missing', /\b(?:MODULE_NOT_FOUND|Cannot find module|ModuleNotFoundError|No module named|ERR_MODULE_NOT_FOUND|Cannot resolve dependency|could not resolve)\b/i,
    ['The dependencies are not installed in this folder.', 'The package name or import path is misspelled.', 'The package was installed in a different project or environment.'],
    ['Install the dependencies (“install the dependencies in this project”).', 'Check the import path and the package name in package.json.']),
  R('npm-resolve', 'Dependency versions conflict', /\b(?:ERESOLVE|peer dep|unable to resolve dependency tree|conflicting peer dependency)\b/i,
    ['Two packages ask for incompatible versions of a shared dependency.'],
    ['Read which package wants which version in the message.', 'Update the older package, or install with the project’s documented flag for peer conflicts.']),
  R('ts-error', 'A TypeScript type error', /\berror TS\d{3,5}\b/,
    ['A value does not match the type the code expects.', 'A type definition changed after an upgrade.'],
    ['Open the file and line named in the message; the first error is usually the cause of the rest.', 'Fix the first error and rebuild before reading the others.']),
  R('syntax', 'A syntax error', /\b(?:SyntaxError|ParseError|Unexpected token|unexpected end of (?:input|file)|invalid syntax|IndentationError|Unterminated)\b/i,
    ['A bracket, quote or comma is missing or extra.', 'The file was cut off or edited half-way.', 'The code uses a newer language feature than this runtime supports.'],
    ['Go to the line in the message (and the line before it); look for an unclosed bracket or quote.', 'Check the runtime version supports the syntax.']),
  R('json', 'Invalid JSON', /\b(?:JSON\.parse|Unexpected token .* in JSON|JSONDecodeError|invalid json|Expecting (?:value|property name))/i,
    ['A trailing comma, a single-quoted string, or a comment in a JSON file.', 'The response was HTML or empty, not JSON.', 'The file is truncated.'],
    ['Paste the file into a JSON checker or ask me to “check the project” — it validates JSON files.', 'If it came from a web request, look at the status code and the first characters of the body.']),
  R('not-recognized', 'A command was not found', /\b(?:is not recognized as an internal or external command|command not found|CommandNotFoundException|not recognized as the name of a cmdlet|'[^']+' is not recognized)\b/i,
    ['The program is not installed, or is installed but not on PATH.', 'The terminal was opened before it was installed.'],
    ['Check it is installed (“is git installed”).', 'Open a new terminal after installing so PATH is refreshed.']),
  R('git-conflict', 'A git merge conflict', /\b(?:CONFLICT \(|merge conflict|Automatic merge failed|fix conflicts and then commit)\b/i,
    ['The same lines were changed on both sides.'],
    ['Open the conflicted files and choose which side to keep between the <<<<<<< and >>>>>>> markers.', 'Then stage them and commit, or abort the merge.']),
  R('git-auth', 'Git could not authenticate', /\b(?:Authentication failed|could not read Username|Permission denied \(publickey\)|remote: (?:Invalid username|Support for password authentication was removed)|403)\b.*|\bfatal: could not read Password\b/i,
    ['The saved credential is expired or wrong.', 'The repository is private and this account has no access.'],
    ['Sign in again through your git credential manager, or use a token instead of a password.', 'Check the remote URL (“git remote -v”).']),
  R('git-not-repo', 'Not a git repository', /\b(?:not a git repository|fatal: no git repository)\b/i,
    ['The command ran in a folder that is not a git project.'],
    ['Run it from the project folder, or start one with “git init”.']),
  R('out-of-memory', 'Ran out of memory', /\b(?:JavaScript heap out of memory|OutOfMemory|MemoryError|ENOMEM|Cannot allocate memory|out of memory)\b/i,
    ['The task needs more memory than it was given.', 'A loop is building something without bound.'],
    ['Close other heavy programs and retry.', 'For Node, raise the limit (--max-old-space-size) only after checking for a runaway loop.']),
  R('disk-full', 'The disk is full', /\b(?:ENOSPC|no space left on device|not enough space on the disk|There is not enough space)\b/i,
    ['The drive has no free space left.'],
    ['Free space (“what is using my disk space”), then retry.']),
  R('timeout', 'It took too long', /\b(?:ETIMEDOUT|timed out|timeout|ESOCKETTIMEDOUT|deadline exceeded|operation timed out)\b/i,
    ['The server or program was too slow or unreachable.', 'A firewall or VPN is blocking the connection.', 'The timeout is shorter than the work needs.'],
    ['Check the connection (“am I online”), then retry once.', 'If it repeats, check the address and any VPN or proxy.']),
  R('network', 'The connection failed', /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|getaddrinfo|Name or service not known|Could not resolve host|No connection could be made|net::ERR_|Failed to fetch)\b/i,
    ['The address is wrong, or the server is down or not started yet.', 'You are offline, or DNS is failing.', 'Nothing is listening on that port.'],
    ['Check the address and port.', 'Check you are online.', 'If it is your own server, make sure it is running first.']),
  R('tls', 'A certificate problem', /\b(?:CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|self[- ]signed certificate|certificate (?:verify failed|has expired)|SSL: CERTIFICATE|ERR_CERT|SEC_E_UNTRUSTED_ROOT)\b/i,
    ['The site’s certificate expired or is self-signed.', 'The PC clock is wrong.', 'A proxy or antivirus is intercepting secure connections.'],
    ['Check the date and time on this PC.', 'Do not turn certificate checking off to make it go away; fix the certificate or trust the right one.']),
  R('http-401', 'Not authorised (401/403)', /\b(?:401|403)\b.*\b(?:unauthori[sz]ed|forbidden|denied)\b|\b(?:unauthori[sz]ed|forbidden)\b.*\b(?:401|403)\b|\bstatus(?: code)?:? ?(?:401|403)\b/i,
    ['The key or token is missing, expired or has too few permissions.', 'The account is not allowed to use that resource.'],
    ['Check the credential is being sent and has not expired.', 'Check the account has access to that resource.']),
  R('http-404', 'Not found (404)', /\b404\b.*\bnot found\b|\bnot found\b.*\b404\b|\bstatus(?: code)?:? ?404\b/i,
    ['The URL or route is wrong, or the item was deleted.'],
    ['Check the address character by character, including the version and trailing path.']),
  R('http-429', 'Too many requests (429)', /\b429\b|too many requests|rate limit/i,
    ['Requests are being sent faster than the service allows.'],
    ['Wait for the time in the Retry-After header, then retry more slowly.']),
  R('http-5xx', 'The server failed (5xx)', /\bstatus(?: code)?:? ?5\d\d\b|\b50[0234]\b.*\b(?:error|gateway|unavailable)\b|internal server error|bad gateway|service unavailable/i,
    ['The problem is on the server’s side, not in your request.'],
    ['Retry after a short wait.', 'If it persists, check the service’s status page, or its own logs if you run it.']),
  R('stack-overflow', 'Too much recursion', /\b(?:Maximum call stack size exceeded|StackOverflow|RecursionError|stack overflow)\b/i,
    ['A function keeps calling itself without a stopping condition.'],
    ['Look at the repeated frames in the stack trace; the function that repeats is the one to fix.']),
  R('null', 'Used a value that was not there', /\b(?:Cannot read propert(?:y|ies) of (?:undefined|null)|undefined is not (?:a function|an object)|NullReferenceException|NoneType|TypeError: .* is not (?:a function|iterable))\b/i,
    ['A variable was undefined or null when the code used it.', 'A response or file did not have the shape the code expected.'],
    ['Find the variable named in the message and check where it is set; add a check or fix the data.', 'Log it just before the failing line.']),
  R('test-fail', 'A test failed', /\b(?:AssertionError|expected .* to (?:equal|be|match|contain)|\d+ failed|Tests?:\s+\d+ failed|FAILED|assert(?:ion)? failed)\b/i,
    ['The code does something different from what the test expects.', 'The test itself is out of date after a change.'],
    ['Read the “expected / received” lines first.', 'Decide whether the code or the test is wrong before changing either.']),
  R('exit-code', 'A program exited with an error', /\b(?:exit(?:ed)? (?:with )?(?:code|status) [1-9]\d*|exit code:? [1-9]\d*|returned non-zero exit status)\b/i,
    ['The program ran and reported failure; the real reason is in the lines printed above this one.'],
    ['Scroll up to the first error line, not the last one.']),
  R('encoding', 'A text encoding problem', /\b(?:UnicodeDecodeError|UnicodeEncodeError|invalid (?:utf-8|byte sequence)|codec can't (?:decode|encode)|charmap)\b/i,
    ['The file is not in the encoding the program assumed (often UTF-8 vs the Windows code page).'],
    ['Open the file with an explicit encoding (utf-8), or re-save it as UTF-8.']),
  R('execution-policy', 'PowerShell blocked a script', /\b(?:running scripts is disabled|cannot be loaded because running scripts|ExecutionPolicy|UnauthorizedAccess.*\.ps1)\b/i,
    ['Windows’ script policy does not allow unsigned scripts to run.'],
    ['Do not weaken the policy system-wide; run the single command you trust, or sign / unblock that one script after reading it.']),
];

export interface Explanation {
  recognised: boolean;
  matches: Array<{ rule: FailureRule; evidence: string[] }>;
}

/** The lines that triggered a rule, trimmed, at most three. */
function evidenceFor(rule: FailureRule, text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hits = lines.filter((l) => rule.test.test(l));
  return (hits.length ? hits : lines.slice(0, 1)).slice(0, 3).map((l) => (l.length > 160 ? `${l.slice(0, 159)}…` : l));
}

export function explainFailure(error: string, context = ''): Explanation {
  const text = `${error}\n${context}`.trim();
  const matches = FAILURE_RULES.filter((r) => r.test.test(text))
    .slice(0, 3)
    .map((rule) => ({ rule, evidence: evidenceFor(rule, text) }));
  return { recognised: matches.length > 0, matches };
}

export function formatExplanation(e: Explanation): string {
  if (!e.recognised) {
    return '🩺 I don’t recognise that error, so I won’t guess. Send me the first error line (not the last), the command that produced it, and the folder it ran in, and I’ll look again — or say “search the web for” plus the exact message.';
  }
  const lines: string[] = [];
  for (const { rule, evidence } of e.matches) {
    lines.push(`🩺 ${rule.title}`, ...evidence.map((l) => `   “${l}”`), 'Likely causes:', ...rule.causes.map((c) => `  • ${c}`), 'What to try:', ...rule.fixes.map((f) => `  • ${f}`), '');
  }
  lines.push('These are the common causes for this kind of error — leads to check, not a certain diagnosis.');
  return lines.join('\n');
}
