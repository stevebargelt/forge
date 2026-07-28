# PRD — Evidence-Led Review Lifecycle

**Status:** draft for operator discussion

**Date:** 2026-07-27

**Backlog linkage:** none yet. Confirm this PRD before decomposing implementation work.

## Objective

Replace Forge's open-ended, authoritative red/fixer loop with a durable,
evidence-led review lifecycle:

1. deterministic verification;
2. one risk-targeted discovery pass;
3. explicit disposition of every finding;
4. one batch fix for findings accepted as current scope;
5. documentation reconciliation;
6. deterministic verification of the final candidate;
7. exact recheck of the accepted finding IDs;
8. shipping review against acceptance criteria and the settled ledger.

Adversarial reviewers remain an important source of evidence. They stop being
the authority that silently changes scope, threat model, or architecture.

The desired result is not fewer findings. It is a system where every finding
has stable identity, provenance, disposition, and closing evidence, and where
the stop condition is derived from that durable state rather than from a later
reviewer happening to return `pass`.

## Decisions this draft asks the operator to confirm

1. Discipline reds are advisory evidence producers; ledger disposition is the
   blocking authority.
2. Review performs one discovery pass, batches all current `fix_now` findings,
   and exactly rechecks those IDs. New evidence returns to disposition, never
   an automatic discovery/fix loop.
3. The plan gate approves the review contract and threat model before discovery.
4. Among model review roles, only shipping review remains directly
   authoritative, and only for explicit
   acceptance/evidence/ledger/identity checks.
5. A deferred finding requires a durable destination. Choosing not to create
   one is `accepted_risk`, not an invisible deferral.
6. `feature` is the first migrated workflow; legacy verdict gates remain intact
   until the new path is proven.

## Why this is needed

Forge's current prompts and control plane disagree.

The discipline-red seeds correctly say that the human gate reviewer decides
what to act on. The `feature` workflow nevertheless attaches six reds to the
build aggregate—wide, narrow, frontend, backend, security, and
shipping-reviewer—and configures every one as:

```yaml
authority: authoritative
gate_on_verdict: true
```

Any fail therefore writes `blocked_by_red`. Separately, `forge review-loop`
normalizes a red `fail` into `needs_fix`, hands every fixable finding directly
to an engineer, and then performs another open-ended review pass. The next pass
is not a check of the previous findings; it is a fresh discovery sample.

This has produced both genuine value and repeated control failures.

### Value that must be preserved

Red reviewers have found reachable defects missed by implementation and CI:

- ignored agent output being destroyed during workspace cleanup;
- stale workspace paths deleting an unrelated worktree;
- branch and registration cleanup being stranded after transient failures;
- a security check split across independently built files but dead on the
  production path;
- environment-preparation paths that passed fixtures but failed on Forge's
  native dependency graph;
- crashed, absent, or undispatched phases being summarized as success.

Removing adversarial review would discard a real Forge advantage.

### Failure modes that must be removed

- A reviewer can strengthen the threat model during implementation, and a
  fixer can encode that new architecture without an operator decision.
- Multiple correlated model opinions can make one premise look independently
  established.
- A finding can disappear from later output while remaining unfixed.
- The loop treats a new review pass as closure evidence for an earlier finding.
- Fixers receive findings serially even when several should be solved together.
- A local hardening can break the system-level contract. The FG-566 lifecycle
  suppression is the current example: installation scripts were treated as a
  unique host-code boundary even though the next gate executes
  candidate-controlled tests on that same host.
- Raw red verdicts remain terminal after the reviewed candidate changes,
  requiring a human `--force` over a verdict that no longer describes the tree.
- "Review until no new findings" has no stable convergence definition and
  rewards repeated sampling rather than completion.

## Product principles

1. **A red verdict is evidence, not scope authority.**
2. **Silence never resolves a finding.** Only an explicit disposition or
   evidence-bearing recheck can settle it.
3. **Threat model precedes security review.** A security reviewer can challenge
   it, but that challenge returns to architecture/operator judgment rather than
   going directly to a fixer.
4. **One finding has one stable Forge identity.** Multiple reviewers may add
   provenance to it.
5. **Fix accepted findings as a set.** The implementation unit is the coherent
   change, not one finding per stochastic round.
6. **Recheck known claims exactly.** New discovery during recheck is allowed but
   enters disposition as new work.
7. **Gate on settled state, not historical raw verdicts.**
8. **Reviewer selection follows declared risk.** Every feature does not need
   every discipline red.
