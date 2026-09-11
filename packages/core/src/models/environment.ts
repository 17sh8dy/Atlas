/**
 * Environment variables, as the two registry keys that actually define them
 * store them — never the current process's own merged view. See
 * `environment.rs`'s module doc for why that distinction is load-bearing.
 */

export type EnvironmentScope = 'user' | 'system';

export interface EnvVar {
  name: string;
  value: string;
  scope: EnvironmentScope;
}
