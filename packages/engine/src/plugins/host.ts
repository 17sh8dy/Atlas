/**
 * Loading plugins: read the folders, validate each strictly, register what passed.
 *
 * Nothing here executes plugin content. A plugin that fails validation is reported and skipped (the
 * others still load), and a plugin cannot replace a template it did not add: its template ids must
 * be new, so installing one can never change what a built-in project writes.
 */

import type { Platform } from '@atlas/core';
import { allTemplates, registerTemplates, unregisterTemplates } from '../templates';
import { manifestTemplates, parseManifest } from './manifest';

export interface LoadedPlugin {
  folder: string;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  templates: Array<{ id: string; label: string; group: string }>;
}
export interface RejectedPlugin {
  folder: string;
  errors: string[];
}
export interface PluginReport {
  loaded: LoadedPlugin[];
  rejected: RejectedPlugin[];
}

const EMPTY: PluginReport = { loaded: [], rejected: [] };
let current: PluginReport = EMPTY;
let loadedSources: string[] = [];

/** The result of the last load. */
export function pluginReport(): PluginReport {
  return current;
}

export async function loadPlugins(platform: Pick<Platform, 'pluginManifests'>): Promise<PluginReport> {
  // Forget the previous load first, so removing a plugin folder really removes its templates.
  for (const source of loadedSources) unregisterTemplates(source);
  loadedSources = [];

  const report: PluginReport = { loaded: [], rejected: [] };
  let folders;
  try {
    folders = (await platform.pluginManifests?.()) ?? [];
  } catch (e) {
    report.rejected.push({ folder: '(plugins folder)', errors: [e instanceof Error ? e.message : 'The plugins folder could not be read.'] });
    current = report;
    return report;
  }

  const taken = new Set(allTemplates().map((t) => t.id));
  for (const f of folders) {
    if (f.json === null) { report.rejected.push({ folder: f.folder, errors: [f.error ?? 'Could not be read.'] }); continue; }
    const parsed = parseManifest(f.json, f.folder);
    if (!parsed.ok) { report.rejected.push({ folder: f.folder, errors: parsed.errors }); continue; }
    const { manifest } = parsed;

    const clashes = manifest.templates.filter((t) => taken.has(t.id)).map((t) => `The template id "${t.id}" is already used by something else.`);
    if (clashes.length) { report.rejected.push({ folder: f.folder, errors: clashes }); continue; }

    registerTemplates(manifestTemplates(manifest));
    manifest.templates.forEach((t) => taken.add(t.id));
    loadedSources.push(manifest.id);
    report.loaded.push({
      folder: f.folder,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      templates: manifest.templates.map((t) => ({ id: t.id, label: t.label, group: t.group })),
    });
  }
  current = report;
  return report;
}
