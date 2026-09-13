/**
 * Six hand-written categories of "what Atlas can help with" — a grid of
 * cards, none of which run anything when clicked.
 *
 * ── Where this used to live ──────────────────────────────────────────────
 * This was Home's entire first screen before Home became an identity plus
 * Recent Activity (see `Conversation.tsx`'s `EmptyState`). Pulled out into
 * its own component rather than deleted: the six categories are still a
 * real, useful answer to "what is this thing for", and Home now opens it
 * from a small "What can Atlas do?" link instead of leading with it — a
 * companion states who it is first and shows its card catalogue on request,
 * not the other way around. Nothing else has reused this yet, but nothing
 * about it is Home-specific, which is the point of it living here rather
 * than inline in a page file.
 *
 * ── Two things this tried before, and why both were wrong ───────────────
 * v1 was six icon-over-one-line tiles — "open file explorer", "what's my
 * battery" — literally `skill.examples[…]` read off the registry. It filled
 * a laptop screen to show six of a hundred and thirty-seven things, which is
 * a dashboard, not an assistant.
 *
 * v2 fixed the space problem by turning tiles into rows inside one glass
 * panel per category, nineteen suggestions deep. It solved density and
 * created a new problem: each row was still one skill's own example sentence
 * — "what's 12 * 7", "tip on 84.50" — which demonstrates that skill and
 * nothing else. Reading nineteen of those teaches "here are things I have
 * seen Atlas do," not "I could just tell Atlas what I want," and every one
 * of them was also a live command: clicking it *ran* something, so the
 * screen still read as a control panel of buttons rather than an invitation
 * to type.
 *
 * ── This version: six categories, hand-written, and none of them run ────
 * `CARDS` below is not read from the registry. That is deliberate: a
 * category like "Control my PC" describes a dozen different skills at once
 * ("lock my pc", "take a screenshot", "what's my battery"), and no single
 * `skill.examples[0]` can stand in for all of them without becoming exactly
 * the over-specific chip this rewrite removes. The cost is that these six
 * sentences need a human to update them if a whole *category* of ability
 * disappears — `home.test.ts` can't check a hand-written sentence against
 * the grammar the way it checked a literal skill id. What it still checks:
 * every card names something a real domain in the registry covers, so a
 * category can't quietly refer to capabilities Atlas dropped.
 *
 * Clicking a card never executes anything — seeing "Search the web" run a
 * web search with no query was worse than not being able to click it.
 * Instead it hands the caller a starter phrase to drop into the composer,
 * cursor at the end, so the person finishes the sentence in their own words.
 * The broadest cards ("Control my PC", "Work with my notes", "Get something
 * done") have no natural single verb to start with, so those hand back ''
 * instead — identical to clicking "Get something done", which exists
 * specifically to say out loud that typing anything, unprompted, is the
 * whole point.
 */

interface HomeCard {
  icon: string;
  label: string;
  description: string;
  /**
   * Handed to `onSelect` on click. Omitted for a category too broad for one
   * natural sentence start — clicking those passes `''` instead.
   */
  starter?: string;
  /**
   * Registry domains this card promises are real, checked by `home.test.ts`
   * against the same domain tags the capability browser groups by. Not shown
   * anywhere — it exists so a category whose domain quietly disappears from
   * every skill pack gets caught here instead of by a person clicking a card
   * that no longer means anything.
   */
  domains: readonly string[];
}

export const CARDS: readonly HomeCard[] = [
  {
    icon: '🔎',
    label: 'Search the web',
    description: 'Find information, websites, images, and more.',
    starter: 'search the web for ',
    domains: ['web', 'research'],
  },
  {
    icon: '🚀',
    label: 'Open something',
    description: 'Launch an app, website, file, or folder.',
    starter: 'open ',
    domains: ['apps', 'web', 'files'],
  },
  {
    icon: '🖥️',
    label: 'Control my PC',
    description: 'Check your system, windows, battery, and more.',
    domains: ['system', 'notifications'],
  },
  {
    icon: '📁',
    label: 'Find something',
    description: 'Locate files, folders, or applications.',
    starter: 'find ',
    domains: ['files', 'apps'],
  },
  {
    icon: '📝',
    label: 'Work with my notes',
    description: 'Read, create, or manage notes and to-dos.',
    domains: ['notes', 'memory'],
  },
  {
    icon: '🛠️',
    label: 'Get something done',
    description: 'Tell Atlas what you need, in your own words.',
    domains: ['core', 'atlas'],
  },
];

export function CapabilityCards({ onSelect }: { onSelect(starter: string): void }) {
  return (
    <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {CARDS.map((card) => (
        <button
          key={card.label}
          type="button"
          onClick={() => onSelect(card.starter ?? '')}
          title={card.description}
          // atlas-enhance: opt-in hook for the Enhanced Effects setting
          // (styles/index.css) — inert unless it's on.
          className="atlas-glass atlas-enhance hover:bg-surface-raised duration-fast min-w-0 rounded-xl p-4 text-left transition"
        >
          <span className="text-xl leading-none">{card.icon}</span>
          <p className="text-foreground mt-2 text-sm font-medium">{card.label}</p>
          <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">{card.description}</p>
        </button>
      ))}
    </div>
  );
}
