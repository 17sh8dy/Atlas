# Atlas 2.0.2 — the capability layer

Status: **built and tested on branch `atlas-2.0.2`, local only.** Nothing here is pushed, released or deployed,
and the version number has not been bumped. This document says what was built, what was measured, and what was
not, in that order of importance.

## 1. What was found before anything was changed

The brief assumed Atlas relies on ~354 hand-wired commands and exact phrases. The codebase was further along than
that, and the plan followed from what was actually there:

| Piece | Where | What it already did |
|---|---|---|
| Skill registry | `engine/src/skills/registry.ts` | One door (`invoke`) for every action: argument validation + coercion, capability gating (`needs`), content policy, `guard`, crash containment. 334 skill ids in the test build (330 at the start of 2.0.2; the new ones are listed in §3). |
| Capability router | `skills/router.ts` | Deterministic BM25 over each skill's label / id / examples / description. |
| Model gateway | `gateway/plan.ts` | Picks `tools` / `schema` / `text` route from what the model is known to support; offers at most 20 tools; validates every step with the registry's rules; one repair re-ask. |
| Goal agents | `agent/loop.ts` (+ `devagent`, `uiagent`) | Bounded observe → act → re-plan loop through the real `Executor`; untrusted-output fencing and tainting; same-failure stop; verification before "done". Task-specific: `allow()` is a fixed filter and the catalog is built once. |
| Task kernel | `task/*` | Durable multi-step tasks, per-step read-back, resume, F8 halt. |
| Executor + safety | `planner/executor.ts`, `safety/*` | Execution modes, `preview`, `guard`, `assess`, content policy, Allowed Folders, F8. |
| PowerShell broker | `skills/powershell-skills.ts`, `safety/powershell-policy.ts`, `powershell.rs` | Whole script shown, fingerprinted, refused classes, Allowed Folders, checked again in Rust. |
| Terminal | `project.terminal` | Opened an EMPTY terminal in a project. Could not open one that runs something, and nothing read its output. |

## 2. Architecture (all additive; no tool, phrase or setting removed)

```
request ──► A. existing grammar (unchanged, instant) ─hit─► executor
                │ miss
                ▼
        A1a. cleaner reading preferred when manners change the match     (new, engine.ts 1a)
        A1b. second attempt with manners/greeting stripped               (existing)
        A1c. leading-verb typo fix                                       (existing)
        A1d. paraphrase layer (polite wrappers, phrasal verbs, "go ahead and") (new, planner/paraphrase.ts)
                │ miss
                ▼
        content policy → executor → triage → model plan (existing, unchanged)
                │
   (only if the person says "figure out how to…")
                ▼
        agent.solve → universal agent: the SAME agent loop, catalog re-selected every step from the
        whole registry by CapabilityIndex.disclose; every step through the real Executor.
```

Where the pieces live:

* `engine/src/capabilities/` — `describeSkill` (a read-only adapter: input schema, output envelope, permissions,
  timeout, failure modes, verification, availability; **no skill was rewritten**), `families`, `vocabulary`
  (shared by retrieval and paraphrase), `CapabilityIndex` (search + progressive disclosure).
* `engine/src/planner/paraphrase.ts` — rewrites the SHAPE of a sentence into one the rules know.
* `engine/src/planner/{terminal,workflow-memory,universal,phrasing,phrasing-simple}-grammar.ts` — plain-English
  routes to the new skills, and the phrasing fixes the corpus found.
* `engine/src/skills/terminal-skills.ts` + `apps/desktop/src-tauri/src/terminal.rs` — `terminal.open`,
  `terminal.read`, `terminal.list`, `dev.tools`.
* `engine/src/workflow/memory.ts` + `skills/workflow-memory-skills.ts` — `workflow.remember`, `workflow.replay`,
  `workflow.saved`, `workflow.forget`.
* `engine/src/universal/loop.ts` + `skills/universal-skill.ts` — `agent.solve`; `AgentTaskConfig.select` is the
  one optional field added to the shared loop (absent = old behaviour, byte-for-byte).
