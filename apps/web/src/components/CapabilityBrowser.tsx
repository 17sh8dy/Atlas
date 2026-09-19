/**
 * "What can you do?" — as something a person can read.
 *
 * ── The problem it solves ───────────────────────────────────────────────────
 * Atlas can do a hundred and ten things, and until this component it proved
 * it by printing all hundred and ten in one flat list. That is an inventory,
 * not an answer. Nobody scrolls it, and the impression it leaves is not
 * "capable" but "unfinished" — the same impression a settings page full of
 * disabled switches leaves.
 *
 * Six categories with counts fit on one screen. The scale is the headline,
 * and the detail is one click away for the person who wants it.
 *
 * ── Why the naming lives here and not in the engine ─────────────────────────
 * The engine tags each row with its `domain`: "files", "system", "math".
 * Those are facts about the registry. That "math", "time" and "utility"
 * should appear to a person as one section called **Utilities** with a
 * calculator icon is a presentation decision, and presentation decisions do
 * not belong in a package that renders nothing. So the engine sends grouped
 * data, and the mapping below turns groups into sections.
 *
 * That split is also what keeps this generic: handed a result set grouped by
 * something else entirely — dates, drives — it renders those groups under
 * their own names rather than failing to find them in the table.
 */

import { useState } from 'react';
import { Icons, cn } from '@atlas/ui';
import type { ResultRow } from '@atlas/core';

type IconComponent = typeof Icons.Folder;

interface Category {
  /** What a person calls it. */
  label: string;
  icon: IconComponent;
  /** Registry domains that land here. */
  domains: readonly string[];
}

/**
 * The seven sections, in the order they are shown.
 *
 * Ordered by how often someone wants them, not alphabetically and not by
 * size: Files and System are what a desktop assistant is *for*, so they lead
 * even though Utilities is the largest bucket. Developer is last — real, but
 * not what most people open this list to find.
 */
const CATEGORIES: readonly Category[] = [
  { label: 'Files', icon: Icons.Folder, domains: ['files'] },
  {
    label: 'System',
    icon: Icons.Cpu,
    domains: ['system', 'apps', 'notifications', 'atlas', 'core', 'uiagent'],
  },
  { label: 'Web', icon: Icons.Globe, domains: ['web', 'research'] },
  { label: 'Text', icon: Icons.FileText, domains: ['text', 'clipboard'] },
  { label: 'Utilities', icon: Icons.Calculator, domains: ['utility', 'math', 'time'] },
  { label: 'Notes', icon: Icons.StickyNote, domains: ['notes', 'memory'] },
  {
    label: 'Developer',
    icon: Icons.Terminal,
    domains: ['project', 'git', 'code', 'build', 'test', 'devagent'],
  },
];

/** Every domain the table claims, for the test that nothing falls through. */
export const MAPPED_DOMAINS: readonly string[] = CATEGORIES.flatMap((c) => c.domains);

interface Section {
  label: string;
  icon: IconComponent;
  rows: ResultRow[];
}

/**
 * Rows into sections.
 *
 * Anything whose group is not in the table becomes its own section under the
 * raw group name — visible rather than silently dropped, which is what makes
 * a missing mapping something you notice instead of something that quietly
 * loses a skill.
 */
export function toSections(rows: readonly ResultRow[]): Section[] {
  const byGroup = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const key = row.group ?? '';
    const list = byGroup.get(key) ?? [];
    list.push(row);
    byGroup.set(key, list);
  }

  const sections: Section[] = [];
  const claimed = new Set<string>();

  for (const category of CATEGORIES) {
    const rowsHere = category.domains.flatMap((d) => {
      claimed.add(d);
      return byGroup.get(d) ?? [];
    });
    if (rowsHere.length) {
      sections.push({ label: category.label, icon: category.icon, rows: rowsHere });
    }
  }

  for (const [group, rowsHere] of byGroup) {
    if (claimed.has(group) || !rowsHere.length) continue;
    sections.push({
      label: group ? group[0]!.toUpperCase() + group.slice(1) : 'Other',
      icon: Icons.Sparkles,
      rows: rowsHere,
    });
  }

  return sections;
}

/**
 * A few of the things in a section, as a phrase.
 *
 * Deliberately built from the real skill labels rather than written by hand:
 * a hand-written teaser is a promise that drifts the moment a skill is added
 * or removed, and this one cannot.
 */
function teaser(rows: readonly ResultRow[]): string {
  const names = rows.slice(0, 4).map((r) => r.title.toLowerCase());
  const rest = rows.length - names.length;
  return names.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

export function CapabilityBrowser({
  rows,
  title,
  subtitle,
}: {
  rows: readonly ResultRow[];
  title?: string;
  subtitle?: string;
}) {
  const sections = toSections(rows);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="border-border bg-surface/40 max-w-[92%] overflow-hidden rounded-xl border">
      {title && (
        <div className="border-border flex items-baseline justify-between border-b px-4 py-2.5">
          <span className="text-foreground text-xs font-medium">{title}</span>
          {subtitle && <span className="text-foreground-subtle text-xs">{subtitle}</span>}
        </div>
      )}

      <ul className="divide-border divide-y">
        {sections.map((section) => {
          const expanded = open === section.label;
          const Icon = section.icon;
          return (
            <li key={section.label}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : section.label)}
                className="hover:bg-surface duration-fast flex w-full items-center gap-3 px-4 py-3 text-left transition"
              >
                <span className="bg-primary/10 text-primary grid h-8 w-8 shrink-0 place-items-center rounded-lg">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-foreground text-sm font-medium">{section.label}</span>
                    <span className="text-foreground-subtle text-xs">{section.rows.length}</span>
                  </span>
                  {/* The teaser is the whole point of the collapsed state: it
                      says what kind of thing lives in here without making
                      anyone open it. */}
                  <span className="text-foreground-subtle mt-0.5 block truncate text-xs">
                    {teaser(section.rows)}
                  </span>
                </span>
                <Icons.ChevronRight
                  className={cn(
                    'text-foreground-subtle duration-fast h-4 w-4 shrink-0 transition-transform',
                    expanded && 'rotate-90',
                  )}
                />
              </button>

              {expanded && (
                <ul className="border-border bg-background/40 border-t">
                  {section.rows.map((row, i) => (
                    <li key={`${row.title}-${i}`} className="flex items-start gap-3 px-4 py-2 pl-6">
                      <span className="mt-0.5 text-sm leading-none">{row.icon ?? '•'}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground text-sm">{row.title}</p>
                        {row.subtitle && (
                          <p className="text-foreground-subtle text-xs leading-relaxed">
                            {row.subtitle}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
