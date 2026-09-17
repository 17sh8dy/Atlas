/**
 * The "+" in the composer: everything you can hand Atlas alongside a message.
 *
 * ── Why a declared list rather than markup ──────────────────────────────────
 * The sources are data (`SOURCES` below), not a column of hand-written JSX, so
 * adding one is adding an object: an icon, a label, what it does, and — the
 * part that actually matters — the capability it needs and what to say when
 * that capability is absent. A build with no `screen` capability doesn't get a
 * dead "Take a screenshot" row that fails when clicked; it gets a row that
 * says, before it is clicked, why it can't.
 *
 * That last rule is this codebase's own — "capability absence is data, not an
 * exception" (ARCHITECTURE §2.4). A source whose platform method is missing is
 * shown disabled with the reason, never hidden: a person who expected to find
 * it here should learn that it isn't available in this build, not conclude
 * they misremembered where it was.
 */

import { useRef, useState } from 'react';
import type { CapabilityName, Platform } from '@atlas/core';
import { Icons, Popover, PopoverGroup, PopoverItem, cn } from '@atlas/ui';

interface Props {
  platform: Platform;
  capabilities: readonly CapabilityName[];
  disabled?: boolean;
  busy?: boolean;
  onAddFiles(options?: { imagesOnly?: boolean }): void;
  /** Capture once, right now, and attach it. */
  onTakeScreenshot(): void;
  /** Open the share picker — choosing a target is a separate, explicit step. */
  onShareScreen(): void;
  /** True while a share is running, so the item reads "Stop sharing". */
  sharing?: boolean;
  onStopSharing(): void;
}

interface Source {
  id: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  group?: string;
  /** What this needs from the platform; absent means always available. */
  needs?: CapabilityName;
  /** The specific port method, checked because a capability can be on while a build lacks the method. */
  available(platform: Platform): boolean;
  unavailable: string;
  run(props: Props): void;
}

const SOURCES: Source[] = [
  {
    id: 'files',
    icon: <Icons.FileText className="h-4 w-4" />,
    label: 'Add files and documents',
    hint: 'Points Atlas at a file. Reading it is a separate step.',
    available: (p) => Boolean(p.pickFiles),
    unavailable: 'This build has no file picker.',
    run: (p) => p.onAddFiles(),
  },
  {
    id: 'images',
    icon: <Icons.Sparkles className="h-4 w-4" />,
    label: 'Add images',
    hint: 'Shown in the conversation, and kept on this machine.',
    available: (p) => Boolean(p.pickFiles),
    unavailable: 'This build has no file picker.',
    run: (p) => p.onAddFiles({ imagesOnly: true }),
  },
  {
    id: 'screenshot',
    icon: <Icons.Scissors className="h-4 w-4" />,
    label: 'Take a screenshot',
    hint: 'Captures every monitor now and attaches it.',
    group: 'Your screen',
    needs: 'screen',
    available: (p) => Boolean(p.captureScreen),
    unavailable: "This build can't capture the screen.",
    run: (p) => p.onTakeScreenshot(),
  },
  {
    id: 'share',
    icon: <Icons.MonitorSmartphone className="h-4 w-4" />,
    label: 'Share screen with Atlas',
    hint: 'Pick a monitor or a window. You choose, and you can stop any time.',
    needs: 'screen',
    available: (p) => Boolean(p.captureScreen),
    unavailable: "This build can't capture the screen.",
    run: (p) => p.onShareScreen(),
  },
];

export function ContextMenu(props: Props) {
  const { platform, capabilities, disabled, busy, sharing, onStopSharing } = props;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const select = (source: Source) => {
    setOpen(false);
    source.run(props);
  };

  let lastGroup: string | undefined;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add context"
        title="Add files, images or your screen"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'atlas-enhance duration-fast mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg transition',
          'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
          disabled && 'cursor-not-allowed opacity-40',
          open || sharing
            ? 'bg-primary/15 text-primary'
            : 'text-foreground-subtle hover:bg-surface-raised hover:text-foreground',
        )}
      >
        {/* The same reasoning as the dictation button's dot: the control that
            started the share is where a person looks to check it is still on. */}
        {sharing && (
          <span className="bg-primary absolute right-1 top-1 h-1.5 w-1.5 rounded-full motion-safe:animate-pulse" />
        )}
        <Icons.Plus
          className={cn('duration-fast h-4 w-4 transition-transform', open && 'rotate-45')}
        />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={trigger}
        label="Add context"
        className="w-[19rem]"
      >
        {SOURCES.map((source) => {
          const missingCapability = source.needs && !capabilities.includes(source.needs);
          const unavailable = missingCapability || !source.available(platform);
          const group = source.group;
          const heading = group && group !== lastGroup ? group : null;
          if (group) lastGroup = group;

          return (
            <div key={source.id}>
              {heading && <PopoverGroup label={heading} />}
              <PopoverItem
                icon={source.icon}
                label={source.label}
                hint={unavailable ? source.unavailable : source.hint}
                disabled={unavailable || busy}
                onSelect={() => select(source)}
              />
            </div>
          );
        })}

        {sharing && (
          <>
            <div className="bg-border my-1 h-px" />
            <PopoverItem
              icon={<Icons.X className="h-4 w-4" />}
              label="Stop sharing"
              hint="Atlas stops capturing immediately."
              onSelect={() => {
                setOpen(false);
                onStopSharing();
              }}
            />
          </>
        )}
      </Popover>
    </>
  );
}
