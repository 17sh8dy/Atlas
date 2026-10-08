/**
 * `workflow.last` — “what did you just do?”, “what's left?”, “where did it put it?”.
 *
 * It reads the report of the last run (see `workflow/report.ts`) and says it in the one standard
 * shape. It only reads: nothing is re-run and nothing is changed. The log lives in memory for the
 * session and is gone when Atlas closes.
 */

import type { Skill } from '@atlas/core';
import { formatWorkflowReport, type WorkflowLog } from '../workflow/report';

export function createWorkflowSkills(log: WorkflowLog): Skill[] {
  return [
    {
      id: 'workflow.last',
      label: 'What I just did',
      icon: '🧾',
      domain: 'atlas',
      description:
        'Report the last thing Atlas did, step by step: what finished, what failed or was skipped, what changed, what is still to do, and where the results are. It only reads the record of the last run.',
      risk: 'safe',
      examples: ['what did you just do', 'what is left to do', 'show the last task report'],
      params: {},
      async run() {
        const report = log.latestMulti() ?? log.latest();
        if (!report) return { ok: true, message: 'I haven’t done anything yet this session.' };
        return { ok: true, message: `🧾 ${formatWorkflowReport(report)}`, aloud: false, data: report };
      },
    },
  ];
}
