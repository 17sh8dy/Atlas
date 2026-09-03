import type { SVGProps } from 'react';

/**
 * The Atlas mark — a diamond split at its vertical centre, outline on the
 * left, solid on the right. Round corner joins throughout.
 *
 * Traced from `design/logo/atlas-mark.svg` (320×384, the canonical 5:6
 * width:height ratio — see `design/logo/README.md` for the full spec:
 * per-size stroke weights, tile colours, clear space). `currentColor` drives
 * both fill and stroke, so it inherits whatever text color its container
 * sets — the same convention `Icons.*` already follows, which is what makes
 * it a drop-in replacement for the placeholder `Icons.Compass` it replaces.
 */
export function AtlasMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 320 384" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M160 0 L320 192 L160 384 L0 192 Z"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinejoin="round"
      />
      <path d="M160 0 L320 192 L160 384 Z" fill="currentColor" />
    </svg>
  );
}
