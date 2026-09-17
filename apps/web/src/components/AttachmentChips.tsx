/**
 * What is attached to the message being written, above the input.
 *
 * A chip is the honest summary of a *reference*: what it is, how big, and —
 * the part most attachment UIs leave out — whether Atlas can read it. A `.pdf`
 * says so before you send and wonder why nothing happened, rather than after.
 *
 * "Add contents" is the only thing here that reads a file, and it is a button
 * a person presses. That is the whole model: attaching points, reading is
 * asked for. See `useAttachments.ts`.
 */

import { describeAttachment, EXTRACTION_NOT_BUILT_YET, type Attachment } from '@atlas/core';
import { Icons, cn } from '@atlas/ui';

interface Props {
  items: Attachment[];
  onRemove(id: string): void;
  onExtract(id: string): void;
}

function iconFor(a: Attachment) {
  if (a.kind === 'screenshot' || a.kind === 'frame') return Icons.MonitorSmartphone;
  if (a.kind === 'image') return Icons.Sparkles;
  return Icons.FileText;
}

export function AttachmentChips({ items, onRemove, onExtract }: Props) {
  if (!items.length) return null;

  return (
    <ul className="mb-2 flex flex-wrap gap-2">
      {items.map((a) => {
        const Icon = iconFor(a);
        const detail = describeAttachment(a);
        const canExtract = a.extraction === 'available';
        const notBuilt = a.extraction === 'unsupported' && EXTRACTION_NOT_BUILT_YET.has(a.ext);

        return (
          <li
            key={a.id}
            className={cn(
              'border-border bg-surface atlas-disclose-in group flex items-center gap-2.5',
              'max-w-[18rem] rounded-lg border py-1.5 pl-1.5 pr-1',
            )}
          >
            {a.dataUrl ? (
              // The preview is the label for a capture: "Screen 1" tells you
              // which monitor, the thumbnail tells you what was on it.
              <img
                src={a.dataUrl}
                alt={a.name}
                className="border-border h-8 w-12 shrink-0 rounded border object-cover"
              />
            ) : (
              <span className="bg-surface-raised text-foreground-subtle grid h-8 w-8 shrink-0 place-items-center rounded">
                <Icon className="h-4 w-4" />
              </span>
            )}

            <span className="min-w-0 flex-1">
              <span className="text-foreground block truncate text-xs font-medium" title={a.name}>
                {a.name}
              </span>
              {detail && (
                <span
                  className={cn(
                    'block truncate text-[11px]',
                    a.extraction === 'failed' ? 'text-danger' : 'text-foreground-subtle',
                  )}
                  title={a.extractionError ?? detail}
                >
                  {a.extractionError ?? detail}
                </span>
              )}
            </span>

            {canExtract && (
              <button
                type="button"
                onClick={() => onExtract(a.id)}
                title="Read this file's text and include it"
                className={cn(
                  'text-foreground-subtle hover:text-foreground duration-fast shrink-0 rounded px-1.5 py-1',
                  'text-[11px] transition hover:bg-surface-raised',
                  'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
                )}
              >
                Add contents
              </button>
            )}
            {notBuilt && (
              <span
                className="text-foreground-subtle shrink-0 px-1 text-[11px]"
                title="No extractor for this format yet — the file is still attached as a reference."
              >
                <Icons.Info className="h-3.5 w-3.5" />
              </span>
            )}

            <button
              type="button"
              onClick={() => onRemove(a.id)}
              aria-label={`Remove ${a.name}`}
              className={cn(
                'text-foreground-subtle hover:text-foreground duration-fast grid h-6 w-6 shrink-0',
                'place-items-center rounded transition hover:bg-surface-raised',
                'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
              )}
            >
              <Icons.X className="h-3.5 w-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