* `engine/test/coverage*` + `docs/CAPABILITY-COVERAGE.md` — the measuring stick (generated; see §6).

## 3. What was implemented, by stage

| Stage | What | State |
|---|---|---|
| 0 | Baseline measurement; "no tool disappears" guard (`test/baseline/skill-ids.json`, 330 ids) | built, tested |
| 1 | Capability descriptors, families, vocabulary, `CapabilityIndex` (progressive disclosure bounded at 16 hits whatever the registry size; tested at 10,000 synthetic skills) | built, tested |
| 2 | Paraphrase layer (fourth parse attempt) + measured chain helper | built, tested |
| 3 | Visible terminal (`terminal.open` runs a policy-checked command in a window that stays open and logs `[atlas-started]` / output / `[atlas-exit:N]`), `terminal.read`, `terminal.list`, `dev.tools` (fixed list, fixed version flag), Rust launcher tests that run a real PowerShell | built, tested; **window creation itself not driven by an automated test** (§8) |
| 4 | Workflow memory: save a named, user-approved list of steps; replay = ordinary execution; credentials refused; bounded | built, tested |
| 5 | Universal agent (`agent.solve`), explicit trigger only ("figure out how to…") | built, tested with a scripted model; **never run against a real model** (§8) |
| 6 | Coverage corpus (≈1,000 expanded sentences), two held-out sets, generated report, and the grammar fixes the measurement found | built, tested |
| 7 | Real-machine checks | see §8 |
| 8 | Performance, security review, this report | §5 and §4 |

New skill ids (all additive): `terminal.open`, `terminal.read`, `terminal.list`, `dev.tools`,
`workflow.remember`, `workflow.replay`, `workflow.saved`, `workflow.forget`, `agent.solve`.
New Tauri commands: `terminal_open`, `terminal_read`, `terminal_list`, `dev_tools_probe` (registered in
`authz_inventory.rs`; the two readers are exempt from the emergency stop like the other read commands).

Behaviour changes to existing paths (each is a deliberate correction, each covered by the existing 2,400-test
suite plus new tests):

1. **Engine step 1a** — if the raw sentence and the same sentence without its manners/greeting match *different*
   skills, the cleaner one wins. Fixes "list my reminders please" (read as a folder called "reminders please"),
   "hey atlas, what time is it in tokyo" (read as plain "what time is it").
2. `stripFiller` also removes "go ahead and" and a trailing "?" after a courtesy ("for me?").
3. Small regex fixes: `appVolume` no longer treats "the" or "my computer" as an app; "pull the latest changes"
   reaches `git.pull`.
4. `paraphraseCandidates` never turns "are you able to…" / "is it possible to…" into a command (those ask about
   ability) — found because a conversation-routing test failed.

## 4. Security review

Principle held throughout: **a new path chooses a skill; it never makes anything safe, and it never executes.**

