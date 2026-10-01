import { useEffect, type RefObject } from 'react';
import { wheelStep } from './scroll';

/**
 * Scale (and cap) mouse-wheel scrolling on one element — see `scroll.ts`.
 * A non-passive listener, because the default scroll has to be cancelled to replace it.
 */
export function useWheelSpeed(ref: RefObject<HTMLElement | null>, speed: number): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Pinch-zoom (ctrl+wheel) and sideways scrolling are not ours.
      if (e.ctrlKey || e.defaultPrevented || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const step = wheelStep(e.deltaY, e.deltaMode, speed, el.clientHeight);
      if (step === 0) return;
      e.preventDefault();
      el.scrollBy({ top: step });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, speed]);
}
