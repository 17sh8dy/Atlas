/**
 * Windows services — the second Phase 11 group, and the first one that can
 * change the machine.
 *
 * The network pack set three properties for every group to copy: reads are
 * `safe`, the answer is a sentence rather than a table dump, and absence is an
 * answer. All three hold here. This group adds the two that only appear once a
 * group can *act*:
 *
 * 4. **The friendly name is resolved before anything is asked.** People say
 *    "the print spooler", not "Spooler". Resolution happens against the live
 *    list, and an ambiguous name produces the candidates rather than a guess —
 *    guessing which service to stop is exactly the wrong place to be
 *    confident.
 * 5. **Some calls are refused, not confirmed.** `guard` is the tier above
 *    `confirm`: no card is drawn for stopping the RPC service, because a card
 *    in front of something that would be declined anyway teaches people to
 *    click through the cards that matter. The list here is a pre-empt on what
 *    was typed; the real refusal is in `services.rs`, against the resolved
 *    name, next to the process that would do it.
 *
 * ⚠️ Starting and stopping services needs administrator rights, and Atlas
 * deliberately does not run elevated. `services.rs` asks Windows to ask, per
 * action: the ordinary call is tried first, and a refusal turns into the
 * system's own consent dialog naming `sc.exe`. So one of these can pause on a
 * prompt Atlas has no control over, and "you dismissed it" is a normal
 * outcome rather than an error.
 */

import type {
  Platform,
  ResultRow,
  ServiceDetail,
  ServiceEntry,
  Skill,
  SkillArgs,
} from '@atlas/core';

/**
 * Services Atlas will not stop, matched against what the user typed.
 *
 * A copy of `NEVER_STOP` in `services.rs`, and deliberately a copy rather than
 * a value fetched from it: this list exists to keep a confirmation card from
 * being drawn, which has to happen before any call is made. The list next to
 * the process is the one that decides. If the two ever disagree the machine's
 * wins, and the only consequence of this one being out of date is a card
 * appearing in front of a refusal rather than instead of it.
 */
const NEVER_STOP = [
  'rpcss',
  'rpc',
  'rpceptmapper',
  'dcomlaunch',
  'lsm',
  'samss',
  'profsvc',
  'gpsvc',
  'plugplay',
  'brokerinfrastructure',
  'systemeventsbroker',
  'eventlog',
];

/** What "the print spooler service" is asking about. */
function tidyName(raw: string): string {
  return String(raw)
    .toLowerCase()
    .replace(/^\s*(?:the|my)\s+/, '')
    .replace(/\s+service$/, '')
    .replace(/[?.!,]+$/, '')
    .trim();
}

export type ServiceMatch =
  | { kind: 'one'; entry: ServiceEntry }
  | { kind: 'none' }
  | { kind: 'many'; candidates: ServiceEntry[] };

/**
 * Which service did they mean?
 *
 * Four passes, narrowest first, and it stops at the first one that produces a
 * single answer. The order is the whole design: an exact service name must
 * beat a partial display-name match, or asking to restart "Themes" could hit
 * whatever else happens to have "themes" in its description.
 *
 * Exported because it is pure, and because the ambiguity case is the one worth
 * pinning in tests — a resolver that silently picks the first of six is
 * indistinguishable from a correct one until the day it stops the wrong
 * service.
 */
export function resolveService(services: readonly ServiceEntry[], query: string): ServiceMatch {
  const q = tidyName(query);
  if (!q) return { kind: 'none' };

  const exactName = services.filter((s) => s.name.toLowerCase() === q);
  if (exactName.length === 1) return { kind: 'one', entry: exactName[0]! };

  const exactDisplay = services.filter((s) => s.display.toLowerCase() === q);
  if (exactDisplay.length === 1) return { kind: 'one', entry: exactDisplay[0]! };

  const startsWith = services.filter(
    (s) => s.display.toLowerCase().startsWith(q) || s.name.toLowerCase().startsWith(q),
  );
  if (startsWith.length === 1) return { kind: 'one', entry: startsWith[0]! };

  const contains = services.filter(
    (s) => s.display.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
  );
  if (contains.length === 1) return { kind: 'one', entry: contains[0]! };

  // Several matched at the same specificity. Prefer the narrower pass's list,
  // so "windows update" offers the two services whose names start that way
  // rather than the nine that mention it.
  const candidates = startsWith.length ? startsWith : contains;
  if (!candidates.length) return { kind: 'none' };
  return { kind: 'many', candidates };
}