9. **Deterministic checks run before model review.** Do not spend reviewer
   tokens explaining a typecheck or test failure.
10. **The dashboard must show the review object a human actually manages.**

## Authority model

### Discipline reds

`red-wide`, `red-narrow`, `red-frontend`, `red-backend`, and `red-security`
become advisory evidence producers in the evidence-led lifecycle:

```yaml
authority: specialist
gate_on_verdict: false
```

Their findings may ultimately block shipping, but only through the disposition
and ledger-closure rules below. Their raw verdict does not directly write
`blocked_by_red`.

### Disposition authority

Forge distinguishes routine engineering disposition from product/policy
authority:

- The orchestrator may choose `fix_now`, `duplicate`, or `rejected_premise`
  when evidence and existing policy make the answer mechanical.
- The orchestrator may choose `deferred` only when it can name an existing
  durable destination or the operator has authorized a new one. Forge does not
  automatically file a ticket for every low finding.
- `accepted_risk` requires a rationale. If it changes a stated threat model,
  product boundary, acceptance criterion, security promise, or data-integrity
  guarantee, it requires operator authority.
- A finding whose resolution would change the architecture or acceptance scope
  is classified `architecture_question`; it cannot be dispatched to a fixer
  until the question is decided and the review contract is amended.

### Shipping reviewer

The shipping reviewer remains authoritative, but its authority is narrowed to:

- mapping every ticket acceptance criterion to evidence;
- confirming required verification exists for the reviewed candidate;
- confirming every ledger finding is settled under policy;
- confirming candidate, gate, receipt, and publication identity are continuous;
- reporting documentation or closeout gaps explicitly required by the ticket.

A free-form new concern from the shipping reviewer becomes a ledger finding
and follows normal disposition. It does not gain special authority merely
because it was discovered late.

## Review contract

The plan gate persists a small review contract before code review begins:

```json
{
  "threat_model": "operator_trusted_candidate",
  "protected_invariants": [
    "candidate tree equals gated tree",
    "only Forge publishes the target branch"
  ],
  "acceptance_refs": ["FG-566 AC 1", "FG-566 AC 2"],
  "risk_lenses": ["wide", "backend", "security"],
  "non_goals": [
    "protect the host from deliberately malicious candidate test code"
  ]
}
```

The exact schema is validated and persisted with the review. It is not
reconstructed from prompts after the fact.

### Required fields

- `threat_model`: a named trust posture, with prose available in the ticket or
  architecture artifact;
- `protected_invariants`: the promises whose violation can become
  fix-before-advance irrespective of reviewer severity;
- `acceptance_refs`: ticket criteria the shipping reviewer must map;
- `risk_lenses`: selected discovery roles;
- `non_goals`: explicit boundaries reviewers must not silently expand.

The initial implementation does not build an automatic risk classifier from
file paths. The architect/tech-lead proposes the contract, and the existing
human plan gate confirms it. Automated routing based on historical data may be
considered only after this lifecycle produces trustworthy measurements.

## Lifecycle

```text
verified candidate
      |
      v
discovering
      |
      v
awaiting_disposition
      |
      +---- architecture question ----> operator/architect decision
      |
      +---- no fix_now findings ------> docs reconciliation
      |
      v
fixing (one batch)
      |
      v
docs reconciliation
      |
      v
verifying final candidate
      |
      v
rechecking known finding IDs
      |
      +---- still present/new finding -> awaiting_disposition
      |
      v
shipping review
      |
      v
settled
```

There is no `max_rounds` convergence rule in this lifecycle. A review may
return to disposition because evidence remains open, but Forge never
automatically starts another discover/fix cycle.

### Stage 1 — deterministic verification

Use the existing covering-evidence and host-readiness machinery. If the
candidate is not runnable, stop as
`verification_environment_unavailable`. No reviewer or fixer is dispatched,
and no review cycle is consumed.

If verification fails, stop on the deterministic failure. It is not converted
into a red finding.

### Stage 2 — discovery

Run the selected risk lenses in parallel, read-only, against one recorded
candidate SHA and one review contract.

The discovery prompt requires every finding to state:

- summary and evidence;
- severity and risk lens;
- source anchor where applicable;
- affected acceptance criterion or invariant, if any;
- reachability: `demonstrated`, `supported`, or `speculative`;
- whether it challenges the review contract itself;
- recommended remediation, explicitly marked as advice.

