/**
 * Windows other than Atlas's own, and ending a process — the first group of
 * "operate the machine" skills built past Phase 11's original ten.
 *
 * Risk answers itself here almost entirely from the existing test ("does this
 * change something closing a window won't undo?"): listing, reading what's
 * focused, and moving a window around the screen are all `safe` — cosmetic,
 * instantly reversible, the same reasoning `showWindow`/`hideWindow` already
 * use for Atlas's own window. Closing a window or ending a process is
 * `confirm` — real work can be lost on the other side of either. Ending a
 * process the *session* doesn't survive losing is refused outright, via
 * `guard`, mirroring `service-skills.ts`'s `NEVER_STOP` pre-empt one layer up
 * — this list is a duplicate of `window.rs::NEVER_END` on purpose, for the
 * same reason that one is a duplicate of `services.rs`'s: this copy exists so
 * no confirmation card is ever drawn in front of a call that would then be
 * refused, and the machine's own copy, next to `TerminateProcess`, is the one
 * that actually decides.
 */

import type { Platform, ProcessEntry, ResultRow, Skill, SkillArgs, WindowEntry } from '@atlas/core';
import { resolveWindow, liveWindows } from '../text/windows';

const NEVER_END = [
  'system',
  'system idle process',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'smss.exe',
  'svchost.exe',
  'dwm.exe',
  'explorer.exe',
  'atlas-desktop.exe',
];

function windowRow(w: WindowEntry, actions?: ResultRow['actions']): ResultRow {
  return {
    title: w.title,
    subtitle: [w.processName, w.minimized ? 'minimized' : w.maximized ? 'maximized' : '', w.active ? 'active' : '']
      .filter(Boolean)
      .join(' · '),
    icon: w.active ? '🟢' : '🪟',
    payload: w,
    actions,
  };
}

/**
 * "Did you mean one of these?", the same shape every resolver in this
 * codebase offers — except two windows can share a title (two "Calculator"
 * windows, one of them the actual app and one an `ApplicationFrameHost`
 * shell), so the row's action can't re-run the skill with that title the way
 * `app.open`'s "did you mean" does. It re-invokes with the window's own `id`
 * instead, which `resolveWindow` now matches exactly — clicking a candidate
 * (or `working.resolveOrdinal` picking "the second one") lands on that exact
 * window, not whichever one a name match would have guessed.
 */
function offerWindows(
  candidates: WindowEntry[],
  query: string,
  ctx: { showResults?: (items: ResultRow[], meta?: { title?: string; subtitle?: string }) => void },
  actionFor: (entry: WindowEntry) => ResultRow['actions'],
): { ok: true; spoken: true; message: '' } {
  ctx.showResults?.(
    candidates.slice(0, 12).map((w) => windowRow(w, actionFor(w))),
    {
      title: `${candidates.length} windows match “${query}”`,
      subtitle: 'Click one, or say which.',
    },
  );
  return { ok: true, spoken: true, message: '' };
}

