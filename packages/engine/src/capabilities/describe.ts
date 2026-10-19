/**
 * What each capability IS, as a plain readable record — derived, not hand-written.
 *
 * Every `Skill` already declares most of what a capability description needs: an id, a description, typed
 * parameters, a risk, the host capabilities it needs, optional guard / preview / assess / verify hooks.
 * This module reads those and adds the few things the skill cannot say about itself (a family, an advisory
 * time limit, what usually goes wrong), so the roughly 330 existing tools are described without touching
 * one of them. It is an ADAPTER: removing it changes nothing about how any skill runs.
 *
 * Honesty rules the tests hold:
 *   · a field is only `read-back` verified if the skill (or the verify table) really declares a read-back;
 *   · a time limit is only marked enforced where the code that enforces it is known; everything else is
 *     said to be advisory, never implied to be a guarantee;
 *   · availability comes from the registry's own check, with the reason, not from a guess.
 */

import type { FailureKind, Skill, SkillParam } from '@atlas/core';
import { VERIFY_DECLARATIONS } from '../verify/declarations';
import { asksEvenInDoItPlus } from '../safety/dangerous';
import type { SkillRegistry } from '../skills/registry';
import { familyOf, type FamilyId } from './families';

export interface InputField {
  name: string;
  type: SkillParam['type'];
  required: boolean;
  description: string;
  enum?: readonly string[];
  default?: unknown;
}

export interface CapabilityDescriptor {
  id: string;
  label: string;
  description: string;
  family: FamilyId;
  domain: string;
  /** The verb(s) this capability performs: the id's own name, split into words ("batchRename" → batch, rename). */
  operations: string[];
  input: InputField[];
  /** Every skill answers with the same envelope; `shape` says what its payload usually is, when known. */
  output: { envelope: 'ok/message/error/data'; reportsData: boolean; undoable: false | 'declared' | 'on-result' };
  permissions: {
    /** Host capabilities required (a build that lacks one hides the skill). */
    needs: string[];
    risk: 'safe' | 'confirm';
    /** The risk is decided per call (`riskFor`), so the value above is the usual one, not the only one. */
    variesWithArguments: boolean;
    /** Still asks in Do It + (deleting, uninstalling…). */
    alwaysAsks: boolean;
    /** Takes a path or folder argument, so Allowed Folders apply. */
    touchesFiles: boolean;
  };
  execution: {
    /** Shows what it will do before it does it. */
    previews: boolean;
    /** Has its own veto, checked in the registry before running. */
    guarded: boolean;
    /** Looks at its target before a card is drawn. */
    assesses: boolean;
    /** Needs elevation to do its job. */
    elevated: boolean;
  };
  availability: { available: boolean; reason?: string };
  timeout: { ms: number; enforced: boolean };
  /** The failure kinds this capability's results are classified into (the shared taxonomy). */
  failures: readonly FailureKind[];
  verification: 'read-back' | 'result-only';
  examples: string[];
}

const PATH_PARAM = /^(?:path|file|folder|dir|directory|cwd|source|destination|target|from|to|root|archive|output)$/i;

/**
 * Advisory limits by what kind of work the capability does. Only `powershell.run` is known to be bounded
 * where it runs (its own 60 s limit, in Rust), so only it is marked enforced.
 */
const TIMEOUTS: readonly [RegExp, number][] = [
  [/^powershell\./, 60_000],
  [/^(?:build|test|dependency|script|devagent|builder|app\.scaffold)\b/, 300_000],
  [/^(?:git\.(?:push|pull|clone))/, 120_000],
  [/^(?:research|docs|web\.search|net\.|network\.)/, 30_000],
  [/^(?:media|files\.(?:zip|unzip|duplicates|searchContent|organize))/, 120_000],
  [/^(?:uia|input|window|kbm|screen)\./, 15_000],
];
const ENFORCED = new Set(['powershell.run']);

function timeoutFor(id: string): { ms: number; enforced: boolean } {
  const hit = TIMEOUTS.find(([re]) => re.test(id));
  return { ms: hit ? hit[1] : 30_000, enforced: ENFORCED.has(id) };
}

/** What usually goes wrong, by what the capability does. A guide to recovery, not a promise. */
function failuresFor(skill: Skill, touchesFiles: boolean): readonly FailureKind[] {
  const kinds: FailureKind[] = ['unknown'];
  if (touchesFiles) kinds.push('not-found', 'permission');
  if (skill.risk === 'confirm') kinds.push('declined', 'refused');
  if (skill.guard || skill.assess) kinds.push('refused');
  if (/^(?:app|window|uia|input|kbm|screen|service|process)\b/.test(skill.id)) kinds.push('not-found', 'busy');
  if (/^(?:web|research|docs|net|network|git\.(?:push|pull))/.test(skill.id)) kinds.push('unavailable', 'timeout');
  if (/^(?:build|test|dependency|script|powershell)\b/.test(skill.id)) kinds.push('timeout');
  if (Object.values(skill.params ?? {}).some((p) => p.required)) kinds.push('invalid');
  kinds.push('halted');
  return [...new Set(kinds)];
}

/** "batchRename" → ["batch", "rename"]; "files.find" → ["find"]. */
export function operationsOf(id: string): string[] {
  const name = id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function describeSkill(skill: Skill, registry?: SkillRegistry): CapabilityDescriptor {
  const input: InputField[] = Object.entries(skill.params ?? {}).map(([name, p]) => ({
    name,
    type: p.type,
    required: Boolean(p.required),
    description: p.description,
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
  }));
  const touchesFiles = input.some((f) => PATH_PARAM.test(f.name));
  const available = registry ? registry.isAvailable(skill) : true;
  const missing = (skill.needs ?? []).join(', ');
  const verified = Boolean(skill.verify) || Object.prototype.hasOwnProperty.call(VERIFY_DECLARATIONS, skill.id);
  return {
    id: skill.id,
    label: skill.label,
    description: skill.description,
    family: familyOf(skill),
    domain: skill.domain,
    operations: operationsOf(skill.id),
    input,
    output: {
      envelope: 'ok/message/error/data',
      reportsData: /list|find|search|info|status|read|tree|scan|compare|detect|inspect|show|get/i.test(skill.id),
      undoable: skill.risk === 'confirm' && /write|edit|move|rename|organize|recolor|replace|undo/i.test(skill.id) ? 'on-result' : false,
    },
    permissions: {
      needs: [...(skill.needs ?? [])],
      risk: skill.risk ?? 'safe',
      variesWithArguments: Boolean(skill.riskFor),
      alwaysAsks: asksEvenInDoItPlus(skill),
      touchesFiles,
    },
    execution: {
      previews: Boolean(skill.preview),
      guarded: Boolean(skill.guard),
      assesses: Boolean(skill.assess),
      elevated: /^app\.runAsAdmin|^elevation\.|^system\.(?:services?|registry)\b/.test(skill.id) || /admin|elevat/i.test(skill.description.slice(0, 120)),
    },
    availability: available ? { available: true } : { available: false, reason: `needs ${missing || 'a capability this build lacks'}` },
    timeout: timeoutFor(skill.id),
    failures: failuresFor(skill, touchesFiles),
    verification: verified ? 'read-back' : 'result-only',
    examples: [...(skill.examples ?? [])],
  };
}
