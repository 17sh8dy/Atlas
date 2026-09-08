/**
 * The whole product, on one screen.
 *
 * There is no navigation here on purpose. An assistant's job is to remove the
 * need to go and find things, so a sidebar of places to go would be arguing
 * with its own premise. Everything happens in the transcript, and Settings is
 * one button away rather than a permanent fixture.
 *
 * The empty state does the teaching. A blank box gives no clue what a program
 * like this accepts, so the first screen shows a handful of broad things Atlas
 * helps with. See the doc comment on `CARDS` below for why these are
 * hand-written categories rather than the literal skill commands the screen
 * used to show, and why clicking one no longer runs anything.
 */

import { useState } from 'react';
import type { ExecutionMode } from '@atlas/core';
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
  executionMode: ExecutionMode;
  onCycleExecutionMode(): void;
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
  executionMode,
  onCycleExecutionMode,
  dictation,
  dictated,
}: Props) {
  // A Home card was clicked: its starter text (possibly '') goes into the
  // composer and takes focus. `at` forces the effect in `Composer` to fire
  // even when the same card is clicked twice in a row with nothing typed
  // in between — same pattern as `dictated` just below it.
  const [prefill, setPrefill] = useState<{ text: string; at: number } | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {entries.length === 0 ? (
          <EmptyState
            skills={skills}
            greeting={greeting}
            personalized={personalized}
            atlasName={atlasName}
            onSelect={(starter) => setPrefill({ text: starter, at: Date.now() })}
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
        executionMode={executionMode}
        onCycleExecutionMode={onCycleExecutionMode}
        dictation={dictation}
        dictated={dictated}
        prefill={prefill}
      />
    </div>
  );
}

/**
 * The first screen, and the only teaching Atlas does.
 *
 * ── Two things this screen tried before, and why both were wrong ───────────
 * v1 was six icon-over-one-line tiles — "open file explorer", "what's my
 * battery" — literally `skill.examples[…]` read off the registry. It filled a
 * laptop screen to show six of a hundred and thirty-seven things, which is a
 * dashboard, not an assistant.
 *
 * v2 fixed the space problem by turning tiles into rows inside one glass panel
 * per category, nineteen suggestions deep. It solved density and created a new
 * problem: each row was still one skill's own example sentence — "what's 12 *
 * 7", "tip on 84.50" — which demonstrates that skill and nothing else. Reading
 * nineteen of those teaches "here are things I have seen Atlas do," not "I
 * could just tell Atlas what I want," and every one of them was also a live
 * command: clicking it *ran* something, so the screen still read as a control
 * panel of buttons rather than an invitation to type.
 *
 * ── This version: six categories, hand-written, and none of them run ───────
 * `CARDS` below is not read from the registry. That is deliberate, for the
 * first time on this screen: a category like "Control my PC" describes a
 * dozen different skills at once ("lock my pc", "take a screenshot", "what's
 * my battery"), and no single `skill.examples[0]` can stand in for all of
 * them without becoming exactly the over-specific chip this rewrite removes.
 * The cost is that these six sentences need a human to update them if a whole
 * *category* of ability disappears — `home.test.ts` can't check a hand-written
 * sentence against the grammar the way it checked a literal skill id. What it
 * still checks: every card names something a real domain in the registry
 * covers, so a category can't quietly refer to capabilities Atlas dropped.
 *
 * Clicking a card never executes anything — seeing "Search the web" run a web
 * search with no query was worse than not being able to click it. Instead it
 * drops a starter phrase into the composer and focuses it (`Conversation`'s
 * `prefill` state, read by `Composer`), cursor at the end, so the person
 * finishes the sentence in their own words. The broadest cards ("Control my
 * PC", "Work with my notes", "Do something for me") have no natural single
 * verb to start with, so those just focus an empty composer — identical to
 * clicking "Do something for me", which exists specifically to say out loud
 * that typing anything, unprompted, is the whole point of this screen.
 *
 * ── No "recent" row, deliberately ───────────────────────────────────────────
 * It was considered and dropped. Episodic memory stores what *happened*
 * ("Opening Steam.") rather than what was typed, so a recent row could be
 * shown but not re-run — and a row that does nothing when clicked is precisely
 * the unfinished feeling the rest of this work is removing. Conversation
 * history that could be replayed dies with the process today; when Phase 3
 * persists it, this is where it goes.
 */
interface HomeCard {
  icon: string;
  label: string;
  description: string;
  /**
   * Dropped into the composer on click, cursor placed at the end. Omitted for
   * a category too broad for one natural sentence start — clicking those just
   * focuses the (empty) composer instead.
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
    label: 'Do something for me',
    description: 'Tell Atlas what you need, in your own words.',
    domains: ['core', 'atlas'],
  },
];

function EmptyState({
  skills,
  greeting,
  personalized,
  atlasName,
  onSelect,
}: {
  skills: SkillRegistry;
  greeting: string;
  personalized: boolean;
  atlasName: string;
  /** A card was clicked; carries its starter text, or '' for an empty focus. */
  onSelect(starter: string): void;
}) {
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

        <div className="mt-7 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
              <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
                {card.description}
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