export function createWindowSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'window.list',
    label: 'Open windows',
    icon: '🪟',
    domain: 'system',
    description: 'List the windows currently open on the desktop.',
    needs: ['window-control'],
    risk: 'safe',
    examples: ['what windows do I have open', 'list open windows'],
    async run(_args, ctx) {
      const windows = await liveWindows(platform);
      if (!windows.length) return { ok: true, message: 'Nothing appears to be open.' };
      ctx.showResults?.(windows.map((w) => windowRow(w)), {
        title: `${windows.length} open window${windows.length === 1 ? '' : 's'}`,
      });
      return { ok: true, spoken: true, message: '' };
    },
  });

  skills.push({
    id: 'window.active',
    label: 'Active window',
    icon: '🪟',
    domain: 'system',
    description: 'Which window currently has focus.',
    needs: ['window-control'],
    risk: 'safe',
    examples: ['what window is active', "what's focused right now"],
    async run() {
      const active = (await platform.activeWindow?.()) ?? null;
      if (!active) return { ok: false, error: "I couldn't tell what's focused." };
      return { ok: true, message: `${active.title} (${active.processName}) has focus.`, data: active };
    },
  });

  /** The `{ id, entry }` a named-window skill needs, or the response to hand straight back. */
  async function targetWindow(
    query: string,
    ctx: { showResults?: (items: ResultRow[], meta?: { title?: string; subtitle?: string }) => void },
    actionFor: (entry: WindowEntry) => ResultRow['actions'],
  ): Promise<{ entry: WindowEntry } | { early: { ok: boolean; message?: string; error?: string; spoken?: true } }> {
    const match = resolveWindow(await liveWindows(platform), query);
    if (match.kind === 'none') {
      return { early: { ok: false, error: `I can't find a window called “${query}”.` } };
    }
    if (match.kind === 'many') return { early: offerWindows(match.candidates, query, ctx, actionFor) };
    return { entry: match.entry };
  }

  const namedWindowSkill = (
    id: string,
    label: string,
    verb: string,
    examples: string[],
    act: (windowId: string) => Promise<boolean> | undefined,
    done: (title: string) => string,
  ): Skill => ({
    id,
    label,
    icon: '🪟',
    domain: 'system',
    description: `${label} — a window by its title.`,
    needs: ['window-control'],
    risk: 'safe',
    examples,
    params: {
      name: { type: 'string', required: true, description: 'the window, by its title or app name' },
    },
    async run(args, ctx) {
      const query = String(args.name ?? '');
      const buttonLabel = verb.charAt(0).toUpperCase() + verb.slice(1);
      const target = await targetWindow(query, ctx, (entry) => [{ label: buttonLabel, skill: id, args: { name: entry.id } }]);
      if ('early' in target) return target.early;

      const ok = await act(target.entry.id);
      if (!ok) return { ok: false, error: `I couldn't ${verb} ${target.entry.title}.` };
      return { ok: true, message: done(target.entry.title) };
    },
  });

  skills.push(
    namedWindowSkill(
      'window.focus',
      'Focus a window',
      'focus',
      ['focus the notepad window', 'switch to discord'],
      (id) => platform.focusWindow?.(id),
      (title) => `Switched to ${title}.`,
    ),
  );
  skills.push(
    namedWindowSkill(
      'window.minimize',
      'Minimize a window',
      'minimize',
      ['minimize the notepad window'],
      (id) => platform.minimizeWindow?.(id),
      (title) => `Minimized ${title}.`,
    ),
  );
  skills.push(
    namedWindowSkill(
      'window.maximize',
      'Maximize a window',
      'maximize',
      ['maximize the notepad window'],
      (id) => platform.maximizeWindow?.(id),
      (title) => `Maximized ${title}.`,
    ),
  );
  skills.push(
    namedWindowSkill(
      'window.restore',
      'Restore a window',
      'restore',
      ['restore the notepad window'],
      (id) => platform.restoreWindow?.(id),
      (title) => `Restored ${title}.`,
    ),
  );

  skills.push({
    id: 'window.move',
    label: 'Move or resize a window',
    icon: '🪟',
    domain: 'system',
    description: 'Move and/or resize a window by its title. Any dimension left out keeps its current value.',
    needs: ['window-control'],
    risk: 'safe',
    examples: ['move the notepad window to 0, 0', 'resize the notepad window to 800 by 600'],
    params: {
      name: { type: 'string', required: true, description: 'the window, by its title or app name' },
      x: { type: 'number', description: 'left edge, in pixels' },
      y: { type: 'number', description: 'top edge, in pixels' },
      width: { type: 'number', description: 'width, in pixels' },
      height: { type: 'number', description: 'height, in pixels' },
    },
    async run(args, ctx) {
      const query = String(args.name ?? '');
      const bounds: { x?: number; y?: number; width?: number; height?: number } = {};
      if (typeof args.x === 'number') bounds.x = args.x;
      if (typeof args.y === 'number') bounds.y = args.y;
      if (typeof args.width === 'number') bounds.width = args.width;
      if (typeof args.height === 'number') bounds.height = args.height;

      const target = await targetWindow(query, ctx, (entry) => [
        { label: 'Move here', skill: 'window.move', args: { name: entry.id, ...bounds } },
      ]);
      if ('early' in target) return target.early;

      const ok = await platform.setWindowBounds?.(target.entry.id, bounds);
      if (!ok) return { ok: false, error: `I couldn't move ${target.entry.title}.` };
      return { ok: true, message: `Moved ${target.entry.title}.` };
    },
  });

  skills.push({
    id: 'window.close',
    label: 'Close a window',
    icon: '🪟',
    domain: 'system',
    description: 'Ask a window to close, by its title — the same request its own close button sends.',
    needs: ['window-control'],
    // Unsaved work on the other side of it is exactly what a closing window
    // will not undo.
    risk: 'confirm',
    examples: ['close the notepad window'],
    params: {
      name: { type: 'string', required: true, description: 'the window, by its title or app name' },
    },
    async run(args, ctx) {
      const query = String(args.name ?? '');
      const target = await targetWindow(query, ctx, (entry) => [
        { label: 'Close', skill: 'window.close', args: { name: entry.id } },
      ]);
      if ('early' in target) return target.early;

      const ok = await platform.closeWindow?.(target.entry.id);
      if (!ok) return { ok: false, error: `I couldn't close ${target.entry.title}.` };
      return { ok: true, message: `Asked ${target.entry.title} to close.` };
    },
  });

  /** What "end chrome" or "end pid 1234" is asking about. */
  function resolveProcess(
    processes: readonly ProcessEntry[],
    query: string,
  ): { kind: 'one'; entry: ProcessEntry } | { kind: 'none' } | { kind: 'many'; candidates: ProcessEntry[] } {
    const asPid = Number(query);
    if (Number.isInteger(asPid) && asPid > 0) {
      const byPid = processes.find((p) => p.pid === asPid);
      if (byPid) return { kind: 'one', entry: byPid };
    }
    const q = query.toLowerCase().replace(/\.exe$/, '').trim();
    if (!q) return { kind: 'none' };
    const exact = processes.filter((p) => p.name.toLowerCase().replace(/\.exe$/, '') === q);
    if (exact.length === 1) return { kind: 'one', entry: exact[0]! };
    if (exact.length > 1) return { kind: 'many', candidates: exact };
    const contains = processes.filter((p) => p.name.toLowerCase().includes(q));
    if (contains.length === 1) return { kind: 'one', entry: contains[0]! };
    if (!contains.length) return { kind: 'none' };
    return { kind: 'many', candidates: contains };
  }

  function guardEndingProcess(args: SkillArgs): string | null {
    const q = String(args.process ?? '').toLowerCase().replace(/\.exe$/, '').trim();
    if (!q) return null;
    const hit = NEVER_END.find((n) => n.replace(/\.exe$/, '') === q);
    if (!hit) return null;
    return "I won't end that one — this session doesn't survive losing it.";
  }

  skills.push({
    id: 'system.endProcess',
    label: 'End a process',
    icon: '⛔',
    domain: 'system',
    description: 'Force-end a running process, by name or by process id.',
    needs: ['window-control', 'processes'],
    // Unsaved work in that process is gone, and nothing about a kill is
    // reversible the way closing a window's own way still lets it decline.
    risk: 'confirm',
    guard: guardEndingProcess,
    examples: ['end chrome.exe', 'force close process 4242'],
    params: {
      process: { type: 'string', required: true, description: 'a process name or a process id' },
    },
    async run(args, ctx) {
      const query = String(args.process ?? '');
      const processes = (await platform.runningProcesses?.(200)) ?? [];
      const match = resolveProcess(processes, query);

      if (match.kind === 'none') {
        return { ok: false, error: `Nothing called “${query}” is running.` };
      }
      if (match.kind === 'many') {
        ctx.showResults?.(
          match.candidates.slice(0, 12).map((p) => ({
            title: p.name,
            subtitle: `pid ${p.pid}`,
            icon: '⛔',
            payload: p,
            actions: [{ label: 'End', skill: 'system.endProcess', args: { process: String(p.pid) } }],
          })),
          { title: `${match.candidates.length} processes match “${query}”`, subtitle: 'Click one, or say its pid.' },
        );
        return { ok: true, spoken: true, message: '' };
      }
      if (NEVER_END.includes(match.entry.name.toLowerCase())) {
        return { ok: false, error: `I won't end ${match.entry.name} — this session doesn't survive losing it.` };
      }

      const ok = await platform.endProcess?.(match.entry.pid);
      if (!ok) return { ok: false, error: `I couldn't end ${match.entry.name}.` };
      return { ok: true, message: `Ended ${match.entry.name}.` };
    },
  });

  return skills;
}
