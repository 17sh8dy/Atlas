/**
 * The event bus — how subsystems stay ignorant of each other.
 *
 * Memory doesn't know the executor exists; it listens. The UI doesn't poll the
 * engine; it subscribes. Everything interesting publishes, and whatever cares
 * picks it up. This is what keeps the engine from turning into a web of direct
 * calls where adding an observer means editing everything it observes.
 *
 * Wildcards matter more than they look: `*` is how episodic memory captures a
 * timeline of events it was never told about in advance, and `prefix:*` is how
 * a feature watches a whole domain without enumerating its events.
 */

export type BusHandler<T = unknown> = (payload: T, event: string) => void;
export type Unsubscribe = () => void;

export class Bus {
  private readonly exact = new Map<string, Set<BusHandler>>();
  private readonly prefixes = new Map<string, Set<BusHandler>>();
  private readonly all = new Set<BusHandler>();

  /**
   * @param event `"file.opened"`, `"file:*"` for a whole domain, or `"*"` for
   *              everything.
   */
  on<T = unknown>(event: string, handler: BusHandler<T>): Unsubscribe {
    const h = handler as BusHandler;

    if (event === '*') {
      this.all.add(h);
      return () => this.all.delete(h);
    }

    if (event.endsWith(':*') || event.endsWith('.*')) {
      const prefix = event.slice(0, -2);
      const set = this.prefixes.get(prefix) ?? new Set();
      set.add(h);
      this.prefixes.set(prefix, set);
      return () => set.delete(h);
    }

    const set = this.exact.get(event) ?? new Set();
    set.add(h);
    this.exact.set(event, set);
    return () => set.delete(h);
  }

  /** Subscribe, but only for the first matching event. */
  once<T = unknown>(event: string, handler: BusHandler<T>): Unsubscribe {
    const off = this.on<T>(event, (payload, name) => {
      off();
      handler(payload, name);
    });
    return off;
  }

  emit<T = unknown>(event: string, payload?: T): void {
    // A throwing subscriber must not stop the others from being told, nor
    // propagate back into whatever published the event.
    const call = (h: BusHandler) => {
      try {
        h(payload, event);
      } catch (err) {
        console.error(`[bus] handler for "${event}" threw:`, err);
      }
    };

    this.exact.get(event)?.forEach(call);

    const sep = event.includes(':') ? ':' : '.';
    const prefix = event.split(sep)[0];
    if (prefix && prefix !== event) this.prefixes.get(prefix)?.forEach(call);

    this.all.forEach(call);
  }

  /** Drop every subscription. Used between tests. */
  clear(): void {
    this.exact.clear();
    this.prefixes.clear();
    this.all.clear();
  }
}
