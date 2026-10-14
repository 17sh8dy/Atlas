/**
 * Skills as tool definitions, and tool calls back as skill ids.
 *
 * What a model is offered is a *description* of some of Atlas's skills, derived from the skill's
 * own text and parameter list: nothing is added, nothing is widened. What comes back is a
 * proposal that is validated against the registry like any other plan (`plan.ts`).
 *
 * Names: providers want `[A-Za-z0-9_-]{1,64}`; skill ids contain a dot (`files.createFolder`).
 * The mapping is `.` ⇄ `__` and is reversible because no skill id contains `__`.
 */

import type { ModelTool, Skill, SkillParam } from '@atlas/core';
import { rankSkills } from '../skills/router';

/** The most tools offered in one request. Past this, models choose worse and prompts get large. */
export const MAX_TOOLS = 20;
/** Enough to give a request that shares no words with any skill something to work with. */
export const MIN_TOOLS = 8;

/** The one meta-tool: "I need something that is not in this list." Answered by Atlas, not run. */
export const DISCOVERY_TOOL = 'find_capabilities';

export function toolName(skillId: string): string {
  return skillId.replace(/\./g, '__');
}

export function skillIdOfTool(name: string): string {
  return name.replace(/__/g, '.');
}

function propertyFor(p: SkillParam): Record<string, unknown> {
  const out: Record<string, unknown> = { type: p.type, description: p.description };
  if (p.enum && p.enum.length) out.enum = [...p.enum];
  return out;
}

/** One skill as one tool. The schema is exactly the skill's own declared parameters. */
export function toolFor(skill: Skill): ModelTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, param] of Object.entries(skill.params ?? {})) {
    properties[name] = propertyFor(param);
    if (param.required && param.default === undefined) required.push(name);
  }
  return {
    name: toolName(skill.id),
    description: skill.description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
  };
}

export const discoveryTool: ModelTool = {
  name: DISCOVERY_TOOL,
  description:
    'Call this when none of the other tools fit the request. Say in a few words what you need to do, and you will be given other tools to choose from.',
  parameters: {
    type: 'object',
    properties: { need: { type: 'string', description: 'What you need to be able to do, in a few words.' } },
    required: ['need'],
    additionalProperties: false,
  },
};

/**
 * The skills worth offering for a request: the best matches, at most `max`, in best-first order.
 * Deterministic and model-free (the same router that trims the text catalog).
 */
export function selectSkills(available: readonly Skill[], request: string, max = MAX_TOOLS): Skill[] {
  const ranked = rankSkills(available, request, { limit: max }).map((r) => r.skill);
  const floor = Math.min(max, MIN_TOOLS);
  if (ranked.length >= floor) return ranked.slice(0, max);
  const have = new Set(ranked.map((s) => s.id));
  const filler = available.filter((s) => !have.has(s.id)).slice(0, floor - ranked.length);
  return [...ranked, ...filler];
}

/** The tool list for a request: the selected skills, plus discovery when something was left out. */
export function toolsFor(available: readonly Skill[], selected: readonly Skill[]): ModelTool[] {
  const tools = selected.map(toolFor);
  if (selected.length < available.length) tools.push(discoveryTool);
  return tools;
}

/** A JSON Schema for a whole plan, with the skill ids limited to the ones offered. */
export function planSchema(skillIds: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      intent: { type: 'string' },
      confidence: { type: 'number' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            skill: { type: 'string', enum: [...skillIds] },
            args: { type: 'object' },
          },
          required: ['skill', 'args'],
        },
      },
    },
    required: ['intent', 'confidence', 'steps'],
  };
}
