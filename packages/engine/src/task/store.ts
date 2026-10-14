/**
 * Where tasks are kept: the last thirty, in Atlas's own Storage port (never anywhere else).
 */

import type { Storage, Task } from '@atlas/core';

/** Lowercase on purpose — `storage.rs` refuses anything else, silently. */
export const TASK_STORAGE_KEY = 'atlas.tasks';
const KEEP = 30;

export class TaskStore {
  constructor(private readonly storage: Storage) {}

  async list(): Promise<Task[]> {
    const raw = await this.storage.get<Task[]>(TASK_STORAGE_KEY).catch(() => undefined);
    return Array.isArray(raw) ? raw.filter((t) => t && typeof t.id === 'string' && Array.isArray(t.steps)) : [];
  }

  async save(task: Task): Promise<void> {
    const all = await this.list();
    const next = [...all.filter((t) => t.id !== task.id), structuredClone(task)]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-KEEP);
    await this.storage.set(TASK_STORAGE_KEY, next);
  }
}
