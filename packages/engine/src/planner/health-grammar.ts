/**
 * Phrasings for the 1.0.8 read-only tools: PC health, file intelligence, build diagnosis, release
 * notes. All deterministic — the AI tier may make a phrasing better understood, never the only way
 * to say a documented one (see advertised-examples.test.ts).
 *
 * A rule here only ever picks a skill and its arguments. The skill decides what is allowed.
 */

import { plan, step, type GrammarRule } from './grammar';

const WIN_PATH = String.raw`(?:"[a-z]:[\\/][^"]*"|[a-z]:[\\/][^\s"]*[^\s".,;:!?])`;
const unq = (s: string) => s.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');

/** Every Windows path in a sentence, in order. */
export function pathsIn(raw: string): string[] {
  return [...raw.matchAll(new RegExp(WIN_PATH, 'gi'))].map((m) => unq(m[0]));
}

/** The sentence with each path replaced by a `<p>` token, so patterns read as sentences. */
const tok = (lower: string, paths: string[]) =>
  paths.reduce((s, p) => s.split(`"${p.toLowerCase()}"`).join('<p>').split(p.toLowerCase()).join('<p>'), lower).replace(/[?.!]+\s*$/, '').replace(/\s+/g, ' ').trim();

/** "last 3 days", "past 12 hours", "today", "yesterday", "this week" → hours (1–168). */
export function hoursIn(lower: string): number | null {
  const m = /\b(?:in\s+|from\s+|over\s+|for\s+)?(?:the\s+)?(?:last|past)\s+(\d+|an?|one|two|three|four|five|six|seven)\s*(hours?|hrs?|days?|weeks?)\b/.exec(lower);
  if (m) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : (words[m[1]!] ?? 1);
    const unit = m[2]!.startsWith('h') ? 1 : m[2]!.startsWith('d') ? 24 : 168;
    return Math.min(168, Math.max(1, n * unit));
  }
  if (/\btoday\b|\blast\s+24\b/.test(lower)) return 24;
  if (/\byesterday\b/.test(lower)) return 48;
  if (/\bthis\s+week\b|\blast\s+week\b/.test(lower)) return 168;
  return null;
}

const TAIL = String.raw`\s*[?.!]*$`;
const LEAD = String.raw`^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:i\s+(?:want|need)\s+(?:you\s+)?to\s+)?`;

