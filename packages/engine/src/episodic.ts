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
      const skill = skills.get(stepOutcome.skill);
      // `aloud: false` already marks a message as data rather than narration
      // (see `Skill.aloud`) — a raw metrics dump or a generated secret reads
      // as noise in a timeline the same way it would read as noise spoken
      // aloud. Its own `label` ("System status", "Generate a password") is
      // what belongs in a history of *what Atlas did*; the reading itself
      // stays exactly where it was said, in the transcript.
      const label =
        skill?.aloud === false
          ? skill.label
          : stepOutcome.message?.trim() || skill?.label || stepOutcome.skill;
      void memory.record(stepOutcome.skill, label);
    }
  });
}
