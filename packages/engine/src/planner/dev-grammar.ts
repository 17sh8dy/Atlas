/**
 * Developer phrasings that name no folder: "git status", "which branch am I
 * on", "commit my changes with message …", "push to github", "stash my
 * changes", "open this project in vscode".
 *
 * None of these carry a path. The skills they reach fall back to the current
 * project (`project-context.ts`), or ask which one — so these rules never have
 * to know where the project is, and never guess.
 *
 * Ordered at -11.46, ahead of the core rules: "push to github" and "pull the
 * latest" would otherwise be read as clicking a control, and "open this project
 * in vscode" as an app called "this project in vscode".
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

const PATH = String.raw`(?:[a-z]:[\\/]|\\\\)`;

function tidy(s: string | undefined): string {
  return (s ?? '')
    .trim()
    .replace(/[?.!]+$/g, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

/** " in D:\Dev\X" / " in my atlas project" at the end — a folder, said or spoken. */
const WHERE = String.raw`(?:\s+(?:in|for|on|of|at)\s+(?:the\s+|my\s+)?(.+?))?`;

function withPath(args: Record<string, string | number | boolean>, where: string | undefined) {
  const w = tidy(where).replace(/\s+project$/i, '');
  return w && !/^(?:this|that|the|current|it)(?:\s+(?:project|repo|repository|folder))?$/i.test(w) ? { ...args, path: w } : args;
}

