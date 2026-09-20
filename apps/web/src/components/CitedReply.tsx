/**
 * An answer with its sources beside the words they support.
 *
 * ── What it renders ─────────────────────────────────────────────────────────
 * `… season 4 [2] …` becomes the sentence with a small numbered link where the
 * `[2]` was; a click opens that source. Under the answer, the engine's own
 * Sources footer becomes a compact list — same facts, now clickable — with the
 * source check ("4 independent sites agree") kept visible.
 *
 * ── Why a link only ever comes from the engine's footer ─────────────────────
 * A marker is a link only when the footer has a source with that number, and
 * the address is the footer's. The model's prose is never parsed for URLs, so
 * a model that invents `[7]`, or writes a link of its own, produces a plain
 * marker or plain text — never something clickable it chose.
 *
 * ── Streaming ───────────────────────────────────────────────────────────────
 * The same component draws a reply while it is still arriving, with a caret at
 * the end. The footer appears when the reply finishes, at which point markers
 * that were plain during streaming become links. It does not animate: the words
 * arriving *are* the animation, and replaying a reveal over a finished stream
 * would draw the same answer twice.
 */

import { useMemo } from 'react';
import { cn } from '@atlas/ui';
import { parseAnswer, segmentCitations, type Source } from './citations';

export function CitedReply({
  text,
  streaming = false,
  onOpen,
}: {
  text: string;
  streaming?: boolean;
  onOpen(url: string): void;
}) {
  const parsed = useMemo(() => parseAnswer(text), [text]);
  const byNumber = useMemo(
    () => new Map(parsed.sources.map((s) => [s.n, s] as const)),
    [parsed.sources],
  );
  const segments = useMemo(() => segmentCitations(parsed.body), [parsed.body]);

  return (
    <>
      {segments.map((segment, i) =>
        segment.type === 'text' ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <Cite key={i} n={segment.n} source={byNumber.get(segment.n)} onOpen={onOpen} />
        ),
      )}
      {streaming && (
        <span
          aria-hidden="true"
          className="bg-foreground-subtle ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] motion-safe:animate-pulse"
        />
      )}
      {parsed.sources.length > 0 && (
        <SourceList
          heading={parsed.heading}
          sources={parsed.sources}
          notes={parsed.notes}
          onOpen={onOpen}
        />
      )}
    </>
  );
}

const PILL =
  'mx-0.5 inline-flex h-[1.15em] min-w-[1.15em] -translate-y-[0.12em] items-center justify-center rounded-full px-1 align-baseline text-[0.7em] font-medium leading-none';

function Cite({
  n,
  source,
  onOpen,
}: {
  n: number;
  source: Source | undefined;
  onOpen(url: string): void;
}) {
  // No matching source: a plain marker, not a link to nowhere.
  if (!source) {
    return <span className={cn(PILL, 'bg-surface text-foreground-subtle')}>{n}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(source.url)}
      title={`${source.title} — ${source.host}`}
      aria-label={`Source ${n}: ${source.title}, ${source.host}`}
      className={cn(
        PILL,
        'bg-primary/15 text-primary hover:bg-primary/30 duration-fast cursor-pointer transition',
        'focus-visible:outline-primary focus-visible:outline focus-visible:outline-2',
      )}
    >
      {n}
    </button>
  );
}

function SourceList({
  heading,
  sources,
  notes,
  onOpen,
}: {
  heading: string;
  sources: Source[];
  notes: string[];
  onOpen(url: string): void;
}) {
  return (
    <div className="border-border text-foreground-subtle mt-3 border-t pt-2 text-xs leading-relaxed">
      <p className="mb-1">{heading.replace(/:\s*$/, '')}</p>
      <ul className="flex flex-col gap-0.5">
        {sources.map((s) => (
          <li key={s.n} className="flex min-w-0 gap-2">
            <span className="text-primary w-4 shrink-0 text-right tabular-nums">{s.n}</span>
            <button
              type="button"
              onClick={() => onOpen(s.url)}
              title={s.url}
              className="hover:text-foreground min-w-0 cursor-pointer truncate text-left underline-offset-2 hover:underline"
            >
              <span className="text-foreground-muted">{s.host}</span>
              <span> — {s.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {notes.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {notes.map((n, i) => (
            <li key={i}>· {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
