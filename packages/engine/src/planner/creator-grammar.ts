/**
 * Phrasings for flushing DNS, starting and deploying a project, compressing /
 * converting / resizing media, renaming many files, and "restart the network
 * adapter" (which Windows only lets an administrator do).
 *
 * The media rules run ahead of the file rules (-10.8…): "compress video.mp4" is
 * a video being made smaller, not a zip, and "convert song.wav to mp3" is not a
 * unit conversion.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

const VIDEO = String.raw`[^\s]+?\.(?:mp4|mkv|mov|avi|webm|m4v|wmv|flv)`;
const MEDIA = String.raw`[^\s]+?\.(?:mp4|mkv|mov|avi|webm|m4v|wmv|flv|mp3|wav|flac|m4a|ogg|aac|wma|opus|png|jpe?g|webp|bmp|gif|tiff?)`;
const IMAGE = String.raw`[^\s]+?\.(?:png|jpe?g|webp|bmp|gif|tiff?)`;
const FORMATS = 'mp3|wav|flac|m4a|ogg|opus|mp4|webm|gif|png|jpe?g|webp|bmp';

function tidy(s: string): string {
  return s
    .trim()
    .replace(/[?.!]+$/g, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

/** "x.mp4 in downloads" — a file with an optional place after it. */
const WITH_PLACE = (file: string) => String.raw`(${file}(?:\s+(?:in|on|from)\s+(?:my\s+|the\s+)?[^\s].*?)?)`;

