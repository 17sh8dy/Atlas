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

import type { EngineStatus, SkillRegistry } from '@atlas/engine';
import { Icons } from '@atlas/ui';
import { Composer } from '../components/Composer';
import { Transcript } from '../components/Transcript';
import type { Entry } from '../atlas/useAtlas';

interface Props {
  entries: Entry[];
  busy: boolean;
  /** What Atlas is doing, when it is worth naming. */
  status?: EngineStatus | null;
  skills: SkillRegistry;
  greeting: string;
  personalized: boolean;
  atlasName: string;
  onAsk(text: string): void;
  onRunAction(skill: string, args: Record<string, string | number | boolean>): void;
  onAnswerConfirm(approved: boolean): void;
  onCopy(text: string): Promise<boolean>;
}

export function Conversation({
  entries,
  busy,
  status,
  skills,
  greeting,
  personalized,
  atlasName,
  onAsk,
  onRunAction,
  onAnswerConfirm,
  onCopy,
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
            status={status}
            onAnswerConfirm={onAnswerConfirm}
            onRunAction={onRunAction}
            onCopy={onCopy}
          />
        )}
      </div>

      <Composer onSubmit={onAsk} busy={busy} />
    </div>
  );
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
  // Suggestions are pulled from what this build can really do. On the desktop
  // that includes files and apps; in a browser those skills aren't registered
  // at all, so they're never suggested and never disappoint.
  const available = new Set(skills.available().map((s) => s.id));
  // Each one is phrased the way it would be typed, and none of them assumes
  // anything about this particular machine — a suggestion that only works if
  // you happen to own the app it names is an advert, not a suggestion.
  const suggestions = [
    { when: 'web.openBrowser', text: 'open any browser', icon: Icons.Globe },
    { when: 'system.info', text: 'system status', icon: Icons.Activity },
    { when: 'app.list', text: 'what apps do I have installed?', icon: Icons.AppWindow },
    { when: 'system.processes', text: "what's running", icon: Icons.Cpu },
    { when: 'util.password', text: 'generate a password', icon: Icons.Lock },
    { when: 'engine.help', text: 'what can you do?', icon: Icons.Sparkles },
  ].filter((s) => available.has(s.when));

  return (
    <div className="my-auto flex w-full flex-col items-center px-8 py-10 text-center">
      <div className="accent-surface text-primary-foreground shadow-glow mb-4 grid h-12 w-12 place-items-center rounded-2xl">
        <Icons.Compass className="h-6 w-6" />
      </div>

      <h1 className="text-foreground text-lg font-semibold tracking-tight">{atlasName}</h1>
      {personalized && (
        <p className="text-foreground mt-1.5 max-w-sm text-sm leading-relaxed">{greeting}</p>
      )}
      <p className="text-foreground-muted mt-1.5 max-w-sm text-sm leading-relaxed">
        Ask plainly and it happens. {skills.available().length} actions are ready right now — no
        account, no key, nothing sent anywhere.
      </p>

      {suggestions.length > 0 && (
        <div className="mt-6 w-full max-w-sm">
          <p className="text-foreground-subtle mb-2 text-left text-xs font-medium uppercase tracking-wide">
            Popular
          </p>
          <div className="grid grid-cols-2 gap-2">
            {suggestions.map(({ text, icon: Icon }) => (
              <button
                key={text}
                type="button"
                onClick={() => onAsk(text)}
                className="border-border bg-surface/50 text-foreground-muted duration-fast hover:border-border-strong hover:bg-surface hover:text-foreground flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-center text-sm transition"
              >
                <span className="bg-primary/10 text-primary grid h-9 w-9 place-items-center rounded-lg">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="leading-snug">{text}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
