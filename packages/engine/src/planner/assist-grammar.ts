/**
 * Phrasings for the 1.0.9 assist tools (`skills/assist-skills.ts`). All deterministic, all read-only:
 * each rule only picks a tool and its arguments; the tool decides what is allowed.
 *
 *   “audit your tools”                                   → atlas.selfAudit
 *   “dry run: clean up my downloads”                     → workflow.dryRun
 *   “explain this error: ENOENT …”, “what does EADDRINUSE mean” → diagnostics.explainFailure
 *   “what does my change affect”                         → git.changeImpact
 *   “compare the config files D:\a.json and D:\b.json”   → config.diff
 *   “what do my notes say about X in D:\Dev\Docs”        → knowledge.citeEvidence
 */

import { plan, step, type GrammarRule } from './grammar';
import { pathsIn } from './health-grammar';

const clean = (s: string) => s.trim().replace(/^["'“‘]|["'”’]$/g, '').trim();

export function parseExplainError(raw: string): string | null {
  const m =
    /^\s*(?:please\s+)?(?:can\s+you\s+)?(?:explain|diagnose|decode|analy[sz]e|interpret|help\s+me\s+(?:with|understand))\s+(?:this|the|my|that)\s+(?:error|failure|exception|stack\s?trace|crash|message)(?:\s+message)?\s*[:\-–]?\s*([\s\S]+)$/i.exec(raw) ??
    /^\s*(?:what\s+does|what\s+is|what's)\s+(?:the\s+error\s+)?([A-Z][A-Z0-9_]{3,})\s+(?:error\s+)?mean\s*[?.!]*$/.exec(raw);
  const text = m?.[1] ? clean(m[1]) : '';
  return text.length >= 3 ? text : null;
}

export function parseDryRun(raw: string): string | null {
  const m =
    /^\s*(?:please\s+)?(?:dry[\s-]?run|simulate|rehearse)\s*[:,\-–]?\s+(.+?)\s*[?.!]*$/i.exec(raw) ??
    /^\s*what\s+(?:would|will)\s+(?:happen|you\s+do)\s+if\s+i\s+(?:said|say|asked(?:\s+you)?(?:\s+to)?|told\s+you\s+to)\s*[:,]?\s+(.+?)\s*[?.!]*$/i.exec(raw);
  const request = m?.[1] ? clean(m[1]) : '';
  return request.length >= 3 ? request : null;
}

export function parseConfigDiff(raw: string): { a: string; b: string } | null {
  if (!/\b(?:configs?|configuration|settings?|\.env|environment\s+file)\b/i.test(raw)) return null;
  if (!/\b(?:compare|diff|difference|differences|different|differ)\b/i.test(raw)) return null;
  const paths = pathsIn(raw);
  return paths.length === 2 ? { a: paths[0]!, b: paths[1]! } : null;
}

export function parseCiteEvidence(raw: string): { question: string; folder?: string } | null {
  const paths = pathsIn(raw);
  if (paths.length > 1) return null;
  const without = paths.reduce((s, p) => s.replace(`"${p}"`, ' ').replace(p, ' '), raw).replace(/\s+/g, ' ').trim();
  const stripPlace = (s: string) => s.replace(/\s+(?:in|from|inside|under|within|at)\s*$/i, '').replace(/[?.!]+$/, '').trim();
  const m =
    /^(?:please\s+)?what\s+(?:do|does)\s+(?:my|the|our)\s+(?:notes?|docs?|documentation|files?|documents?|readme|code|project)\s+say\s+about\s+(.+)$/i.exec(without) ??
    /^(?:please\s+)?(?:find|show\s+me|get|give\s+me)\s+(?:the\s+)?(?:evidence|sources?|references?|citations?|passages?|quotes?)\s+(?:for|on|about|of)\s+(.+)$/i.exec(without) ??
    /^(?:please\s+)?(?:cite|quote)\s+(?:my\s+|the\s+)?(?:files?|notes?|docs?|sources?)?\s*(?:on|about|for)\s+(.+)$/i.exec(without) ??
    /^(?:please\s+)?where\s+(?:in\s+(?:my|the)\s+(?:files?|notes?|docs?|project|code)\s+)?(?:do\s+(?:i|we|you)|does\s+(?:it|anything))\s+(?:mention|talk\s+about|say\s+anything\s+about)\s+(.+)$/i.exec(without);
  const question = m?.[1] ? stripPlace(m[1]) : '';
  if (!question) return null;
  return paths[0] ? { question, folder: paths[0] } : { question };
}

export function createAssistGrammar(): GrammarRule[] {
  return [
    {
      name: 'selfAudit',
      order: -12.71,
      questionSafe: ['self-audit'],
      test(lower) {
        const t = lower.trim().replace(/[?.!]+$/, '');
        return /^(?:please\s+)?(?:run\s+(?:a\s+)?)?(?:tool|skill|self)\s*audit$/.test(t) ||
          /^(?:please\s+)?(?:audit|check|inspect|review|validate)\s+(?:your|atlas'?s?|all\s+(?:of\s+)?your)\s+(?:own\s+)?(?:tools?|skills?|actions?|capabilities)$/.test(t) ||
          /^(?:are|is)\s+(?:all\s+)?(?:of\s+)?your\s+(?:tools?|skills?)\s+(?:set\s+up\s+)?(?:ok|okay|fine|right|correct(?:ly)?|declared\s+(?:right|correctly))$/.test(t)
          ? plan(step('atlas.selfAudit', {}), 'self-audit')
          : null;
      },
    },
    {
      name: 'explainError',
      order: -12.7,
      questionSafe: ['explain-error'],
      test(_lower, raw) {
        const error = parseExplainError(raw);
        return error ? plan(step('diagnostics.explainFailure', { error }), 'explain-error') : null;
      },
    },
    {
      name: 'dryRun',
      // After the batch-rename rule (-10.74), which has its own "dry run …" phrasings.
      order: -10.73,
      questionSafe: ['dry-run'],
      test(_lower, raw) {
        const request = parseDryRun(raw);
        return request ? plan(step('workflow.dryRun', { request }), 'dry-run') : null;
      },
    },
    {
      name: 'changeImpact',
      order: -12.68,
      pathSafe: true,
      questionSafe: ['change-impact'],
      test(lower, raw) {
        const paths = pathsIn(raw);
        if (paths.length > 1) return null;
        const t = paths.reduce((s, p) => s.split(p.toLowerCase()).join('<p>'), lower).replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
        const hit =
          /^(?:what|which)\s+(?:does|do|will|would|could|might|can)\s+(?:my|the|these|this)\s+(?:uncommitted\s+|current\s+)?(?:changes?|edits?|diff|commit)\s+(?:affect|break|touch|impact|change|involve|reach)(?:\s+in\s+<p>)?$/.test(t) ||
          /^(?:what|which)\s+(?:files|tests)\s+(?:does|do|will|would|could)\s+(?:my|the)\s+(?:changes?|edits?)\s+(?:affect|touch|impact)(?:\s+in\s+<p>)?$/.test(t) ||
          /^(?:what(?:'s|\s+is)\s+)?(?:the\s+)?(?:impact|blast\s+radius)\s+of\s+(?:my|the)\s+(?:uncommitted\s+)?(?:changes?|edits?)(?:\s+in\s+<p>)?$/.test(t) ||
          /^(?:check|assess|analy[sz]e)\s+(?:the\s+)?(?:impact|risk)\s+of\s+(?:my|the)\s+(?:changes?|edits?)(?:\s+in\s+<p>)?$/.test(t);
        return hit ? plan(step('git.changeImpact', paths[0] ? { path: paths[0] } : {}), 'change-impact') : null;
      },
    },
    {
      name: 'configDiff',
      order: -10.76,
      pathSafe: true,
      questionSafe: ['config-diff'],
      test(_lower, raw) {
        const d = parseConfigDiff(raw);
        return d ? plan(step('config.diff', d), 'config-diff') : null;
      },
    },
    {
      name: 'citeEvidence',
      order: -10.2,
      pathSafe: true,
      questionSafe: ['cite-evidence'],
      test(_lower, raw) {
        const c = parseCiteEvidence(raw);
        return c ? plan(step('knowledge.citeEvidence', c.folder ? { question: c.question, folder: c.folder } : { question: c.question }), 'cite-evidence') : null;
      },
    },
  ];
}
