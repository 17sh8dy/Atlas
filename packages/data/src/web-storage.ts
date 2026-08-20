/**
 * The browser implementation of the `Storage` port — a thin, JSON-serialising
 * wrapper over `localStorage`, so the web build behaves the same as the
 * desktop one without needing anywhere else to persist to.
 */

import type { Storage } from '@atlas/core';

export function createWebStorage(): Storage {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const raw = localStorage.getItem(key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        // Pre-existing unquoted values (if any ever land under a shared key)
        // stay readable instead of silently vanishing.
        return raw as unknown as T;
      }
    },

    async set<T>(key: string, value: T): Promise<void> {
      localStorage.setItem(key, JSON.stringify(value));
    },

    async remove(key: string): Promise<void> {
      localStorage.removeItem(key);
    },
  };
}