export function createDevGrammar(): GrammarRule[] {
  return [
    {
      name: 'gitStatus',
      order: -11.46,
      pathSafe: true,
      questionSafe: ['git-status', 'git-branch', 'git-log', 'git-diff'],
      test(_lower, raw) {
        const status = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:(?:show|check|what(?:['’]?s|\s+is))\s+(?:me\s+)?(?:the\s+)?)?git\s+status${WHERE}\s*[?.!]*$|^\s*(?:what(?:['’]?s|\s+is)\s+(?:the\s+)?)?status\s+of\s+(?:the\s+|my\s+)?(?:git\s+)?(?:repo|repository|project)${WHERE}\s*[?.!]*$|^\s*(?:are\s+there|do\s+i\s+have|any)\s+(?:any\s+)?(?:uncommitted|unsaved|unstaged)\s+changes${WHERE}\s*[?.!]*$|^\s*what\s+(?:have\s+i|did\s+i)\s+(?:changed?|modified|edited)${WHERE}\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (status) return plan(step('git.status', withPath({}, status[1] ?? status[2] ?? status[3] ?? status[4])), 'git-status');

        const log = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:(?:show|list|see)\s+(?:me\s+)?(?:the\s+)?)?(?:git\s+log|(?:recent|latest|last)\s+commits|commit\s+history|commits)${WHERE}\s*[?.!]*$|^\s*what\s+(?:did\s+i|have\s+i|was)\s+(?:last\s+)?commit(?:ted)?${WHERE}\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (log) return plan(step('git.log', withPath({ limit: 10 }, log[1] ?? log[2])), 'git-log');

        const diff = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:(?:show|see)\s+(?:me\s+)?(?:the\s+)?)?(?:git\s+diff|diff)${WHERE}\s*[?.!]*$|^\s*what\s+(?:exactly\s+)?(?:did\s+i|have\s+i)\s+change(?:d)?(?:\s+exactly)?${WHERE}\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (diff) return plan(step('git.diff', withPath({}, diff[1] ?? diff[2])), 'git-diff');

        const branch = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:(?:which|what)\s+branch\s+(?:am\s+i\s+on|is\s+(?:this|checked\s+out)|are\s+we\s+on)|(?:show|list|see)\s+(?:me\s+)?(?:the\s+|all\s+(?:the\s+)?|my\s+)?branches|git\s+branch|current\s+branch)${WHERE}\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (branch) return plan(step('git.branch', withPath({}, branch[1])), 'git-branch');
        return null;
      },
    },

    {
      name: 'gitCommit',
      order: -11.455,
      pathSafe: true,
      test(_lower, raw) {
        // "commit everything with message fix typo" → stage all, then commit.
        const all = raw.match(
          /^\s*(?:please\s+)?(?:git\s+)?commit\s+(?:all|everything|all\s+(?:my\s+)?changes|my\s+changes|the\s+changes)\s+(?:with\s+(?:the\s+)?(?:message|msg)|saying|as|:|-m)\s*:?\s*([\s\S]+?)\s*[.!]*$/i,
        );
        if (all) {
          const message = tidy(all[1]);
          if (!message) return null;
          return plan(
            [step('git.add', { file: '.' }), step('git.commit', { message })],
            'git-commit-all',
          );
        }
        // "commit with message fix typo" / `git commit -m "fix typo"` → what is already staged.
        const staged = raw.match(
          /^\s*(?:please\s+)?(?:git\s+)?commit\s+(?:(?:what(?:['’]?s|\s+is)\s+)?staged\s+)?(?:with\s+(?:the\s+)?(?:message|msg)|saying|-m)\s*:?\s*([\s\S]+?)\s*[.!]*$/i,
        );
        if (staged) {
          const message = tidy(staged[1]);
          if (!message) return null;
          return plan(step('git.commit', { message }), 'git-commit');
        }
        return null;
      },
    },

    {
      name: 'gitSwitch',
      order: -11.454,
      pathSafe: true,
      test(_lower, raw) {
        const create = raw.match(
          /^\s*(?:please\s+)?(?:git\s+checkout\s+-b|(?:create|make|start|open)\s+(?:a\s+)?(?:new\s+)?branch(?:\s+(?:called|named))?|new\s+branch)\s+([A-Za-z0-9][A-Za-z0-9._/-]*)\s*[?.!]*$/i,
        );
        if (create) return plan(step('git.checkout', { branch: create[1]!, create: true }), 'git-checkout');
        const sw = raw.match(
          /^\s*(?:please\s+)?(?:git\s+checkout|git\s+switch|check\s*out|(?:switch|go|change)\s+to\s+(?:the\s+)?branch|switch\s+branch(?:es)?\s+to)\s+(?:branch\s+)?([A-Za-z0-9][A-Za-z0-9._/-]*)\s*[?.!]*$/i,
        );
        if (sw) return plan(step('git.checkout', { branch: sw[1]! }), 'git-checkout');
        return null;
      },
    },

    {
      name: 'gitPullPush',
      order: -11.453,
      pathSafe: true,
      test(_lower, raw) {
        const pull = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:git\s+pull|pull(?:\s+(?:down|in))?\s+(?:the\s+)?(?:latest|newest|changes|updates|everything)|pull\s+(?:from|the\s+latest\s+from)\s+(?:github|origin|remote|upstream|git)|update\s+(?:my\s+)?(?:repo|repository|project)\s+from\s+(?:github|origin|remote)|pull)${WHERE}\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (pull) return plan(step('git.pull', withPath({}, pull[1])), 'git-pull');
        const push = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:git\s+push|push(?:\s+(?:my|the|all|these|those))?\s+(?:changes|commits?|code|work|branch)|push\s+(?:it\s+)?(?:up\s+)?to\s+(?:github|origin|remote|upstream|git|the\s+remote)|push)${WHERE}\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (push) return plan(step('git.push', withPath({}, push[1])), 'git-push');
        return null;
      },
    },

    {
      name: 'gitStash',
      order: -11.452,
      pathSafe: true,
      test(lower) {
        if (/^\s*(?:please\s+)?(?:(?:git\s+)?stash\s+(?:pop|apply)|(?:un-?stash|pop\s+(?:the\s+|my\s+)?stash)(?:\s+(?:my\s+)?changes)?|(?:restore|bring\s+back|get\s+back)\s+(?:my\s+)?stash(?:ed)?(?:\s+changes)?)\s*[?.!]*$/.test(lower)) {
          return plan(step('git.stash', { action: 'pop' }), 'git-stash');
        }
        if (/^\s*(?:please\s+)?(?:(?:list|show)\s+(?:my\s+|the\s+)?stash(?:es)?|git\s+stash\s+list|what(?:['’]?s|\s+is)\s+(?:in\s+)?(?:my\s+|the\s+)?stash)\s*[?.!]*$/.test(lower)) {
          return plan(step('git.stash', { action: 'list' }), 'git-stash');
        }
        if (/^\s*(?:please\s+)?(?:git\s+stash|stash(?:\s+(?:my|the|these|all))?(?:\s+(?:changes|work))?|set\s+(?:my\s+)?changes\s+aside|shelve\s+(?:my\s+)?changes)\s*[?.!]*$/.test(lower)) {
          return plan(step('git.stash', { action: 'push' }), 'git-stash');
        }
        return null;
      },
    },

    {
      name: 'projectUse',
      order: -11.451,
      pathSafe: true,
      questionSafe: ['project-current'],
      test(_lower, raw) {
        const use = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:use|set|make)\s+(${PATH}.+?|.+?\s+project|.+?)\s+(?:as\s+)?(?:my\s+|the\s+)?(?:current\s+|active\s+)?project\s*[?.!]*$|^\s*(?:please\s+)?(?:work\s+on|switch\s+to\s+(?:the\s+)?project|open\s+project|set\s+(?:my\s+|the\s+)?project\s+to|change\s+(?:my\s+|the\s+)?project\s+to)\s+(${PATH}.+?|.+?\s+project)\s*[?.!]*$`,
          'i',
        ).exec(raw);
        const target = tidy(use?.[1] ?? use?.[2]).replace(/\s+project$/i, '');
        if (use && target && !/^(?:a|the|this|that|my|new)$/i.test(target)) {
          return plan(step('project.use', { target }), 'project-use');
        }
        if (/^\s*(?:which|what)\s+project\s+(?:am\s+i\s+(?:working\s+on|in)|is\s+(?:this|current|active))\s*[?.!]*$|^\s*(?:the\s+)?current\s+project\s*[?.!]*$/i.test(raw)) {
          return plan(step('project.current', {}), 'project-current');
        }
        return null;
      },
    },

    {
      name: 'projectOpenIn',
      order: -11.45,
      pathSafe: true,
      test(_lower, raw) {
        const term = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:open|launch|start|bring\s+up)\s+(?:a\s+|the\s+|my\s+)?(?:new\s+)?terminal(?:\s+window)?(?:\s+(?:in|for|at|on)\s+(?:the\s+|my\s+)?(.+?))?\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (term) {
          const where = tidy(term[1]);
          if (!where || /^(?:this|that|the|current|my)?\s*(?:project|folder|repo|repository|directory)?$/i.test(where)) {
            return plan(step('project.terminal', {}), 'project-terminal');
          }
          return plan(step('project.terminal', { path: where.replace(/\s+project$/i, '') }), 'project-terminal');
        }
        const editor = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:open|launch|edit|start)\s+(?:(?:this|the|my|that)\s+)?(?:project|repo|repository|folder|code)?\s*(?:(.+?)\s+)?(?:in|with|using)\s+(?:vs\s*code|vscode|visual\s+studio\s+code|code|my\s+editor|the\s+editor)\s*[?.!]*$`,
          'i',
        ).exec(raw);
        if (editor) {
          const where = tidy(editor[1]).replace(/^(?:this|the|my|that)\s+/i, '').replace(/\s+project$/i, '');
          return plan(step('project.editor', where && !/^(?:project|repo|repository|folder)$/i.test(where) ? { path: where } : {}), 'project-editor');
        }
        return null;
      },
    },
  ];
}
