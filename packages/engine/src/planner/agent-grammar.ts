/**
 * Grammar for 1.0.3's "doing, not answering" layer — Watch, setups, the
 * developer loop's plain phrasings, window placement and the microphone.
 *
 * Every phrasing any of those skills advertises is reachable here without a
 * model (the rule in `advertised-examples.test.ts`: the AI tier may make a
 * phrasing better understood, never be the only thing that makes it work).
 *
 * Ordered ahead of the core rules (−12 … −11) because each rule is anchored on
 * words the core rules would otherwise misread: "when OBS closes, open Discord"
 * starts like nothing but ends like `app.open`, and "put Discord on the left"
 * is not a file being moved into a folder called "the left".
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';
import { readPosition } from '../setup/spec';

const THEN = String.raw`(?:\s*,\s*(?:and\s+)?(?:then\s+)?|\s+and\s+then\s+|\s+then\s+)`;
const PATH = String.raw`(?:[a-z]:[\\/]|\\\\)`;

function clean(s: string | undefined): string {
  return (s ?? '')
    .trim()
    .replace(/[.!]+$/, '')
    .trim();
}

/** "watch this download and let me know when it's done" → "this download". */
function watchTarget(text: string): { target: string; then: string } {
  let t = clean(text);
  let then = '';
  const cont = new RegExp(`^(.+?)${THEN}(.+)$`, 'i').exec(t);
  if (cont && !/^(?:let me know|tell me|notify me|ping me)\b/i.test(cont[2]!)) {
    t = cont[1]!;
    then = cont[2]!;
  }
  t = t
    .replace(
      /\s+(?:and|,)\s+(?:let me know|tell me|notify me|ping me|alert me|continue|carry on)(?:\s+(?:when|once|if)\s+(?:it['’]?s|it is|they['’]?re|they are|it)\s*(?:done|finished|finishes|complete[sd]?|over|closes|exits|ready))?$/i,
      '',
    )
    .replace(/\s+(?:until|till)\s+(?:it['’]?s|it is)\s+(?:done|finished)$/i, '')
    .trim();
  return { target: t, then };
}

/** Targets "watch …" may take — never a film or a channel. */
const WATCHABLE =
  /^(?:this|that|the|my)\s+(?:downloads?|build|compile|process|program|app|install(?:ation|er)?|update|render|export|upload|copy|transfer|job|task)\b/i;

/**
 * Does this read like something Atlas can wait for? "When OBS closes" does;
 * "when I was young" and "when on" do not, and must stay conversation. Checked
 * on the *end* of the when-part, which is where the predicate sits in English.
 */
const CONDITION_TAIL =
  /(?:finish(?:es|ed)?|(?:is|are)\s+(?:done|finished|complete|closed|open|running|started|up|there|over|ready)|done|complete[sd]?|close[sd]?|exit(?:s|ed)?|quits?|stops?|ends?|crash(?:es|ed)?|starts?|opens?|launch(?:es|ed)?|loads?|boots?|comes\s+(?:up|back)|goes\s+away|shuts\s+down|no\s+longer\s+running|online(?:\s+again)?|back(?:\s+(?:up|on))?|connected|appears?|exists?|(?:is\s+)?created|shows\s+up|download(?:s|ed|ing)?|pass(?:es|ed)?|seconds?|secs?|minutes?|mins?|hours?|hrs?)$/i;

export function createAgentGrammar(): GrammarRule[] {
  return [
    // ── Watch ────────────────────────────────────────────────────────────
    {
      name: 'watchLetMeKnow',
      order: -12,
      pathSafe: true,
      test(_lower, raw) {
        const m = new RegExp(
          `^\\s*(?:let me know|tell me|notify me|ping me|alert me|lmk)\\s+(?:when|once|as soon as|if)\\s+(.+?)(?:${THEN}(.+?))?\\s*[.!]*$`,
          'i',
        ).exec(raw);
        if (!m || !CONDITION_TAIL.test(clean(m[1]))) return null;
        return plan(
          step('watch.create', { when: clean(m[1]), then: clean(m[2]), request: raw.trim() }),
          'watch-create',
        );
      },
    },
    {
      name: 'watchWhenThen',
      order: -11.99,
      pathSafe: true,
      // "When …" opens a question as often as an instruction, so the grammar
      // treats it as question-shaped. This rule claims it only with an
      // instruction after the comma and no question mark at the end.
      questionSafe: ['watch-create'],
      test(_lower, raw) {
        if (raw.trim().endsWith('?')) return null;
        const m =
          new RegExp(`^\\s*(?:when|once|as soon as)\\s+(.+?)${THEN}(.+?)\\s*[.!]*$`, 'i').exec(
            raw,
          ) ??
          new RegExp(
            `^\\s*after\\s+((?:the|this|my|that)\\s+.+?|\\d+\\s*\\w+)${THEN}(.+?)\\s*[.!]*$`,
            'i',
          ).exec(raw);
        if (!m || !CONDITION_TAIL.test(clean(m[1]))) return null;
        let then = clean(m[2]);
        if (/^(?:let me know|tell me|notify me|ping me)$/i.test(then)) then = '';
        return plan(
          step('watch.create', { when: clean(m[1]), then, request: raw.trim() }),
          'watch-create',
        );
      },
    },
    {
      name: 'watchInTime',
      order: -11.98,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          /^\s*in\s+(\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?))\s*,\s*(.+?)\s*[.!]*$/i.exec(
            raw,
          );
        if (!m) return null;
        return plan(
          step('watch.create', { when: clean(m[1]), then: clean(m[2]), request: raw.trim() }),
          'watch-create',
        );
      },
    },
    {
      name: 'watchThis',
      order: -11.97,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          /^\s*(watch|monitor|keep an eye on|keep watch on|keep watching)\s+(.+?)\s*[.!]*$/i.exec(
            raw,
          );
        if (!m) return null;
        const { target, then } = watchTarget(m[2]!);
        if (!target) return null;
        // "watch" alone is also what people do to films; only take it for a job.
        if (/^watch$/i.test(m[1]!) && !WATCHABLE.test(target)) return null;
        const when = /\b(?:starts|opens|launches|closes|exits|finishes|is done|appears)$/i.test(
          target,
        )
          ? target
          : `${target} finishes`;
        return plan(step('watch.create', { when, then, request: raw.trim() }), 'watch-create');
      },
    },
    {
      name: 'watchList',
      order: -11.96,
      questionSafe: ['watch-list'],
      test(lower) {
        const t = lower.trim().replace(/[?.!]+$/, '');
        if (
          /^(?:what(?:'s| is| are)\s+(?:you\s+)?(?:watching|monitoring|keeping an eye on)(?:\s+for)?(?:\s+right now)?|(?:show\s+(?:me\s+)?)?(?:my\s+|the\s+)?watch(?:es| list)|watch status|(?:what'?s|what is) the status(?: of (?:my|the) watch(?:es)?)?|status of (?:my|the) watch(?:es)?|(?:are there )?any watches(?: running)?|how(?:'s| is) (?:my|the) watch going)$/.test(
            t,
          )
        ) {
          return plan(step('watch.list'), 'watch-list');
        }
        return null;
      },
    },
    {
      name: 'watchCancel',
      order: -11.95,
      test(lower) {
        const m =
          /^(?:stop|cancel|end|quit)\s+(?:watching|monitoring|keeping an eye on)(?:\s+(?:for\s+)?(.+?))?\s*[.!]*$/.exec(
            lower,
          ) ??
          /^(?:stop|cancel|end|delete|remove)\s+(?:the\s+|my\s+)?(all\s+)?(?:(?:the|my)\s+)?watch(?:es)?(?:\s+(?:for|on)\s+(.+?))?\s*[.!]*$/.exec(
            lower,
          );
        if (!m) return null;
        const which = m.length > 2 ? (m[1] ? 'all' : clean(m[2])) : clean(m[1]);
        return plan(step('watch.cancel', which ? { which } : {}), 'watch-cancel');
      },
    },
    {
      name: 'watchPauseResume',
      order: -11.94,
      test(lower) {
        const m =
          /^(pause|resume|unpause|restart)\s+(?:the\s+|my\s+)?(all\s+)?(?:(?:the|my)\s+)?watch(?:es|ing)?(?:\s+(?:for|on)\s+(.+?))?\s*[.!]*$/.exec(
            lower,
          );
        if (!m) return null;
        const which = m[2] ? 'all' : clean(m[3]);
        const skill = m[1] === 'pause' ? 'watch.pause' : 'watch.resume';
        return plan(
          step(skill, which ? { which } : {}),
          skill === 'watch.pause' ? 'watch-pause' : 'watch-resume',
        );
      },
    },

    // ── Setups ───────────────────────────────────────────────────────────
    {
      name: 'setupRun',
      order: -11.9,
      pathSafe: true,
      test(_lower, raw) {
        const t = raw.trim().replace(/[.!]+$/, '');
        const m =
          /^(?:(?:get|make)\s+(?:my\s+|the\s+)?(?:pc|computer|machine|desktop|laptop|rig|system|setup|everything|things|stuff|it|me|us)?\s*(?:all\s+)?(?:ready|set\s*up|prepped|prepared)|(?:prepare|prep|set\s+up)\s+(?:my\s+|the\s+)?(?:pc|computer|machine|desktop|laptop|rig|system)|(?:prepare|prep)|get\s+set)\s+(?:for|to)\s+(.+?)(?:\s*(?::|—|–|\s-\s)\s*(.+))?$/i.exec(
            t,
          );
        if (m) {
          const spec = clean(m[2]);
          return plan(
            step('setup.run', spec ? { name: clean(m[1]), spec } : { name: clean(m[1]) }),
            'setup-run',
          );
        }
        const run =
          /^(?:run|start|load|apply|do|use)\s+(?:my\s+|the\s+)?(.+?)\s+(?:setup|routine)$/i.exec(t);
        if (run) return plan(step('setup.run', { name: clean(run[1]) }), 'setup-run');
        if (
          /^(?:get|make)\s+(?:my\s+)?(?:pc|computer|machine|everything|things)\s+ready$/i.test(t)
        ) {
          return plan(step('setup.run', {}), 'setup-run');
        }
        return null;
      },
    },
    {
      name: 'setupSave',
      order: -11.89,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          /^\s*(?:save|make|create|set)\s+(?:a\s+|my\s+|the\s+)?(.+?)\s+(?:setup|routine)\s*(?:as|:|to be|to|with|=)\s+(.+?)\s*[.!]*$/i.exec(
            raw,
          );
        if (!m) return null;
        return plan(step('setup.save', { name: clean(m[1]), spec: clean(m[2]) }), 'setup-save');
      },
    },
    {
      name: 'setupList',
      order: -11.88,
      questionSafe: ['setup-list'],
      test(lower) {
        return /^(?:show|list|what are)\s+(?:me\s+)?(?:all\s+)?(?:my\s+)?(?:saved\s+)?(?:setups|routines)\??$/.test(
          lower.trim(),
        )
          ? plan(step('setup.list'), 'setup-list')
          : null;
      },
    },
    {
      name: 'setupDelete',
      order: -11.87,
      test(lower) {
        const m =
          /^(?:delete|remove|forget)\s+(?:my\s+|the\s+)?(.+?)\s+(?:setup|routine)\s*[.!]*$/.exec(
            lower,
          );
        return m ? plan(step('setup.delete', { name: clean(m[1]) }), 'setup-delete') : null;
      },
    },

    // ── Developer loop, in plain words ───────────────────────────────────
    {
      name: 'devTests',
      order: -11.5,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          /^\s*(?:run|do)\s+(?:the\s+|my\s+|all\s+(?:the\s+)?)?(?:unit\s+)?tests?(?:\s+(?:in|for|on|at)\s+(.+?))?\s*[.!]*$/i.exec(
            raw,
          );
        if (!m) return null;
        const path = clean(m[1]).replace(/^["']|["']$/g, '');
        return plan(step('test.run', path ? { path } : {}), 'test-run');
      },
    },
    {
      name: 'devBuild',
      order: -11.49,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          /^\s*(build|compile|package|bundle)\s+(?:it|this|the\s+(?:project|app|code)|my\s+(?:project|app))(?:\s+(?:in|at)\s+(.+?))?\s*[.!]*$/i.exec(
            raw,
          ) ??
          new RegExp(`^\\s*(build|compile|package|bundle)\\s+(${PATH}.+?)\\s*[.!]*$`, 'i').exec(
            raw,
          );
        if (!m) return null;
        const path = clean(m[2]).replace(/^["']|["']$/g, '');
        const packaging = /^(?:package|bundle)$/i.test(m[1]!);
        const args: Record<string, string> = {};
        if (path) args.path = path;
        if (packaging) args.target = 'package';
        return plan(step('build.run', args), packaging ? 'package' : 'build');
      },
    },
    {
      name: 'devProject',
      order: -11.47,
      pathSafe: true,
      test(_lower, raw) {
        const inspect = new RegExp(
          `^\\s*(?:inspect|detect|look at|analy[sz]e)\\s+(?:the\\s+|my\\s+)?project\\s+(?:at|in)\\s+(${PATH}.+?)\\s*[.!]*$`,
          'i',
        ).exec(raw);
        if (inspect)
          return plan(step('project.detect', { path: clean(inspect[1]) }), 'project-detect');
        const create = new RegExp(
          `^\\s*(?:start|create|make|begin|set up)\\s+(?:a\\s+)?new\\s+project\\s+(?:at|in|called)\\s+(${PATH}.+?)\\s*[.!]*$`,
          'i',
        ).exec(raw);
        if (create)
          return plan(step('project.create', { path: clean(create[1]) }), 'project-create');
        const search =
          /^\s*search\s+(?:the|this|my)\s+project\s+for\s+["“']?(.+?)["”']?(?:\s+in\s+(.+?))?\s*[.!]*$/i.exec(
            raw,
          );
        if (search) {
          const args: Record<string, string> = { query: search[1]!.trim() };
          if (search[2]) args.path = clean(search[2]);
          return plan(step('code.search', args), 'code-search');
        }
        return null;
      },
    },
    {
      name: 'devOpenResult',
      order: -11.48,
      pathSafe: true,
      test(lower) {
        return /^open\s+(?:the\s+|my\s+)?(?:result|output|build(?:\s+output)?|finished\s+(?:build|project)|project i just built)\s*[.!]*$/.test(
          lower.trim(),
        )
          ? plan(step('project.launch', {}), 'project-launch')
          : null;
      },
    },

    // ── Windows and devices ──────────────────────────────────────────────
    {
      name: 'windowPlace',
      order: -11.4,
      test(_lower, raw) {
        const m =
          /^\s*(?:put|move|snap|place|dock|send)\s+(.+?)\s+(?:on|to|in|at|into)\s+(?:the\s+)?(.+?)(?:\s+(?:of|on)\s+(?:display|monitor|screen)\s+(\d))?\s*[.!]*$/i.exec(
            raw,
          );
        if (!m) return null;
        const position = readPosition(m[2]!);
        if (!position) return null;
        const name = clean(m[1])
          .replace(/^(?:the|my)\s+/i, '')
          .replace(/\s+window$/i, '');
        const args: Record<string, string | number> = { name, position };
        if (m[3]) args.display = Number(m[3]);
        return plan(step('window.place', args), 'window-place');
      },
    },
    {
      name: 'audioDevices',
      order: -11.3,
      questionSafe: ['audio-devices'],
      test(lower) {
        const t = lower.trim().replace(/[?.!]+$/, '');
        return /^(?:(?:which|what)\s+(?:mic|microphone|speakers?|audio device|headset)\s+(?:am i using|is (?:on|selected|in use|active|being used|my default|the default)|do i have (?:on|selected))|(?:what'?s|what is)\s+my\s+(?:default\s+)?(?:mic|microphone)|(?:check|show)\s+my\s+(?:mic|microphone|audio devices?))$/.test(
          t,
        )
          ? plan(step('system.audioDevices'), 'audio-devices')
          : null;
      },
    },
  ];
}
