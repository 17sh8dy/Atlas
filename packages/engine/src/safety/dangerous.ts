/**
 * What "Do It +" still asks about, whatever else it lets through.
 *
 * Do It + exists for someone who trusts the task and wants far fewer questions: building a
 * project, writing files, running its tests, committing. It does NOT remove the stop in front of
 * the things that cannot be taken back or that leave this computer, and this file is the whole
 * list of them in one place so a reader can check it.
 *
 *   · deleting for good, and emptying a folder or the Recycle Bin;
 *   · installing, updating or uninstalling software;
 *   · publishing: `git push`, a deploy;
 *   · throwing work away: discarding changes, clearing notes, deleting a setup;
 *   · ending a process, closing a window, restarting an app or Explorer;
 *   · power: shutdown, sleep, restart;
 *   · system settings that outlive the session (environment variables);
 *   · driving another program's UI.
 *
 * The rule when a skill is not named here but sounds like one of these (its id says delete,
 * remove, erase, wipe, format, uninstall, shutdown, kill, discard, purge) is that it asks too:
 * a skill added later should fail safe, not quietly run under a mode that skips questions.
 *
 * This never softens anything else: `guard` refusals, the content policy, Allowed Folders, the
 * UI-consequence check (`Skill.assess`), a bulk skill's own preview and the emergency stop all
 * apply in Do It + exactly as they do in every other mode.
 */

import type { Skill } from '@atlas/core';

export const ALWAYS_ASK_IN_DO_IT_PLUS: ReadonlySet<string> = new Set([
  'files.delete',
  'storage.emptyFolder',
  'system.emptyRecycleBin',
  'apps.install',
  'apps.update',
  'apps.uninstall',
  'git.push',
  'git.discardChanges',
  'project.deploy',
  'notes.clear',
  'setup.delete',
  'environment.setSystem',
  'environment.deleteSystem',
  'system.endProcess',
  'window.close',
  'app.restart',
  'system.restartExplorer',
  'system.power',
  'system.sleep',
  'system.shutdownIn',
  'ui.drive',
  // Whatever the script says, the person reads all of it first, in every mode.
  'powershell.run',
]);

const SOUNDS_DESTRUCTIVE = /delete|remove|erase|wipe|format|uninstall|shutdown|kill|terminate|discard|purge/i;

/** True when Do It + must still ask before running this skill. */
export function asksEvenInDoItPlus(skill: Pick<Skill, 'id'>): boolean {
  return ALWAYS_ASK_IN_DO_IT_PLUS.has(skill.id) || SOUNDS_DESTRUCTIVE.test(skill.id);
}
