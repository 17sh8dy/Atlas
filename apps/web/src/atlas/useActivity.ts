/**
 * The live record of what Atlas is doing, assembled from `activity:step`.
 *
 * ── Why a reducer over the bus and not state in the executor ────────────────
 * The executor reports events; it holds no history, and shouldn't — it is the
 * thing doing the work, not the thing describing it. This turns that stream
 * into the shape a panel renders: one run per ask, steps in plan order,
 * sub-steps nested under the step that reported them.
 *
 * Events can arrive for a step that has already finished (a skill reporting a
 * late sub-step) and for a run that has already ended (the same, after
 * `engine:done`). Both are tolerated rather than dropped — losing the last
 * line of a search because the plan finished a millisecond earlier would be a
 * bug nobody could reproduce on purpose.
 */

import { useEffect, useRef, useState } from 'react';
import type { ActivityRun, ActivityStep } from '@atlas/core';
import type { ActivityEvent, Bus } from '@atlas/engine';

/** Runs older than this are dropped, so a long session doesn't grow forever. */
const KEEP_RUNS = 30;

export function useActivity(bus: Bus): Map<string, ActivityRun> {
  const [runs, setRuns] = useState<Map<string, ActivityRun>>(() => new Map());
  // The run being built. A ref because every event mutates the same one and
  // re-rendering to carry an id between events would be pointless work.
  const currentId = useRef<string | null>(null);
  const nextRunId = useRef(1);

  useEffect(() => {
    const offAsk = bus.on<{ text: string }>('engine:ask', (payload) => {
      const id = `r${nextRunId.current++}`;
      currentId.current = id;
      setRuns((prev) => {
        const next = new Map(prev);
        next.set(id, {
          id,
          request: payload.text,
          startedAt: Date.now(),
          steps: [],
          state: 'running',
        });
        // Oldest first in insertion order, so trimming the front is trimming
        // the oldest.
        while (next.size > KEEP_RUNS) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next;
      });
    });

    const offStep = bus.on<ActivityEvent>('activity:step', (event) => {
      const runId = currentId.current;
      if (!runId) return;

      setRuns((prev) => {
        const run = prev.get(runId);
        if (!run) return prev;
        const next = new Map(prev);
        const steps = [...run.steps];

        // The parent step for this event — created on demand, because a
        // skill can report a sub-step before its own 'running' has landed.
        let parent = steps[event.index];
        if (!parent) {
          parent = {
            id: `${runId}s${event.index}`,
            label: event.label,
            state: 'running',
            startedAt: event.at,
            skill: event.skill,
          };
          steps[event.index] = parent;
        }

        if (event.childId) {
          const children = [...(parent.children ?? [])];
          const at = children.findIndex((c) => c.id === event.childId);
          const child: ActivityStep = {
            id: event.childId,
            label: event.label,
            detail: event.detail,
            state: event.state,
            startedAt: at >= 0 ? children[at]!.startedAt : event.at,
            endedAt: event.state === 'running' ? undefined : event.at,
          };
          if (at >= 0) children[at] = child;
          else children.push(child);
          steps[event.index] = { ...parent, children };
        } else {
          steps[event.index] = {
            ...parent,
            label: event.label,
            skill: event.skill,
            // A finished step keeps whatever detail it ended with rather than
            // being blanked by an event that carried none.
            detail: event.detail ?? parent.detail,
            state: event.state,
            startedAt: parent.state === 'running' ? parent.startedAt : event.at,
            endedAt: event.state === 'running' ? undefined : event.at,
          };
        }

        next.set(runId, { ...run, steps });
        return next;
      });
    });

    const finish = (state: ActivityRun['state']) => {
      const runId = currentId.current;
      if (!runId) return;
      currentId.current = null;
      setRuns((prev) => {
        const run = prev.get(runId);
        if (!run) return prev;
        const next = new Map(prev);
        next.set(runId, {
          ...run,
          state,
          endedAt: Date.now(),
          // Anything still marked running when the plan ended never got its
          // closing event — a halt, or a throw. Left as "running" it would
          // spin forever in the panel.
          steps: run.steps.map((s) =>
            s.state === 'running'
              ? { ...s, state: state === 'halted' ? 'halted' : 'failed', endedAt: Date.now() }
              : s,
          ),
        });
        return next;
      });
    };

    const offDone = bus.on('engine:done', () => finish('done'));
    const offHalted = bus.on('engine:halted', () => finish('halted'));

    return () => {
      offAsk();
      offStep();
      offDone();
      offHalted();
    };
  }, [bus]);

  return runs;
}