Forge mechanically validates anchors as it does today. Invalid anchored
findings remain visible as rejected evidence; they are not silently deleted.

### Stage 3 — normalization and deduplication

Forge assigns each accepted observation a stable finding ID such as `RF-104`.
Models never mint authoritative IDs.

Observations may be deduplicated when they name the same anchored mechanism and
affected invariant. Deduplication preserves every source reviewer and verdict
as provenance. It never converts correlated sources into an "independent
review count."

When Forge cannot safely determine that two observations are the same, it
keeps both. False separation is cheaper than silently merging distinct defects.

### Stage 4 — disposition

Every new finding begins `untriaged`. It must receive exactly one disposition:

- `fix_now`
- `accepted_risk`
- `deferred`
- `rejected_premise`
- `duplicate`
- `architecture_question`

Disposition records who decided, when, against which candidate, and why.

`fix_now` findings are the only findings sent to the fixer. `accepted_risk`,
`deferred`, `rejected_premise`, and `duplicate` are settled when their required
rationale/linkage is present. `architecture_question` leaves the review
unsettled until the contract or finding is dispositioned by the appropriate
authority.

### Stage 5 — batch fix

One fixer receives all `fix_now` findings in a structured payload:

```json
{
  "review_id": "review-...",
  "candidate_sha": "...",
  "findings": [
    {
      "finding_id": "RF-104",
      "summary": "...",
      "evidence": "...",
      "disposition_rationale": "..."
    }
  ]
}
```

The fixer is instructed to solve the set coherently and report, per finding:

- files changed;
- remediation summary;
- test added or existing evidence used;
- any interaction with another finding;
- any finding it believes cannot be resolved without changing scope.

The existing scope guard remains. A scope-changing conflict returns to
disposition; it is not guessed through.

### Stage 6 — docs reconciliation

Run the guaranteed documentation phase after the current remediation batch.
This phase may update the candidate, so its output must precede final
verification and recheck rather than relying on evidence bound to an earlier
SHA.

### Stage 7 — deterministic verification

Run the full required verification against the final candidate, including
documentation changes. A failing verification is a deterministic
code/environment outcome, not a reviewer opinion. It stops the lifecycle
before recheck.

### Stage 8 — exact recheck

The rechecker receives every `fix_now` finding ID and its original evidence.
When discovery produced no `fix_now` findings, this stage is a no-op rather
than a second discovery pass.
For each ID it must return:

```json
{
  "finding_id": "RF-104",
  "result": "resolved | still_present | inconclusive",
  "evidence": "..."
}
```

Omission is a schema failure, never resolution.

The rechecker may also return `new_findings`. New findings enter the ledger as
`untriaged`; they do not automatically dispatch another fixer. A new
demonstrably reachable violation of an explicit invariant returns immediately
to disposition. Lower-confidence observations are still recorded and
dispositioned, but do not acquire blocking force from lateness alone.

### Stage 9 — shipping review

Shipping review checks:

1. deterministic verification is green for the current candidate;
2. every acceptance criterion is `met`, `unmet`, or `unproven`, with cited
   evidence;
3. every finding is settled;
4. every `fix_now` finding is explicitly `resolved`;
5. the reviewed SHA equals the trusted remote head;
6. candidate/gate/receipt/publication identity remains continuous.

`unmet` or `unproven` acceptance criteria block shipping. New free-form
findings return to disposition.

## Persistence model

Raw verdicts remain immutable in the existing `verdicts` table for provenance.
Add two tables.

### `reviews`

Suggested fields:

- `id`
- `run_id` and/or `subject_task_id`
- `ticket_id`
- `base_sha`
- `candidate_sha`
- `trusted_remote_sha`
- `contract_json`
- `state`
- `created_at`
- `updated_at`
- `settled_at`

Review states:

- `discovering`
- `awaiting_disposition`
- `fixing`
- `documenting`
- `verifying`
- `rechecking`
- `shipping_review`
- `settled`
- `blocked_environment`
- `failed`

### `review_findings`

Suggested fields:

- `id`
- `review_id`
- `fingerprint`
- `summary`
- `severity`
- `risk_lens`
- `finding_type`
- `evidence`
- `hypothesis`
- `reachability`
- `file`, `line`, `quoted_text`
- `acceptance_ref`
- `invariant_ref`
- `sources_json` — raw verdict/reviewer provenance
- `disposition`
- `disposition_rationale`
- `decided_by`
- `followup_ticket_id`
- `resolution`
- `resolution_evidence`
- `discovered_sha`
- `resolved_sha`
- `created_at`
- `updated_at`

