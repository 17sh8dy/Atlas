/**
 * Game engines found on this PC, and the plugin folders Atlas reads. Plain data shapes the engine
 * and the native side share; see `apps/desktop/src-tauri/src/engines.rs`.
 */

export type EngineKind = 'unreal' | 'unity' | 'godot' | 'blender';

/** One game engine editor that really exists on disk. */
export interface EngineInfo {
  kind: EngineKind;
  /** "5.7", "6000.0.23f1", "4.3" */
  version: string;
  /** The install folder (Unreal, Unity) or the folder holding the executable (Godot). */
  path: string;
  /** The editor executable. */
  editor: string;
}

/** One folder under Atlas's plugins folder, with its plugin.json text unparsed. */
export interface PluginFolder {
  folder: string;
  json: string | null;
  error: string | null;
}
