/**
 * Personalization — what Atlas calls you, what it calls itself, and how it
 * greets you. Backed by the existing `Fact` model through `@atlas/data`'s
 * preferences module, not a new store.
 *
 * Each field saves independently rather than behind one big "Save" button —
 * there's no form to submit, just three small facts to remember.
 *
 * ── Checked on the way in, not on the way out ───────────────────────────────
 * `checkPersonalization` runs before `writePreference`, so a refused value
 * never reaches storage. Validating at render instead would mean the value is
 * already saved and already in the engine's phrasing layer, and the UI would
 * be arguing with a fact that is fully in effect.
 *
 * The rules themselves live in `@atlas/core` rather than here, because they
 * are domain rules and not a property of this screen — which also means they
 * are testable without mounting React, and reusable by anything else that ever
 * sets these values.
 *
 * What the guard is *for* is in that module's header, and the short version
 * matters: it is not a profanity filter, and "Fucking Shady" is a supported
 * nickname.
 */

import { useEffect, useState } from 'react';
import type { AtlasRole, PersonalizationField, Storage, VoiceProfile } from '@atlas/core';
import {
  ATLAS_ROLES,
  ATLAS_ROLE_META,
  DEFAULT_ATLAS_ROLE,
  checkPersonalization,
  personalizationMessage,
} from '@atlas/core';
import { writePreference } from '@atlas/data';
import { Button, Icons, Input, cn } from '@atlas/ui';
import { TextAndColors } from './personalization/TextAndColors';

interface Props {
  storage: Storage;
  voiceProfile: VoiceProfile;
  onVoiceProfileChange(): void;
}

export function Personalization({ storage, voiceProfile, onVoiceProfileChange }: Props) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <Field
          label="What should Atlas call you?"
          placeholder="Your name"
          initial={voiceProfile.userName ?? ''}
          subject="user.name"
          field="userName"
          storage={storage}
          onSaved={onVoiceProfileChange}
        />
        <Field
          label="What should Atlas call itself?"
          placeholder="Atlas"
          initial={voiceProfile.atlasName ?? ''}
          subject="atlas.name"
          field="atlasName"
          storage={storage}
          onSaved={onVoiceProfileChange}
        />
        <Field
          label="Custom greeting"
          placeholder="Leave blank for a generated one"
          initial={voiceProfile.greeting ?? ''}
          subject="greeting"
          field="greeting"
          storage={storage}
          onSaved={onVoiceProfileChange}
        />
      </div>

      <RoleSection storage={storage} voiceProfile={voiceProfile} onSaved={onVoiceProfileChange} />

      <TextAndColors />
    </div>
  );
}

/**
 * Atlas Role — how Atlas works alongside you, not what it can do.
 *
 * Every role reaches the same 137 actions; picking one only changes the
 * opening line (`AtlasRoleMeta.greeting`, in `@atlas/core`'s `atlas-role.ts`)
 * — the sentence Atlas opens with before anything has been asked of it, where
 * a relationship reads differently from a straight question. The preview line
 * below the grid renders that exact function, so nobody has to open Home and
 * clear the transcript just to hear what a choice sounds like — and it goes
 * stale the instant `userName` or `atlasName` changes elsewhere on this
 * screen, which is why it is read from the live `voiceProfile` prop rather
 * than captured once.
 *
 * Deliberately not a `Field`: there is nothing to type and nothing to
 * validate — `checkPersonalization` exists for free text that could contain
 * something unsafe, and a fixed sentence chosen from seven has no such risk.
 * Selecting a card saves immediately, the same as `Appearance`'s accent
 * swatches, rather than waiting on a Save button with nothing to review.
 */
function RoleSection({
  storage,
  voiceProfile,
  onSaved,
}: {
  storage: Storage;
  voiceProfile: VoiceProfile;
  onSaved(): void;
}) {
  const role = voiceProfile.role ?? DEFAULT_ATLAS_ROLE;
  const atlasName = voiceProfile.atlasName?.trim() || 'Atlas';
  const userName = voiceProfile.userName?.trim() || undefined;
  const [pending, setPending] = useState<AtlasRole | null>(null);

  return (
    <section>
      <h2 className="text-foreground mb-1 text-sm font-medium">Atlas Role</h2>
      <p className="text-foreground-subtle mb-3 text-xs leading-relaxed">
        How Atlas works alongside you. The skills never change — only the opening line does.
      </p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ATLAS_ROLES.map((id) => {
          const meta = ATLAS_ROLE_META[id];
          const selected = id === role;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              disabled={pending !== null}
              onClick={async () => {
                if (selected) return;
                setPending(id);
                await writePreference(storage, 'role', id);
                setPending(null);
                onSaved();
              }}
              className={cn(
                'duration-fast flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition',
                'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60',
                selected
                  ? 'border-border-strong bg-surface text-foreground'
                  : 'border-border bg-surface/40 text-foreground-muted hover:bg-surface hover:text-foreground',
              )}
            >
              <span className="text-base leading-none">{meta.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-sm font-medium">{meta.label}</span>
                  {selected && <Icons.Check className="text-primary h-3.5 w-3.5 shrink-0" />}
                </span>
                <span className="text-foreground-subtle mt-0.5 block text-xs leading-relaxed">
                  {meta.feeling}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {!voiceProfile.greeting?.trim() ? (
        <p className="text-foreground-subtle mt-3 text-xs leading-relaxed">
          Opens with: <span className="text-foreground">“{ATLAS_ROLE_META[role].greeting(atlasName, userName)}”</span>
        </p>
      ) : (
        <p className="text-foreground-subtle mt-3 text-xs leading-relaxed">
          Your custom greeting above is in use, so this role's opening line won't be heard until it's
          cleared.
        </p>
      )}
    </section>
  );
}

function Field({
  label,
  placeholder,
  initial,
  subject,
  field,
  storage,
  onSaved,
}: {
  label: string;
  placeholder: string;
  initial: string;
  subject: 'user.name' | 'atlas.name' | 'greeting';
  /** Which set of rules applies. `atlasName` is held to a slightly higher bar. */
  field: PersonalizationField;
  storage: Storage;
  onSaved(): void;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The profile can change out from under this field (a reload after another
  // field saved) — stay in sync rather than showing stale text.
  useEffect(() => setValue(initial), [initial]);

  const dirty = value !== initial;

  return (
    <div>
      <label className="text-foreground mb-1.5 block text-sm font-medium">{label}</label>
      <div className="flex gap-2">
        <Input
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
            // The complaint is about what was submitted, not what is being
            // typed — leaving it up while they fix it reads as an accusation.
            setError(null);
          }}
        />
        <Button
          variant="secondary"
          size="md"
          disabled={!dirty}
          onClick={async () => {
            const checked = checkPersonalization(field, value);
            if (!checked.ok) {
              setError(personalizationMessage(field, checked.reason));
              return;
            }
            // The checked value, so trailing whitespace and invisible
            // characters do not reach storage — everything else is exactly
            // what was typed.
            await writePreference(storage, subject, checked.value);
            setError(null);
            setSaved(true);
            onSaved();
          }}
        >
          Save
        </Button>
      </div>
      {error && <p className="text-warning mt-1 text-xs">{error}</p>}
      {saved && !dirty && !error && <p className="text-primary mt-1 text-xs">Saved.</p>}
    </div>
  );
}