/** The pre-empt described above. Sees what was typed, not what it resolves to. */
function guardStopping(args: SkillArgs): string | null {
  const q = tidyName(String(args.name ?? ''));
  if (!q) return null;
  const hit = NEVER_STOP.find((n) => q === n || q.split(/\s+/).includes(n));
  if (!hit) return null;
  return `I won't stop that one — Windows doesn't survive losing it, and the way back is the power button.`;
}

/**
 * How a start type reads in a sentence.
 *
 * `services.rs` reports the *setting* — "automatic", "manual", "disabled" —
 * because that is what Windows configured, and adjectives are the honest shape
 * for a setting. A sentence needs a clause, and interpolating the adjective
 * straight in produces "Print Spooler is running, and starts automatic", which
 * is what the app said the first time it was driven.
 */
const STARTS: Record<string, string> = {
  automatic: 'and starts automatically',
  'automatic (delayed)': 'and starts automatically, after a delay',
  manual: 'and only starts when something asks for it',
  disabled: 'and is disabled, so nothing can start it',
  'at boot': 'and starts with Windows itself',
};

function stateWord(entry: { running: boolean; state: string }): string {
  if (entry.running) return 'running';
  if (entry.state === 'STOPPED' || entry.state === 'UNKNOWN') return 'stopped';
  // START_PENDING, STOP_PENDING, PAUSED — mid-transition, and saying
  // "stopped" for a service that is on its way up would be wrong.
  return entry.state.toLowerCase().replace(/_/g, ' ');
}

function row(entry: ServiceEntry): ResultRow {
  return {
    title: entry.display,
    subtitle: [entry.name, stateWord(entry), entry.protected ? 'protected' : '']
      .filter(Boolean)
      .join(' · '),
    icon: entry.running ? '🟢' : '⚪',
    payload: entry,
  };
}

/** "Did you mean one of these?", as rows rather than a sentence full of names. */
function offerCandidates(
  match: { candidates: ServiceEntry[] },
  query: string,
  ctx: { showResults?: (items: ResultRow[], meta?: { title?: string; subtitle?: string }) => void },
): { ok: true; spoken: true; message: '' } {
  ctx.showResults?.(match.candidates.slice(0, 12).map(row), {
    title: `${match.candidates.length} services match “${query}”`,
    subtitle: 'Say which one, by its name.',
  });
  return { ok: true, spoken: true, message: '' };
}

