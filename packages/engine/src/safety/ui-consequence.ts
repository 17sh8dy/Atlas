/**
 * What pressing a control would actually do — worked out from what the window
 * says about it, never from the button's label alone.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Atlas has no vision. It can read a window's UI Automation tree — control
 * names, roles, the text around them — and that is all it knows about a screen.
 * "Continue", "Confirm" and "Submit" are the same word on a cookie banner and
 * on a page that is about to charge a card, so a rule that trusts the label
 * either presses both or refuses both. This looks at what surrounds the label.
 *
 * Three outcomes, and the third is the important one:
 *
 *  - the control names a consequential thing itself ("Delete", "Pay $12.00",
 *    "Send", "Install") → ask;
 *  - the control is a generic go-ahead ("Continue", "OK", "Confirm", "Submit")
 *    → ask if the window around it mentions money, sending, deleting,
 *    installing or a secret, and ask if there is *no readable context at all*;
 *  - it names an ordinary thing ("File", "Play", "Search") → press it.
 *
 * **When it cannot tell, it asks.** A control with no name, or a generic
 * go-ahead in a window that exposes no text, is not "probably fine". That is
 * the rule Brandon set for Do It?: if Atlas cannot reliably determine what an
 * action will do, it stops and asks rather than guessing.
 *
 * This is a read-only classifier over data already fetched. It never touches
 * the machine, so it can run before the person has said anything.
 */

import type { UiaNode } from '@atlas/core';

export type ConsequenceKind = 'money' | 'send' | 'destroy' | 'install' | 'secret' | 'commit';

export type Assessment = { kind: 'routine' } | { kind: 'ask'; reason: string; effect: string };

interface Rule {
  kind: ConsequenceKind;
  /** What to tell the person it could do. */
  effect: string;
  pattern: RegExp;
}

// Written as word-boundary patterns so "order" does not fire on "border" and
// "post" does not fire on "postcode"'s neighbour "compost". Lowercased input.
const RULES: readonly Rule[] = [
  {
    kind: 'money',
    effect: 'charge you or start a payment',
    pattern:
      /\b(pay|paying|payment|purchase|buy|buying|checkout|check out|place (?:your |my |the )?order|order now|subscribe|subscription|billing|credit card|debit card|card number|donate|donation|renew|upgrade now|start (?:your )?(?:free )?trial|top[- ]?up|add funds|wallet|invoice|charge)\b|[$€£¥]\s?\d|\d\s?(?:usd|eur|gbp)\b/,
  },
  {
    kind: 'send',
    effect: 'send something to someone or publish it',
    pattern: /\b(send|sending|post|publish|tweet|share|reply all|forward|broadcast)\b/,
  },
  {
    kind: 'destroy',
    effect: 'delete or overwrite something',
    pattern:
      /\b(delete|remove|erase|wipe|format (?:the |this )?(?:disk|drive|volume)|uninstall|reset|clear all|discard|permanently|factory|close (?:my |your )?account|deactivate|terminate|overwrite|replace all|empty (?:the )?recycle|shred|purge)\b/,
  },
  {
    kind: 'install',
    effect: 'install software or change the system',
    pattern:
      /\b(install|installing|run as administrator|administrator|user account control|make changes to your device|allow this app|grant|elevate|firewall|uac)\b/,
  },
  {
    kind: 'secret',
    effect: 'use or reveal something private',
    pattern:
      /\b(password|passcode|passphrase|pin code|security code|cvv|cvc|ssn|social security|secret|private key|api key|recovery (?:code|key)|two[- ]factor|2fa|verify (?:your )?identity|authenticat)/,
  },
  {
    kind: 'commit',
    effect: 'agree to something on your behalf',
    pattern:
      /\b(agree|i accept|accept (?:the )?terms|terms of (?:service|use)|sign (?:the )?contract|legally binding|authorize|authorise)\b/,
  },
];

/**
 * Words that mean "go ahead" without saying with what. Whether pressing one is
 * fine depends entirely on the window it is in.
 */
