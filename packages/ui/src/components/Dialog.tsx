import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name for the dialog (visually hidden). */
  label: string;
  children: ReactNode;
  className?: string;
  position?: 'center' | 'top';
  /** Extra classes merged onto the scrim — e.g. a heavier blur for a full-screen launcher. */
  overlayClassName?: string;
}

/**
 * Accessible modal built on Radix Dialog: focus trapping, escape-to-close, and
 * scroll locking come for free. Enter/exit animations via tailwindcss-animate.
 */
export function Modal({
  open,
  onOpenChange,
  label,
  children,
  className,
  position = 'center',
  overlayClassName,
}: ModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
            overlayClassName,
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 z-50 w-full -translate-x-1/2 px-4 outline-none',
            position === 'top' ? 'top-[12vh] max-w-xl' : 'top-1/2 max-w-lg -translate-y-1/2',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{label}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
