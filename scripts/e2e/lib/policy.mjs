// What a test driver may answer to a confirmation card in the real app. The default answer is NO.
//
// A card is approved only when ALL of these hold:
//   1. no path in the card lies outside the test sandbox (a card with no path at all is allowed only if it is one
//      of the known, harmless start-up cards listed in SAFE_NO_PATH);
//   2. it does not read as destructive ("for good", "Clean N files", delete/remove/empty/wipe/uninstall/format/
//      end process/shut down/restart/sleep/power…) UNLESS the run explicitly allowed destructive actions for
//      the sandbox AND every path in the card is inside it;
//   3. it is not a card asking to ADD a folder to the allowed folders, or to change a setting, unless the run
//      said so.
// This exists because a driver once answered "yes" to everything and approved a real cleanup of the user's temp
// folder (docs/INCIDENT-2026-10-18-TEMP-CLEANUP.md). Do not loosen it to make a test pass: fix the test.

import path from 'node:path'

const DESTRUCTIVE = /\b(?:for\s+good|removed?\b|delete[ds]?\b|erase|wipe|empty(?:ing)?\s+the|uninstall|format(?:ting)?\b|end(?:ing)?\s+(?:the\s+)?process|kill|shut\s*down|restart|reboot|sleep|power\s+off|clean\s+\d[\d,]*\s+files|clean\s+up)\b/i
const ADDS_PERMISSION = /\b(?:add\s+(?:it|this\s+folder|the\s+folder)|allowed\s+folders?|allow\s+atlas|grant|permission|change\s+(?:the\s+)?setting)/i
/** Cards that start an experiment and touch nothing by themselves. */
const SAFE_NO_PATH = [/work\s+this\s+out\s+step\s+by\s+step/i]

const WIN_PATH = /[A-Za-z]:[\\/][^\s"'<>|?*]+/g
const norm = (p) => path.resolve(p).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
const inside = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(norm(parent) + '\\')

export function pathsIn(text) {
  return (String(text).match(WIN_PATH) || []).map((p) => p.replace(/[.,;:)]+$/, ''))
}

/**
 * @param {string} cardText  everything the card shows
 * @param {{ sandbox: string, allowDestructiveInSandbox?: boolean, allowPermissionCards?: boolean }} opts
 * @returns {{ answer: 'yes' | 'no', reason: string }}
 */
export function decideCard(cardText, opts) {
  const text = String(cardText)
  const paths = pathsIn(text)
  const outside = paths.filter((p) => !inside(p, opts.sandbox))
  if (outside.length) return { answer: 'no', reason: `mentions a path outside the sandbox: ${outside[0]}` }
  if (ADDS_PERMISSION.test(text) && !opts.allowPermissionCards) return { answer: 'no', reason: 'asks to widen a permission or change a setting' }
  const destructive = DESTRUCTIVE.test(text)
  if (destructive) {
    if (opts.allowDestructiveInSandbox && paths.length > 0) return { answer: 'yes', reason: 'destructive, but every path is inside the sandbox and the run allowed it' }
    return { answer: 'no', reason: 'reads as destructive' }
  }
  if (paths.length === 0 && !SAFE_NO_PATH.some((r) => r.test(text))) return { answer: 'no', reason: 'names no target, so it cannot be checked' }
  return { answer: 'yes', reason: paths.length ? 'only sandbox paths, not destructive' : 'a known start-up card' }
}
