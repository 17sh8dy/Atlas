/**
 * Saved setups — "recording", "streaming", "work" — in Atlas's own storage.
 *
 * Keeps a synchronous copy in memory once loaded, because two places need to
 * read it without awaiting: `setup.run`'s `clarify` hook (which offers the
 * saved names when someone says just "get my PC ready") is synchronous by
 * contract, and so is the Settings list's first paint. Reading Atlas's own
 * saved data is not "asking the machine" — it is the same kind of read as a
 * preference.
 */

import type { Setup, SetupItem, Storage } from '@atlas/core';
import { setupKey } from './spec';

export const SETUPS_KEY = 'atlas.setups';

type Listener = (setups: readonly Setup[]) => void;

export class SetupStore {
  private setups: Setup[] = [];
  private loaded: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly storage: Storage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  load(): Promise<void> {
    this.loaded ??= this.storage
      .get<Setup[]>(SETUPS_KEY)
      .then((stored) => {
        this.setups = Array.isArray(stored)
          ? stored.filter((s) => s && typeof s.name === 'string')
          : [];
        this.emit();
      })
      .catch(() => undefined);
    return this.loaded;
  }

  /** Synchronous: whatever has loaded so far. */
  all(): readonly Setup[] {
    return this.setups;
  }

  names(): string[] {
    return this.setups.map((s) => s.name);
  }

  /** By the name a person uses — "my recording setup" finds "recording". */
  get(name: string): Setup | undefined {
    const key = setupKey(name);
    return (
      this.setups.find((s) => s.name === key) ??
      // "record" / "recording", "stream" / "streaming".
      this.setups.find((s) => s.name.replace(/ing$/, '') === key.replace(/ing$/, ''))
    );
  }

  async save(name: string, items: SetupItem[]): Promise<Setup> {
    await this.load();
    const key = setupKey(name);
    const now = this.now();
    const existing = this.setups.find((s) => s.name === key);
    const setup: Setup = existing
      ? { ...existing, items, updatedAt: now }
      : { name: key, items, createdAt: now, updatedAt: now };
    this.setups = [setup, ...this.setups.filter((s) => s.name !== key)];
    await this.persist();
    return setup;
  }

  async recordRun(name: string, report: string): Promise<void> {
    const setup = this.get(name);
    if (!setup) return;
    setup.lastRunAt = this.now();
    setup.lastReport = report;
    await this.persist();
  }

  async remove(name: string): Promise<boolean> {
    await this.load();
    const setup = this.get(name);
    if (!setup) return false;
    this.setups = this.setups.filter((s) => s !== setup);
    await this.persist();
    return true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.setups);
    return () => this.listeners.delete(listener);
  }

  private async persist(): Promise<void> {
    await this.storage.set(SETUPS_KEY, this.setups);
    this.emit();
  }

  private emit(): void {
    const view = [...this.setups];
    for (const l of this.listeners) l(view);
  }
}
