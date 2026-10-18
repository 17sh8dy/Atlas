/**
 * Atlas Pro — a preview of what may come, and nothing more.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THIS PAGE SELLS NOTHING, BECAUSE NOTHING IS FOR SALE.
 *
 * There is no subscription, no checkout, no payment code, no account requirement and no list of
 * features that "unlock". Every one of the items below is a plan: it may change, arrive later or
 * not ship, and the page says so in plain words instead of in a footnote. The button is a label
 * that cannot be pressed.
 *
 * Two promises are written into the page itself so they cannot quietly erode:
 *   · what Atlas does today stays free — this page does not take anything away from it;
 *   · it never promises what it cannot know: not "unlimited" memory, and not what a phone's
 *     operating system will allow (`atlas-pro.test.ts` fails the build if either word appears).
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { Button, Icons } from '@atlas/ui';

export interface ProFeature {
  id: string;
  title: string;
  icon: Icons.LucideIcon;
  /** What is planned, in words that do not promise more than anyone can know today. */
  plan: string;
}

export const PRO_FEATURES: readonly ProFeature[] = [
  {
    id: 'mobile',
    title: 'Atlas Mobile',
    icon: Icons.Smartphone,
    plan: 'A standalone assistant for Android and iOS, with phone automation and native device tools where the phone’s operating system allows them.',
  },
  {
    id: 'connect',
    title: 'Atlas Connect',
    icon: Icons.Link2,
    plan: 'Connect a phone to Atlas on your PC, send tasks to it from anywhere, and get progress updates back.',
  },
  {
    id: 'memory',
    title: 'Advanced Long-Term Memory',
    icon: Icons.Brain,
    plan: 'More detailed, more precise memory across your conversations and projects.',
  },
  {
    id: 'history',
    title: 'Persistent Chat History',
    icon: Icons.History,
    plan: 'Search your saved history, reopen a conversation and carry on from any point in it.',
  },
  {
    id: 'context',
    title: 'Extended Conversation Memory',
    icon: Icons.MessagesSquare,
    plan: 'Better context in very long chats, including remembering finished tasks, decisions, the current goal and the work that is left.',
  },
  {
    id: 'sync',
    title: 'Cross-Device Sync',
    icon: Icons.RefreshCw,
    plan: 'Optional, encrypted sync of chats, memory and settings between your devices.',
  },
  {
    id: 'automation',
    title: 'Advanced Remote Automation',
    icon: Icons.Workflow,
    plan: 'More powerful workflows that span several devices, and workflows that run on a schedule.',
  },
];

export function AtlasPro() {
  return (
    <section className="flex flex-col gap-3">
      <div className="border-border rounded-xl border px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Icons.Gem className="text-primary h-4 w-4 shrink-0" />
          <h2 className="text-foreground text-sm font-medium">Atlas Pro</h2>
          <span className="border-primary/30 bg-primary/10 text-primary rounded-full border px-2 py-0.5 text-[10px] font-medium">
            Coming soon
          </span>
        </div>
        <p className="text-foreground-subtle mt-1.5 text-xs leading-relaxed">
          A preview of what Atlas Pro may offer one day. None of it exists yet, nothing is for sale,
          and there is nothing to sign up for. These are plans, and plans change: a feature here may
          arrive later, arrive differently, or not arrive.
        </p>
        <p className="text-foreground mt-2 text-xs leading-relaxed">
          Everything Atlas does today stays free. Atlas Pro would only add new things; it would not
          take anything away from what you already have.
        </p>
      </div>

      <ul className="flex flex-col gap-3" aria-label="Planned Atlas Pro features">
        {PRO_FEATURES.map(({ id, title, icon: Icon, plan }) => (
          <li key={id} className="border-border flex items-start gap-3 rounded-xl border px-4 py-3.5">
            <Icon className="text-foreground-muted mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-foreground text-sm font-medium">{title}</h3>
                <span className="border-border text-foreground-subtle rounded-full border px-2 py-0.5 text-[10px] font-medium">
                  Planned
                </span>
              </div>
              <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">{plan}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3.5">
        <p className="text-foreground-subtle min-w-[14rem] flex-1 text-xs leading-relaxed">
          No release date or price has been announced. What a phone can do depends on what its
          operating system permits.
        </p>
        <Button variant="secondary" size="sm" disabled aria-disabled="true">
          Coming Soon
        </Button>
      </div>
    </section>
  );
}
