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
import type { PersonalizationField, Storage, VoiceProfile } from '@atlas/core';
import { checkPersonalization, personalizationMessage } from '@atlas/core';
import { writePreference } from '@atlas/data';
import { Button, Input } from '@atlas/ui';

interface Props {
  storage: Storage;
  voiceProfile: VoiceProfile;
  onVoiceProfileChange(): void;
}

export function Personalization({ storage, voiceProfile, onVoiceProfileChange }: Props) {
  return (
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
