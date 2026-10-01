/**
 * Phrasings for the tool-catalog pass (docs/TOOL-CATALOG.md): more system tools
 * to open, restarting an app, lint / typecheck / format as named actions, search a
 * particular site, and "do you have a skill for…".
 *
 * Each rule leads to a skill that already existed or is in catalog-skills.ts; none
 * is a new way to do something Atlas could already do.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';
import { SEARCH_SITES, siteKey } from '../skills/catalog-skills';

const tidy = (s: string) => s.trim().replace(/[?.!]+$/g, '').replace(/^["'“‘]|["'”’]$/g, '').trim();

/** Words after "restart" that mean something other than an app. */
const NOT_AN_APP =
  /^(?:it|this|that|them|now|pc|computer|laptop|machine|windows|explorer|taskbar|network|wifi|wi-?fi|internet|ethernet|router|modem|adapter|bluetooth|atlas|everything|all|the\s+(?:pc|computer|laptop|machine))$/;

const SCRIPTS: Array<[RegExp, string]> = [
  [/^(?:lint(?:er|ing)?|eslint)$/, 'lint'],
  [/^(?:type-?check(?:er|ing)?|type\s+check(?:ing)?|tsc)$/, 'typecheck'],
  [/^(?:format(?:ter|ting)?|prettier)$/, 'format'],
];

const UNIT: Record<string, number> = { b: 1, byte: 1, bytes: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
const NOT_EXT = /^(?:empty|big|large|small|new|old|recent|all|any|my|me|duplicate|hidden|text|biggest|largest)$/;
const SIZE = String.raw`(\d+(?:\.\d+)?)\s*(bytes?|kb|mb|gb|tb)\b`;
const sizeOf = (n: string, u: string) => Math.round(Number(n) * UNIT[u.toLowerCase()]!);
/** Plural / spoken names for common extensions: "pdfs", "mp4s", "jpegs". */
const EXT_WORDS: Record<string, string> = { pdfs: 'pdf', docs: 'docx', zips: 'zip', txts: 'txt', pngs: 'png', jpgs: 'jpg', jpegs: 'jpg', mp3s: 'mp3', mp4s: 'mp4', mkvs: 'mkv', exes: 'exe', isos: 'iso', logs: 'log', csvs: 'csv' };


const MEDIA_FILE = String.raw`(.+?\.(?:mp4|mkv|mov|avi|webm|m4v|wmv|flv|mp3|wav|flac|m4a|ogg|aac|wma|opus|png|jpe?g|webp|bmp|gif|tiff?)(?:\s+(?:in|from|on)\s+.+?)?)`;
const IMAGE_FILE = String.raw`(.+?\.(?:png|jpe?g|webp|bmp|gif|tiff?)(?:\s+(?:in|from|on)\s+.+?)?)`;
const VIDEO_AUDIO_FILE = String.raw`(.+?\.(?:mp4|mkv|mov|avi|webm|m4v|wmv|flv|mp3|wav|flac|m4a|ogg|aac|wma|opus)(?:\s+(?:in|from|on)\s+.+?)?)`;

/** "90", "90s", "1:30", "1:02:03", "90 seconds" → seconds. */
function seconds(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s*(?:seconds?|secs?|s)$/, '');
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}
const TIME = String.raw`(\d+(?::\d{1,2}){0,2}(?:\.\d+)?(?:\s*(?:seconds?|secs?|s))?)`;

