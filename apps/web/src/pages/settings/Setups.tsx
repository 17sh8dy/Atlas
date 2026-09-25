/**
 * Setups — what "get my PC ready for recording" means, written down.
 *
 * Every setup is a short list of things to open, close, arrange and check.
 * Atlas asks what a new one should mean the first time it's named; this page
 * is where the answer can be read back and changed later: remove an item, add
 * one in plain words ("put Discord on the left", "at least 50 GB on D:"), make
 * a new setup from scratch, or delete one.
 *
 * Adding an item goes through the same parser the conversation uses
 * (`parseSpec`), so a setup made here behaves exactly like one described
 * aloud — and a line it can't read is said back rather than saved as a guess.
 */

import { useEffect, useState } from 'react';
import type { Setup, SetupItem } from '@atlas/core';
import { describeItem, parseSpec, type SetupStore } from '@atlas/engine';
import { Button, Icons, Input, Modal } from '@atlas/ui';
import { timeAgo } from '../../lib/timeAgo';

interface Props {
  setups: SetupStore;
}

export function Setups({ setups }: Props) {
  const [list, setList] = useState<readonly Setup[]>(() => setups.all());
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    void setups.load();
    return setups.subscribe((next) => setList([...next]));
  }, [setups]);

  return (
    <div>
      <section className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-foreground mb-1 text-sm font-medium">Setups</h2>
          <p className="text-foreground-muted text-xs leading-relaxed">
            What “get my PC ready for …” means to you. Atlas opens and closes apps, arranges
            windows, and checks your microphone, free space and internet — then tells you what it
            actually confirmed, not just what it tried. Closing an app always asks first.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => setCreating(true)}
        >
          <Icons.Plus className="h-3.5 w-3.5" />
          New setup
        </Button>
      </section>

      {list.length === 0 ? (
        <p className="border-border bg-surface/40 text-foreground-subtle rounded-xl border px-4 py-6 text-center text-xs leading-relaxed">
          No setups yet. Say “get my PC ready for recording” and Atlas will ask what that means — or
          make one here.
        </p>
      ) : (
        <div className="space-y-4">
          {list.map((setup) => (
            <SetupCard
              key={setup.name}
              setup={setup}
              store={setups}
              onDelete={() => setDeleting(setup.name)}
            />
          ))}
        </div>
      )}

      <NewSetup open={creating} onOpenChange={setCreating} store={setups} />

      <Modal
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        label="Delete setup?"
        className="max-w-sm"
      >
        <div className="border-border bg-surface rounded-2xl border p-5 shadow-lg">
          <h2 className="text-foreground text-sm font-medium">Delete the {deleting} setup?</h2>
          <p className="text-foreground-subtle mt-1.5 text-xs leading-relaxed">
            Next time you ask for it, Atlas will ask what it should mean again.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (deleting) void setups.remove(deleting);
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function SetupCard({
  setup,
  store,
  onDelete,
}: {
  setup: Setup;
  store: SetupStore;
  onDelete(): void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = (items: SetupItem[]) => void store.save(setup.name, items);

  const add = () => {
    const parsed = parseSpec(draft);
    if (parsed.unknown.length) {
      setError(
        `Couldn’t read ${parsed.unknown.map((u) => `“${u}”`).join(', ')}. Try “open OBS”, “close Chrome”, “Discord on the left”, “check my mic”, “50 GB on D:”.`,
      );
      return;
    }
    if (!parsed.items.length) return;
    setError(null);
    setDraft('');
    save([...setup.items, ...parsed.items]);
  };

  return (
    <section className="border-border overflow-hidden rounded-xl border">
      <header className="bg-surface/60 flex items-center gap-3 px-4 py-2.5">
        <Icons.Clapperboard className="text-foreground-muted h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">{capitalize(setup.name)}</p>
          <p className="text-foreground-subtle text-xs">
            Say “get ready for {setup.name}”
            {setup.lastRunAt ? ` · last run ${timeAgo(setup.lastRunAt)}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="text-foreground-subtle hover:text-foreground rounded-md p-1.5"
          aria-label={`Delete the ${setup.name} setup`}
          title="Delete setup"
        >
          <Icons.Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      <ul className="divide-border divide-y text-sm">
        {setup.items.map((item, i) => (
          <li key={`${i}-${JSON.stringify(item)}`} className="flex items-center gap-3 px-4 py-2">
            <span className="bg-foreground-subtle/50 h-1.5 w-1.5 shrink-0 rounded-full" />
            <span className="text-foreground min-w-0 flex-1 truncate">{describeItem(item)}</span>
            <button
              type="button"
              onClick={() => save(setup.items.filter((_, j) => j !== i))}
              className="text-foreground-subtle hover:text-foreground shrink-0"
              aria-label={`Remove “${describeItem(item)}”`}
              title="Remove"
            >
              <Icons.X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>

      <div className="border-border border-t px-4 py-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add: “open Spotify”, “Discord on the left”, “50 GB on D:”"
            className="flex-1"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
        {error && <p className="text-danger mt-2 text-xs">{error}</p>}
        {setup.lastReport && (
          <p className="text-foreground-subtle mt-3 whitespace-pre-line text-xs leading-relaxed">
            Last time: {setup.lastReport}
          </p>
        )}
      </div>
    </section>
  );
}

function NewSetup({
  open,
  onOpenChange,
  store,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  store: SetupStore;
}) {
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const parsed = parseSpec(spec);
    if (!name.trim()) return setError('Give it a name — what you’ll say after “get ready for”.');
    if (parsed.unknown.length)
      return setError(`Couldn’t read ${parsed.unknown.map((u) => `“${u}”`).join(', ')}.`);
    if (!parsed.items.length) return setError('Say at least one thing it should do.');
    await store.save(name, parsed.items);
    setName('');
    setSpec('');
    setError(null);
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} label="New setup" className="max-w-md">
      <div className="border-border bg-surface rounded-2xl border p-5 shadow-lg">
        <h2 className="text-foreground text-sm font-medium">New setup</h2>
        <label className="text-foreground-muted mt-4 block text-xs">
          Get my PC ready for…
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="streaming"
            className="mt-1"
          />
        </label>
        <label className="text-foreground-muted mt-3 block text-xs">
          What it means
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            rows={3}
            placeholder="open OBS and Discord, close Chrome, put Discord on the left, check my mic, 50 GB on D:"
            className="border-border bg-background text-foreground placeholder:text-foreground-subtle mt-1 w-full rounded-lg border px-3 py-2 text-sm"
          />
        </label>
        {error && <p className="text-danger mt-2 text-xs">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void create()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
