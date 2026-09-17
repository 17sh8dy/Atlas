/**
 * A reply arriving on screen — word by word, letter by letter, a fade, or not
 * at all, per Personalization → Text & colors.
 *
 * ── Only for what is new ────────────────────────────────────────────────────
 * The parent decides `animate`, and only ever for an entry that just arrived:
 * a transcript restored at launch, or scrolled back through, is already read
 * and appears as it is. Reduced motion turns it off regardless.
 *
 * ── Why the reveal never changes what is copied or spoken ───────────────────
 * This is presentation only. The entry's text is complete from the first
 * frame — the copy button copies all of it and speech reads all of it — so a
 * slow animation can never make Atlas slower to *answer*, only to finish
 * drawing. Clicking the message finishes it at once.
 *
 * Word mode renders everything already settled as one text node and only the
 * last few words as fading spans, so a long reply is not hundreds of animated
 * elements.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { revealPlan, type AnimationSpeed, type ReplyAnimation } from '@atlas/tokens';

const FADING_TAIL = 6;

export function RevealText({
  text,
  animate,
  animation,
  speed,
  onProgress,
}: {
  text: string;
  animate: boolean;
  animation: ReplyAnimation;
  speed: AnimationSpeed;
  /** Called as the text grows, so the transcript can keep the end in view. */
  onProgress?(): void;
}) {
  const mode: ReplyAnimation = animate ? animation : 'off';

  // Words keep their trailing whitespace so joining them back is lossless.
  const units = useMemo(
    () => (mode === 'typewriter' ? Array.from(text) : (text.match(/\S+\s*|\s+/g) ?? [])),
    [text, mode],
  );
  const { stepMs } = revealPlan(units.length, mode, speed);
  const [shown, setShown] = useState(stepMs > 0 ? 0 : units.length);
  const progress = useRef(onProgress);
  progress.current = onProgress;

  useEffect(() => {
    if (stepMs <= 0) {
      setShown(units.length);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const next = Math.min(units.length, Math.floor((now - started) / stepMs) + 1);
      setShown(next);
      progress.current?.();
      if (next < units.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [units, stepMs]);

  const done = shown >= units.length;
  const finish = done ? undefined : () => setShown(units.length);

  if (mode === 'fade') return <span className="atlas-reply-in block">{text}</span>;
  if (mode === 'off' || stepMs <= 0) return <>{text}</>;

  if (mode === 'typewriter') {
    return (
      <span onClick={finish}>
        {units.slice(0, shown).join('')}
        {!done && <span aria-hidden="true" className="atlas-caret" />}
      </span>
    );
  }

  const settled = Math.max(0, shown - FADING_TAIL);
  return (
    <span onClick={finish}>
      {units.slice(0, settled).join('')}
      {units.slice(settled, shown).map((word, i) => (
        <span key={settled + i} className="atlas-word-in">
          {word}
        </span>
      ))}
    </span>
  );
}
