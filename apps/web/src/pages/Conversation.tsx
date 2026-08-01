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
  skills: SkillRegistry;
  onAsk(text: string): void;
  onRunAction(skill: string, args: Record<string, string | number | boolean>): void;
  onAnswerConfirm(approved: boolean): void;
}

export function Conversation({
  entries,
  busy,
  skills,
  onAsk,
  onRunAction,
  onAnswerConfirm,
}: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <EmptyState skills={skills} onAsk={onAsk} />
        ) : (
          <Transcript
            entries={entries}
            busy={busy}
            onAnswerConfirm={onAnswerConfirm}
            onRunAction={onRunAction}
          />
        )}
      </div>

      <Composer onSubmit={onAsk} busy={busy} />
    </div>
  );
}

function EmptyState({ skills, onAsk }: { skills: SkillRegistry; onAsk(text: string): void }) {
  // Suggestions are pulled from what this build can really do. On the desktop
  // that includes files and apps; in a browser those skills aren't registered
  // at all, so they're never suggested and never disappoint.
  const available = new Set(skills.available().map((s) => s.id));
  const suggestions = [
    { when: 'files.find', text: 'find my tax pdf', icon: Icons.FileText },
    { when: 'app.open', text: 'open steam', icon: Icons.Rocket },
    { when: 'system.info', text: 'system status', icon: Icons.Activity },
    { when: 'app.list', text: 'what apps do I have installed?', icon: Icons.AppWindow },
    { when: 'web.open', text: 'open github.com', icon: Icons.Globe },
  ].filter((s) => available.has(s.when));

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-10 text-center">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-glow">
        <Icons.Compass className="h-6 w-6" />
      </div>

      <h1 className="text-lg font-semibold tracking-tight text-foreground">Atlas</h1>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-foreground-muted">
        Ask plainly and it happens. {skills.available().length} actions are ready right now —
        no account, no key, nothing sent anywhere.
      </p>

      {suggestions.length > 0 && (
        <div className="mt-6 flex w-full max-w-sm flex-col gap-1.5">
          {suggestions.map(({ text, icon: Icon }) => (
            <button
              key={text}
              type="button"
              onClick={() => onAsk(text)}
              className="flex items-center gap-2.5 rounded-lg border border-border bg-surface/50 px-3 py-2 text-left text-sm text-foreground-muted transition duration-fast hover:border-border-strong hover:bg-surface hover:text-foreground"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
