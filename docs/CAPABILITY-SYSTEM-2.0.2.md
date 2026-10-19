# Atlas 2.0.2 — the capability layer

Status: **in progress on branch `atlas-2.0.2`, local only.** Nothing here is pushed, released or deployed.
This document is kept honest: what is built is marked built, what is planned is marked planned, and the
numbers are measured, not hoped for.

## 1. What I found (inspection, before any change)

The brief assumed Atlas relies on ~354 hand-wired commands and exact phrases. The codebase is further along
than that, and the plan follows from what is actually there:

| Piece | Where | What it already does |
|---|---|---|
| Skill registry | `engine/src/skills/registry.ts` | One door (`invoke`) for every action: argument validation + coercion, capability gating (`needs`), content policy, `guard`, crash containment. ~330 skill ids. |
| Capability router | `skills/router.ts` | Deterministic BM25 over each skill's label / id / examples / description. No model, no data file. Used to trim the catalog and to pick tools. |
| Model gateway | `gateway/plan.ts` | Picks `tools` / `schema` / `text` route from what the model is *known* to support; offers at most 20 tools chosen by the router; validates every step with the registry's rules; one repair re-ask. Real-app verified. |
| Goal agents | `agent/loop.ts` (+ `devagent`, `uiagent`) | Bounded observe → act → re-plan loop. Every step through the real `Executor`; untrusted-output fencing and tainting; same-failure stop; verification before "done" for project changes. **Task-specific only**: `allow()` is a fixed filter and the catalog is built once. |
| Task kernel | `task/*` | Durable multi-step tasks, per-step read-back, resume, F8 halt. |
| Executor + safety | `planner/executor.ts`, `safety/*` | Execution modes (Do It / Do It + / Plan First / Confirm Actions), `preview`, `guard`, `assess`, content policy, Allowed Folders, F8. |
| Verification | `verify/*` | `Skill.verify` read-backs; "Confirmed / Not confirmed". |
| Self test | `skills/selftest-skills.ts` | Checks the running install, including that advertised phrasings still reach their skill. |
| PowerShell broker | `skills/powershell-skills.ts`, `safety/powershell-policy.ts`, `powershell.rs` | Whole script shown, fingerprinted, refused classes, Allowed Folders, checked again in Rust. |
| Terminal | `project.terminal` | Opens an EMPTY terminal in a project. Cannot open one that runs something, and nothing reads its output. |

**Measured baseline (2026-10-18, `test/capability/baseline`):** 61 differently-worded requests across five
areas; the deterministic grammar handles **41 (67%)**. Everything else falls to a model (slow on a CPU) and,
for a small local model, often to a chatty non-answer. Several of the 41 are handled *wrongly*
("bring up Steam" → web.open, "open claude code in powershell" → an app literally named that).

## 2. The gaps, ranked by what they cost a person

1. **Wording**: "can you … for me", "please …", "fire up / boot up / get X running", trailing "please".
2. **No general capability description**: a skill's `Skill` object has no output schema, timeout, failure
   handling or availability reason that a retrieval step (or a person) can read.
3. **The goal-agent is task-specific**: no agent can choose from *all* capabilities, so a multi-step objective
   outside "build/fix a project" or "drive one app's UI" only gets a one-shot plan.
4. **No visible terminal that runs something**, and no way to see its output afterwards.
5. **No saved, approved workflows** beyond Setups (apps + windows only).
6. **No measure of coverage**: nobody can say how many task kinds work.

## 3. Design (all additive; existing tools, phrases, settings untouched)

```
request ──► A. existing grammar (unchanged, instant) ──hit──► executor
                │ miss
                ▼
        A'. paraphrase layer (polite wrappers, phrasal verbs) ──► grammar again ──hit──► executor
                │ miss
                ▼
        B. capability retrieval (families → top-K capabilities, vocabulary-expanded BM25)
                ▼
        C. gateway plan (existing, now fed better candidates) ──steps──► executor
                │ nothing
                ▼
        D. universal agent (existing agent loop, catalog re-selected EVERY step by retrieval)
                ▼
        E. executor (modes, confirmations, F8) → F. verify → G. recover / stop / ask
```

New modules (each small, each tested):

* `capabilities/` — descriptor adapter (`describeSkill`), families, vocabulary (shared by retrieval and
  paraphrase), `CapabilityIndex` (progressive disclosure), coverage model. **Reuses `Skill` metadata; no
  skill is rewritten.**
* `planner/paraphrase.ts` — only runs when the grammar returned nothing.
* `terminal` skills + native `terminal.rs` — visible terminal that runs a *policy-checked* command, transcript
  file for reading output and detecting completion/exit code. Uses the PowerShell policy; no new shell door.
* `workflow/memory.ts` + `workflow.*` skills — user-approved saved workflows, re-run through the executor with
  normal approvals every time; secrets refused, never stored.
* `universal/` — the universal agent: `runAgentTask` with an optional per-step catalog selector (one optional
  field added to `AgentTaskConfig`; absent = old behaviour).

Security rules that bound every new path: nothing bypasses `registry.invoke` or `Executor.run`; a model-written
step is validated exactly like a grammar step; approval of one step never covers another; tool output is data
(existing untrusted fencing); the new terminal path checks the command against the PowerShell policy twice
(TS and Rust) and shows the exact command before it runs.

## 4. Staged plan and honest status

| Stage | What | Status |
|---|---|---|
| 0 | Baseline measurement; "no tool disappears" guard (snapshot of every registered skill id) | planned |
| 1 | Capability descriptors, families, vocabulary, `CapabilityIndex` | planned |
| 2 | Paraphrase layer + grammar gaps found by the corpus | planned |
| 3 | Terminal capability (visible, transcript, exit code) + dev-tool detection | planned |
| 4 | Workflow memory | planned |
| 5 | Universal agent + feature flag | planned |
| 6 | Coverage report + large phrasing corpus | planned |
| 7 | Real-machine tests (release build, isolated folders) | planned |
| 8 | Performance measurements, security review, final report | planned |

Browser capabilities (brief §7): see §6 — investigated, mostly reuses UI Automation and the existing page
fetcher; not a new door.

## 5. Non-goals / things this will NOT claim

* "10,000 supported tasks." The task *space* the composition can reach is large; the number that is **verified**
  is whatever `capability-coverage` reports, and the report separates implemented / tested / partial /
  unsupported.
* Unrestricted shell. There is none.
* Silent behaviour change. The new paths run only where the old ones returned nothing, and the universal agent
  is a setting.

## 6. Browser (investigated)

Existing: `web.open*`, `web.search*`, `research.*`, `fetch_page` (read a page as untrusted text), and
`uia.*` / `input.*` which can drive a Chromium browser through its accessibility tree. What would be a *new*
door — a scripted/debug-port browser that can fill forms and download — is not added here: it would need
an explicit permission model of its own (cookies, sessions, downloads), and "do not bypass website permissions"
is hardest to guarantee there. Interim: reading pages and driving visible controls through UIA, each step
through the same executor and confirmation rules. Recorded as a known limitation, not hidden.
