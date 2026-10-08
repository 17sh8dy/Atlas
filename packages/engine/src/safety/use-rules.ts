/**
 * The use rules Atlas tells a connected model about, in one place.
 *
 * Nova's Acceptable Use Policy and the Atlas Terms are the authoritative rules; this is only how
 * they reach the model on the paths where Atlas ACTS (the action context, the planner, the
 * agents). It is deliberately general: no word lists. Explaining and teaching stay allowed, and
 * what is declined is helping to carry out something illegal or seriously harmful.
 *
 * It is the same whichever model is connected (Nova's, local, third-party, cloud or custom), but
 * a model may ignore it, so this is a safeguard and not a guarantee. The deterministic check in
 * `content-policy.ts` is separate and narrower.
 *
 * ⚠ The Atlas Terms (NovaLegal `atlas-terms.js`, "What Atlas sends") describe what a request
 * contains. If this wording changes in kind, that document must change with it.
 */
export const USE_RULES =
  'Atlas does not help carry out illegal or seriously harmful activity, such as harming people, ' +
  'getting into other people\'s accounts or systems without permission, fraud, or invading ' +
  "someone's privacy. Explaining and teaching about sensitive subjects is fine. If a request " +
  'is meant to carry out something like that, decline in a sentence and do not act on it. ' +
  'These rules apply whichever model is in use.';
