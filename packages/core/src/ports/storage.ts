/**
 * The storage port — small, JSON-serialisable, namespaced key/value
 * persistence for Atlas's own settings and preferences.
 *
 * Deliberately minimal: this is not a database and not a file index. It's the
 * same shape as `localStorage`, made async so a desktop implementation can
 * write to the app's own data directory instead of the page. Keys follow the
 * dot-namespaced convention already used elsewhere in the app (`atlas.theme`)
 * — e.g. `atlas.preferences`, `atlas.settings.notificationsEnabled`.
 *
 * A missing key is `undefined`, not an error — callers supply their own
 * defaults, the same way `localStorage.getItem` does.
 */
export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}
