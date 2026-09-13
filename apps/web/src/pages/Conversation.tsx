/**
 * The whole product, on one screen.
 *
 * There is no navigation here on purpose. An assistant's job is to remove the
 * need to go and find things, so a sidebar of places to go would be arguing
 * with its own premise. Everything happens in the transcript, and Settings is
 * one button away rather than a permanent fixture.
 *
 * ── Home: a companion, not a dashboard ───────────────────────────────────
 * The empty state used to lead with six capability cards — "here is a grid
 * of things I can do," the same shape every AI dashboard opens with. What it
 * leads with now is Atlas saying who it is (the mark, its name, a line that
 * states the relationship rather than a feature list) and Recent Activity —
 * what Atlas has actually done on this machine, which reads as "I have been
 * useful to you" in a way a static card grid cannot. The six cards still
 * exist — see `CapabilityCards` — reachable from the small "What can Atlas
 * do?" link rather than occupying the first thing you see.
 *
 * "160 capabilities · Local-first · No account required" used to sit right
 * under the name. It moved to Settings → About, where a person who wants
 * that reassurance goes looking for it — a fact worth stating once, in the
 * place that answers "can I trust this", rather than as permanent chrome on
 * the screen you open the most.
 */

import { useEffect, useState } from 'react';
import type { EpisodicEvent, ExecutionMode, Memory } from '@atlas/core';
import { AtlasMark, Modal } from '@atlas/ui';
import { Composer } from '../components/Composer';
import { Transcript } from '../components/Transcript';
import { HomeBackdrop } from '../effects/HomeBackdrop';
import { CapabilityCards } from '../components/CapabilityCards';
import { RecentActivity } from '../components/RecentActivity';
import type { Entry } from '../atlas/useAtlas';

interface Props {
  entries: Entry[];
  busy: boolean;
  /** A confirmation is open, so the composer must stay usable. */
  awaitingAnswer: boolean;
  /** Where Recent Activity reads from, and nowhere else — see `EmptyState`. */
  memory: Memory;
  greeting: string;
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
  memory,
  greeting,
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
            memory={memory}
            greeting={greeting}
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

function EmptyState({
  memory,
  greeting,
  atlasName,
  onSelect,
}: {
  memory: Memory;
  greeting: string;
  atlasName: string;
  /** A card was clicked, or the Recent Activity empty state's CTA — carries
   *  its starter text, or '' for an empty focus. */
  onSelect(starter: string): void;
}) {
  const [episodes, setEpisodes] = useState<EpisodicEvent[] | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  // Fetched fresh on every mount rather than kept live: this component only
  // ever mounts when Home becomes visible again (a fresh launch, or clearing
  // the conversation) — see `RecentActivity`'s doc comment for why there is
  // nothing to subscribe to in between.
  useEffect(() => {
    let alive = true;
    void memory.episodes().then((events) => {
      if (alive) setEpisodes(events);
    });
    return () => {
      alive = false;
    };
  }, [memory]);

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
        <p className="text-foreground-muted mt-1 text-xs">Your personal computer companion</p>
        <p className="text-foreground mt-3 max-w-md text-center text-sm leading-relaxed">
          {greeting}
        </p>

        <div className="mt-7 w-full max-w-md">
          {/* `null` while the first read is in flight — rendering nothing for
              that instant beats flashing the empty state and then replacing
              it with real rows a moment later. */}
          {episodes && <RecentActivity episodes={episodes} onDoSomething={() => onSelect('')} />}
        </div>

        <button
          type="button"
          onClick={() => setBrowseOpen(true)}
          className="text-foreground-subtle hover:text-foreground duration-fast mt-6 text-xs transition"
        >
          What can Atlas do?
        </button>
      </div>

      <Modal
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        label="What Atlas can help with"
        className="max-w-3xl"
      >
        <div className="border-border bg-surface max-h-[80vh] overflow-y-auto rounded-2xl border p-6 shadow-lg">
          <h2 className="text-foreground text-sm font-semibold">What Atlas can help with</h2>
          <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
            Pick a category to start typing, or just say what you need.
          </p>
          <div className="mt-5">
            <CapabilityCards
              onSelect={(starter) => {
                setBrowseOpen(false);
                onSelect(starter);
              }}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
