/**
 * The review panel: every file Atlas changed, what changed in it, and what you can do about it.
 *
 *   · the list on the left is "this review" (the files from the card you opened) or "recent edits"
 *     (the history Atlas keeps); each row shows the file, its +/- counts and whether the change is
 *     proposed, applied, kept or reverted;
 *   · the diff on the right is inline or side by side, coloured, with line numbers;
 *   · for a change that has been WRITTEN you can Keep it, Edit it or Undo it. Undo and Edit only act
 *     if the file still holds exactly what Atlas wrote; if you have changed it since, Atlas says so
 *     and leaves it alone;
 *   · for a change that is only PROPOSED the panel shows it and does nothing else: approving or
 *     declining is done on the card in the conversation, where it has always been done.
 *
 * Everything that touches a file goes through the same native commands (and the same Allowed
 * Folders gate) as every other edit; this panel grants nothing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeMeta, FileReview, Platform } from '@atlas/core';
import { diffText, reviewOf } from '@atlas/engine';
import { Button, Icons, Modal, SegmentedControl, cn } from '@atlas/ui';
import { DiffView, type DiffMode } from './DiffView';
import {
  CHANGES_EVENT,
  STATUS_WORDS,
  TONE_CLASS,
  canUndo,
  countsLabel,
  needsDecision,
  readMode,
  writeMode,
} from './reviewModel';

interface Props {
  platform: Platform | null;
  /** The files of the card that was opened; omitted to show the history of recent edits. */
  initial: FileReview[] | null;
  index: number;
  onClose(): void;
}

const MAX_EDIT_BYTES = 256 * 1024;

function fromMeta(m: ChangeMeta): FileReview {
  return {
    path: m.path,
    name: m.name,
    status: m.status,
    added: m.added,
    removed: m.removed,
    hunks: null,
    changeId: m.id,
    ...(m.edited ? { note: 'You edited this after Atlas wrote it.' } : {}),
  };
}

