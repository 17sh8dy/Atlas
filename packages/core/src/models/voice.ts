import type { AtlasRole } from './atlas-role';

/**
 * What Atlas calls the user, and what it calls itself.
 *
 * Small on purpose — this is not the semantic-memory `Fact` store, it's the
 * handful of things that shape *how Atlas talks*, read by the phrasing layer
 * on every response. An unset field means "use the default," never an error.
 */
export interface VoiceProfile {
  /** What Atlas calls the user. Undefined = not set yet. */
  userName?: string;
  /** What Atlas calls itself. Falls back to "Atlas" wherever unset. */
  atlasName?: string;
  /** A custom first-open greeting. Falls back to a generated one. */
  greeting?: string;
  /** How Atlas presents itself — see `atlas-role.ts`. Falls back to `assistant`. */
  role?: AtlasRole;
}