export function createCatalogGrammar(): GrammarRule[] {
  return [
    {
      name: 'fileHash',
      order: -10.35,
      pathSafe: true,
      questionSafe: ['file-hash'],
      test(_lower, raw) {
        const m =
          /^\s*(?:what(?:['’]?s|\s+is)\s+)?(?:the\s+)?(?:get\s+)?(?:sha-?256|checksum|hash)\s+(?:of|for)\s+(.+?)\s*[?.!]*$/i.exec(raw) ??
          /^\s*(?:hash|checksum)\s+(?:the\s+file\s+)?(.+?)\s*[?.!]*$/i.exec(raw);
        if (!m) return null;
        const target = tidy(m[1]!);
        // A file, not some text: util.hash owns "sha256 of hello world".
        if (!/\.[a-z0-9]{1,6}(?:\s|$)|[\\/]|\bfile\b/i.test(target)) return null;
        return plan(step('files.hash', { target }), 'file-hash');
      },
    },

    {
      name: 'archiveList',
      order: -10.34,
      pathSafe: true,
      questionSafe: ['archive-list'],
      test(_lower, raw) {
        const m = /^\s*(?:what(?:['’]?s|\s+is)\s+(?:in|inside)|list\s+(?:the\s+)?(?:contents?\s+of|files\s+in)|show\s+(?:me\s+)?(?:the\s+)?(?:contents?\s+of|what(?:['’]?s|\s+is)\s+in|inside)|(?:peek|look)\s+(?:in|inside))\s+(?:the\s+|my\s+)?(.+?\.zip(?:\s+(?:in|from|on)\s+.+?)?)\s*[?.!]*$/i.exec(raw);
        if (!m) return null;
        return plan(step('files.listArchive', { target: tidy(m[1]!) }), 'archive-list');
      },
    },

    {
      // "find all pdfs in downloads", "find mp4 files bigger than 500 mb in videos", "files older than 90 days in documents"
      name: 'fileSearch',
      order: -10.33,
      pathSafe: true,
      test(_lower, raw) {
        const head = /^\s*(?:find|show|list|search\s+for|get|look\s+for)\s+(?:me\s+)?(?:all\s+)?(?:of\s+)?(?:the\s+|my\s+)?(.+?)\s*[?.!]*$/i.exec(raw);
        if (!head) return null;
        let body = head[1]!;
        // "… in <place>" at the end (the last " in "/" from "/" inside ").
        const placeAt = Math.max(...[' in ', ' from ', ' inside ', ' under '].map((w) => body.toLowerCase().lastIndexOf(w)));
        if (placeAt < 0) return null;
        const where = tidy(body.slice(placeAt).replace(/^\s+(?:in|from|inside|under)\s+/i, '').replace(/^(?:my|the)\s+/i, ''));
        body = body.slice(0, placeAt);
        if (!where || /^(?:the\s+)?(?:last|past)\s/i.test(where)) return null;

        const args: Record<string, string | number | boolean> = { where };
        let rest = body;
        const bigger = new RegExp(String.raw`\b(?:bigger|larger|greater|over|above|more\s+than|at\s+least)\s+(?:than\s+)?${SIZE}`, 'i').exec(rest);
        if (bigger) {
          args.minBytes = sizeOf(bigger[1]!, bigger[2]!);
          rest = rest.replace(bigger[0], ' ');
        }
        const smaller = new RegExp(String.raw`\b(?:smaller|less|under|below|at\s+most)\s+(?:than\s+)?${SIZE}`, 'i').exec(rest);
        if (smaller) {
          args.maxBytes = sizeOf(smaller[1]!, smaller[2]!);
          rest = rest.replace(smaller[0], ' ');
        }
        const within = /\b(?:modified|changed|edited|made|created)?\s*(?:in|within)\s+the\s+(?:last|past)\s+(\d+)\s+days?\b/i.exec(rest);
        if (within) {
          args.withinDays = Number(within[1]);
          rest = rest.replace(within[0], ' ');
        }
        const older = /\b(?:older\s+than|not\s+(?:changed|modified|touched|opened)\s+(?:in|for))\s+(\d+)\s+days?\b/i.exec(rest);
        if (older) {
          args.olderDays = Number(older[1]);
          rest = rest.replace(older[0], ' ');
        }
        const word = rest.replace(/\b(?:files?|that\s+are|which\s+are|thats|that's|are|is|with)\b/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        const hadFiles = /\bfiles?\b/i.test(rest);
        const dotted = /^\.([a-z0-9]{1,5})$/.exec(word) ?? (hadFiles ? /^([a-z0-9]{2,5})$/.exec(word) : null);
        if (word && EXT_WORDS[word]) args.ext = EXT_WORDS[word];
        else if (word && dotted && !NOT_EXT.test(word)) args.ext = dotted[1]!;
        else if (word) return null; // some other kind of find: files.find's business
        if (args.ext === undefined && args.minBytes === undefined && args.maxBytes === undefined && args.withinDays === undefined && args.olderDays === undefined) return null;
        return plan(step('files.search', args), 'file-search');
      },
    },

    {
      name: 'emptyFind',
      order: -10.335,
      pathSafe: true,
      test(_lower, raw) {
        const m = /^\s*(?:find|show|list|search\s+for|get)\s+(?:me\s+)?(?:all\s+)?(?:the\s+|my\s+)?empty\s+(files?|folders?|directories|directory)(?:\s+(?:in|from|inside|under)\s+(?:the\s+|my\s+)?(.+?))?\s*[?.!]*$/i.exec(raw);
        if (!m) return null;
        const kind = /^file/i.test(m[1]!) ? 'files' : 'folders';
        const args: Record<string, string | number | boolean> = { kind };
        if (m[2]) args.where = tidy(m[2]);
        return plan(step('files.findEmpty', args), 'empty-find');
      },
    },

    {
      name: 'foldersCompare',
      order: -10.31,
      pathSafe: true,
      test(_lower, raw) {
        const m = /^\s*(?:compare|diff)\s+(?:the\s+)?(?:two\s+)?folders?\s+(.+?)\s+(?:and|with|to|against|vs\.?)\s+(.+?)\s*[?.!]*$/i.exec(raw);
        if (!m) return null;
        return plan(step('files.compareFolders', { a: tidy(m[1]!), b: tidy(m[2]!) }), 'folders-compare');
      },
    },

    {
      name: 'catalogSystemTools',
      order: -6.55,
      test(lower) {
        if (/\bevent viewer\b/.test(lower)) return plan(step('system.openTool', { tool: 'event-viewer' }), 'system-tool');
        if (/\bdisk management\b/.test(lower)) return plan(step('system.openTool', { tool: 'disk-management' }), 'system-tool');
        if (/\bresource monitor\b/.test(lower)) return plan(step('system.openTool', { tool: 'resource-monitor' }), 'system-tool');
        if (/\b(?:registry editor|regedit)\b/.test(lower) && /\b(?:open|show|launch|start|run|bring up)\b|^\s*regedit\s*$/.test(lower)) {
          return plan(step('system.openTool', { tool: 'registry-editor' }), 'system-tool');
        }
        if (/^\s*(?:please\s+)?(?:open|show|launch|start|bring up)\s+(?:the\s+|my\s+)?(?:windows\s+)?services(?:\s+(?:console|app|window|list))?\s*[?.!]*$/.test(lower)) {
          return plan(step('system.openTool', { tool: 'services' }), 'system-tool');
        }
        return null;
      },
    },

    {
      // "restart discord": end it, then open it again. Ending asks first, as it always does.
      name: 'appRestart',
      order: -6.45,
      test(lower) {
        const m = lower.match(/^\s*(?:please\s+)?(?:restart|relaunch|reopen|reload)\s+(?:the\s+|my\s+)?([a-z0-9][a-z0-9 .+'-]*?)(?:\s+app)?\s*[?.!]*$/);
        if (!m) return null;
        const name = m[1]!.trim();
        // "restart my computer in half an hour" is the PC on a delay, not an app called that.
        if (/\b(?:in|at|after|for|on|by|from|tomorrow|tonight|today|seconds?|minutes?|hours?|computer|pc|laptop|machine)\b/.test(name)) return null;
        if (NOT_AN_APP.test(name) ||/\b(?:service|services|watch(?:es)?|timers?|alarms?|reminders?)$/.test(name)) return null;
        return plan(step('app.restart', { name }), 'app-restart', 0.8);
      },
    },

    {
      name: 'devScripts',
      order: -11.46,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          /^\s*(?:run|do|check)\s+(?:the\s+|my\s+)?([a-z-]+(?:\s+check(?:ing)?)?)(?:\s+(?:in|for|on|at)\s+(.+?))?\s*[.!]*$/i.exec(raw) ??
          /^\s*(lint|typecheck|type-check|format)\s+(?:it|this|the\s+(?:project|code|app)|my\s+(?:project|code|app))(?:\s+(?:in|at)\s+(.+?))?\s*[.!]*$/i.exec(raw);
        if (!m) return null;
        const word = m[1]!.toLowerCase().trim();
        const target = SCRIPTS.find(([re]) => re.test(word))?.[1];
        if (!target) return null;
        const path = tidy(m[2] ?? '');
        return plan(step('build.run', path ? { path, target } : { target }), `dev-${target}`);
      },
    },

    {
      // The rest of everyday git. The folder is never named here: the current project fills it in.
      name: 'gitMore',
      order: -11.451,
      pathSafe: true,
      questionSafe: ['git-tags'],
      test(_lower, raw) {
        const BRANCH = '([A-Za-z0-9][A-Za-z0-9._/-]*)';
        const merge =
          new RegExp(String.raw`^\s*(?:please\s+)?(?:git\s+merge|merge\s+(?:the\s+)?branch)\s+${BRANCH}(?:\s+into\s+(?:this|the\s+current)\s+branch)?\s*[?.!]*$`, 'i').exec(raw) ??
          new RegExp(String.raw`^\s*(?:please\s+)?merge\s+${BRANCH}\s+into\s+(?:this|the\s+current)\s+branch\s*[?.!]*$`, 'i').exec(raw);
        if (merge) return plan(step('git.merge', { branch: merge[1]! }), 'git-merge');

        if (/^\s*(?:please\s+)?(?:(?:list|show)\s+(?:me\s+)?(?:my\s+|the\s+|all\s+(?:the\s+)?)?(?:git\s+)?tags|git\s+tag\s+--?list|git\s+tags|what\s+tags\s+(?:do\s+i|are\s+there)(?:\s+have)?)\s*[?.!]*$/i.test(raw)) {
          return plan(step('git.tags', {}), 'git-tags');
        }
        const tag = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:git\s+tag|create\s+(?:a\s+)?(?:git\s+)?tag(?:\s+(?:called|named))?|tag\s+(?:this(?:\s+commit)?|the\s+(?:latest\s+|current\s+)?commit|it|the\s+release)(?:\s+(?:as|with))?|tag\s+(?:this\s+)?release(?:\s+as)?)\s+${BRANCH}\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (tag) return plan(step('git.tag', { name: tag[1]! }), 'git-tag');

        const unstage = /^\s*(?:please\s+)?(?:git\s+(?:unstage|reset(?:\s+head)?)|unstage)\s+(.+?)\s*[?.!]*$/i.exec(raw) ?? /^\s*(?:please\s+)?take\s+(.+?)\s+out\s+of\s+(?:the\s+)?(?:next\s+)?commit\s*[?.!]*$/i.exec(raw);
        if (unstage) return plan(step('git.unstage', { file: tidy(unstage[1]!) }), 'git-unstage');

        const discard =
          /^\s*(?:please\s+)?(?:discard|throw\s+away|undo|revert)\s+(?:all\s+)?(?:my\s+|the\s+)?(?:uncommitted\s+)?changes\s+(?:to|in|on|of)\s+(.+?)\s*[?.!]*$/i.exec(raw) ??
          /^\s*(?:please\s+)?git\s+checkout\s+--\s+(.+?)\s*[?.!]*$/i.exec(raw) ??
          /^\s*(?:please\s+)?git\s+restore\s+(?!--staged)(.+?)\s*[?.!]*$/i.exec(raw);
        if (discard) return plan(step('git.discardChanges', { file: tidy(discard[1]!) }), 'git-discard');

        if (/^\s*(?:please\s+)?(?:git\s+init|(?:initiali[sz]e|create|start|set\s+up)\s+(?:a\s+)?(?:new\s+)?git\s+repo(?:sitory)?|make\s+(?:this|it)\s+a\s+git\s+repo(?:sitory)?)\s*[?.!]*$/i.test(raw)) {
          return plan(step('git.init', {}), 'git-init');
        }
        return null;
      },
    },

    {
      name: 'netTools',
      order: -10.2,
      questionSafe: ['dns-lookup', 'traceroute'],
      test(_lower, raw) {
        const HOST = String.raw`((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)`;
        const dns =
          new RegExp(String.raw`^\s*(?:please\s+)?(?:dns\s+lookup|nslookup|dig|resolve|look\s*up\s+(?:the\s+)?(?:ip(?:\s+address)?|address|dns)\s+(?:of|for))\s+(?:for\s+)?${HOST}\s*[?.!]*$`, 'i').exec(raw) ??
          new RegExp(String.raw`^\s*what(?:['’]?s|\s+is)\s+the\s+ip(?:\s+address)?\s+(?:of|for)\s+${HOST}\s*[?.!]*$`, 'i').exec(raw) ??
          new RegExp(String.raw`^\s*what\s+ip(?:\s+address)?\s+does\s+${HOST}\s+(?:resolve\s+to|use|have)\s*[?.!]*$`, 'i').exec(raw);
        if (dns) return plan(step('net.dnsLookup', { host: tidy(dns[1]!) }), 'dns-lookup');
        const trace = new RegExp(String.raw`^\s*(?:please\s+)?(?:trace\s*route|tracert|trace\s+the\s+route|run\s+a\s+trace\s*route)\s+(?:to\s+)?${HOST}\s*[?.!]*$`, 'i').exec(raw);
        if (trace) return plan(step('net.traceroute', { host: tidy(trace[1]!) }), 'traceroute');
        return null;
      },
    },

    {
      name: 'systemReads',
      order: -10.19,
      questionSafe: ['firmware', 'security-status', 'process-info'],
      test(lower, raw) {
        if (/^\s*(?:what(?:['’]?s|\s+is)\s+)?(?:my\s+|the\s+)?(?:bios(?:\s+version)?|motherboard|mobo|computer\s+name|pc\s+name|hostname|user\s*name|windows\s+user)\s*[?.!]*$/.test(lower) || /^\s*who\s+am\s+i\s+(?:signed|logged)\s+in\s+as\s*[?.!]*$/.test(lower)) {
          return plan(step('system.firmware', {}), 'firmware');
        }
        if (/^\s*(?:is\s+(?:the\s+)?(?:windows\s+)?firewall\s+(?:on|enabled|off|running|disabled)|(?:windows\s+)?firewall\s+status|is\s+(?:windows\s+)?defender\s+(?:on|enabled|running|off|working)|(?:windows\s+)?defender\s+status|(?:windows\s+)?security\s+status|(?:am\s+i|is\s+atlas)\s+(?:running\s+as\s+)?(?:an?\s+)?admin(?:istrator)?|check\s+(?:the\s+)?administrator\s+status)\s*[?.!]*$/.test(lower)) {
          return plan(step('security.status', {}), 'security-status');
        }
        const proc =
          /^\s*where\s+is\s+(?:the\s+)?(.+?)\s+(?:running\s+from|installed\s+from|located)\s*[?.!]*$/i.exec(raw) ??
          /^\s*(?:what(?:['’]?s|\s+is)\s+the\s+)?(?:path|location)\s+of\s+(?:the\s+)?(.+?)\s+process\s*[?.!]*$/i.exec(raw) ??
          /^\s*process\s+(?:info|information|details)\s+(?:for|of|about(?:\s+the)?)\s+(.+?)\s*[?.!]*$/i.exec(raw);
        if (proc) return plan(step('system.processInfo', { name: tidy(proc[1]!) }), 'process-info');
        return null;
      },
    },

    {
      name: 'mediaInfo',
      order: -10.28,
      pathSafe: true,
      questionSafe: ['media-info'],
      test(_lower, raw) {
        const m =
          new RegExp(String.raw`^\s*(?:how\s+long\s+is|what(?:['’]?s|\s+is)\s+the\s+(?:duration|length|resolution|fps|frame\s*rate|dimensions?|size\s+in\s+pixels)\s+of|(?:duration|length|resolution|dimensions)\s+of|media\s+info(?:rmation)?\s+(?:for|of|about)|info\s+(?:for|about|on)|what\s+resolution\s+is|how\s+many\s+fps\s+is|what(?:['’]?s|\s+is)\s+the\s+resolution\s+of)\s+(?:the\s+|my\s+)?${MEDIA_FILE}\s*[?.!]*$`, 'i').exec(raw);
        if (!m) return null;
        return plan(step('media.info', { target: tidy(m[1]!) }), 'media-info');
      },
    },

    {
      name: 'mediaTrim',
      order: -10.275,
      pathSafe: true,
      test(_lower, raw) {
        const m = new RegExp(String.raw`^\s*(?:please\s+)?(?:trim|cut|clip)\s+(?:the\s+|my\s+)?${VIDEO_AUDIO_FILE}\s+(?:from|between|starting\s+at)\s+${TIME}\s+(?:to|and|until|till|-)\s+${TIME}\s*[?.!]*$`, 'i').exec(raw);
        if (!m) return null;
        const start = seconds(m[2]!);
        const end = seconds(m[3]!);
        if (start === null || end === null || end <= start) return null;
        return plan(step('media.trim', { target: tidy(m[1]!), start, end }), 'media-trim');
      },
    },

    {
      name: 'mediaFrame',
      order: -10.27,
      pathSafe: true,
      test(_lower, raw) {
        const m = new RegExp(String.raw`^\s*(?:please\s+)?(?:grab|extract|get|save|take)\s+(?:me\s+)?(?:a\s+|the\s+)?(?:frame|still|screenshot|picture|image)\s+(?:from|of)\s+(?:the\s+|my\s+)?${VIDEO_AUDIO_FILE}\s+at\s+${TIME}\s*[?.!]*$`, 'i').exec(raw);
        if (!m) return null;
        const at = seconds(m[2]!);
        if (at === null) return null;
        return plan(step('media.frame', { target: tidy(m[1]!), at }), 'media-frame');
      },
    },

    {
      name: 'mediaPicture',
      order: -10.265,
      pathSafe: true,
      test(_lower, raw) {
        const rot = new RegExp(String.raw`^\s*(?:please\s+)?rotate\s+(?:the\s+|my\s+)?${IMAGE_FILE}\s+(?:by\s+)?(90|180|270)(?:\s*(?:°|degrees?))?(?:\s+(clockwise|counter-?clockwise|left|right|anti-?clockwise))?\s*[?.!]*$`, 'i').exec(raw);
        if (rot) {
          let amount = Number(rot[2]);
          // Turning "left" or counter-clockwise by 90 is 270 clockwise, and the reverse.
          if (/left|counter|anti/i.test(rot[3] ?? '') && amount !== 180) amount = 360 - amount;
          return plan(step('media.edit', { target: tidy(rot[1]!), op: 'rotate', amount }), 'media-rotate');
        }
        const flip = new RegExp(String.raw`^\s*(?:please\s+)?(?:flip|mirror)\s+(?:the\s+|my\s+)?${IMAGE_FILE}\s+(horizontally|sideways|vertically|upside\s+down)\s*[?.!]*$`, 'i').exec(raw);
        if (flip) return plan(step('media.edit', { target: tidy(flip[1]!), op: 'flip', amount: /^h|^side/i.test(flip[2]!) ? 0 : 1 }), 'media-flip');
        const square = new RegExp(String.raw`^\s*(?:please\s+)?crop\s+(?:the\s+|my\s+)?${IMAGE_FILE}\s+(?:to\s+)?(?:a\s+)?square\s*[?.!]*$`, 'i').exec(raw);
        if (square) return plan(step('media.edit', { target: tidy(square[1]!), op: 'square' }), 'media-square');
        const thumb = new RegExp(String.raw`^\s*(?:please\s+)?(?:make|create|save)\s+(?:a\s+)?thumbnail\s+(?:of|for|from)\s+(?:the\s+|my\s+)?${IMAGE_FILE}\s*[?.!]*$`, 'i').exec(raw);
        if (thumb) return plan(step('media.edit', { target: tidy(thumb[1]!), op: 'thumbnail' }), 'media-thumbnail');
        return null;
      },
    },

    {
      name: 'filesDuplicate',
      order: -10.26,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          /^\s*(?:please\s+)?(?:duplicate|clone)\s+(?:the\s+|my\s+)?(?:file\s+|folder\s+|directory\s+)?(.+?)\s*[?.!]*$/i.exec(raw) ??
          /^\s*(?:please\s+)?make\s+(?:a\s+)?(?:copy|duplicate)\s+of\s+(?:the\s+|my\s+)?(?:file\s+|folder\s+|directory\s+)?(.+?)\s*[?.!]*$/i.exec(raw);
        if (!m) return null;
        const target = tidy(m[1]!);
        // "duplicate" with nothing to point at, or a thing that isn't a file (a line, a tab…).
        if (!target || /^(?:this|that|it|line|tab|window|the\s+line|(?:my\s+|the\s+)?(?:screens?|displays?|monitors?|desktop|pc|computer))$/i.test(target)) return null;
        return plan(step('files.duplicate', { target }), 'files-duplicate');
      },
    },

    {
      name: 'shortcutCreate',
      order: -10.255,
      pathSafe: true,
      test(_lower, raw) {
        const m = /^\s*(?:please\s+)?(?:create|make|add|put)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:desktop\s+)?(?:shortcut|link)\s+(?:to|for|of)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:on|in|at)\s+(?:the\s+|my\s+)?(.+?))?\s*[?.!]*$/i.exec(raw);
        if (!m) return null;
        const target = tidy(m[1]!);
        if (!target) return null;
        const args: Record<string, string | number | boolean> = { target };
        if (m[2]) args.where = tidy(m[2]);
        return plan(step('files.createShortcut', args), 'shortcut-create');
      },
    },

    {
      name: 'cleanupFlow',
      order: -10.25,
      questionSafe: ['cleanup-review'],
      test(lower) {
        const KIND = String.raw`(temp(?:orary)?(?:\s+files?)?|crash\s+dumps?|dump\s+files?|(?:old\s+)?installers?|setup\s+files?)`;
        const kindOf = (s: string) => (/temp/.test(s) ? 'temp' : /dump/.test(s) ? 'crashdumps' : 'installers');
        const clean = new RegExp(String.raw`^\s*(?:please\s+)?(?:clean(?:\s+up)?|clear(?:\s+out)?|delete|remove|get\s+rid\s+of)\s+(?:all\s+)?(?:of\s+)?(?:my\s+|the\s+)?${KIND}\s*[?.!]*$`).exec(lower);
        if (clean) return plan(step('cleanup.clean', { kind: kindOf(clean[1]!) }), 'cleanup-clean');
        const review = new RegExp(String.raw`^\s*(?:please\s+)?(?:review|check|scan|look\s+at|show\s+me|how\s+much\s+(?:space\s+)?(?:is\s+|are\s+)?(?:in\s+)?)\s*(?:my\s+|the\s+)?${KIND}\s*[?.!]*$`).exec(lower);
        if (review) return plan(step('cleanup.review', { kind: kindOf(review[1]!) }), 'cleanup-review');
        if (/^\s*(?:please\s+)?(?:what\s+(?:can|could)\s+i\s+(?:clean(?:\s+up)?|delete|get\s+rid\s+of)|(?:review|scan|check)\s+(?:for\s+)?(?:junk|clutter|cleanup|clean\s*up)|clean\s*up\s+(?:my\s+)?(?:pc|computer|disk|drive)|how\s+much\s+junk\s+(?:do\s+i\s+have|is\s+there)|run\s+(?:a\s+)?clean\s*up)\s*[?.!]*$/.test(lower)) {
          return plan(step('cleanup.review', {}), 'cleanup-review');
        }
        return null;
      },
    },

    {
      name: 'selfTest',
      order: -10.24,
      questionSafe: ['self-test'],
      test(lower) {
        if (/^\s*(?:please\s+)?(?:run\s+(?:a\s+|the\s+|your\s+)?(?:self[\s-]?test|health\s*check|diagnostics?)|self[\s-]?test|(?:do|run)\s+a\s+(?:system\s+)?(?:check|health\s*check)\s+on\s+(?:yourself|atlas)|check\s+(?:yourself|atlas(?:'s)?\s+health)|is\s+atlas\s+(?:working|ok(?:ay)?|healthy)(?:\s+(?:properly|correctly|ok(?:ay)?))?|are\s+you\s+(?:working|ok(?:ay)?)(?:\s+(?:properly|correctly))?|atlas\s+health)\s*[?.!]*$/.test(lower)) {
          return plan(step('engine.selfTest', {}), 'self-test');
        }
        return null;
      },
    },

    {
      name: 'clipboardHistory',
      order: -10.235,
      questionSafe: ['clipboard-history'],
      test(lower) {
        if (/^\s*(?:please\s+)?(?:clear|forget|wipe|delete)\s+(?:my\s+|the\s+)?clipboard\s+history\s*[?.!]*$/.test(lower)) {
          return plan(step('clipboard.clearHistory', {}), 'clipboard-history-clear');
        }
        if (/^\s*(?:please\s+)?(?:(?:show|list|see|open|view)\s+(?:me\s+)?(?:my\s+|the\s+)?clipboard\s+history|what\s+(?:did\s+i|have\s+i)\s+(?:copy|copied)(?:\s+(?:earlier|before|recently|lately|today))?|what\s+was\s+on\s+my\s+clipboard(?:\s+before)?|what(?:['’]?s|\s+is)\s+in\s+my\s+clipboard\s+history|clipboard\s+history)\s*[?.!]*$/.test(lower)) {
          return plan(step('clipboard.history', {}), 'clipboard-history');
        }
        const n =
          /^\s*(?:please\s+)?(?:copy|restore|put|paste)\s+(?:clipboard\s+)?(?:item|entry|number|#)\s*(\d{1,2})(?:\s+(?:back|again))?(?:\s+(?:to|on)\s+(?:the\s+|my\s+)?clipboard)?\s*[?.!]*$/.exec(lower) ??
          /^\s*(?:please\s+)?copy\s+(?:the\s+)?(?:(\d{1,2})(?:st|nd|rd|th)\s+(?:thing|item|entry)\s+i\s+copied)\s*(?:back|again)?\s*[?.!]*$/.exec(lower);
        if (n) return plan(step('clipboard.restore', { n: Number(n[1]) }), 'clipboard-restore');
        return null;
      },
    },

    {
      name: 'siteSearch',
      order: -3.48,
      test(_lower, raw) {
        const a = /^\s*(?:search|find|look\s+up|look\s+for)\s+(?:on\s+)?(?:the\s+)?(\S+?)\s+for\s+(.+?)\s*[?.!]*$/i.exec(raw);
        if (a && (siteKey(a[1]!) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(a[1]!))) {
          return plan(step('web.searchSite', { site: a[1]!, query: tidy(a[2]!) }), 'site-search');
        }
        const b = /^\s*(?:search|find|look\s+up|look\s+for)\s+(.+?)\s+(?:on|in|at)\s+([a-z0-9.-]+?)\s*[?.!]*$/i.exec(raw);
        if (b && b[2]! in SEARCH_SITES) {
          return plan(step('web.searchSite', { site: b[2]!, query: tidy(b[1]!) }), 'site-search');
        }
        if (b && siteKey(b[2]!)) {
          return plan(step('web.searchSite', { site: b[2]!, query: tidy(b[1]!) }), 'site-search');
        }
        return null;
      },
    },

    {
      name: 'skillSearch',
      order: -11.4,
      questionSafe: ['skill-search'],
      test(lower) {
        const m =
          lower.match(/^\s*(?:do\s+you\s+have|have\s+you\s+got|is\s+there)\s+(?:a\s+|any\s+)?(?:skills?|tools?|commands?|way|anything|something)\s+(?:for|to\s+do\s+with|about|with|to)\s+(.+?)\s*[?.!]*$/) ??
          lower.match(/^\s*(?:can\s+you\s+do\s+anything|what\s+can\s+you\s+do)\s+(?:with|for|about)\s+(.+?)\s*[?.!]*$/);
        if (!m) return null;
        return plan(step('engine.searchSkills', { query: tidy(m[1]!) }), 'skill-search');
      },
    },
  ];
}
