/**
 * Which Windows this is. Informational only — see `compat.rs`'s doc comment
 * for why nothing in this build actually gates a capability on it.
 */
export interface WindowsCompatibility {
  /** "Windows 11 Pro", as Windows itself names it. */
  productName: string;
  /** "23H2" — absent on builds old enough not to have one. */
  displayVersion?: string;
  /** The build number as text, e.g. "22631". */
  build: string;
  /** The update-revision suffix — "22631.**3737**". */
  ubr?: number;
  /** The same build number as a plain integer, for comparison. */
  buildNumber: number;
}
