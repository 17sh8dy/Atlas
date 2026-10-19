/**
 * Plain-English routes to saved workflows. Every form names the word "workflow" (or "remember … as"),
 * so "run the tests" and "save the file" are never mistaken for them.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

const clean = (s: string) => s.trim().replace(/^["'`]+|["'`.!?]+$/g, '').trim();

export function parseRemember(raw: string): { name: string; then?: string } | null {
  const t = raw.trim().replace(/[\s.!]+$/, '');
  // "save a workflow called deploy: run the tests then open the site"
  let m = /^(?:please\s+)?(?:save|make|create|remember)\s+(?:a\s+|an\s+)?(?:new\s+)?workflow\s+(?:called|named)\s+(.+?)\s*[:-]\s*(.+)$/i.exec(t);
  if (m) return { name: clean(m[1]!), then: clean(m[2]!) };
  // "remember that as my morning routine", "save this as the deploy workflow", "remember what you just did as deploy"
  m = /^(?:please\s+)?(?:remember|save|keep)\s+(?:that|this|it|what\s+you\s+(?:just\s+)?did|those\s+steps)\s+as\s+(?:a\s+|an\s+|my\s+|the\s+)?(.+?)(?:\s+workflow)?$/i.exec(t);
  if (m) return { name: clean(m[1]!) };
  // "save a workflow called deploy"
  m = /^(?:please\s+)?(?:save|make|create)\s+(?:a\s+|an\s+)?(?:new\s+)?workflow\s+(?:called|named)\s+(.+)$/i.exec(t);
  if (m) return { name: clean(m[1]!) };
  return null;
}

export function createWorkflowMemoryGrammar(): GrammarRule[] {
  return [
    {
      name: 'workflowRemember',
      order: -11.69,
      pathSafe: true,
      test(_lower, raw) {
        const r = parseRemember(raw);
        if (!r || !r.name) return null;
        return plan(step('workflow.remember', r.then ? { name: r.name, then: r.then } : { name: r.name }), 'workflow-remember');
      },
    },
    {
      name: 'workflowReplay',
      order: -11.68,
      test(lower) {
        const t = lower.trim().replace(/[?.!]+$/, '');
        const m =
          /^(?:please\s+)?(?:run|start|replay|do|play)\s+(?:my\s+|the\s+)?(?:saved\s+)?workflow\s+(?:called\s+|named\s+)?(.+)$/.exec(t) ??
          /^(?:please\s+)?(?:run|start|replay|do|play)\s+(?:my\s+|the\s+)?(.+?)\s+workflow$/.exec(t);
        return m?.[1] ? plan(step('workflow.replay', { name: clean(m[1]) }), 'workflow-replay') : null;
      },
    },
    {
      name: 'workflowSaved',
      order: -11.67,
      questionSafe: ['workflow-saved'],
      test(lower) {
        const t = lower.trim().replace(/[?.!]+$/, '');
        return /^(?:what|which)\s+workflows?\s+(?:do\s+i\s+have|have\s+i\s+saved|are\s+saved|did\s+i\s+save)(?:\s+saved)?$/.test(t) ||
          /^(?:list|show)\s+(?:me\s+)?(?:my\s+|the\s+|all\s+)*saved\s+workflows$/.test(t) ||
          /^(?:list|show)\s+(?:me\s+)?(?:my\s+)?workflows$/.test(t)
          ? plan(step('workflow.saved', {}), 'workflow-saved')
          : null;
      },
    },
    {
      name: 'workflowForget',
      order: -11.66,
      test(lower) {
        const t = lower.trim().replace(/[?.!]+$/, '');
        const m =
          /^(?:please\s+)?(?:forget|delete|remove)\s+(?:my\s+|the\s+)?(?:saved\s+)?workflow\s+(?:called\s+|named\s+)?(.+)$/.exec(t) ??
          /^(?:please\s+)?(?:forget|delete|remove)\s+(?:my\s+|the\s+)?(.+?)\s+workflow$/.exec(t);
        return m?.[1] ? plan(step('workflow.forget', { name: clean(m[1]) }), 'workflow-forget') : null;
      },
    },
  ];
}
