/**
 * The whole product, on one screen.
 *
 * There is no navigation here on purpose. An assistant's job is to remove the
 * need to go and find things, so a sidebar of places to go would be arguing
 * with its own premise. Everything happens in the transcript, and Settings is
 * one button away rather than a permanent fixture.
 *
 * The empty state does the teaching. A blank box gives no clue what a program
 * like this accepts, so the first screen is a short list of things that
 * genuinely work in *this* build — drawn from the skills actually available on
 * this platform, not a fixed marketing list that promises what a browser tab
 * can't do.
 */

import type { SkillRegistry } from '@atlas/engine';
import { Icons } from '@atlas/ui';
import { Composer } from '../components/Composer';
import { Transcript } from '../components/Transcript';
import type { Entry } from '../atlas/useAtlas';

interface Props {
  entries: Entry[];
  busy: boolean;
  /** A confirmation is open, so the composer must stay usable. */
  awaitingAnswer: boolean;
  skills: SkillRegistry;
  greeting: string;
  personalized: boolean;
  atlasName: string;
  onAsk(text: string): void;
  onRunAction(skill: string, args: Record<string, string | number | boolean>): void;
  onAnswerConfirm(approved: boolean): void;
  onCopy(text: string): Promise<boolean>;
  /** Re-ask one of your own messages. */
  onAskAgain?(text: string): void;
  /** Passed through to the composer; absent when this build cannot listen. */
  dictation?: { active: boolean; transcribing: boolean; onToggle(): void };
  dictated?: { text: string; at: number } | null;
}

export function Conversation({
  entries,
  busy,
  awaitingAnswer,
  skills,
  greeting,
  personalized,
  atlasName,
  onAsk,
  onRunAction,
  onAnswerConfirm,
  onCopy,
  onAskAgain,
  dictation,
  dictated,
}: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {entries.length === 0 ? (
          <EmptyState
            skills={skills}
            greeting={greeting}
            personalized={personalized}
            atlasName={atlasName}
            onAsk={onAsk}
          />
        ) : (
          <Transcript
            entries={entries}
            busy={busy}
            onAnswerConfirm={onAnswerConfirm}
            onRunAction={onRunAction}
            onCopy={onCopy}
            onAskAgain={onAskAgain}
          />
        )}
      </div>

      <Composer
        onSubmit={onAsk}
        busy={busy}
        awaitingAnswer={awaitingAnswer}
        dictation={dictation}
        dictated={dictated}
      />
    </div>
  );
}

/**
 * The first screen, and the only teaching Atlas does.
 *
 * ── What was wrong with it ──────────────────────────────────────────────────
 * Six cards, two columns, each a 90px-tall tile with an icon above a line of
 * text. They filled the window on a laptop and still only showed six of a
 * hundred and ten things, which is the worst of both: it takes the whole
 * screen to say very little. A first screen that large reads as a dashboard,
 * and Atlas is not a dashboard — it is a box you type into.
 *
 * So the tiles became rows. Eighteen suggestions now fit in less room than
 * six cards used to, grouped under the same six headings the capability
 * browser uses, so the two places that answer "what can this thing do?" agree
 * with each other.
 *
 * ── The phrasings are the skills' own ───────────────────────────────────────
 * Every label here is `skill.examples[…]`, read from the registry at render.
 * Nothing on this screen is a sentence somebody wrote into the UI hoping the
 * grammar would take it — which is exactly how a suggestion rots into a lie
 * after a rule changes. The shortest example wins, because this is a grid of
 * one-line chips and a suggestion that wraps is a suggestion that looks
 * broken.
 *
 * A skill this build does not have is skipped, so the browser never suggests
 * something only the desktop app can do.
 *
 * ── No "recent" row, deliberately ───────────────────────────────────────────
 * It was considered and dropped. Episodic memory stores what *happened*
 * ("Opening Steam.") rather than what was typed, so a recent row could be
 * shown but not re-run — and a row of chips that does nothing when clicked is
 * precisely the unfinished feeling the rest of this work is removing.
 * Conversation history that could be replayed dies with the process today;
 * when Phase 3 persists it, this is where it goes.
 */

/** Curated per category. Order is what a person reaches for, not the registry's. */
export const SUGGESTED: ReadonlyArray<{ category: string; skills: readonly string[] }> = [
  { category: 'Files', skills: ['files.find', 'files.openKnown', 'files.list'] },
  { category: 'System', skills: ['system.info', 'system.processes', 'system.battery', 'net.ip'] },
  { category: 'Web', skills: ['web.openBrowser', 'web.search', 'web.searchYoutube'] },
  { category: 'Utilities', skills: ['math.calculate', 'time.now', 'util.password', 'util.uuid'] },
  { category: 'Text', skills: ['text.case', 'clipboard.transform'] },
  { category: 'Notes', skills: ['notes.list', 'todo.list', 'memory.list'] },
];

function EmptyState({
  skills,
  greeting,
  personalized,
  atlasName,
  onAsk,
}: {
  skills: SkillRegistry;
  greeting: string;
  personalized: boolean;
  atlasName: string;
  onAsk(text: string): void;
}) {
  const available = new Map(skills.available().map((s) => [s.id, s]));

  const groups = SUGGESTED.map(({ category, skills: ids }) => ({
    category,
    items: ids.flatMap((id) => {
      const skill = available.get(id);
      if (!skill?.examples?.length) return [];
      // Shortest, because these are one-line chips and a wrapped suggestion
      // looks like a mistake.
      const text = [...skill.examples].sort((a, b) => a.length - b.length)[0]!;
      return [{ id, text, icon: skill.icon ?? '•' }];
    }),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="my-auto flex w-full flex-col items-center px-6 py-8">
      <div className="accent-surface text-primary-foreground mb-3 grid h-10 w-10 place-items-center rounded-xl">
        <Icons.Compass className="h-5 w-5" />
      </div>

      <h1 className="text-foreground text-base font-semibold tracking-tight">{atlasName}</h1>
      {personalized && (
        <p className="text-foreground mt-1 max-w-md text-center text-sm leading-relaxed">
          {greeting}
        </p>
      )}
      <p className="text-foreground-subtle mt-1 max-w-md text-center text-xs leading-relaxed">
        {skills.available().length} actions, all on this machine. No account, no key.
      </p>

      {groups.length > 0 && (
        <div className="mt-7 grid w-full max-w-3xl grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-3">
          {groups.map((group) => (
            <div key={group.category} className="min-w-0">
              <p className="text-foreground-subtle mb-1 px-2 text-[10px] font-medium uppercase tracking-wide">
                {group.category}
              </p>
              <div className="flex flex-col">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onAsk(item.text)}
                    title={item.text}
                    className="text-foreground-muted hover:bg-surface hover:text-foreground duration-fast flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition"
                  >
                    <span className="shrink-0 text-xs leading-none">{item.icon}</span>
                    <span className="min-w-0 truncate">{item.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
