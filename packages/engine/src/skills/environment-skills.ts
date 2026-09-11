/**
 * Environment variables — the third Phase 11 group, and the first one where
 * the same verb is a different risk tier depending on an argument.
 *
 * `environment.rs`'s two scopes earn two different tiers here rather than one
 * skill with a dynamic badge: a scope changes which registry key is touched
 * and whether administrator rights are needed, and `Skill.risk` is a static
 * property checked before anything runs — a single skill covering both would
 * either over-confirm the common case (your own variable, instantly
 * reversible) or under-confirm the rare one (every account on the machine,
 * behind a consent dialog). The roadmap's own risk model names "an env var for
 * the session" as the example of a reversible change that just runs — that is
 * the user scope. The system scope gets `service.start`'s treatment instead:
 * confirmed, because it needs the same elevation dance and reaches every
 * account that logs into this machine, not just the one asking.
 */

import type { EnvVar, Platform, ResultRow, Skill } from '@atlas/core';

function row(v: EnvVar): ResultRow {
  return {
    title: v.name,
    subtitle: `${v.value || '(empty)'} · ${v.scope}`,
    icon: v.scope === 'system' ? '🖥️' : '👤',
    payload: v,
  };
}

export function createEnvironmentSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  const list = async (): Promise<EnvVar[]> => (await platform.listEnvironmentVariables?.()) ?? [];

  skills.push({
    id: 'environment.list',
    label: 'Environment variables',
    icon: '⚙️',
    domain: 'system',
    description: 'List environment variables — yours, or the whole machine’s.',
    needs: ['environment'],
    risk: 'safe',
    examples: ['list my environment variables', 'what environment variables are set'],
    params: {
      scope: {
        type: 'string',
        enum: ['user', 'system', 'all'],
        default: 'all',
        description: 'whose variables to list',
      },
    },
    async run(args, ctx) {
      const vars = await list();
      if (!vars.length) return { ok: false, error: 'I couldn’t read the environment variables.' };

      const scope = String(args.scope ?? 'all');
      const shown = scope === 'all' ? vars : vars.filter((v) => v.scope === scope);
      if (!shown.length) {
        return { ok: true, message: `No ${scope} environment variables.` };
      }

      ctx.showResults?.(shown.map(row), {
        title: `${shown.length} environment variable${shown.length === 1 ? '' : 's'}`,
        subtitle: scope === 'all' ? 'user and system' : scope,
      });
      return { ok: true, spoken: true, message: '' };
    },
  });

  skills.push({
    id: 'environment.get',
    label: 'Get an environment variable',
    icon: '⚙️',
    domain: 'system',
    description: 'The value of one named environment variable.',
    needs: ['environment'],
    risk: 'safe',
    examples: ['what is the PATH environment variable', 'what is my JAVA_HOME set to'],
    params: {
      name: { type: 'string', required: true, description: 'the variable name' },
    },
    async run(args) {
      const name = String(args.name ?? '').trim();
      const vars = await list();
      const matches = vars.filter((v) => v.name.toLowerCase() === name.toLowerCase());

      if (!matches.length) {
        return { ok: false, error: `There’s no environment variable called “${name}”.` };
      }
      if (matches.length === 1) {
        const [only] = matches;
        return { ok: true, message: `${only!.name} (${only!.scope}) is “${only!.value}”.` };
      }
      // Defined in both scopes with (possibly) different values — both are
      // true at once, so both are said rather than picking one silently.
      return {
        ok: true,
        message: matches.map((v) => `${v.scope}: “${v.value}”`).join('; '),
      };
    },
  });

  skills.push({
    id: 'environment.set',
    label: 'Set an environment variable',
    icon: '⚙️',
    domain: 'system',
    description: 'Set one of your own environment variables. Takes effect for new processes.',
    needs: ['environment'],
    // The roadmap's own example of a reversible change: your own variable,
    // no administrator rights, and setting it back undoes it completely.
    risk: 'safe',
    examples: ['set the environment variable FOO to bar', 'set my JAVA_HOME to C:\\Java'],
    params: {
      name: { type: 'string', required: true, description: 'the variable name' },
      value: { type: 'string', required: true, description: 'the value to set it to' },
    },
    async run(args) {
      const name = String(args.name ?? '').trim();
      const value = String(args.value ?? '');
      const ok = await platform.setEnvironmentVariable?.(name, value, 'user');
      if (!ok) return { ok: false, error: `I couldn’t set ${name}.` };
      return {
        ok: true,
        message: `Set ${name}. Already-open programs won’t see it until they restart.`,
      };
    },
  });

  skills.push({
    id: 'environment.setSystem',
    label: 'Set a system environment variable',
    icon: '🖥️',
    domain: 'system',
    description: 'Set an environment variable for every account on this machine. Needs administrator rights.',
    needs: ['environment'],
    risk: 'confirm',
    examples: ['set the system environment variable FOO to bar for every user'],
    params: {
      name: { type: 'string', required: true, description: 'the variable name' },
      value: { type: 'string', required: true, description: 'the value to set it to' },
    },
    async run(args) {
      const name = String(args.name ?? '').trim();
      const value = String(args.value ?? '');
      const ok = await platform.setEnvironmentVariable?.(name, value, 'system');
      if (!ok) return { ok: false, error: `I couldn’t set ${name}.` };
      return {
        ok: true,
        message: `Set ${name} for every account. Already-open programs won’t see it until they restart.`,
      };
    },
  });

  skills.push({
    id: 'environment.delete',
    label: 'Remove an environment variable',
    icon: '⚙️',
    domain: 'system',
    description: 'Remove one of your own environment variables.',
    needs: ['environment'],
    risk: 'safe',
    examples: ['remove the FOO environment variable', 'delete my JAVA_HOME variable'],
    params: {
      name: { type: 'string', required: true, description: 'the variable name' },
    },
    async run(args) {
      const name = String(args.name ?? '').trim();
      const ok = await platform.deleteEnvironmentVariable?.(name, 'user');
      if (!ok) return { ok: false, error: `I couldn’t remove ${name}.` };
      return { ok: true, message: `Removed ${name}.` };
    },
  });

  skills.push({
    id: 'environment.deleteSystem',
    label: 'Remove a system environment variable',
    icon: '🖥️',
    domain: 'system',
    description: 'Remove an environment variable for every account on this machine. Needs administrator rights.',
    needs: ['environment'],
    risk: 'confirm',
    examples: ['remove the system environment variable FOO for every user'],
    params: {
      name: { type: 'string', required: true, description: 'the variable name' },
    },
    async run(args) {
      const name = String(args.name ?? '').trim();
      const ok = await platform.deleteEnvironmentVariable?.(name, 'system');
      if (!ok) return { ok: false, error: `I couldn’t remove ${name}.` };
      return { ok: true, message: `Removed ${name} for every account.` };
    },
  });

  return skills;
}