export function ReviewPanel({ platform, initial, index, onClose }: Props) {
  const [source, setSource] = useState<'review' | 'history'>(initial && initial.length ? 'review' : 'history');
  const [files, setFiles] = useState<FileReview[]>(initial ?? []);
  const [selected, setSelected] = useState(Math.min(index, Math.max(0, (initial?.length ?? 1) - 1)));
  const [detail, setDetail] = useState<FileReview | null>(null);
  const [mode, setMode] = useState<DiffMode>(readMode);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
    window.dispatchEvent(new Event(CHANGES_EVENT));
  }, []);

  // The list. "This review" refreshes each file's status from the checkpoint (it may have been undone
  // since the card was drawn); "recent edits" is the history itself.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (source === 'history') {
        const metas = (await platform?.listChanges?.(50).catch(() => [])) ?? [];
        if (alive) setFiles(metas.map(fromMeta));
        return;
      }
      const base = initial ?? [];
      const live = await Promise.all(
        base.map(async (f) => {
          if (!f.changeId || !platform?.getChange) return f;
          const rec = await platform.getChange(f.changeId).catch(() => null);
          return rec ? { ...f, status: rec.status, added: rec.added, removed: rec.removed } : f;
        }),
      );
      if (alive) setFiles(live);
    })();
    return () => {
      alive = false;
    };
  }, [source, initial, platform, tick]);

  const file = files[Math.min(selected, files.length - 1)];

  // The selected file's diff. A written change is read back from its checkpoint, so the diff shown
  // is the real one even when the card only carried counts.
  useEffect(() => {
    let alive = true;
    setEditing(null);
    if (!file) {
      setDetail(null);
      return;
    }
    void (async () => {
      if (file.changeId && platform?.getChange) {
        const rec = await platform.getChange(file.changeId).catch(() => null);
        if (rec) {
          const r = reviewOf(rec.path, rec.before, rec.after, rec.status, {
            changeId: rec.id,
            ...(rec.edited ? { note: 'You edited this after Atlas wrote it.' } : {}),
          });
          if (alive) setDetail(r);
          return;
        }
      }
      if (alive) setDetail(file);
    })();
    return () => {
      alive = false;
    };
  }, [file?.changeId, file?.path, file?.status, platform, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseMode = (m: DiffMode) => {
    setMode(m);
    writeMode(m);
  };

  const act = async (what: 'keep' | 'undo' | 'save') => {
    if (!platform || !detail?.changeId) return;
    setBusy(true);
    setMessage(null);
    try {
      let out;
      if (what === 'keep') out = await platform.keepChange?.(detail.changeId);
      else if (what === 'undo') out = await platform.revertChange?.(detail.changeId);
      else {
        const rec = await platform.getChange?.(detail.changeId);
        const text = editing ?? '';
        if (new TextEncoder().encode(text).length > MAX_EDIT_BYTES) {
          setMessage({ ok: false, text: 'That is too much text to keep a checkpoint of.' });
          return;
        }
        const d = diffText(rec?.before ?? '', text);
        out = await platform.editChange?.(detail.changeId, text, { added: d.added, removed: d.removed });
        if (out?.ok) setEditing(null);
      }
      setMessage(out ? { ok: out.ok, text: out.message } : { ok: false, text: 'This build cannot do that.' });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const startEdit = async () => {
    if (!platform?.getChange || !detail?.changeId) return;
    const rec = await platform.getChange(detail.changeId).catch(() => null);
    if (!rec) return;
    setEditing(rec.after);
    setMessage(null);
  };

  const words = detail ? STATUS_WORDS[detail.status] : null;
  const ready = useMemo(() => !!platform, [platform]);

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} label="Review changes" className="max-w-4xl">
      <div className="border-border bg-background flex max-h-[86vh] min-h-[22rem] flex-col overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <Icons.FileDiff className="text-primary h-4 w-4 shrink-0" />
          <h2 className="text-foreground text-sm font-medium">Review changes</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {initial && initial.length > 0 && (
              <SegmentedControl<'review' | 'history'>
                options={[
                  { value: 'review', label: 'This review' },
                  { value: 'history', label: 'Recent edits' },
                ]}
                value={source}
                onChange={(v) => {
                  setSource(v);
                  setSelected(0);
                  setMessage(null);
                }}
              />
            )}
            <SegmentedControl<DiffMode>
              options={[
                { value: 'inline', label: 'Inline' },
                { value: 'split', label: 'Side by side' },
              ]}
              value={mode}
              onChange={chooseMode}
            />
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close review">
              <Icons.X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {!ready ? (
          <p className="text-foreground-muted p-6 text-sm">Reviewing changes needs the Atlas desktop app.</p>
        ) : files.length === 0 ? (
          <p className="text-foreground-muted p-6 text-sm">
            {source === 'history'
              ? "Atlas hasn't edited any of your files yet, so there is nothing to review."
              : 'There are no files in this review.'}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <ul
              className="border-border max-h-40 shrink-0 overflow-y-auto border-b sm:max-h-none sm:w-60 sm:border-b-0 sm:border-r"
              aria-label="Changed files"
            >
              {files.map((f, i) => {
                const w = STATUS_WORDS[f.status];
                return (
                  <li key={`${f.changeId ?? f.path}-${i}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(i);
                        setMessage(null);
                      }}
                      aria-current={i === selected}
                      title={f.path}
                      className={cn(
                        'flex w-full flex-col gap-0.5 px-3 py-2 text-left transition',
                        i === selected ? 'bg-surface' : 'hover:bg-surface/60',
                      )}
                    >
                      <span className="text-foreground truncate text-xs font-medium">{f.name}</span>
                      <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="text-success tabular-nums">+{f.added}</span>
                        <span className="text-danger tabular-nums">−{f.removed}</span>
                        <span className={cn('rounded-full border px-1.5 py-px text-[10px]', TONE_CLASS[w.tone])}>{w.label}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              {detail && words && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-foreground min-w-0 break-all text-sm font-medium">{detail.name}</h3>
                    <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', TONE_CLASS[words.tone])}>
                      {words.label}
                    </span>
                    <span className="text-foreground-subtle text-xs tabular-nums">{countsLabel(detail)}</span>
                  </div>
                  <p className="text-foreground-subtle mt-0.5 break-all text-[11px]">{detail.path}</p>
                  <p className="text-foreground-muted mt-2 text-xs">{words.detail}</p>

                  {editing !== null ? (
                    <div className="mt-3">
                      <label className="text-foreground-subtle mb-1 block text-xs" htmlFor="review-edit">
                        Your version of {detail.name}. Undo will still restore the original.
                      </label>
                      <textarea
                        id="review-edit"
                        value={editing}
                        onChange={(e) => setEditing(e.target.value)}
                        spellCheck={false}
                        rows={14}
                        className="border-border bg-surface text-foreground w-full resize-y rounded-lg border p-2 font-mono text-[11.5px] leading-5"
                      />
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" disabled={busy} onClick={() => void act('save')}>
                          Save my edit
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <DiffView file={detail} mode={mode} className="mt-3" />
                      {detail.hunks && detail.note && <p className="text-foreground-subtle mt-2 text-xs">{detail.note}</p>}
                    </>
                  )}

                  {editing === null && detail.status === 'proposed' && (
                    <p className="text-foreground-subtle mt-3 text-xs leading-relaxed">
                      This is a proposal. Approve or decline it on the card in the conversation; nothing is written until you do.
                    </p>
                  )}

                  {editing === null && canUndo(detail) && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {needsDecision(detail) && (
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('keep')}>
                          <Icons.Check className="h-3.5 w-3.5" />
                          Keep
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void startEdit()}>
                        <Icons.Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} className="text-danger" onClick={() => void act('undo')}>
                        <Icons.Undo2 className="h-3.5 w-3.5" />
                        Undo
                      </Button>
                    </div>
                  )}

                  {message && (
                    <p role="status" aria-live="polite" className={cn('mt-3 text-xs leading-relaxed', message.ok ? 'text-success' : 'text-danger')}>
                      {message.ok ? '✓ ' : '✗ '}
                      {message.text}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
