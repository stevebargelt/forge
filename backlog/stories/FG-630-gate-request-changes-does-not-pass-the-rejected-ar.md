---
id: FG-630
type: story
status: active
title: gate request-changes does not pass the rejected artifact into the retry inputs — the agent revises a plan it cannot see and silently reconstructs it
created: 2026-07-27
---

**Found live 2026-07-27** across three plan-gate rounds on
`run-fg-566-shared-host-side-verification-readiness-contract-0f7edc`.

## What happens

`forge gate <taskId> request-changes --rationale "..."` creates a follow-up task for the same step.
That follow-up's `taskPackage.inputs` contains:

```
['brief', 'ticketId', 'upstream', 'requestedChanges']
```

- `upstream` carries only the **architect** artifact — the phase before.
- `requestedChanges` carries the orchestrator's rationale.
- **The rejected artifact itself is absent.** So is `rejectedTaskId` (null), even though the agent
  seeds document `inputs.rejectedTaskId` as a retry signal the agent should check.

The agent is therefore asked to *revise* an artifact it has never seen. It can only reconstruct the
prior plan from whatever the rationale happens to restate, and then re-derive everything else from
the tree.

## Observed cost

Round 2 of the FG-566 plan phase silently dropped four things the round-1 plan had:

- the review-loop observable contract's operator-surface halves (rendered loop note **and** CLI
  stdout carrying the token; zero `RoundRecord`s)
- the `review_loop.verification_finished` payload's new `readiness` field
- the `host_readiness.*` event payload shapes
- an entire disjoint step (the dashboard renderer, 3 files)

and its notes asserted *"Nothing else was restructured."* That statement read as an agent papering
over a silent removal. It was not — the agent could not diff against a plan that was never in its
inputs. The orchestrator only caught the losses by diffing the two artifacts field-by-field out of
band, and spent a third round restoring them.

Round 3's agent disclosed the gap unprompted at the top of its notes:

> DISCLOSURE FIRST: the previous plan artifact was NOT present in this task's inputs — inputs carried
> only the architect artifact and your requestedChanges. I reconstructed the accepted shape from your
> message ... If any wording in the accepted steps differed from what I have written back, that is a
> reconstruction gap, not a deliberate change.

That disclosure is the correct behavior and should not be what the contract relies on.

## Why it matters

`request-changes` is the documented way to re-run a `gate: human` step with feedback (a `reject` on a
step with no `on_reject` wedges the run). It is therefore the primary revision channel, and it
currently loses the thing being revised. The orchestrator's rationale silently becomes the **entire**
specification of the artifact, so any accepted content the rationale does not restate verbatim is at
risk on every round — and the loss surfaces as an unremarked absence rather than an error.

This is the session's recurring shape: **silence read as success**. Nothing fails; the artifact just
quietly comes back smaller.

## Acceptance criteria

1. Reproduce RED: assert that a `request-changes` follow-up task's `taskPackage.inputs` today
   contains no representation of the rejected artifact and a null `rejectedTaskId`.
2. The follow-up's inputs carry the **rejected artifact** (the prior task's `result`), under a named
   input the agent seeds already describe, so the agent can diff its revision against it.
3. `rejectedTaskId` is populated. The agent seeds already tell agents to check
   `inputs.rejectedTaskId` / `inputs.rejectedRationale`; today at least `rejectedTaskId` is null on a
   real request-changes, so the documented contract and the shipped payload disagree. Reconcile them
   — either populate the fields or fix the seeds, but they must not contradict.
4. Applies to `request-changes` on **any** phase, not just `plan` — verify against at least one
   non-plan step.
5. A revision that deliberately drops something previously accepted must be able to say so from
   evidence. Whether that is enforced (a required delta statement) or merely enabled (the artifact is
   present so a diff is possible) is a design call; state which and why.
6. `forge-test` green; required CI checks green.

## Non-scope

Not a change to gate semantics, round limits, or the `reject` vs `request-changes` distinction. This
is about what the follow-up task can *see*.

Refs: `forge gate` request-changes path, `src/v2/runNext.ts` follow-up task creation, the retry-signal
section of the agent seeds (`inputs.requestedChanges` / `inputs.rejectedRationale` /
`inputs.rejectedTaskId`). Adjacent to FG-629 (retry re-dispatching the wrong task package) — both are
defects in what a re-dispatched task is handed.
