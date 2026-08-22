/**
 * Windows services, as Atlas is allowed to see and change them.
 *
 * Unlike `network.ts`, this model describes something that can be *changed* —
 * so it carries the one field a read-only model never needs: `protected`. A
 * service Atlas will refuse to stop says so in its own data, which means the
 * UI can decline to offer the action rather than offering it and then
 * apologising.
 */

export type ServiceAction = 'start' | 'stop' | 'restart';

export interface ServiceEntry {
  /** The short name Windows takes: "Spooler". */
  name: string;
  /** The name a person recognises: "Print Spooler". */
  display: string;
  /** "RUNNING", "STOPPED", "START_PENDING"… as Windows reports it. */
  state: string;
  running: boolean;
  /**
   * True for services Atlas will never stop, at any risk tier.
   *
   * Not "important" — plenty of important services are fine to restart. This
   * marks the ones where stopping takes the session down with it and the way
   * back is the power button.
   */
  protected: boolean;
}

export interface ServiceDetail extends ServiceEntry {
  /** "automatic", "automatic (delayed)", "manual", "disabled", "at boot". */
  startType?: string;
  /** What actually runs. Shown, never used to build a command. */
  binary?: string;
}

export interface ServiceOutcome {
  name: string;
  display: string;
  /**
   * The state observed after the action settled — not what the command
   * claimed. Windows returns from "start" while the service is still coming
   * up, and a service that fails to start returns success from the request
   * that asked it to.
   */
  state: string;
  running: boolean;
  /** Set when nothing needed doing: "It was already running." */
  note?: string;
}
