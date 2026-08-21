/**
 * What Atlas is doing right now, as data.
 *
 * The engine already decides, tier by tier, how much machinery a request
 * needs — grammar for most things, an external model only when nothing local
 * can answer. Until now that decision was invisible: every request, whether it
 * opened an app in 40ms or waited four seconds on a network round trip, showed
 * the same "Working…". A user watching a blank pause has no way to tell a slow
 * answer from a stuck one.
 *
 * This module gives the escalation a voice. The engine emits a stage whenever
 * the kind of work changes, and the surface renders it however it likes.
 *
 * Two deliberate choices:
 *
 * 1. The engine emits STAGES, not durations or animations. How long
 *    "Switching models" stays on screen is a presentation question, and the
 *    engine renders nothing — a surface that wants a minimum display time so
 *    the label does not flash can enforce that itself, and a test can ignore
 *    it entirely.
 *
 * 2. The label is carried WITH the stage rather than looked up by the surface.
 *    Response text belongs to `phrasing.ts`, so that a personalised Atlas
 *    speaks consistently everywhere; having the UI keep its own copy of these
 *    strings is exactly the drift `phrasing` exists to prevent.
 */

/**
 * The kinds of work worth telling someone about.
 *
 * Anything the engine finishes in a few milliseconds is deliberately absent:
 * a stage that appears and vanishes within one frame is noise, not feedback.
 */
export type EngineStage =
  /** Local, deterministic work — a skill running, a plan executing. */
  | 'working'
  /** Reaching out to the web for current information. */
  | 'searching'
  /** Handing the request over to an intelligence provider. */
  | 'switching'
  /** The provider has the request and is generating an answer. */
  | 'thinking';

export interface EngineStatus {
  stage: EngineStage;
  /** Ready to render. Comes from `phrasing`, never assembled by the surface. */
  label: string;
  /**
   * Which provider is involved, when one is. Lets a surface show an icon or a
   * name without having to parse the label.
   */
  providerId?: string;
  /**
   * True when the provider runs on this machine. A surface may want to say so
   * — "switching to a model that sends nothing anywhere" is worth different
   * treatment from a call to someone else's server.
   */
  local?: boolean;
}