export function createHealthGrammar(): GrammarRule[] {
  return [
    {
      // "why is my pc slow", "pc performance report": one evidence-based report.
      name: 'pcReport',
      order: -13.2,
      questionSafe: ['pc-report'],
      test(lower) {
        const t = lower.replace(/[?.!]+\s*$/, '').trim();
        const hit =
          /\bwhy\s+(?:is|does|has)\s+(?:my\s+|the\s+|this\s+)?(?:pc|computer|laptop|machine|system)\s+(?:(?:so|very|really|suddenly|getting)\s+)*(?:slow|lagg?y|lagging|sluggish|freezing|stuttering|running\s+slow)\b/.test(t) ||
          /\b(?:pc|computer|system|performance)\s+(?:performance\s+|health\s+)?report\b/.test(t) ||
          /\b(?:diagnose|check\s+up\s+on|health\s*-?check)\s+(?:on\s+)?(?:my\s+|the\s+|this\s+)?(?:pc|computer|laptop|machine|system)\b/.test(t) ||
          /\bis\s+(?:there\s+)?anything\s+wrong\s+with\s+(?:my\s+|the\s+|this\s+)?(?:pc|computer|laptop|machine)\b/.test(t) ||
          /^\s*(?:run\s+)?(?:a\s+)?(?:pc|computer)\s+health\s*-?check\s*$/.test(t);
        if (!hit) return null;
        const hours = hoursIn(t);
        return plan(step('system.report', hours ? { hours } : {}), 'pc-report');
      },
    },
    {
      // "how is my pc doing", "live cpu and gpu usage": a reading right now.
      name: 'pcMetrics',
      order: -13.1,
      questionSafe: ['pc-metrics'],
      test(lower) {
        const t = lower.replace(/[?.!]+\s*$/, '').trim();
        const hit =
          /\bhow\s+is\s+(?:my\s+|the\s+|this\s+)?(?:pc|computer|laptop|machine|system)\s+(?:doing|running|performing)\b/.test(t) ||
          /\blive\s+(?:cpu|gpu|ram|memory|disk|system|pc|metrics|usage|stats|performance)\b/.test(t) ||
          /\b(?:gpu)\s+(?:usage|load|utili[sz]ation)\b|\bhow\s+much\s+gpu\b|\bhow\s+busy\s+is\s+(?:my\s+)?(?:gpu|cpu|pc|computer)\b/.test(t) ||
          /\b(?:system|pc|computer)\s+(?:metrics|performance\s+now|vitals)\b/.test(t) ||
          /\bwhich\s+programs?\s+(?:use|using|take|taking)\s+the\s+most\s+(?:cpu|memory|ram)\b/.test(t) ||
          /\bcpu\s*,?\s*(?:and\s+)?(?:gpu|ram)\b.*\b(?:usage|right\s+now|now)\b/.test(t);
        return hit ? plan(step('system.metrics'), 'pc-metrics') : null;
      },
    },
    {
      // "show recent windows errors", "any errors in the event log", "what crashed in the last 3 days".
      name: 'windowsErrors',
      order: -13.05,
      questionSafe: ['windows-errors'],
      test(lower) {
        const t = lower.replace(/[?.!]+\s*$/, '').trim();
        const hit =
          /\b(?:recent|latest|last)\s+(?:windows\s+|system\s+|event\s*(?:log\s+|viewer\s+)?)?(?:errors?|crashes)\b/.test(t) ||
          /\b(?:any|show|list|check)\s+(?:me\s+)?(?:the\s+)?(?:recent\s+)?(?:windows\s+|system\s+)?errors?\s+(?:in|from)\s+(?:the\s+)?(?:windows\s+|event\s+)?(?:log|logs|viewer|event\s+viewer)\b/.test(t) ||
          /\b(?:event\s*log|event\s*viewer)\s+errors?\b/.test(t) ||
          /\bwhat\s+(?:has\s+)?crash(?:ed)?\b/.test(t) ||
          /^\s*(?:show|list|check)\s+(?:me\s+)?(?:the\s+)?(?:windows|system)\s+errors?\b/.test(t);
        if (!hit) return null;
        const hours = hoursIn(t);
        return plan(step('system.errors', hours ? { hours } : {}), 'windows-errors');
      },
    },
    {
      // "what software is installed", "list installed programs", "what are my biggest programs".
      name: 'installedSoftware',
      order: -13.0,
      questionSafe: ['installed-software'],
      test(lower) {
        const t = lower.replace(/[?.!]+\s*$/, '').trim();
        const biggest = /\b(?:biggest|largest|heaviest)\s+(?:installed\s+)?(?:programs|software|apps|applications)\b/.test(t);
        const listing =
          /\b(?:what|which)\s+(?:software|programs|apps|applications)\s+(?:is|are|do\s+i\s+have)\s+installed\b/.test(t) ||
          /\b(?:list|show)\s+(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?installed\s+(?:software|programs|apps|applications)\b/.test(t) ||
          /^\s*installed\s+(?:software|programs)\s*$/.test(t);
        if (!biggest && !listing) return null;
        return plan(step('system.software', biggest ? { sort: 'size' } : {}), 'installed-software');
      },
    },
    {
      // "list my drivers", "what graphics driver do i have", "are any drivers unsigned".
      name: 'drivers',
      order: -12.95,
      questionSafe: ['drivers'],
      test(lower) {
        const t = lower.replace(/[?.!]+\s*$/, '').trim();
        if (!/\bdrivers?\b/.test(t)) return null;
        if (/\b(?:update|install|download|uninstall|remove|roll\s*back|reinstall|fix)\b/.test(t)) return null;
        const verb = /^\s*(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:list|show|what|which|are|check|do|display|give)\b/.test(t) || /\bdriver\s+(?:list|inventory|versions?)\b/.test(t);
        if (!verb) return null;
        const kinds: Array<[RegExp, string]> = [
          [/\b(?:graphics|video|display|gpu)\b/, 'display'],
          [/\b(?:network|wi-?fi|wireless|ethernet|lan)\b/, 'net'],
          [/\b(?:audio|sound|speaker|media)\b/, 'media'],
          [/\bbluetooth\b/, 'bluetooth'],
          [/\busb\b/, 'usb'],
          [/\b(?:disk|storage|nvme|sata)\b/, 'hdc'],
        ];
        const kind = kinds.find(([re]) => re.test(t))?.[1];
        const unsigned = /\bunsigned\b/.test(t);
        return plan(step('system.drivers', unsigned ? { query: '' } : kind ? { query: kind } : {}), 'drivers');
      },
    },
    {
      // "network usage", "how much data have i used".
      name: 'networkUsage',
      order: -12.9,
      questionSafe: ['network-usage'],
      test(lower) {
        const t = lower.replace(/[?.!]+\s*$/, '').trim();
        const hit =
          /\b(?:network|data|bandwidth|internet)\s+usage\b/.test(t) ||
          /\bhow\s+much\s+(?:data|bandwidth)\s+(?:have|did|has)\s+(?:i|my\s+pc|this\s+pc)\s+(?:used|use|sent|received|transferred)\b/.test(t) ||
          /\bhow\s+fast\s+is\s+my\s+(?:network|connection|internet)\s+right\s+now\b/.test(t);
        return hit ? plan(step('net.usage'), 'network-usage') : null;
      },
    },
    {
      // "verify D:\Downloads\setup.exe", "is D:\x.exe signed", "check the signature of …".
      name: 'verifyFile',
      order: -12.85,
      pathSafe: true,
      questionSafe: ['verify-file'],
      test(lower, raw) {
        const paths = pathsIn(raw);
        if (paths.length !== 1) return null;
        // The path becomes a token, so the patterns read as sentences.
        const sentence = lower.replace(paths[0]!.toLowerCase(), '<p>').replace(/"<p>"/, '<p>').replace(/[?.!]+\s*$/, '').trim();
        const hit =
          /^(?:please\s+)?(?:verify|authenticate)\s+(?:the\s+)?(?:file\s+|download\s+)?<p>$/.test(sentence) ||
          /^(?:please\s+)?(?:check|verify|show|get)\s+(?:the\s+)?(?:digital\s+)?(?:signature|signer|publisher)\s+(?:of|on|for)\s+(?:the\s+)?(?:file\s+)?<p>$/.test(sentence) ||
          /^is\s+(?:the\s+)?(?:file\s+)?<p>\s+(?:digitally\s+)?signed$/.test(sentence) ||
          /^who\s+(?:signed|published|made)\s+(?:the\s+)?(?:file\s+)?<p>$/.test(sentence) ||
          /^what\s+(?:kind|type)\s+of\s+file\s+is\s+<p>(?:\s+(?:really|actually))?$/.test(sentence);
        return hit ? plan(step('files.verify', { path: paths[0]! }), 'verify-file') : null;
      },
    },
    {
      // "read the registry key HKCU\Software\…", "show registry HKLM\…".
      name: 'registryRead',
      order: -12.8,
      pathSafe: true,
      questionSafe: ['registry-read'],
      test(_lower, raw) {
        const m = /(?:"((?:HKEY_CURRENT_USER|HKEY_LOCAL_MACHINE|HKCU|HKLM)[\\/][^"]*)"|\b((?:HKEY_CURRENT_USER|HKEY_LOCAL_MACHINE|HKCU|HKLM)(?:[\\/][^"\r\n]*[^\s".,;:!?])?))/i.exec(raw);
        if (!m) return null;
        // A key name can hold spaces ("Windows NT"), so the unquoted form runs to the end of the sentence;
        // if what follows the hive reads like an instruction to change something, it is not a read.
        if (/\b(?:delete|remove|set|write|change|edit|modify|and\s+then)\b/i.test(m[2] ?? '')) return null;
        const before = raw.slice(0, m.index).toLowerCase();
        if (!/\b(?:read|show|view|inspect|look\s+at|open|list|display|what(?:'s|\s+is)\s+in)\b/.test(before) || !/\b(?:registry|reg\s+key|key|hive)\b/.test(before)) return null;
        // Changing the registry is not something Atlas does, and must not read as a read.
        if (/\b(?:set|write|change|edit|modify|delete|remove|add|create|import|export|fix|clean)\b/.test(before)) return null;
        return plan(step('registry.read', { key: (m[1] ?? m[2])!.trim() }), 'registry-read');
      },
    },
    {
      // "read D:\Docs\report.pdf", "what does D:\x.docx say".
      name: 'readDocument',
      order: -12.75,
      pathSafe: true,
      questionSafe: ['read-document'],
      test(lower, raw) {
        const all = pathsIn(raw);
        const paths = all.filter((p) => /\.(?:pdf|docx)$/i.test(p));
        if (paths.length !== 1 || all.length !== 1) return null;
        const s = tok(lower, paths);
        const around = /^(?:please\s+)?(?:find|search\s+for|look\s+for)\s+["“]?([^"”<]+?)["”]?\s+in\s+(?:the\s+)?(?:pdf\s+|document\s+|file\s+)?<p>$/.exec(s);
        if (around) return plan(step('files.readDocument', { path: paths[0]!, around: around[1]!.trim() }), 'read-document');
        const hit =
          /^(?:please\s+)?(?:read|open\s+and\s+read|show\s+me\s+the\s+text\s+of|show\s+the\s+text\s+of|extract\s+the\s+text\s+from|get\s+the\s+text\s+of)\s+(?:the\s+)?(?:pdf\s+|word\s+(?:document\s+)?|document\s+|file\s+)?<p>$/.test(s) ||
          /^what\s+(?:does|do)\s+(?:the\s+)?(?:pdf\s+|document\s+|file\s+)?<p>\s+say$/.test(s) ||
          /^what(?:'s|\s+is)\s+in\s+(?:the\s+)?(?:pdf\s+|document\s+|file\s+)?<p>$/.test(s);
        return hit ? plan(step('files.readDocument', { path: paths[0]! }), 'read-document') : null;
      },
    },

    {
      // "find files containing "invoice" in D:\Documents", "search inside D:\Work for "tax"".
      name: 'searchContent',
      order: -12.7,
      pathSafe: true,
      questionSafe: ['search-content'],
      test(lower, raw) {
        const paths = pathsIn(raw);
        if (paths.length !== 1) return null;
        const folder = paths[0]!;
        if (/\.[a-z0-9]{1,5}$/i.test(folder)) return null;
        const q = (re: RegExp) => re.exec(raw);
        const quote = String.raw`["“]([^"”]{2,})["”]`;
        const m =
          q(new RegExp(String.raw`\b(?:find|which|list|show|search\s+for)\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?files?\s+(?:that\s+|which\s+)?(?:containing|contain|contains|mention|mentions|mentioning|with|including)\s+${quote}`, 'i')) ||
          q(new RegExp(String.raw`\bsearch\s+(?:inside|within|the\s+contents?\s+of|the\s+text\s+of|through)\s+.*?\bfor\s+${quote}`, 'i')) ||
          q(new RegExp(String.raw`\b(?:find|which\s+files\s+(?:in|under)|grep|look)\s+.*?\b(?:inside|within)\s+files?\s+(?:in|under)\s+.*?\bfor\s+${quote}`, 'i')) ||
          q(new RegExp(String.raw`\bfind\s+${quote}\s+(?:inside|within|in\s+the\s+(?:text|contents?)\s+of)\s+(?:the\s+)?files?\s+(?:in|under)\b`, 'i'));
        if (!m) {
          // Unquoted single word: "which files mention budget in D:\Work"
          const u = /\b(?:which|what|find|list|show)\s+(?:me\s+)?(?:the\s+)?files?\s+(?:that\s+)?(?:mention|mentions|contain|contains|containing)\s+([\w'-]{2,})\s+(?:in|under|inside)\b/i.exec(raw);
          if (!u || lower.includes('"')) return null;
          return plan(step('files.searchContent', { path: folder, query: u[1]! }), 'search-content');
        }
        return plan(step('files.searchContent', { path: folder, query: m[1]!.trim() }), 'search-content');
      },
    },
    {
      // "merge D:\a.txt and D:\b.txt [into D:\all.txt]": two or more FILES, so "merge branch dev" is untouched.
      name: 'mergeText',
      order: -12.65,
      pathSafe: true,
      test(lower, raw) {
        const paths = pathsIn(raw);
        if (paths.length < 2) return null;
        if (!/^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:merge|combine|join|concatenate|stitch)\b/.test(lower)) return null;
        if (/\b(?:zip|archive|branch|pdf|images?|videos?|clips?|audio|mp3|mp4)\b/.test(lower)) return null;
        let output: string | undefined;
        const into = new RegExp(String.raw`\b(?:into|to|as)\s+(${WIN_PATH})\s*[.!]?$`, 'i').exec(raw);
        let sources = paths;
        if (into) {
          output = unq(into[1]!);
          sources = paths.filter((p) => p !== output);
        }
        if (sources.length < 2) return null;
        // They must all be plain text files by name.
        if (sources.some((p) => !/\.(?:txt|md|log|csv|json|ini|cfg|conf|yml|yaml|xml|html?|css|js|ts|py|rs|cs|java|c|cpp|h|tsv|sql|bat|ps1|sh)$/i.test(p))) return null;
        return plan(step('files.mergeText', { paths: sources.join('\n'), ...(output ? { output } : {}) }), 'merge-text');
      },
    },
    {
      // "what did you just do", "what's left to do", "show the last task report": the last run, in one shape.
      name: 'workflowLast',
      order: -12.5,
      questionSafe: ['workflow-last'],
      test(lower) {
        const t = lower.replace(/[?.!]+\s*$/, '').trim();
        const hit =
          /^(?:so\s+)?what\s+(?:did|have)\s+you\s+(?:just\s+)?(?:do|done|run|finish(?:ed)?|accomplish(?:ed)?)(?:\s+(?:so\s+far|there|just\s+now|last))?$/.test(t) ||
          /^what(?:'s|\s+is|\s+was)\s+(?:left|remaining|still\s+to\s+do)(?:\s+to\s+do)?$/.test(t) ||
          /^(?:show|give|tell)\s+(?:me\s+)?(?:the\s+)?(?:last|latest|previous)\s+(?:task|run|job|action)s?\s+(?:report|summary|result)s?$/.test(t) ||
          /^(?:summari[sz]e|recap|report\s+on)\s+(?:the\s+)?(?:last|latest|previous)\s+(?:task|run|job)$/.test(t);
        return hit ? plan(step('workflow.last'), 'workflow-last') : null;
      },
    },
    {
      // "check the project I just built", "what did you build": the builder's look at what is on disk.
      name: 'builderCheck',
      order: -12.52,
      pathSafe: true,
      questionSafe: ['project-check', 'builder-status'],
      test(lower, raw) {
        const paths = pathsIn(raw);
        if (paths.length > 1) return null;
        const s = tok(lower, paths);
        const status =
          /^(?:so\s+)?what\s+(?:did|have)\s+you\s+(?:just\s+)?(?:build|built|make|made)(?:\s+(?:so\s+far|for\s+me))?$/.test(s) ||
          /^what(?:'s|\s+is)\s+my\s+current\s+(?:app|project|game|site|website)$/.test(s);
        if (status) return plan(step('builder.status'), 'builder-status');
        const check = /^(?:please\s+)?(?:check|verify)\s+(?:the\s+|my\s+)?(?:project|app|game|site|website)(?:\s+(?:i|you)\s+(?:just\s+)?(?:built|made)|\s+(?:you\s+)?(?:just\s+)?(?:built|made))?(?:\s+(?:in|at)\s+<p>)?$/.test(s) || (paths.length === 1 && /^(?:please\s+)?(?:check|verify)\s+(?:the\s+)?(?:project|app|game|site|website)?\s*<p>$/.test(s));
        return check ? plan(step('project.check', paths[0] ? { path: paths[0] } : {}), 'project-check') : null;
      },
    },
    {
      // "look up fetch abort signals in the docs", "read the vite docs about base path": documentation research.
      name: 'docsResearch',
      order: -12.58,
      questionSafe: ['docs-research'],
      test(_lower, raw) {
        const t = raw.replace(/[?.!]+\s*$/, '').trim();
        if (/https?:\/\//i.test(t) || /\b[a-z]:\\/i.test(t)) return null;
        const clean = (s: string) => s.replace(/^(?:how\s+(?:do\s+i|to|can\s+i)\s+)/i, 'how to ').trim();
        // "<look up / research / find out> X in the [LIB] docs"
        let m = /^(?:please\s+)?(?:look\s+up|research|find\s+out|check|search)\s+(.+?)\s+(?:in|on|from|using)\s+(?:the\s+)?(?:(?:official|api)\s+)?(?:([\w.+-]+)\s+)?(?:docs|documentation|api\s+reference)$/i.exec(t);
        if (m) {
          const lib = m[2] && !/^(?:official|api|the|its|their)$/i.test(m[2]) ? m[2] : undefined;
          return plan(step('docs.research', { question: clean(m[1]!), ...(lib ? { library: lib } : {}) }), 'docs-research');
        }
        // "read the [LIB] docs [for|about|on] X"
        m = /^(?:please\s+)?(?:read|check|search|consult)\s+(?:the\s+)?(?:(?:official|api)\s+)?(?:([\w.+-]+)\s+)?(?:docs|documentation|api\s+reference)\s+(?:for|about|on|to\s+see)\s+(.+)$/i.exec(t);
        if (m) {
          const lib = m[1] && !/^(?:official|api|the|its|their)$/i.test(m[1]) ? m[1] : undefined;
          return plan(step('docs.research', { question: clean(m[2]!), ...(lib ? { library: lib } : {}) }), 'docs-research');
        }
        // "what do the docs say about X"
        m = /^what\s+(?:do|does)\s+(?:the\s+)?(?:(?:official|api)\s+)?(?:([\w.+-]+)\s+)?(?:docs|documentation)\s+say\s+(?:about|on)\s+(.+)$/i.exec(t);
        if (m) return plan(step('docs.research', { question: clean(m[2]!), ...(m[1] && !/^(?:official|api|the)$/i.test(m[1]) ? { library: m[1] } : {}) }), 'docs-research');
        return null;
      },
    },
    {
      // "read the docs page https://vite.dev/config/ about base": one documentation page.
      name: 'docsRead',
      order: -12.59,
      questionSafe: ['docs-read'],
      test(_lower, raw) {
        const m = /^(?:please\s+)?(?:read|open|fetch)\s+(?:the\s+)?(?:docs?|documentation)\s+(?:page|at|from)\s+(https?:\/\/\S+?)(?:\s+(?:about|for|on)\s+(.+?))?\s*[?.!]*$/i.exec(raw.trim());
        return m ? plan(step('docs.read', { url: m[1]!, ...(m[2] ? { focus: m[2] } : {}) }), 'docs-read') : null;
      },
    },
    {
      // "show my research notes", "what have you researched".
      name: 'docsNotes',
      order: -12.57,
      questionSafe: ['docs-notes'],
      test(lower) {
        const s = lower.replace(/[?.!]+\s*$/, '').trim();
        return /^(?:show|list|open)\s+(?:me\s+)?(?:my\s+|the\s+)?research\s+notes$|^what\s+(?:have\s+you|did\s+you)\s+(?:researched|look(?:ed)?\s+up|read)(?:\s+so\s+far)?$/.test(s) ? plan(step('docs.notes'), 'docs-notes') : null;
      },
    },
    {
      // "why does my build fail", "why are the tests failing", "diagnose the build in D:\Dev\App".
      name: 'buildDiagnose',
      order: -12.6,
      pathSafe: true,
      questionSafe: ['build-diagnose'],
      test(lower, raw) {
        const paths = pathsIn(raw);
        if (paths.length > 1) return null;
        const rest = tok(lower, paths).replace(/\s*<p>/g, '').trim();
        const tests = /\bwhy\s+(?:are|do|did|is|does)\s+(?:my\s+|the\s+|our\s+)?(?:tests?|specs?)\s+(?:fail(?:ing|ed|s)?|broken|red)\b/.test(rest) || /\bdiagnose\s+(?:the\s+|my\s+)?tests?\b/.test(rest) || /\bwhat(?:'s|\s+is)\s+(?:wrong\s+with|failing\s+in)\s+(?:my\s+|the\s+)?tests?\b/.test(rest);
        const build =
          /\bwhy\s+(?:is|does|did|has)\s+(?:my\s+|the\s+|our\s+)?(?:build|project|app|compile|compilation)\s+(?:fail(?:ing|ed|s)?|broken|not\s+(?:building|compiling|working))\b/.test(rest) ||
          /\bwhy\s+(?:won'?t|will\s+not|can'?t|cannot)\s+(?:my\s+|the\s+)?(?:project|app|code)\s+(?:build|compile)\b/.test(rest) ||
          /\bdiagnose\s+(?:the\s+|my\s+)?(?:build|compile|compilation)\b/.test(rest) ||
          /\bwhat(?:'s|\s+is)\s+wrong\s+with\s+(?:my\s+|the\s+)?build\b/.test(rest) ||
          /\bwhy\s+(?:does|is)\s+(?:the\s+)?(?:lint|typecheck|type\s*check)\s+(?:fail|failing)\b/.test(rest);
        if (!tests && !build) return null;
        const what = tests ? 'test' : /lint/.test(rest) ? 'lint' : /type\s*check/.test(rest) ? 'typecheck' : 'build';
        return plan(step('build.diagnose', { what, ...(paths[0] ? { path: paths[0] } : {}) }), 'build-diagnose');
      },
    },
    {
      // "write release notes", "release notes since v1.0.7", "what changed since the last tag".
      name: 'releaseNotes',
      order: -12.55,
      pathSafe: true,
      questionSafe: ['release-notes'],
      test(lower, raw) {
        const paths = pathsIn(raw);
        if (paths.length > 1) return null;
        const t = tok(lower, paths).replace(/\s*<p>/g, '').trim();
        const notes = /\b(?:release\s+notes|changelog|change\s+log)\b/.test(t);
        const changed = /^\s*what(?:'s|\s+has|\s+is)?\s+changed\s+since\s+(?:the\s+)?last\s+(?:tag|release|version)\s*$/.test(t);
        if (!notes && !changed) return null;
        // Writing a file or publishing is a different request.
        if (/\b(?:publish|post|upload|push|tweet|send|email|save|write\s+to)\b/.test(t) && !/\bwrite\s+(?:the\s+|some\s+|me\s+)?(?:release\s+notes|a?\s*changelog)/.test(t)) return null;
        const since = /\bsince\s+(?:tag\s+|version\s+|release\s+)?(v?\d+(?:\.\d+)+(?:[-\w.]*)?|[a-z][\w./-]*)\b/.exec(t);
        const version = /\b(?:for|as)\s+(?:version\s+|release\s+)?(v?\d+(?:\.\d+)+)\b/.exec(t);
        const args: Record<string, string> = {};
        if (paths[0]) args.path = paths[0];
        if (since && !/^(?:the|last|my|a|tag|release|version)$/.test(since[1]!)) args.since = since[1]!;
        if (version) args.version = version[1]!;
        return plan(step('git.releaseNotes', args), 'release-notes');
      },
    },
  ];
}

// Exported only so a test can pin the shape of the leading words the rules above share.
export const LEAD_WORDS = { LEAD, TAIL };
