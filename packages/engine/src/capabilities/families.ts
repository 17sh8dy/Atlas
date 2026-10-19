/**
 * Families: the coarse shelves Atlas's capabilities sit on.
 *
 * A model shown 330 tool descriptions drowns; a model shown "files, apps, terminal, web…" and then the few
 * tools of the shelf that matters does not. `CapabilityIndex` uses families for progressive disclosure:
 * rank the families first, then rank capabilities inside the best ones.
 *
 * Assignment is by domain and id prefix, from one table. An unknown domain lands in `other` rather than
 * being dropped, so a skill added tomorrow is retrievable the day it is registered.
 */

import type { Skill } from '@atlas/core';

export type FamilyId =
  | 'files'
  | 'apps'
  | 'windows-ui'
  | 'terminal-dev'
  | 'web'
  | 'system'
  | 'network'
  | 'media'
  | 'text-math'
  | 'memory-tasks'
  | 'atlas'
  | 'other';

export interface Family {
  id: FamilyId;
  label: string;
  /** One sentence a model (or a person) can use to decide whether this shelf is the one. */
  summary: string;
}

export const FAMILIES: readonly Family[] = [
  { id: 'files', label: 'Files and folders', summary: 'Find, read, create, copy, move, rename, organize, compare, archive and clean up files and folders.' },
  { id: 'apps', label: 'Applications', summary: 'Discover, launch, restart and close installed programs; install and update them.' },
  { id: 'windows-ui', label: 'Windows and UI', summary: 'List, focus, move and close windows; read and operate on-screen controls; keyboard, mouse and screenshots.' },
  { id: 'terminal-dev', label: 'Terminal and development', summary: 'Run commands, terminals, git, builds, tests, dependencies, project inspection and code edits.' },
  { id: 'web', label: 'Web and research', summary: 'Open sites, search the web, read pages and research a question.' },
  { id: 'system', label: 'System and settings', summary: 'Hardware, processes, services, power, display, audio, environment, drivers and Windows settings.' },
  { id: 'network', label: 'Network', summary: 'Connectivity, adapters, Wi-Fi, ping, speed and what is using the network.' },
  { id: 'media', label: 'Media', summary: 'Convert, trim, inspect and play audio, video and images.' },
  { id: 'text-math', label: 'Text, math and utilities', summary: 'Calculate, convert units, transform text, generate values, dates and times.' },
  { id: 'memory-tasks', label: 'Reminders, notes and tasks', summary: 'Notes, reminders, timers, routines, watches, saved setups, tasks and workflows.' },
  { id: 'atlas', label: 'Atlas itself', summary: 'Atlas’s own settings, plugins, self-check and diagnostics.' },
  { id: 'other', label: 'Other', summary: 'Anything that does not fit another shelf.' },
];

/** domain (or id prefix) → family. First match wins; checked on the id prefix, then the domain. */
const BY_PREFIX: readonly [RegExp, FamilyId][] = [
  [/^(?:files|storage|cleanup|archive|recycle)\b/, 'files'],
  [/^(?:app|apps)\b/, 'apps'],
  [/^(?:window|uia|input|kbm|screen|ui)\b/, 'windows-ui'],
  [/^(?:powershell|git|project|build|test|code|dependency|script|devagent|builder|dev|terminal)\b/, 'terminal-dev'],
  [/^(?:web|research|docs|knowledge)\b/, 'web'],
  [/^(?:net|network|ping|wifi)\b/, 'network'],
  [/^(?:media)\b/, 'media'],
  [/^(?:text|math|util|time|units|calc|convert)\b/, 'text-math'],
  [/^(?:notes|todo|reminder|routine|watch|task|setup|workflow|memory|clipboard|notify|mail|calendar|stopwatch|timer|alarm)\b/, 'memory-tasks'],
  [/^(?:atlas|engine|plugin|diagnostics|security|selftest)\b/, 'atlas'],
  [/^(?:system|os|service|environment|registry|settings|power|display|audio)\b/, 'system'],
];

export function familyOf(skill: Pick<Skill, 'id' | 'domain'>): FamilyId {
  const prefix = skill.id.split('.')[0] ?? '';
  for (const [re, family] of BY_PREFIX) if (re.test(prefix)) return family;
  for (const [re, family] of BY_PREFIX) if (re.test(skill.domain)) return family;
  return 'other';
}

export function familyInfo(id: FamilyId): Family {
  return FAMILIES.find((f) => f.id === id) ?? FAMILIES[FAMILIES.length - 1]!;
}