export function createCreatorGrammar(): GrammarRule[] {
  return [
    {
      // "install spotify" / "uninstall vlc" / "update vlc" / "which apps need updates".
      // Not a dependency ("install express in this project" and friends keep their own rules).
      name: 'appsManage',
      order: -5.31,
      questionSafe: ['apps-updates'],
      test(_lower, raw) {
        if (/^\s*(?:which|what)\s+(?:apps?|programs?|software)\s+(?:need|have|has|are\s+due\s+for)\s+(?:an?\s+)?(?:updates?|upgrad(?:e|es|ing))\s*[?.!]*$|^\s*(?:are\s+there|do\s+i\s+have|any)\s+(?:any\s+)?(?:app|program|software)\s+updates\s*[?.!]*$|^\s*check\s+(?:for\s+)?(?:app|program|software)\s+updates\s*[?.!]*$/i.test(raw)) {
          return plan(step('apps.updates', {}), 'apps-updates');
        }
        const m = raw.match(/^\s*(?:please\s+)?(install|uninstall|update|upgrade)\s+(?:the\s+)?(?:app\s+(?:called\s+)?)?([A-Za-z0-9][A-Za-z0-9 .+_-]{1,40}?)(?:\s+app)?\s*[?.!]*$/i);
        if (!m) return null;
        const name = m[2]!.trim();
        // Words that mean something else: Windows itself, Atlas, packages, "everything".
        if (/^(?:windows|win\s*11|win\s*10|atlas|my\s+pc|everything|all|updates?|drivers?|it|this|that|dependencies|packages?|node|npm|pnpm|python\s+packages?)$/i.test(name)) return null;
        if (/\b(?:package|dependency|dependencies|library|module|extension|plugin|in\s+this|to\s+this|as\s+a\s+dev)\b/i.test(name)) return null;
        const verb = m[1]!.toLowerCase();
        const id = verb === 'install' ? 'apps.install' : verb === 'uninstall' ? 'apps.uninstall' : 'apps.update';
        return plan(step(id, { name }), verb);
      },
    },

    {
      // Windows Update is the person's to run; the page is the right place.
      name: 'windowsUpdate',
      order: -5.305,
      test(lower) {
        if (/^\s*(?:please\s+)?(?:update\s+windows|(?:check|look)\s+for\s+windows\s+updates?|run\s+windows\s+update|install\s+windows\s+updates?)\s*[?.!]*$/.test(lower)) {
          return plan(step('system.settingsPage', { page: 'windows-update' }), 'windows-update', 0.9);
        }
        return null;
      },
    },

    {
      name: 'netFlushDns',
      order: -5.5,
      test(lower) {
        if (/^\s*(?:please\s+)?(?:flush|clear|reset|empty)\s+(?:the\s+|my\s+)?dns(?:\s+(?:cache|resolver(?:\s+cache)?))?\s*[?.!]*$/.test(lower)) {
          return plan(step('net.flushDns', {}), 'flush-dns');
        }
        return null;
      },
    },

    {
      // Restarting an adapter needs administrator rights; Atlas never asks for them here.
      // Ahead of networkReadouts (-6.9), which lists adapters for any mention of one.
      name: 'netAdapterRestart',
      order: -6.95,
      test(lower) {
        if (/^\s*(?:please\s+)?(?:restart|reset|reboot|disable\s+and\s+enable|re-?enable|turn\s+off\s+and\s+on)\s+(?:the\s+|my\s+)?(?:network|wi-?fi|wireless|ethernet|internet)(?:\s+(?:adapter|card|connection|driver))?\s*[?.!]*$/.test(lower)) {
          return plan(step('system.settingsPage', { page: 'network' }), 'network-reset', 0.85);
        }
        return null;
      },
    },

    {
      name: 'mediaCompress',
      order: -10.86,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          new RegExp(String.raw`^\s*(?:please\s+)?(?:compress|shrink|reduce|make\s+smaller)\s+(?:the\s+|my\s+)?${WITH_PLACE(VIDEO)}(?:\s+(?:to\s+be\s+)?(as\s+small\s+as\s+possible|smaller|a\s+lot\s+smaller|high\s+quality|best\s+quality))?\s*[?.!]*$`, 'i').exec(raw) ??
          new RegExp(String.raw`^\s*(?:please\s+)?make\s+(?:the\s+|my\s+)?${WITH_PLACE(VIDEO)}\s+(smaller)\s*[?.!]*$`, 'i').exec(raw);
        if (!m) return null;
        const word = (m[2] ?? '').toLowerCase();
        const level = /small as possible|a lot/.test(word) ? 'small' : /high|best/.test(word) ? 'high' : 'balanced';
        return plan(step('media.compress', { target: tidy(m[1]!), level }), 'media-compress');
      },
    },

    {
      name: 'mediaConvert',
      order: -10.85,
      pathSafe: true,
      test(_lower, raw) {
        const verbs = String.raw`(?:convert|turn|change|save|export|make)`;
        // "convert X to F" / "convert X in PLACE to F" / "convert X to F in PLACE"
        const m =
          new RegExp(String.raw`^\s*(?:please\s+)?${verbs}\s+(?:the\s+|my\s+)?(${MEDIA})\s+(?:in)?to\s+(?:an?\s+)?\.?(${FORMATS})(?:\s+file)?(?:\s+(?:in|on|from)\s+(?:my\s+|the\s+)?(.+?))?\s*[?.!]*$`, 'i').exec(raw) ??
          new RegExp(String.raw`^\s*(?:please\s+)?${verbs}\s+(?:the\s+|my\s+)?(${MEDIA}\s+(?:in|on|from)\s+(?:my\s+|the\s+)?.+?)\s+(?:in)?to\s+(?:an?\s+)?\.?(${FORMATS})(?:\s+file)?\s*[?.!]*$`, 'i').exec(raw) ??
          new RegExp(String.raw`^\s*(?:please\s+)?(?:save|export)\s+(?:the\s+|my\s+)?(${MEDIA})\s+as\s+(?:an?\s+)?\.?(${FORMATS})(?:\s+(?:in|on|from)\s+(?:my\s+|the\s+)?(.+?))?\s*[?.!]*$`, 'i').exec(raw);
        if (m) {
          const target = m[3] ? `${tidy(m[1]!)} in ${tidy(m[3])}` : tidy(m[1]!);
          return plan(step('media.convert', { target, format: m[2]!.toLowerCase().replace('jpeg', 'jpg') }), 'media-convert');
        }
        const audio = new RegExp(String.raw`^\s*(?:please\s+)?(?:extract|rip|pull|get)\s+(?:the\s+)?(?:audio|sound|music)\s+(?:out\s+of|from)\s+(?:the\s+|my\s+)?${WITH_PLACE(VIDEO)}\s*[?.!]*$`, 'i').exec(raw);
        if (audio) return plan(step('media.convert', { target: tidy(audio[1]!), format: 'mp3' }), 'media-convert');
        return null;
      },
    },

    {
      name: 'mediaResizeImage',
      order: -10.84,
      pathSafe: true,
      test(_lower, raw) {
        const m = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:resize|scale|shrink|make)\s+(?:the\s+|my\s+)?${WITH_PLACE(IMAGE)}\s+(?:to\s+|so\s+it(?:'s|\s+is)\s+)?(\d{1,5})\s*(%|percent|px|pixels?)?\s*(?:wide|across)?\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (!m) return null;
        const n = Number(m[2]);
        const unit = (m[3] ?? '').toLowerCase();
        // "to 800" with no unit and no "wide" is ambiguous; a bare number means pixels only when it is large.
        const percent = unit === '%' || unit === 'percent' || (!unit && n <= 100 && !/wide|across/i.test(raw));
        return plan(step('media.resizeImage', { target: tidy(m[1]!), ...(percent ? { percent: n } : { width: n }) }), 'media-resize');
      },
    },

    {
      name: 'projectScaffold',
      order: -9.45,
      pathSafe: true,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:please\s+)?(?:create|make|scaffold|start|set\s+up|generate|build)\s+(?:me\s+)?(?:an?\s+)?(?:new\s+)?(vanilla|react|vue|svelte|vite)(?:\s+(?:with\s+)?(typescript|ts|javascript|js))?\s+(?:app|project|site|website)\s+(?:called|named)\s+([A-Za-z0-9][A-Za-z0-9 _-]*?)(?:\s+(?:in|inside|under|at)\s+(?:my\s+|the\s+)?(.+?))?\s*[?.!]*$/i,
        );
        if (!m) return null;
        const kind = m[1]!.toLowerCase() === 'vite' ? 'vanilla' : m[1]!.toLowerCase();
        const ts = /^(?:typescript|ts)$/i.test(m[2] ?? '') || !m[2];
        // TypeScript unless JavaScript was asked for.
        const template = /^(?:javascript|js)$/i.test(m[2] ?? '') ? kind : `${kind}-ts`;
        void ts;
        const args: Record<string, string> = { name: tidy(m[3]!).toLowerCase().replace(/\s+/g, '-'), template };
        if (m[4]) args.where = tidy(m[4]);
        return plan(step('project.scaffold', args), 'scaffold');
      },
    },

    {
      name: 'projectDeploy',
      order: -9.44,
      pathSafe: true,
      test(_lower, raw) {
        const m = raw.match(/^\s*(?:please\s+)?(?:deploy|publish|ship|push\s+live)(?:\s+(?:this|the|my)(?:\s+(?:project|app|site|website))?|\s+it)?\s+(?:to|on|with|using)\s+(vercel|cloudflare|wrangler|workers)\s*[?.!]*$/i);
        if (!m) return null;
        return plan(step('project.deploy', { target: /vercel/i.test(m[1]!) ? 'vercel' : 'cloudflare' }), 'deploy');
      },
    },

    {
      name: 'filesBatchRename',
      order: -10.74,
      pathSafe: true,
      test(_lower, raw) {
        const PLACE = String.raw`(?:the\s+)?(?:files?|photos?|pictures?|documents?|images?)\s+(?:in|inside|from)\s+(?:my\s+|the\s+)?(.+?)`;
        const replacing = new RegExp(String.raw`^\s*(?:please\s+)?rename\s+(?:all\s+)?${PLACE}\s+(?:by\s+)?replacing\s+["“']?(.+?)["”']?\s+with\s+["“']?(.*?)["”']?\s*[?.!]*$`, 'i').exec(raw);
        if (replacing) return plan(step('files.batchRename', { target: tidy(replacing[1]!), find: tidy(replacing[2]!), replace: replacing[3]! }), 'batch-rename');
        const prefix = new RegExp(String.raw`^\s*(?:please\s+)?(?:add\s+(?:the\s+)?prefix\s+["“']?(.+?)["”']?\s+to|prefix)\s+(?:all\s+)?${PLACE}\s*[?.!]*$`, 'i').exec(raw);
        if (prefix) return plan(step('files.batchRename', { target: tidy(prefix[2]!), prefix: tidy(prefix[1]!) }), 'batch-rename');
        const suffix = new RegExp(String.raw`^\s*(?:please\s+)?add\s+(?:the\s+)?suffix\s+["“']?(.+?)["”']?\s+to\s+(?:all\s+)?${PLACE}\s*[?.!]*$`, 'i').exec(raw);
        if (suffix) return plan(step('files.batchRename', { target: tidy(suffix[2]!), suffix: tidy(suffix[1]!) }), 'batch-rename');
        const num = new RegExp(String.raw`^\s*(?:please\s+)?number\s+(?:all\s+)?${PLACE}\s*[?.!]*$`, 'i').exec(raw);
        if (num) return plan(step('files.batchRename', { target: tidy(num[1]!), numbered: true }), 'batch-rename');
        const kase = new RegExp(String.raw`^\s*(?:please\s+)?(?:make|change|rename)\s+(?:all\s+)?${PLACE}\s+(lowercase|uppercase|lower\s+case|upper\s+case)\s*[?.!]*$`, 'i').exec(raw) ??
          new RegExp(String.raw`^\s*(?:please\s+)?(lowercase|uppercase)\s+(?:all\s+)?${PLACE}\s*[?.!]*$`, 'i').exec(raw);
        if (kase) {
          const swap = kase.length === 3 && /^(?:lowercase|uppercase)$/i.test(kase[1]!);
          const word = (swap ? kase[1]! : kase[2]!).toLowerCase().replace(/\s+/g, '');
          const where = swap ? kase[2]! : kase[1]!;
          return plan(step('files.batchRename', { target: tidy(where), ...(word === 'lowercase' ? { lower: true } : { upper: true }) }), 'batch-rename');
        }
        return null;
      },
    },
  ];
}
