/**
 * Episodic memory — turns "a command ran" into "what happened."
 *
 * Neither the engine nor a skill knows this exists; it just listens on the
 * bus, the way `Bus`'s own doc comment describes memory doing. That keeps
 * "what counts as worth remembering" in one place instead of scattered
 * through every skill that might want to log itself.
 *
 * Every step that actually reached a skill is recorded with its outcome —
 * `done`, `failed` or `declined` (see `EpisodeOutcome`) — so the history can say
 * what was attempted and what came of it instead of listing only the good news.
 * Home's Recent Activity shows `done` entries only; Settings → Activity shows
 * them all. Steps the planner refused before any skill ran are not here.
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
      const skill = skills.get(stepOutcome.skill);
      if (!stepOutcome.ok) {
        const name = skill?.label || stepOutcome.skill;
        if (stepOutcome.skipped) {
          void memory.record(`declined:${stepOutcome.skill}`, `Declined: ${name}`, {
            skill: stepOutcome.skill,
            outcome: 'declined',
          });
        } else {
          const reason = firstLine(stepOutcome.error);
          void memory.record(
            `failed:${stepOutcome.skill}`,
            reason ? `Couldn’t ${lowerFirst(name)} — ${reason}` : `Couldn’t ${lowerFirst(name)}`,
            { skill: stepOutcome.skill, outcome: 'failed' },
          );
        }
        continue;
      }
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
      void memory.record(stepOutcome.skill, label, { skill: stepOutcome.skill, outcome: 'done' });
    }
  });
}

/** The first non-empty line, trimmed to a length a timeline row can carry. */
function firstLine(text: string | undefined): string {
  const line = (text ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}
