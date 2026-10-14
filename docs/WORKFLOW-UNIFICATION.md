# Unifying transactional workflows with the Task Kernel — plan (not implemented)

Status: **plan for review**, 2026-10-14, `atlas-2.0`. Nothing here is built, and nothing is
required for Phase D. It exists so the two orchestration paths converge deliberately instead of
drifting.

## 1. Where things stand

Two things in the engine run "several steps as a unit":

| | Transactional workflow (1.0.9) | Task Kernel (2.0 Phase C) |
|---|---|---|
| Code | `workflow/transaction.ts`, `skills/transaction-skills.ts` | `task/kernel.ts`, `task/graph.ts`, `task/store.ts` |
| Executor | **its own `new Executor(...)`** inside `createTransactionSkills` | none: `TaskHost.run` = `Engine.run` (the one engine executor) |
| Store | `atlas.workflow.transactions`, last 30 | `atlas.tasks`, last 30 |
| Plan shape | linear steps from a sentence (`splitRequest` → `planParts` → `planFor`) | DAG with dependencies, recipes, any `Plan` via `taskPlanFromPlan` |
| Approval | **one approval card in every mode**, with a dry-run summary, then each step asks as usual | only in Plan First; other modes judge per step |
| Interruption | an in-flight step stays `running`; `workflow.resume` asks | `uncertain` unless safe to repeat; resume takes a decision per step |
| Undo | **yes**: a step's reported `undo` is kept; on failure Atlas offers to roll back newest-first through the executor | **not yet** |
| Readback | none ("verified" means the tool said so) | `Skill.verify` + step `expect` probes |
| Statuses | `committed / failed / rolled-back / partly-rolled-back / interrupted` | `done / partial / failed / cancelled / interrupted / awaiting` |

The duplication that matters is the **second `Executor` instance**. It is the same class and the
same safety code, so it is not a bypass, but it is a second place that has to be kept in step with
the engine's executor options (probes, the preapproval hook, the activity bus). The 2.0 rule
"every step goes through the one validated executor" is true of tasks and only *almost* true of
workflows.

## 2. What must be preserved

These are behaviours people can see; unification must not change them (they are pinned by
`test/transactions.test.ts`, 18 tests, which must pass **unchanged**):

1. **Validate first.** Nothing runs if any part of the sentence is not understood or a tool is
   missing. (The kernel already does this per step; the sentence-level split stays in the skill.)
2. **One approval for the whole plan, in every mode**, showing what asks and what changes
   something, and stating that each step still asks for itself.
3. **Checkpoint after every step.** (Kernel: write-ahead before and after.)
4. **Rollback where possible**: a step's reported `undo` is recorded; failure offers to put back
   the finished, undoable steps newest-first through the normal executor; steps with no undo are
   named as staying as they are.
5. **History**: the last thirty, each step with its outcome.
6. The four skill ids and phrasings: `workflow.transaction`, `workflow.resume`,
   `workflow.rollback`, `workflow.history`.

## 3. Gaps in the kernel that unification needs filled

1. **Compensation (undo).** `StepOutcome.undo` is already returned by the executor. The kernel
   must record it on `TaskStep` and offer a rollback pass that runs the undo steps **through the
   same host**, newest first, each step still asking as its own risk requires. An undo that
   cannot be run is reported, never skipped silently.
2. **Approval policy.** Add `TaskPlan.approval: 'mode' | 'always'`. `'always'` shows the plan card
   (dry-run wording from `dryRunSteps`) in every mode before anything runs and **never** turns
   into `approvedStep` for the steps (it is a consent to *start*, not to skip step cards). Default
   stays `'mode'`.
3. **Linear plans from a sentence.** Stay in the skill: `splitRequest`/`planParts` produce a
   `Plan`, `taskPlanFromPlan` makes it a task. No change to the kernel.
4. **Status mapping.** `committed` ↔ `done`; `failed` after a rollback offer ↔ `failed` +
   per-step `rolled-back` (new `TaskStepStatus`: `rolled-back`, `rollback-failed`); `interrupted`
   ↔ `interrupted`.
5. **Resume semantics.** Workflows ask one yes/no for the in-flight step; the kernel's
   per-step decision API subsumes it (the skill keeps asking one question and maps yes → `retry`).

## 4. Migration, in order

Each step is independently shippable and leaves the suite green.

| Step | Change | Risk | Done when |
|---|---|---|---|
| W1 | Kernel records `undo`; add `rolled-back`/`rollback-failed`; add rollback pass. Tests with a fake undo-bearing skill. | low (additive) | kernel suite + new rollback tests |
| W2 | `approval: 'always'` with the dry-run card. | low | a test per mode showing one card and no step pre-approval |
| W3 | Re-implement the four `workflow.*` skills as thin facades over the kernel (`TxStore` unused). `transactions.test.ts` unchanged. | **medium**: user-visible wording and ordering | the 18 existing tests pass without edits |
| W4 | Read the legacy `atlas.workflow.transactions` records as read-only task views (`taskViewFromTx`) so old history is not lost; stop writing to that key. | low | history shows old and new |
| W5 | Delete `executeTx`, `TxStore` writers and the second `Executor`. | low once W3 holds | source sweep: exactly one `new Executor` in the engine package |

W5's guard is the point: a test that **fails the build if a second `new Executor(` appears under
`packages/engine/src`** (the engine's own constructor is the only one). That turns the rule from a
convention into a check.

## 5. What this is not

- Not a rewrite of `workflow.dryRun`, `selfAudit` or `config.diff`; they only read plans.
- Not a change to Watches, Setups or Routines. Their managers keep their stores; the adapters
  already present them in the task vocabulary.
- Not a reason to add transactional guarantees the system cannot give. "All, or stop and say
  exactly what is half-done" remains the promise; a deleted file the tool did not keep still
  cannot be rolled back, and the report still says so.

## 6. Open questions

1. Should `workflow.transaction` accept dependencies in its sentence ("do A, then B and C, then
   D")? Currently strictly linear; the kernel could take more, but the sentence grammar gets
   ambiguous quickly. Recommendation: no; recipes and model plans carry DAGs.
2. Keep two skill families (`workflow.*`, `task.*`) or merge the vocabulary? Recommendation:
   keep both for 2.0 (different promises: undo-offering vs. recipe-running), share the engine.
3. Retention: 30 each today. Unified store → 30 total or 30 per family? Recommendation: 30 per
   family, one key per family, to keep existing behaviour.
