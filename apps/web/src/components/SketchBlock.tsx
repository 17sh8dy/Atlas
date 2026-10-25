/**
 * A drawing the connected model wrote as SVG, shown in the conversation.
 *
 * Shown ONLY as an image: the sanitised text becomes the source of an `<img>`, which cannot run script
 * or load anything from outside, so even a flaw in the sanitiser could not turn a drawing into code in
 * this page. It is sanitised again here (the saved conversation is read back from disk, and nothing read
 * back is assumed to be what was once checked). The note is always visible and cannot be dismissed: how
 * good a drawing looks depends on the model, and Atlas does not pretend otherwise.
 */

import { useMemo } from 'react';
import type { SketchPayload } from '@atlas/core';
import { sanitizeSvg, svgDataUrl } from '@atlas/engine';
import { Button } from '@atlas/ui';

interface Props {
  sketch: SketchPayload;
  onSave(svg: string, name: string): void;
  onCopy(text: string): Promise<boolean>;
}

export function SketchBlock({ sketch, onSave, onCopy }: Props) {
  const checked = useMemo(() => sanitizeSvg(sketch.svg), [sketch.svg]);
  if (!checked.ok) {
    return (
      <p className="text-foreground-muted mt-2 text-sm">
        This drawing could not be shown safely, so it was dropped.
      </p>
    );
  }
  return (
    <figure className="mt-3 max-w-sm">
      <img
        src={svgDataUrl(checked.svg)}
        alt={sketch.subject ? `Sketch of ${sketch.subject}` : 'Sketch'}
        className="border-border bg-surface aspect-square w-full rounded-lg border"
        draggable={false}
      />
      <figcaption className="text-foreground-muted mt-2 text-xs leading-relaxed">
        {sketch.note}
      </figcaption>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onSave(checked.svg, sketch.subject ?? '')}
        >
          Save as SVG
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onCopy(checked.svg)}>
          Copy SVG
        </Button>
      </div>
    </figure>
  );
}
