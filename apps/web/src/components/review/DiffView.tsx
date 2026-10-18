/**
 * A diff, drawn: green for what was added, red for what was removed, line numbers for both sides,
 * in one column (inline) or two (side by side), with syntax colour where the file type is known.
 *
 * It draws what it is given and nothing else. The hunks come from the diff engine, the text is
 * rendered as text (never as HTML), and whitespace is kept exactly, so what is on screen is what is
 * in the file.
 */

import type { DiffLine, FileReview } from '@atlas/core';
import { cn } from '@atlas/ui';
import { highlightLine, languageOf, TOKEN_CLASS, type Lang } from './highlight';
import { hunkHeader, splitRows } from './diffRows';

export type DiffMode = 'inline' | 'split';

function Code({ text, lang }: { text: string; lang: Lang }) {
  const tokens = highlightLine(text, lang);
  return (
    <span className="whitespace-pre">
      {tokens.map((t, i) => (
        <span key={i} className={TOKEN_CLASS[t.kind]}>
          {t.text}
        </span>
      ))}
      {/* An empty line still takes up a line. */}
      {text === '' ? ' ' : ''}
    </span>
  );
}

const ROW: Record<DiffLine['kind'], string> = {
  add: 'bg-success/15',
  remove: 'bg-danger/15',
  context: '',
};
const MARK: Record<DiffLine['kind'], { glyph: string; className: string; label: string }> = {
  add: { glyph: '+', className: 'text-success', label: 'added' },
  remove: { glyph: '−', className: 'text-danger', label: 'removed' },
  context: { glyph: ' ', className: '', label: 'unchanged' },
};

function Gutter({ n }: { n: number | undefined }) {
  return (
    <span className="text-foreground-subtle w-9 shrink-0 select-none pr-2 text-right tabular-nums" aria-hidden="true">
      {n ?? ''}
    </span>
  );
}

function InlineRow({ line, lang }: { line: DiffLine; lang: Lang }) {
  const m = MARK[line.kind];
  return (
    <div className={cn('flex min-w-max', ROW[line.kind])} data-kind={line.kind}>
      <Gutter n={line.oldNo} />
      <Gutter n={line.newNo} />
      <span className={cn('w-4 shrink-0 select-none text-center', m.className)}>
        <span aria-hidden="true">{m.glyph}</span>
        <span className="sr-only">{m.label}</span>
      </span>
      <Code text={line.text} lang={lang} />
    </div>
  );
}

function Cell({ line, side, lang }: { line: DiffLine | undefined; side: 'left' | 'right'; lang: Lang }) {
  if (!line) return <div className="bg-surface/60 min-h-5 flex-1" aria-hidden="true" />;
  const m = MARK[line.kind];
  return (
    <div className={cn('flex min-w-0 flex-1', ROW[line.kind])} data-kind={line.kind}>
      <Gutter n={side === 'left' ? line.oldNo : line.newNo} />
      <span className={cn('w-4 shrink-0 select-none text-center', m.className)}>
        <span aria-hidden="true">{line.kind === 'context' ? ' ' : m.glyph}</span>
        <span className="sr-only">{m.label}</span>
      </span>
      <Code text={line.text} lang={lang} />
    </div>
  );
}

export function DiffView({ file, mode, className }: { file: FileReview; mode: DiffMode; className?: string }) {
  const lang = languageOf(file.path);
  if (!file.hunks) {
    return (
      <p className={cn('text-foreground-subtle px-3 py-3 text-xs leading-relaxed', className)}>
        {file.note ?? 'The lines are not shown for this change.'}
      </p>
    );
  }
  if (file.hunks.length === 0) {
    return (
      <p className={cn('text-foreground-subtle px-3 py-3 text-xs leading-relaxed', className)}>
        {file.note ?? 'No lines differ.'}
      </p>
    );
  }
  return (
    <div
      className={cn('border-border bg-background/40 overflow-x-auto rounded-lg border font-mono text-[11.5px] leading-5', className)}
      role="group"
      aria-label={`Changes to ${file.name}, ${mode === 'split' ? 'side by side' : 'inline'}`}
    >
      {file.hunks.map((h, hi) => (
        <div key={hi} className={cn(hi > 0 && 'border-border border-t')}>
          <div className="bg-surface text-foreground-subtle select-none px-2 py-0.5 text-[10.5px]">{hunkHeader(h)}</div>
          {mode === 'inline'
            ? h.lines.map((l, li) => <InlineRow key={li} line={l} lang={lang} />)
            : splitRows(h.lines).map((r, ri) => (
                <div key={ri} className="divide-border flex min-w-[36rem] divide-x">
                  <Cell line={r.left} side="left" lang={lang} />
                  <Cell line={r.right} side="right" lang={lang} />
                </div>
              ))}
        </div>
      ))}
    </div>
  );
}
