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
import { AtlasMark } from '@atlas/ui';
import { Composer } from '../components/Composer';
import { Transcript } from '../components/Transcript';
import { HomeBackdrop } from '../effects/HomeBackdrop';
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
 * So the tiles became rows, gathered into one glass panel per category —
 * the same six headings the capability browser uses, so the two places that
 * answer "what can this thing do?" agree with each other. Nineteen
 * suggestions still take less room than six cards did, because a row costs a
 * line and a tile costs a block.
 *
 * The panels use `.atlas-glass`, which until now was the voice screen and
 * nowhere else. Its doc comment explains why that was a rule and why Home is
 * the exception: the expensive half of a backdrop-filter is re-filtering, and
 * nothing behind these panels ever moves.
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

/**
 * Curated per category. Order is what a person reaches for, not the registry's.
 *
 * ── The rule: a suggestion has to work on anyone's machine ──────────────────
 * Home suggests what Atlas can do *in general*, never anything about this
 * particular computer's files. The first version broke that and it showed
 * immediately: `files.list`'s example was a path on the D: drive, which Atlas
 * refuses — `is_permitted` allows only what sits under the user's home folder,
 * so that suggestion was broken on every machine, including the one it was
 * written on. Clicking it produced an error, which is worse than showing
 * nothing at all.
 *
 * The file skills are all still registered and still in the capability
 * browser; they are simply not something to *suggest* cold, because a useful
 * file request names a file only the person asking knows about. "Open file
 * explorer" is the shape that belongs here: something anyone can click and
 * have work.
 *
 * "No path in a suggestion" is enforced by `home.test.ts`. The rest is
 * judgement, and the judgement is: if a chip only makes sense to whoever
 * wrote it, it does not belong on this screen.
 */
export const SUGGESTED: ReadonlyArray<{ category: string; skills: readonly string[] }> = [
  {
    category: 'System',
    skills: ['system.info', 'system.processes', 'system.openTool', 'system.battery', 'net.ip'],
  },
  { category: 'Web', skills: ['web.openBrowser', 'web.search', 'web.searchYoutube'] },
  { category: 'Utilities', skills: ['math.calculate', 'time.now', 'util.password', 'util.uuid'] },
  { category: 'Text', skills: ['text.case', 'clipboard.transform'] },
  { category: 'Notes', skills: ['notes.list', 'todo.list', 'memory.list'] },
];

/**
 * Which of a skill's examples becomes the chip.
 *
 * The first one, because that is the phrasing the skill's author chose as
 * canonical — unless it is too long for a panel, in which case the shortest
 * wins so the row does not ellipsise.
 *
 * It used to be *always* the shortest, which was a layout rule pretending to
 * be an editorial one. It picked "open task manager" over "open file
 * explorer" purely on a one-character difference, and "new guid" over
 * "generate a uuid", which is worse writing chosen by accident.
 *
 * `MAX` is set by what fits a panel at 15px, measured rather than guessed:
 * `uppercase "hello world"` (23) sits comfortably and is the longest chip on
 * the screen.
 */
export function chipFor(examples: readonly string[]): string {
  const MAX = 24;
  const first = examples[0]!;
  if (first.length <= MAX) return first;
  return [...examples].sort((a, b) => a.length - b.length)[0]!;
}

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
      return [{ id, text: chipFor(skill.examples), icon: skill.icon ?? '•' }];
    }),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="relative my-auto flex w-full flex-col items-center px-6 py-8">
      {/*
        Behind everything below it, and unable to come forward: the backdrop is
        `z-0` and every child here sits in the `relative z-10` stack that
        follows. See `HomeBackdrop` for why it is this restrained, and for the
        three conditions under which it does not render at all.
      */}
      <HomeBackdrop />

      <div className="relative z-10 flex w-full flex-col items-center">
        <div className="accent-surface text-primary-foreground mb-3 grid h-10 w-10 place-items-center rounded-xl">
          <AtlasMark className="h-5 w-5" />
        </div>

        <h1 className="text-foreground text-base font-semibold tracking-tight">{atlasName}</h1>
        {personalized && (
          <p className="text-foreground mt-1 max-w-md text-center text-sm leading-relaxed">
            {greeting}
          </p>
        )}
        <p className="text-foreground-subtle mt-1 max-w-md text-center text-xs leading-relaxed">
          {skills.available().length} actions, all on this machine. No account needed, no key.
        </p>

        {groups.length > 0 && (
          <div className="mt-7 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((group) => (
              <div key={group.category} className="atlas-glass min-w-0 rounded-xl p-3">
                <p className="text-foreground-subtle mb-1.5 px-1.5 text-[10px] font-medium uppercase tracking-wide">
                  {group.category}
                </p>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onAsk(item.text)}
                      title={item.text}
                      // atlas-enhance: opt-in hook for the Enhanced Effects
                      // setting (styles/index.css) — inert unless it's on.
                      className="text-foreground-muted hover:bg-surface-raised hover:text-foreground duration-fast atlas-enhance flex items-center gap-2.5 rounded-lg px-1.5 py-2 text-left text-[15px] transition"
                    >
                      <span className="shrink-0 text-sm leading-none">{item.icon}</span>
                      <span className="min-w-0 truncate">{item.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
