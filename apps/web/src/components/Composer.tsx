/**
 * The input. The only control Atlas actually needs.
 *
 * It grows with what you type up to a limit, submits on Enter, and takes a
 * newline on Shift+Enter — the conventions people already have from every other
 * text box worth using. It also takes focus back after every send, because an
 * assistant you have to click into between commands is one you stop using.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icons, cn } from '@atlas/ui';

interface Props {
  onSubmit(text: string): void;
  busy: boolean;
  placeholder?: string;
}

const MAX_HEIGHT = 160;

export function Composer({ onSubmit, busy, placeholder = 'Ask Atlas anything…' }: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow to fit, but stop before the transcript is squeezed off screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy]);

  const send = () => {
    const text = value.trim();
    if (!text || busy) return;
    setValue('');
    onSubmit(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-border bg-background/80 px-6 py-4 backdrop-blur">
      <div
        className={cn(
          'flex items-end gap-2 rounded-xl border border-border bg-surface px-3 py-2',
          'transition duration-fast focus-within:border-border-strong',
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={cn(
            'flex-1 resize-none bg-transparent py-1.5 text-sm text-foreground',
            'placeholder:text-foreground-subtle focus:outline-none',
          )}
        />
        <button
          type="button"
          onClick={send}
          disabled={!value.trim() || busy}
          aria-label="Send"
          className={cn(
            'mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg',
            'bg-primary text-primary-foreground transition duration-fast',
            'hover:brightness-110 disabled:opacity-30 disabled:hover:brightness-100',
          )}
        >
          <Icons.ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