| Concern | How it is handled | Evidence |
|---|---|---|
| Arbitrary shell | There is none. `terminal.open` takes a script, and applies the same refusal table (`powershellRefusal`: elevation, encoded/built-up commands, downloads, deletes, disks/registry/services/scheduled tasks, ending processes, credentials, keystrokes), the same Allowed-Folders check on every drive path, in TypeScript **and again in Rust** next to the machine. | `terminal-skills.test.ts` (refuses before a card is drawn), `terminal.rs` test `the_powershell_policy_still_applies_to_what_a_terminal_would_run` |
| Model-written commands | A model never reaches `terminal.open` except through the executor like any other skill; its script is shown in full on a card that no execution mode softens, and an approval is for that exact script (`fingerprint`, including `watch`). Swapping the script after approval is refused. | `runs only the script that was approved`, `watch is part of what was approved` |
| Launcher injection | The script is written once, verbatim, inside a script block in a file in Atlas's own folder; every path/title is a single-quoted PowerShell literal with `'` doubled; the log id can only be `term-` + hex. | `a_path_in_the_launcher_is_always_a_literal`, `an_id_can_never_be_a_path` |
| "It opened" claims | `terminal.open` reports success only after reading `[atlas-started]` back from the log; otherwise it says it did not see the window start. | `does not claim success when the launcher never reports` |
| Tool probe | `dev.tools` only ever runs programs from a fixed list, each once, with one fixed version flag; names outside the list are refused. | `only_known_tools_are_ever_probed_and_with_one_fixed_argument` |
| Emergency stop | `terminal_open` and `dev_tools_probe` check it first; the probe runs each program under `run_for`, which the stop can end. | `authz_inventory`/`halt` tests |
| Workflow memory | Replay hands steps to the ordinary `Executor`: every step is validated, previewed, confirmed and verified as if just requested; an approval at save time never pre-approves a run. Steps are re-checked against the live registry at replay, and credentials are re-checked (not trusted from storage). Agents, workflow and routine/watch creation cannot be saved into a workflow. | `workflow-memory.test.ts` (replay asks again; a "no" stops the rest; removed skill reported not guessed) |
| Secrets | A step whose argument *name* (password, token, apiKey, secret, bearer, cookie…) or *value shape* (API-key/GitHub/AWS/Slack/JWT/private-key shapes, `password=…`, card/SSN shapes) looks like a credential is refused at save, and the message never repeats the value. Nothing leaves the machine. | `credentials by field name or by shape`, `the message never repeats the secret` |
| Universal agent | Can only run what it was **shown** (this step or an earlier one) and that is not on a deny list (other agents, workflow/routine/watch creation, setups); every action is validated by the registry and run by the real `Executor` (modes, previews, confirmations, Allowed Folders, content policy, F8, read-back); output is fenced as untrusted and instruction-like text taints addresses/paths/commands so they cannot steer a later action (existing machinery, unchanged). Bounded by 14 steps and the same-failure rule. Never an automatic fallback: only "figure out how to…" starts it. | `universal-agent.test.ts` |
| Website / tool output | Unchanged and still applied: the shared loop fences every tool result as untrusted. The universal agent adds no new input channel. | existing `web/untrusted` tests |
| Phrasing layers | Rewrites are proposals judged by the same grammar, content policy, risk check and confirmation card as typed text. "not", "never", "instead", "all", "again" are never dropped (tested). Ability questions are not turned into commands. | `paraphrase.test.ts` |

Residual risks, stated plainly:

* A visible terminal is, by design, a place a person can type. Atlas only controls what it *starts*; what the
  person (or a program they approved, such as a coding assistant) then does there is outside Atlas's checks.
  That is the same trust as clicking a shortcut, and the card says what is being started.
* `watch: false` (needed for full-screen programs) means Atlas logs only start and end, not what was on screen.
* The universal agent's quality is only as good as the connected model. A weak model will choose poorly; the
  fences guarantee it cannot choose *unsafely*, not that it chooses *well*.
* The cleaner-reading preference (step 1a) is a behaviour change in a core path. It is covered by the full
  suite and the corpus, but a sentence outside both could in principle switch reading. It only fires when the
  manners-stripped text matches a *different* skill.

## 5. Performance (measured on this machine, no model)

| Measurement | Result |
|---|---|
| Understanding a sentence end-to-end (grammar + courtesy strip + typo + paraphrase) | ≈0.8 ms per sentence over 1,005 sentences |
| A sentence nothing understands (every attempt fails) | ≈0.85 ms |
| Capability disclosure over the real 334-skill registry | ≈9 ms per query |
| Prompt size as the registry grows | bounded: ≤16 hits per disclosure, tested with 10,000 added skills |

For comparison, a request that falls through to a CPU-hosted local model took ≈40 s earlier in this project.
That is the cost the deterministic layers avoid; they do not make the model path faster.

## 6. Coverage — what is and is not claimed

See `docs/CAPABILITY-COVERAGE.md` (generated by the test, not hand-written). Headline, at the time of writing:

* Main corpus (1,005 sentences, iterated against, a regression guard): 99.8% understood correctly.
* Held-out set A (since used to make fixes): 90.6% ok.
* **Held-out set B, never tuned against: 81.0% ok, 7.9% understood as the wrong skill, 11.1% not understood.**
  This is the number to trust. It means roughly one in five unfamiliar-but-ordinary sentences still needs a
  model or is misread, which is exactly the behaviour Brandon described. The wrong readings are listed by name
  in the report so they can be fixed; they were deliberately not tuned away in order to keep set B honest.
* 74 of 334 registered skills are reached by at least one measured sentence. The other 260 have their exact
  phrasings (covered by `advertised-examples.test.ts`) but no measured plain-language route yet.

**Atlas does not claim to support 10,000 tasks.** What exists is a composable system: 334 reusable operations
(+9), a router that can offer the right few to a model at any registry size, and a measured account of what
works. The number of *verified* tasks is whatever the report says it is.

## 7. Browser (investigated, not extended)

Existing: `web.open*`, `web.search*`, `research.*`, page fetch as untrusted text, and `uia.*` / `input.*` which
can drive a Chromium browser through its accessibility tree. A scripted/debug-port browser that could fill forms
and download would be a *new door* needing its own permission model (cookies, sessions, downloads); "do not bypass
website permissions" is hardest to guarantee there. It was not added. Interim: reading pages and driving visible
controls through UIA, every step through the same executor and confirmations.

## 8. Known limitations and what was NOT verified

* **Driven in the real release build (2026-10-18, Windows, WebView2 over the debug port, real data snapshotted
  and restored byte-for-byte afterwards):** "is git installed" answered `✓ git — git version 2.49.0`; "run echo
  hello-from-atlas in a terminal" drew the approval card with the full script even in Do It + mode, a real
  PowerShell window opened, `terminal_list`/`terminal_read` showed started, exit code 0 and the printed text;
  "remember that as echo test" showed the steps and saved only after a yes; "what workflows have I saved"
  listed it; "run my echo test workflow" asked for approval again and a Cancel stopped it ("stopped after 0 of 1
  steps"). Cosmetic issue seen: the saved-step label shows the raw argument `true` (the `watch` flag).
* The universal agent ran in the real app against a SCRIPTED model (a stand-in Ollama): it was shown 14 catalog lines, including the right tool and neither shutdown nor the developer agent, and finished a two-step task. No real model (Ollama or cloud) has run it, so its quality with one is unknown.
* `terminal.open`'s window creation (`CREATE_NEW_CONSOLE` + `-NoExit`) is not asserted by an automated test; the
  launcher it runs *is* (a real PowerShell executes it and the log is read back, including exit codes, thrown
  errors, non-ASCII, and the unwatched mode). A bare `cmd /c exit N` did not set `$LASTEXITCODE` under this
  machine's PowerShell while `cmd.exe /c "exit N"` did; the launcher reads `$LASTEXITCODE`, so programs started
  without `.exe` resolution may report exit 0. Noted, not fixed.
* Full-screen terminal programs (coding assistants) cannot have their screen read; Atlas knows start and end only.
* Known misreadings remain (see the coverage report), e.g. uppercase "SET THE VOLUME TO 30!" hits the
  case-sensitive environment-variable rule; "bring the volume down to 10" is read as an app name.
* `project.startServer` (start a project's dev server) from the plan was **not built**: `terminal.open` with the
  project's own command covers it once the person names the command, but detecting the right command per project
  is not done.
* The Settings UI has no toggle for the universal agent because it has no automatic path to disable.

## 9. Remaining work and suggestions

1. Drive the new skills in the real app (cards, approvals, the window) — the harness exists.
2. Run `agent.solve` against a real local model and record where it stalls.
3. Fix the wrong readings listed in the coverage report, each with a corpus row, and write a *new* held-out set
   (set B is spent the moment it is tuned against).
4. Per-project "start the dev server" detection → `terminal.open`.
5. Terminal output for full-screen programs would need a pseudo-console (ConPTY); a larger change with its own
   security review.
6. A Settings page listing saved workflows (the store has `subscribe` for it).
