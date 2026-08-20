/**
 * Episodic memory — turns "a command ran" into "what happened."
 *
 * Neither the engine nor a skill knows this exists; it just listens on the
 * bus, the way `Bus`'s own doc comment describes memory doing. That keeps
 * "what counts as worth remembering" in one place instead of scattered
 * through every skill that might want to log itself.
 *
 * Only successful steps are recorded — a failed attempt isn't something that
 * "happened" in the sense `EpisodicEvent` means, and skipping them keeps a
 * mistyped command from cluttering the timeline.
 */

import type { Memory, PlanOutcome } from '@atlas/core';
import type { Bus, Unsubscribe } from './bus';
import type { SkillRegistry } from './skills/registry';

interface EngineDonePayload {
  mode: 'command' | 'chat';
  outcome: PlanOutcome;
}

export function recordEpisodes(bus: Bus, memory: Memory, skills: SkillRegistry): Unsubscribe {
  return bus.on<EngineDonePayload>('engine:done', (payload) => {
    if (payload.mode !== 'command') return;
    for (const stepOutcome of payload.outcome.outcomes) {
      if (!stepOutcome.ok) continue;
      const label =
        stepOutcome.message?.trim() || skills.get(stepOutcome.skill)?.label || stepOutcome.skill;
      void memory.record(stepOutcome.skill, label);
    }
  });
}
