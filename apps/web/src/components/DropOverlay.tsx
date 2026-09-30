/**
 * What appears over the chat bar while a file is being dragged across it.
 *
 * It is only ever rendered while that is true — the composer mounts it on
 * `useFileDrop().active` and at no other time, so there is nothing to find,
 * hover or tab to when no drag is under way. It never takes the pointer, so it
 * cannot intercept the drop it is announcing.
 */

import { Icons } from '@atlas/ui';

export function DropOverlay({ count }: { count: number }) {
  return (
    <div
      role="status"
      className="border-primary bg-background/85 pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed backdrop-blur-sm"
    >
      <Icons.Plus className="text-primary h-4 w-4" />
      <span className="text-foreground text-sm font-medium">
        {count > 1 ? `Drop to attach ${count} files` : 'Drop to attach'}
      </span>
    </div>
  );
}