Disposition and resolution are separate:

- disposition answers what Forge decided to do;
- resolution answers whether an accepted fix is proven complete.

All state transitions also emit events. The row provides efficient current
state; events provide the audit history.

Schema changes are additive. Existing verdict and run history remains readable.

## Gate semantics

Introduce a `review_disposition` gate backed by ledger state.

It blocks when:

- any finding is `untriaged`;
- any finding is `architecture_question`;
- any `fix_now` finding lacks `resolved` recheck evidence at the current SHA;
- deterministic verification is absent or red;
- shipping review reports an unmet/unproven acceptance criterion;
- reviewed-tip trust is not equality with the fetched remote head.

It does not block on:

- a raw advisory red `fail` whose findings have been dispositioned;
- `accepted_risk`, `deferred`, `rejected_premise`, or `duplicate` findings with
  the required rationale/linkage;
- historical verdicts against superseded SHAs.

Legacy workflows retain current `verdict` gate and `blocked_by_red` behavior
during migration. Evidence-led workflows use `awaiting_gate` with the explicit
gate kind rather than adding another task status.

`--force` is not the ordinary way to settle review findings. Risk acceptance
is represented as a finding disposition with its own authority and rationale,
not as a blanket override of a stale aggregate verdict.

## CLI

Add a `forge review` command family:

```text
forge review start <ticket-id> [--since <sha>] [--project <path>]
forge review show <review-id> [--json]
forge review disposition <finding-id> <decision> --rationale "..."
forge review continue <review-id>
```

`start` verifies and performs discovery, then stops at disposition when
findings exist.

`continue` drives the one valid next transition from durable state:

- batch fix after disposition;
- verification after a fix;
- exact recheck after green verification;
- shipping review after ledger closure.

It never repeats discovery automatically.

`forge review-loop` remains available for legacy workflows during migration,
but is no longer the documented default once the new lifecycle is proven. It
should emit a deprecation note naming `forge review`. Do not silently reinterpret
`--max-rounds`; the old command retains its old semantics until removal.

## Dashboard

The dashboard presents the review ledger as the managed object.

### Review summary

- candidate SHA and trusted remote SHA;
- lifecycle stage;
- selected risk lenses;
- counts by disposition and resolution;
- deterministic verification state;
- shipping-review state;
- next required action.

### Findings

Each row shows:

- stable finding ID;
- severity, risk lens, and reachability;
- summary and source anchor;
- all source reviewers;
- affected criterion/invariant;
- disposition and rationale;
- resolution and recheck evidence;
- follow-up ticket when deferred.

The attention inbox includes `awaiting_disposition` reviews. Dashboard
disposition controls may follow after the CLI is proven; the first release may
be read-only.

## Workflow integration

The desired feature sequence is:

```text
architect
  -> plan + approved review contract
  -> build
  -> test-engineer
  -> deterministic aggregate verification
  -> evidence-led review lifecycle
  -> docs
  -> shipping review / publication
```

Review should see the combined implementation and test changes, not only the
first engineer diff.

The initial adoption changes `feature` only. Other workflows retain their
existing behavior until explicitly migrated.

Reviewer selection comes from `review_contract.risk_lenses`; do not add a
general conditional-workflow language merely to ship this PRD. The review
coordinator can resolve the small fixed lens vocabulary directly. Generalized
risk-routing syntax is future work only if another consumer needs it.

## Failure and recovery behavior

- Reviewer crash: review becomes `failed` with no verdict inferred.
- One discovery red crashes while others succeed: review is incomplete; retry
  that role or disposition its absence explicitly. Do not call the panel clean.
- Fixer crash: preserve its workspace through existing retention rules and
  leave findings `fix_now`, unresolved.
- Verification environment unavailable: `blocked_environment`; no model
  verdict on code.
- Recheck omission: structural failure; finding remains unresolved.
- Orchestrator crash: `forge review continue` resumes from persisted state and
  never repeats a completed stage solely because the process died.
- Candidate changes out of band: invalidate recheck and shipping evidence;
  return to deterministic verification. Existing dispositions remain, but
  `fix_now` resolutions must be re-established when affected.

## Out of scope

- Automatically generating backlog tickets for every deferred finding.
- A learned or file-path-based risk classifier.
- Replacing deterministic tests with model review.
- Making multiple model opinions statistically independent.
- Protecting the host from deliberately malicious candidate code; that requires
  sandboxing both setup and verification and belongs to the execution-runtime
  architecture.