export function createServiceSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  const list = async (): Promise<ServiceEntry[]> => (await platform.listServices?.()) ?? [];

  skills.push({
    id: 'service.list',
    label: 'Windows services',
    icon: '⚙️',
    domain: 'system',
    description: 'List the services on this machine, running ones by default.',
    needs: ['services'],
    risk: 'safe',
    examples: ['what services are running', 'list all services'],
    params: {
      all: {
        type: 'boolean',
        default: false,
        description: 'include stopped services, not just running ones',
      },
    },
    async run(args, ctx) {
      const services = await list();
      if (!services.length) return { ok: false, error: 'I couldn’t read the services.' };

      const all = args.all === true;
      // "What services are running" is the question people actually ask, and
      // a machine has around three hundred services of which a third are
      // running. Answering with all of them is answering a question nobody
      // asked.
      const shown = all ? services : services.filter((s) => s.running);
      const running = services.filter((s) => s.running).length;

      ctx.showResults?.(shown.map(row), {
        title: all
          ? `${services.length} services`
          : `${running} running service${running === 1 ? '' : 's'}`,
        subtitle: all
          ? `${running} running, ${services.length - running} stopped`
          : `of ${services.length} installed`,
      });
      return { ok: true, spoken: true, message: '' };
    },
  });

  skills.push({
    id: 'service.status',
    label: 'Check a service',
    icon: '⚙️',
    domain: 'system',
    description: 'Whether one named Windows service is running, and how it starts.',
    needs: ['services'],
    risk: 'safe',
    examples: ['is the print spooler service running', 'status of the windows update service'],
    params: {
      name: { type: 'string', required: true, description: 'the service, by either of its names' },
    },
    async run(args, ctx) {
      const query = String(args.name ?? '');
      const match = resolveService(await list(), query);

      if (match.kind === 'none') {
        return { ok: false, error: `There’s no service called “${query}” on this machine.` };
      }
      if (match.kind === 'many') return offerCandidates(match, query, ctx);

      // The listing entry is a valid `ServiceDetail` — the extra fields are
      // optional — so it stands in when the platform has no detail method.
      const detail: ServiceDetail =
        (await platform.serviceDetail?.(match.entry.name)) ?? match.entry;
      const startType = detail.startType;
      // An unknown start type is left out rather than guessed at: Windows has
      // a couple of exotic ones, and a sentence about the state alone is still
      // a true answer to the question.
      const how = startType && STARTS[startType] ? `, ${STARTS[startType]}` : '';
      return {
        ok: true,
        message: `${detail.display} is ${stateWord(detail)}${how}.`,
        data: detail,
      };
    },
  });

  const control = (
    id: string,
    action: 'start' | 'stop' | 'restart',
    label: string,
    examples: string[],
    done: (display: string, state: string) => string,
  ): Skill => ({
    id,
    label,
    icon: '⚙️',
    domain: 'system',
    description: `${label} — a named Windows service. Needs administrator rights.`,
    needs: ['services'],
    // Changing what is running on the machine, and not something closing a
    // window undoes.
    risk: 'confirm',
    examples,
    params: {
      name: { type: 'string', required: true, description: 'the service, by either of its names' },
    },
    // Stopping and restarting both take the service down; starting one never
    // needs refusing, since the never-stop list is about losing them.
    guard: action === 'start' ? undefined : guardStopping,
    async run(args, ctx) {
      const query = String(args.name ?? '');
      const match = resolveService(await list(), query);

      if (match.kind === 'none') {
        return { ok: false, error: `There’s no service called “${query}” on this machine.` };
      }
      if (match.kind === 'many') return offerCandidates(match, query, ctx);
      if (match.entry.protected && action !== 'start') {
        // Reached when the resolved service is protected but the typed name
        // gave the guard nothing to catch — "restart the endpoint mapper".
        return {
          ok: false,
          error: `I won’t stop ${match.entry.display} — Windows doesn’t survive losing it.`,
        };
      }

      const outcome = await platform.serviceControl?.(match.entry.name, action);
      if (!outcome) return { ok: false, error: `I couldn’t ${action} ${match.entry.display}.` };

      // The note carries "it was already running", which is a better answer
      // than reporting a change that did not happen.
      if (outcome.note) {
        return { ok: true, message: `${outcome.display} — ${outcome.note}`, data: outcome };
      }
      return { ok: true, message: done(outcome.display, stateWord(outcome)), data: outcome };
    },
  });

  skills.push(
    control('service.start', 'start', 'Start a service', ['start the print spooler service'], (d, s) =>
      s === 'running' ? `${d} is running now.` : `${d} didn’t start — it’s ${s}.`,
    ),
  );
  skills.push(
    control('service.stop', 'stop', 'Stop a service', ['stop the print spooler service'], (d, s) =>
      s === 'stopped' ? `${d} is stopped.` : `${d} didn’t stop — it’s ${s}.`,
    ),
  );
  skills.push(
    control(
      'service.restart',
      'restart',
      'Restart a service',
      ['restart the print spooler service'],
      (d, s) => (s === 'running' ? `${d} restarted, and is running.` : `${d} is ${s} after that.`),
    ),
  );

  return skills;
}
