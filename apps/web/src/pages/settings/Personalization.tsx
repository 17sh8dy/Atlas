/**
 * Personalization — what Atlas calls you, what it calls itself, and how it
 * greets you. Backed by the existing `Fact` model through `@atlas/data`'s
 * preferences module, not a new store.
 *
 * Each field saves independently rather than behind one big "Save" button —
 * there's no form to submit, just three small facts to remember.
 */

import { useEffect, useState } from 'react';
import type { Storage, VoiceProfile } from '@atlas/core';
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
        storage={storage}
        onSaved={onVoiceProfileChange}
      />
      <Field
        label="What should Atlas call itself?"
        placeholder="Atlas"
        initial={voiceProfile.atlasName ?? ''}
        subject="atlas.name"
        storage={storage}
        onSaved={onVoiceProfileChange}
      />
      <Field
        label="Custom greeting"
        placeholder="Leave blank for a generated one"
        initial={voiceProfile.greeting ?? ''}
        subject="greeting"
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
  storage,
  onSaved,
}: {
  label: string;
  placeholder: string;
  initial: string;
  subject: 'user.name' | 'atlas.name' | 'greeting';
  storage: Storage;
  onSaved(): void;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);

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
          }}
        />
        <Button
          variant="secondary"
          size="md"
          disabled={!dirty}
          onClick={async () => {
            await writePreference(storage, subject, value);
            setSaved(true);
            onSaved();
          }}
        >
          Save
        </Button>
      </div>
      {saved && !dirty && <p className="text-primary mt-1 text-xs">Saved.</p>}
    </div>
  );
}
