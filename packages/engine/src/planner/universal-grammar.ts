/**
 * "Figure out how to…" hands a goal to the universal agent. Only an explicit request of this shape does:
 * the agent is never a silent fallback for something Atlas did not understand.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

export function parseSolveRequest(raw: string): string | null {
  const t = raw.trim().replace(/[\s.!]+$/, '');
  const m =
    /^(?:please\s+)?(?:figure\s+out|work\s+out|find\s+(?:out\s+)?a\s+way)\s+(?:how\s+)?(?:to\s+)?(.{6,300})$/i.exec(t) ??
    /^(?:please\s+)?(?:take\s+care\s+of|handle|sort\s+out)\s+(?:this|the\s+following)\s*[:\-]\s*(.{6,300})$/i.exec(t);
  return m?.[1]?.trim() || null;
}

export function createUniversalGrammar(): GrammarRule[] {
  return [
    {
      name: 'solveGoal',
      order: -11.64,
      pathSafe: true,
      test(_lower, raw) {
        const goal = parseSolveRequest(raw);
        return goal ? plan(step('agent.solve', { goal }), 'agent-solve') : null;
      },
    },
  ];
}