const GENERIC_GO_AHEAD =
  /^(continue|confirm|submit|ok|okay|yes|yes,? i'?m sure|next|apply|finish|done|accept|proceed|allow|complete|go|got it|agree|save|start|begin|enter|sign|yes please|do it|sure|approve|authorize|authorise)$/;

/** Roles that carry the words a person reads, as opposed to controls. */
const TEXT_ROLES = /^(text|static text|label|heading|title|document|edit|hyperlink|link|image)$/;

/** The nearest ancestor that reads as "the dialog/pane this control lives in". */
const CONTAINER_ROLES = /^(dialog|window|pane|group|document|custom|list|tab item|tab)$/;

/** How much surrounding text is worth reading. A browser exposes a whole page. */
const CONTEXT_NODE_CAP = 80;

function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/&(?=\w)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyText(text: string): { kind: ConsequenceKind; effect: string } | null {
  const t = clean(text);
  if (!t) return null;
  return RULES.find((rule) => rule.pattern.test(t)) ?? null;
}

/** The chain of nodes from the root down to (and including) the target. */
function chainTo(root: UiaNode, path: readonly number[]): UiaNode[] | null {
  const chain = [root];
  let node = root;
  for (const index of path) {
    const next = node.children[index];
    if (!next) return null;
    chain.push(next);
    node = next;
  }
  return chain;
}

function textBelow(
  node: UiaNode,
  target: readonly number[],
  out: { lines: string[]; body: string[] },
  budget: { left: number },
): void {
  if (budget.left <= 0) return;
  budget.left -= 1;
  const label = node.name.trim();
  const isTarget = node.path.join(',') === target.join(',');
  if (label && !isTarget) {
    // Every leaf is worth *scanning* — a sibling "Pay now" button is a strong
    // signal — but only real text counts as the page saying something.
    if (TEXT_ROLES.test(node.role)) out.body.push(label);
    if (TEXT_ROLES.test(node.role) || node.children.length === 0) out.lines.push(label);
  }
  for (const child of node.children) textBelow(child, target, out, budget);
}

/**
 * The text around a control. `lines` is everything worth scanning for a
 * consequential word — the names of the containers it sits in, the text and
 * the other controls in the nearest dialog or pane. `body` is only what the
 * window actually *says*, which is what tells "a window with nothing to read"
 * from "a window that reads fine". Bounded, because on a web page "the nearest
 * pane" is the entire page.
 */
export function contextText(
  root: UiaNode,
  path: readonly number[],
): { lines: string[]; body: string[] } {
  const chain = chainTo(root, path);
  const out = { lines: [] as string[], body: [] as string[] };
  if (!chain) return out;

  // Titles of everything above the control.
  for (const ancestor of chain.slice(0, -1)) {
    if (ancestor.name.trim()) out.lines.push(ancestor.name.trim());
  }

  // The nearest enclosing container, excluding the window root itself unless
  // that is all there is.
  const above = chain.slice(0, -1);
  const container =
    [...above].reverse().find((n) => CONTAINER_ROLES.test(n.role) && n !== root) ?? root;
  textBelow(container, path, out, { left: CONTEXT_NODE_CAP });
  return out;
}

export interface AssessInput {
  root: UiaNode;
  node: UiaNode;
  windowTitle: string;
}

/** What pressing `node` would do, judged from its own words and its surroundings. */
export function assessControl({ root, node, windowTitle }: AssessInput): Assessment {
  const name = node.name.trim();
  const label = name || node.automationId.trim();

  // Nothing to go on. Not "probably fine".
  if (!label) {
    return {
      kind: 'ask',
      effect: 'do something I cannot identify',
      reason: 'that control has no name, so I cannot tell what it does',
    };
  }

  // The control says what it is.
  const own = classifyText(label);
  if (own) {
    return {
      kind: 'ask',
      effect: own.effect,
      reason: `“${label}” looks like it could ${own.effect}`,
    };
  }

  const around = contextText(root, node.path);
  const context = [windowTitle, ...around.lines].filter(Boolean);

  if (GENERIC_GO_AHEAD.test(clean(label))) {
    // "Continue" is only as safe as the page it is on.
    for (const line of context) {
      const hit = classifyText(line);
      if (hit) {
        return {
          kind: 'ask',
          effect: hit.effect,
          reason: `“${label}” is a generic button, and the window around it mentions “${line.trim().slice(0, 80)}” — it could ${hit.effect}`,
        };
      }
    }
    // No body text at all — just a title and some buttons: nothing to read
    // means nothing to be sure of.
    if (around.body.length === 0) {
      return {
        kind: 'ask',
        effect: 'do something I cannot see',
        reason: `“${label}” is a generic button and this window shows me no text to tell what it would do`,
      };
    }
    return { kind: 'routine' };
  }

  // An ordinary, named control (a menu, a tab, "Play"). It is only weighed by
  // the *dialogs* that frame it: a control inside a "Delete account?" prompt is
  // part of that prompt. The window title and page text are deliberately not
  // consulted here — a browser's title is the page's, and "Search" on a shop
  // page is still just search.
  const dialogs = (chainTo(root, node.path) ?? [])
    .slice(0, -1)
    .filter((n) => n.role === 'dialog' && n.name.trim());
  for (const dialog of dialogs) {
    const hit = classifyText(dialog.name);
    if (hit) {
      return {
        kind: 'ask',
        effect: hit.effect,
        reason: `“${label}” is inside “${dialog.name.trim().slice(0, 80)}”, which could ${hit.effect}`,
      };
    }
  }

  return { kind: 'routine' };
}
