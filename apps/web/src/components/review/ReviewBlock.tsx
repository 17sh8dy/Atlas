/**
 * What an edit changed, drawn inside the conversation: on the confirmation card BEFORE you answer,
 * and under the message that says it was done AFTER.
 *
 * The same component draws both, and what differs is only what is true:
 *
 *   · on a card, the change is `proposed`: the heading says nothing has been written, and a
 *     declined card says nothing was;
 *   · under a result, the change is `applied`: it says it was written, shows whether it is still in
 *     place, kept or put back (read from the checkpoint, not remembered), and offers Review and Undo.
 *
 * It never decides anything for you. Approving or declining is the card's own buttons; Undo only
 * acts if the file still holds what Atlas wrote.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FileReview, ReviewPayload, ReviewStatus } from '@atlas/core';
import { reviewOf } from '@atlas/engine';
import { Button, Icons, cn } from '@atlas/ui';
import { DiffView, type DiffMode } from './DiffView';
import { useReview } from './ReviewProvider';
import {
  CHANGES_EVENT,
  STATUS_WORDS,
  TONE_CLASS,
  canUndo,
  needsDecision,
  proposalHeading,
  readMode,
  summaryLine,
} from './reviewModel';

type Answer = 'yes' | 'no' | 'halted' | undefined;

/** The live status of each written change, from its checkpoint, refreshed when any change is made. */
function useLiveStatus(files: readonly FileReview[]): Record<string, ReviewStatus> {
  const { platform } = useReview();
  const [live, setLive] = useState<Record<string, ReviewStatus>>({});
  const ids = files.map((f) => f.changeId).filter((x): x is string => !!x);
  const key = ids.join(',');
  const load = useCallback(async () => {
    if (!platform?.getChange || ids.length === 0) return;
    const next: Record<string, ReviewStatus> = {};
    for (const id of ids) {
      const rec = await platform.getChange(id).catch(() => null);
      if (rec) next[id] = rec.status;
    }
    setLive(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, key]);
  useEffect(() => {
    void load();
    window.addEventListener(CHANGES_EVENT, load);
    return () => window.removeEventListener(CHANGES_EVENT, load);
  }, [load]);
  return live;
}

/** The diff of one file, loaded from its checkpoint when the card only carried counts. */
function FileDiff({ file, mode }: { file: FileReview; mode: DiffMode }) {
  const { platform } = useReview();
  const [detail, setDetail] = useState<FileReview>(file);
  useEffect(() => {
    let alive = true;
    if (file.hunks || !file.changeId || !platform?.getChange) {
      setDetail(file);
      return;
    }
    void platform.getChange(file.changeId).then((rec) => {
      if (alive && rec) setDetail(reviewOf(rec.path, rec.before, rec.after, rec.status, { changeId: rec.id }));
    });
    return () => {
      alive = false;
    };
  }, [file, platform]);
  return <DiffView file={detail} mode={mode} className="max-h-72 overflow-y-auto" />;
}

export function ReviewBlock({
  review,
  context,
  answered,
}: {
  review: ReviewPayload;
  context: 'proposal' | 'result';
  answered?: Answer;
}) {
  const { open, platform } = useReview();
  const live = useLiveStatus(review.files);
  // A proposal you have not answered yet opens with its diff showing: seeing it is the point.
  const [expanded, setExpanded] = useState<Record<number, boolean>>(
    context === 'proposal' && !answered ? { 0: true } : {},
  );
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mode = readMode();

  const statusOf = (f: FileReview): ReviewStatus => (f.changeId && live[f.changeId]) || f.status;

  const run = async (kind: 'undo' | 'keep', f: FileReview) => {
    if (!platform || !f.changeId) return;
    setBusy(true);
    setNote(null);
    try {
      const out = await (kind === 'undo' ? platform.revertChange?.(f.changeId) : platform.keepChange?.(f.changeId));
      setNote(out ? { ok: out.ok, text: out.message } : { ok: false, text: 'This build cannot do that.' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event(CHANGES_EVENT));
    }
  };

  return (
    <div className="mt-2" data-review={context}>
      <p className="text-foreground-subtle text-xs font-medium">
        {context === 'proposal' ? proposalHeading(answered) : summaryLine(review)}
      </p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {review.files.map((f, i) => {
          // On a card, what the file is: proposed, unless the answer was no.
          const status: ReviewStatus = context === 'proposal' ? 'proposed' : statusOf(f);
          const words = STATUS_WORDS[status];
          const badge = context === 'proposal' && (answered === 'no' || answered === 'halted') ? 'Not applied' : words.label;
          const tone = context === 'proposal' && (answered === 'no' || answered === 'halted') ? 'undone' : words.tone;
          const shown = !!expanded[i];
          const eff: FileReview = { ...f, status };
          return (
            <li key={`${f.path}-${i}`} className="border-border bg-background/40 rounded-lg border">
              <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
                <Icons.FilePen className="text-foreground-muted h-3.5 w-3.5 shrink-0" />
                <button
                  type="button"
                  onClick={() => setExpanded((s) => ({ ...s, [i]: !s[i] }))}
                  aria-expanded={shown}
                  title={f.path}
                  className="text-foreground min-w-0 truncate text-left text-xs font-medium hover:underline"
                >
                  {f.name}
                </button>
                <span className="text-success text-[11px] tabular-nums">+{f.added}</span>
                <span className="text-danger text-[11px] tabular-nums">−{f.removed}</span>
                <span className={cn('rounded-full border px-1.5 py-px text-[10px]', TONE_CLASS[tone])}>{badge}</span>
                <span className="ml-auto flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setExpanded((s) => ({ ...s, [i]: !s[i] }))}>
                    {shown ? 'Hide changes' : 'Show changes'}
                  </Button>
                  {context === 'result' && (
                    <Button size="sm" variant="ghost" onClick={() => open(review.files, i)}>
                      Review
                    </Button>
                  )}
                </span>
              </div>
              {shown && (
                <div className="px-2.5 pb-2">
                  <FileDiff file={eff} mode={mode} />
                </div>
              )}
              {context === 'result' && (canUndo(eff) || needsDecision(eff)) && (
                <div className="border-border flex flex-wrap gap-1 border-t px-2 py-1">
                  {needsDecision(eff) && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('keep', f)}>
                      <Icons.Check className="h-3.5 w-3.5" />
                      Keep
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy} className="text-danger" onClick={() => void run('undo', f)}>
                    <Icons.Undo2 className="h-3.5 w-3.5" />
                    Undo
                  </Button>
                </div>
              )}
              {context === 'result' && f.note && !f.changeId && (
                <p className="text-foreground-subtle border-border border-t px-2.5 py-1.5 text-[11px]">{f.note}</p>
              )}
            </li>
          );
        })}
      </ul>
      {note && (
        <p role="status" className={cn('mt-1.5 text-xs', note.ok ? 'text-success' : 'text-danger')}>
          {note.ok ? '✓ ' : '✗ '}
          {note.text}
        </p>
      )}
    </div>
  );
}