- A generic policy language for every possible review organization.
- Removing legacy verdict history.
- Rewriting every workflow in the first release.
- Reviewer performance scoring as a shipping dependency.

## Implementation sequence

### Change 1 — durable ledger and read surfaces

- additive `reviews` and `review_findings` schema/migrations;
- store methods and lifecycle events;
- ingestion of raw verdict findings with Forge-assigned IDs;
- explicit disposition CLI;
- `forge review show` and `forge show` integration;
- read-only dashboard rendering.

This change does not alter gate behavior.

### Change 2 — staged review coordinator

- review-contract validation;
- deterministic verification entry;
- one discovery pass;
- normalization/deduplication;
- disposition stop;
- one batch fixer;
- guaranteed docs reconciliation;
- exact-ID recheck;
- shipping-review ledger/AC check;
- `forge review start|continue`;
- recovery from persisted stage.

Pilot through explicit `forge review`; do not migrate `feature` yet.

### Change 3 — authority and workflow migration

- add `review_disposition` gate derivation;
- migrate `feature` from six authoritative build reds to the evidence-led
  lifecycle;
- risk-targeted red selection;
- narrow shipping-reviewer authority;
- update orchestrator, red, fixer, and review skills;
- deprecate `review-loop` as the default.

Do not create additional implementation children before these three prove an
actual boundary that cannot ship together.

## Acceptance scenarios

1. A finding raised during discovery but absent from recheck remains open.
2. Two reviewers report the same anchored mechanism; one finding is created
   with both sources preserved.
3. Two superficially similar findings with different affected invariants remain
   separate.
4. Five `fix_now` findings are handed to one fixer invocation.
5. The fixer resolves four and reports one as scope-changing; the four proceed
   to recheck and the fifth becomes an architecture question.
6. Recheck resolves one finding and reports another `still_present`; the review
   returns to disposition and does not automatically launch a fixer.
7. Recheck reports a new speculative low; it is recorded untriaged and does not
   gain blocking authority merely because it arrived late.
8. Recheck reports a demonstrated data-loss path against a protected invariant;
   it returns to disposition before shipping.
9. A reviewer crashes; no pass or empty finding set is synthesized.
10. A finding omitted from reviewer JSON causes schema failure rather than
    resolution.
11. A raw historical fail against SHA A does not block SHA B after every finding
    is settled and required rechecks cover SHA B.
12. An `accepted_risk` that changes the threat model is refused without operator
    authority.
13. A deferred finding cannot settle without a durable destination authorized
    by the operator.
14. Candidate changes after recheck invalidate candidate-bound resolution and
    shipping evidence.
15. `forge review continue` after an orchestrator crash resumes the persisted
    next stage without repeating discovery.
16. The feature workflow selects only declared risk lenses rather than all
    discipline reds.
17. Shipping review cannot pass with an unmet or unproven acceptance criterion,
    even when the ledger has no open findings.
18. A clean ledger plus green deterministic verification and trusted-tip
    equality can advance without `--force`.

## Interim operating policy

Until this lifecycle ships:

- use one discovery pass rather than repeated open-ended red sampling;
- keep a manual finding ledger;
- disposition findings before dispatching a fixer;
- send all accepted findings to one targeted fixer;
- recheck the known findings explicitly once;
- treat a new finding as new disposition work, not an automatic loop;
- never infer resolution from a finding not being re-raised;
- do not let a red finding silently change the threat model or acceptance scope.

`review-loop --max-rounds 1` can be used as a discovery-only stop, but its
output is not a durable ledger and must not be represented as the finished
model.

## Reference architecture alignment

This design preserves the useful parts of Forge's adversarial-review advantage
while adopting the strongest competitive lessons already recorded:

- GasTown/GasCity: work, integration, gates, and escalation need durable visible
  objects; worker evidence is not publication authority.
- Vjeko's adversarial workflow: red/green claims should be falsifiable and
  evidence-bearing.
- Stoneforge and Agent Orchestrator: worktree isolation is not an OS security
  boundary; threat claims must match the runtime that actually executes code.
- Forge's own competitive synthesis: fewer nouns, stronger receipts,
  deterministic publication, visible readiness, and no silent success.

The one justified new noun is the review ledger itself: it replaces the
implicit state currently scattered across verdict JSON, task statuses,
review-loop markdown notes, fixer commits, and operator memory.
