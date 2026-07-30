# PRD — Evidence-Led Review Lifecycle

**Status:** confirmed. Change 0 is active; implementation is decomposed serially
into FG-638 → FG-639 → FG-640. **Changes 1 (FG-638) and 2 (FG-639) have
shipped** — see their banners under
[Change 1](#change-1--durable-ledger-and-read-surfaces) and
[Change 2](#change-2--staged-review-coordinator). Change 2 is a **pilot** through
the explicit `forge review start` / `forge review continue` verbs only: the
`feature` workflow is not migrated and no gate authority changed. Change 3 has
not started, so the Change-0 interim operating policy remains in force as written
below for any review not driven through the pilot.

**Date:** 2026-07-27

**Last revised:** 2026-07-30

**Backlog linkage:** FG-638 (durable ledger) → FG-639 (pilot coordinator) →
FG-640 (gate and feature-workflow migration)

## Objective

Replace Forge's open-ended, authoritative red/fixer loop with a durable,
evidence-led review lifecycle:

1. deterministic verification;
2. one risk-targeted discovery pass;
3. explicit disposition of every finding;
4. one batch fix for findings accepted as current scope;
5. documentation reconciliation;
6. deterministic verification of the final candidate;
7. exact recheck of the accepted finding IDs plus bounded review of the
   remediation delta;
8. shipping review against acceptance criteria and the settled ledger.

Adversarial reviewers remain an important source of evidence. They stop being
the authority that silently changes scope, threat model, or architecture.

The desired result is not fewer findings. It is a system where every finding
has stable identity, provenance, disposition, and closing evidence, and where
the stop condition is derived from that durable state rather than from a later
reviewer happening to return `pass`.

## Confirmed decisions

1. Discipline reds are advisory evidence producers; ledger disposition is the
   blocking authority.
2. Review performs one discovery pass, batches all current `fix_now` findings,
   exactly rechecks those IDs, and inspects the bounded post-discovery delta
   for regressions. New evidence returns to disposition, never an automatic
   discovery/fix loop.
3. The plan gate approves the review contract and threat model. Forge confirms
   that the final implementation surface is still plausibly covered by that
   contract immediately before discovery; material drift requires amendment.
4. Among model review roles, only shipping review remains directly
   authoritative, and only for explicit
   acceptance/evidence/ledger/identity checks.
5. A deferred finding requires a durable destination. Choosing not to create
   one is `accepted_risk`, not an invisible deferral.
6. `feature` is the first migrated workflow; legacy verdict gates remain intact
   until the new path is proven.
7. Each run persists exactly one review mode. Legacy verdict gates,
   `review-loop`, and the evidence-led lifecycle may coexist during migration,
   but their authority models are never combined within one run.

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
6. **Recheck known claims exactly and inspect what fixed them.** Recheck every
   accepted finding ID and review the bounded candidate delta created after
   discovery. New findings enter disposition as new work.
7. **Gate on settled state, not historical raw verdicts.**
8. **Reviewer selection follows declared risk.** Every feature does not need
   every discipline red.
9. **Deterministic checks run before model review.** Do not spend reviewer
   tokens explaining a typecheck or test failure.
10. **The durable review is the managed object.** The coordinator, CLI, API,
    and dashboard operate on the same review state; humans see and manage it
    when authority or intervention is required.
11. **A selected lens must actually run.** Advisory authority does not make a
    selected review optional. A missing or synthetic lens outcome is
    incomplete evidence, not a clean panel.
12. **A skipped test is never evidence.** A missing capability explains why a
    test did not execute; it does not make the skip valid evidence, and a named
    skip improves visibility but proves nothing. A skip is sound only when
    another mandatory lane executes the same assertion against the same
    candidate SHA. Where no such lane exists, the recorded outcome is
    `not_executed` or `blocked_environment` — never green.

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

Demoting a discipline red to specialist does not weaken lens completeness.
Every lens selected in the review contract must produce a schema-valid,
reviewer-authored discovery result for the confirmed candidate. A reviewer may
author `pass`, `fail`, or `inconclusive`; a crash, timeout, OOM, model error,
missing result, malformed result, or synthesized fallback does not count as
completed discovery. This expected-set rule carries FG-628's fail-closed
artifact invariant into the new authority model instead of reopening its
specialist-crash hole.

### Disposition authority

Forge distinguishes routine engineering disposition from product/policy
authority:

- The orchestrator may choose `fix_now`, `duplicate`, or `rejected_premise`
  when evidence and existing policy make the answer mechanical.
  `rejected_premise` requires candidate-bound evidence that disproves the
  finding's premise; a rationale alone is insufficient.
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

The shipping reviewer remains authoritative. This mostly formalizes duties its
current seed already performs, while narrowing free-form late finding
authority to:

- mapping every ticket acceptance criterion to evidence;
- confirming required verification exists for the reviewed candidate;
- confirming every ledger finding is settled under policy;
- confirming candidate, gate, receipt, and publication identity are continuous;
- confirming the final diff remains plausibly covered by the confirmed review
  contract and declared risk lenses;
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

The plan gate approves the initial contract. Immediately before discovery,
Forge presents the final implementation diff and affected surface for a
lightweight contract confirmation. The coordinator:

- confirms an unchanged contract when its declared lenses still plausibly
  cover the implementation;
- may add risk lenses, recording the diff evidence and reason for widening;
- returns to the original approving authority before removing a lens or
  changing `threat_model`, `protected_invariants`, `acceptance_refs`, or
  `non_goals`; and
- returns to plan/architecture rather than guessing when it cannot classify
  material drift safely.

This widening asymmetry keeps an unchanged autonomous run moving while ensuring
the coordinator can broaden review coverage but cannot silently weaken the
approved contract.

This is not a file-path classifier and does not rerun architecture. It prevents
a plan labeled "backend" from silently reaching discovery after growing a
frontend, runtime, or security-sensitive surface that its lenses do not cover.

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
confirming review contract
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
rechecking known finding IDs + remediation delta
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

### Stage 2 — contract confirmation and discovery

Confirm the approved review contract against the final implementation diff and
persist the confirmed candidate SHA. The coordinator may confirm an unchanged
contract or add lenses with recorded evidence. Removing a lens or changing any
other contract boundary requires the original approving authority. Uncertain
or scope-changing drift returns to plan/architecture. The coordinator does not
infer lenses mechanically from paths.

Run the selected risk lenses in parallel, read-only, against one recorded
candidate SHA and one confirmed review contract. Discovery is complete only
when every selected lens has a schema-valid, reviewer-authored outcome.
Reviewer-authored `inconclusive` is valid evidence that must be dispositioned;
a synthesized result for an infrastructure or output failure is not completion.
Forge normalizes an authored `inconclusive` into an untriaged
`lens_inconclusive` finding. Missing or synthetic outcomes remain an
expected-lens completeness failure; any authorized acceptance of that missing
evidence attaches to the named lens rather than pretending a review occurred.

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
`deferred`, `rejected_premise`, and `duplicate` are settled only when their
required authority, rationale, linkage, and evidence are present.
`rejected_premise` must cite candidate-bound disproving evidence such as a
replayed command and output, a deterministic reproduction, or an anchored fact
that contradicts the premise. `architecture_question` leaves the review
unsettled until the contract or finding is dispositioned by the appropriate
authority.

### Stage 5 — batch fix

Forge persists an immutable, revisioned `FixBatch` containing every current
`fix_now` finding. One fixer is dispatched with the batch ID and a verified
delivery snapshot; the persisted batch, not an assembled prose brief, is the
authoritative handoff.

The logical payload is:

```json
{
  "fix_batch_id": "fix-batch-...",
  "revision": 1,
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

Appendix A sketches the storage and delivery mechanism. It is deliberately
review-specific; this PRD does not require a general agent messaging platform.

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

### Stage 8 — exact recheck and remediation-regression review

The rechecker receives:

- every `fix_now` finding ID and its original evidence;
- the fixer's per-finding evidence;
- the confirmed discovery SHA and final candidate SHA;
- the complete delta between those SHAs, including documentation-phase changes;
- the confirmed review contract.

One dedicated `review-rechecker` role performs this stage. It receives each
finding's source lens and applicable lens instructions in addition to the full
contract, so exact recheck and delta review remain risk-aware without
redispatching the original discovery panel. When it cannot establish a
domain-specific claim, it returns `inconclusive` or a new finding to
disposition; it does not silently launch another sampling cycle.

It performs two bounded jobs: exact recheck of every known finding ID, and
discovery over the post-discovery delta plus directly adjacent production paths
needed to understand that delta. It does not resample the whole repository.
When discovery produced no `fix_now` findings and the candidate has not changed,
this stage is a no-op. Any post-discovery candidate change still receives the
bounded delta review.

For each ID it must return:

```json
{
  "finding_id": "RF-104",
  "result": "resolved | still_present | inconclusive",
  "evidence_kind": "regression_test | replayed_reproduction | anchored_verification | bounded_inspection",
  "evidence": "..."
}
```

Omission is a schema failure, never resolution.

Resolution evidence is proportional to the finding's original reachability:

- `demonstrated` requires a named regression test, replayed reproduction, or
  equivalent deterministic proof;
- `supported` requires anchored contradictory evidence plus a relevant
  verification step;
- `speculative` may be resolved by bounded inspection with its limitation
  explicit.

“Named regression test” names the behavior and invariant; it does not imply a
new finding- or ticket-named test file. Regression evidence normally extends the
canonical behavior-oriented subsystem suite. Finding and ticket identity belong
in the ledger provenance, test name, or a nearby comment. A dedicated
finding-/ticket-named file requires a recorded cross-layer capstone reason.
FG-641 owns consolidation of the existing ticket-named suite; this lifecycle
must prevent new debt but does not absorb that cleanup.

Cited test evidence must be *executed* evidence, established per test rather
than per suite. The rechecker confirms that the named test actually ran against
the current candidate SHA; a green suite containing a skipped test is not proof
that the cited assertion executed. A skipped test never resolves a finding, and
a missing capability — an absent image, an unavailable runtime, an
unprovisioned dependency — explains the skip without converting it into
evidence.

A skip is sound only when another mandatory lane executed the same assertion
against the same candidate SHA. Claiming that alternate coverage requires
naming the lane, the candidate SHA, and the executed assertion; unnamed
"covered elsewhere" is refused.

When no mandatory lane executed the required assertion, the coverage is
recorded `not_executed` — or `blocked_environment` when the environment itself
was unavailable — and the finding's result is `inconclusive`. It is never
`resolved`. Accepting that gap is a disposition decision carrying its own
authority and rationale, not a resolution.

The rechecker verifies this evidence; it does not merely repeat the fixer's
claim. If the required proof is unavailable, the result is `inconclusive`
unless the appropriate authority explicitly accepts the limitation.

The rechecker returns `new_findings` discovered in the bounded remediation
delta. New findings enter the ledger as `untriaged`; they do not automatically
dispatch another fixer. A new
demonstrably reachable violation of an explicit invariant returns immediately
to disposition. Lower-confidence observations are still recorded and
dispositioned, but do not acquire blocking force from lateness alone.

### Stage 9 — shipping review

Shipping review checks:

1. deterministic verification is green for the current candidate, with every
   required check executed rather than skipped;
2. every acceptance criterion is `met`, `unmet`, or `unproven`, with cited
   evidence that executed against the reviewed candidate SHA — mapping is
   verified per test, not by a suite exiting green, and a criterion whose only
   evidence is a skipped test is `unproven`;
3. every finding is settled;
4. every `fix_now` finding is explicitly `resolved` on executed evidence;
5. the reviewed SHA equals the trusted remote head;
6. candidate/gate/receipt/publication identity remains continuous;
7. the final diff remains plausibly covered by the confirmed review contract,
   with any post-confirmation drift reviewed or returned for amendment;
8. any claimed alternate coverage for a skipped required check names the lane,
   the candidate SHA, and the executed assertion.

`unmet` or `unproven` acceptance criteria block shipping. New free-form
findings return to disposition.

## Persistence model

Raw verdicts remain immutable in the existing `verdicts` table for provenance.
Persist `review_mode` on the run or workflow execution so legacy runs without a
`reviews` row still have one unambiguous authority model. Add two review tables.

### `reviews`

Suggested fields:

- `id`
- `run_id` and/or `subject_task_id`
- `ticket_id`
- `base_sha`
- `candidate_sha`
- `contract_confirmed_sha`
- `trusted_remote_sha`
- `contract_json`
- `lens_outcomes_json`
- `review_mode` — copied from the run for convenient read surfaces
- `state`
- `created_at`
- `updated_at`
- `settled_at`

SHA semantics:

- `base_sha` is the implementation comparison base;
- `contract_confirmed_sha` is the frozen anchor reviewed by discovery;
- `candidate_sha` is the mutable current candidate as remediation and
  documentation changes land;
- `trusted_remote_sha` is the fetched remote identity used for final
  trusted-tip equality.

Review states:

- `confirming_contract`
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
- `disposition_evidence`
- `decided_by`
- `followup_ticket_id`
- `resolution`
- `resolution_evidence_kind`
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

- any risk lens selected by the confirmed contract lacks a schema-valid,
  reviewer-authored discovery outcome for the confirmed candidate;
- any finding is `untriaged`;
- any finding is `architecture_question`;
- any `rejected_premise` lacks candidate-bound disproving evidence;
- any `fix_now` finding lacks `resolved` recheck evidence at the current SHA;
- any `fix_now` resolution lacks the evidence required for its original
  reachability;
- any `fix_now` resolution or acceptance-criterion mapping cites a test that
  did not execute against the current candidate SHA;
- deterministic verification is absent, red, or left required coverage
  unexecuted — required coverage that no mandatory lane executed is
  `not_executed`, not green;
- a skipped required check claims alternate coverage without naming the lane,
  the candidate SHA, and the executed assertion;
- shipping review reports an unmet/unproven acceptance criterion;
- reviewed-tip trust is not equality with the fetched remote head.

It does not block on:

- a raw advisory red `fail` whose findings have been dispositioned;
- `accepted_risk`, `deferred`, `rejected_premise`, or `duplicate` findings with
  the required authority, rationale, linkage, and evidence;
- historical verdicts against superseded SHAs.

An absent lens may be cleared only by retrying it, amending the review contract
through the same authority that approved it, or recording an authorized risk
acceptance that names the missing evidence. A routine finding disposition
cannot make an expected lens disappear.

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

**All four verbs have shipped.** `show` and `disposition` landed with Change 1
(FG-638); `start` and `continue`, the coordinator's verbs, landed with Change 2
(FG-639), so `forge review start` is the command that opens a review.

`disposition` shipped with the per-value precondition flags this document's
authority rules imply: `--rationale` (always required),
`--evidence`/`--evidence-kind` for `rejected_premise`, `--ticket` for `deferred`,
`--duplicate-of` for `duplicate`, `--operator` for an authority-changing
`accepted_risk` or a new deferral destination, and `--review` to scope a bare
`RF-n` ref.

`start` shipped with **`--contract <file>` required** — not sketched above, but it
follows from this document's rule that the contract is approved by the plan gate
and never reconstructed from prompts after the fact: without it `start` refuses
and writes nothing. Both verbs also carry `--add-lens <lens:reason:evidence>`
(repeatable) and `--drift <text>` for the two halves of the widening asymmetry,
`--route`/`--unrouted` for routing policy, and `--json`. `continue` adds
`--dry-run` (report the one valid next transition without running it), `--all`
(keep driving while each transition advances), and `--acceptance <file>` for the
shipping review's acceptance-criterion claims.

`start` verifies, confirms the review contract against the final diff, and
performs discovery, then stops at disposition when findings exist.

`continue` drives the one valid next transition from durable state:

- batch fix after disposition;
- verification after a fix;
- exact recheck plus bounded remediation-delta review after green verification;
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
  -> final-diff review-contract confirmation
  -> risk-targeted discovery + disposition
  -> batch remediation when required
  -> docs
  -> final deterministic verification
  -> exact recheck + remediation-delta review
  -> shipping review
  -> publication
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
  that role, amend the contract through its approval authority, or record an
  authorized acceptance of the missing evidence. Do not call the panel clean.
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
- Candidate surface changes materially after contract confirmation: return to
  contract confirmation before discovery or shipping, as appropriate.

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

### Change 0 — activate the interim operating policy

- update `docs/autonomous-run-prompt.md` and the orchestrator seed to require
  one discovery pass, explicit disposition, one targeted batch fix, and one
  known-finding plus fix-delta recheck;
- stop requiring repeated open-ended `review-loop` execution in autonomous
  runs;
- retain legacy control-plane behavior until the evidence-led mode ships; this
  is an operating-policy change, not an early implementation cutover.

Change 0 precedes Change 1 and is independent of ledger code. The interim
policy becomes active only when both authoritative sources agree.

### Change 1 — durable ledger and read surfaces

> **[SHIPPED 2026-07-30 (FG-638) — `ee72fdbf` + `e63b6194` + `1b066aa0`.]** Every
> bullet below landed. Two refinements the implementation settled that this scope
> did not state: the **run row owns `review_mode`** (a never-marked run adopts its
> first review's mode atomically; a marked run refuses a conflicting one, so the
> run and its ledger can never disagree), and `rejected_premise` evidence is
> validated **structurally** — each kind is defined by required fields
> (`replayed_command` `{command, output}`, `deterministic_reproduction`
> `{reproduction, result}`, `anchored_contradiction` `{file, line, fact}`) and
> stored as that parsed payload. Whether the payload actually *disproves* its
> finding is a semantic judgement and stayed Change 2's. At the time this shipped
> the ledger was not populated by anything; the Change 2 coordinator has since
> landed and `forge review start` is what opens a review and ingests findings.
> Gate behavior is unchanged as promised.
> The scope below is preserved as the accepted record; operator-facing detail is
> [Review ledger](../concepts.md#review-ledger) and
> [SCHEMA-CONTRACT](../SCHEMA-CONTRACT.md#reviews--review_findings-tables-fg-638-dashboard-read-path).

- additive `reviews` and `review_findings` schema/migrations;
- persisted review mode, confirmed contract SHA, and per-lens outcome
  provenance;
- store methods and lifecycle events;
- ingestion of raw verdict findings with Forge-assigned IDs;
- explicit disposition CLI;
- `forge review show` and `forge show` integration;
- read-only dashboard rendering.

This change does not alter gate behavior.

### Change 2 — staged review coordinator

> **[SHIPPED 2026-07-30 (FG-639) — `424c8d8a` + `ecf5750d` + `a5030efb`.]** Every
> bullet below landed, as a pilot reachable only through the explicit
> `forge review start` / `forge review continue` verbs: the `feature` workflow is
> NOT migrated and no gate authority changed, both of which remain Change 3. Four
> refinements the implementation settled that this scope did not state. (1) Stage
> completion is recorded **per sha** (`reviews.stage_evidence_json`) rather than as
> a stage cursor, and is checked three ways: `contract_confirmed`/`discovery`
> against the frozen `contract_confirmed_sha`; `docs`/`verified_final`/`recheck`/
> `shipping` against the moving candidate, so a docs or fixer commit re-opens
> exactly the stages after it with no reset flag to clear; and `verified_entry` on
> existence alone, since the entry gate runs once and remediation moving the
> candidate does not un-verify it. (2) `blocked_environment` is a review **state**
> and deliberately not a transition kind — the next transition out of it re-enters
> whichever verification stage blocked (entry or final, which share one code path),
> so a blocked review resumes rather than terminating; the most common concrete
> refusal is `candidate_not_checked_out`, where the workspace head is not the
> candidate under review. (3) The fix stage is the one stage checked by neither sha
> rule: its record carries the *pre*-fix candidate, so coverage is decided **per
> finding**, not per set — a finding is covered when an ingested batch carried it
> *under its current decision*, which is what lets scenario #5's four resolved
> findings proceed while the fifth becomes an architecture question. (4) A finding
> with no recorded `reachability` is treated as `demonstrated` — the strictest case
> — so an unknown reachability is not the cheap path to resolution. Note also that
> resolution invalidation fires only when the coordinator itself advances the
> candidate (the fix and docs stages); a candidate moved out of band is caught by
> the `candidate_not_checked_out` refusal and the `identity_continuity` shipping
> check instead, since `candidate_sha` is never re-read from HEAD once set. The
> scope below is
> preserved as the accepted record; operator-facing detail is
> [Review coordinator](../concepts.md#review-coordinator),
> [A skipped test is never evidence](../concepts.md#a-skipped-test-is-never-evidence),
> [review-rechecker](../concepts.md#review-rechecker), and
> [SCHEMA-CONTRACT](../SCHEMA-CONTRACT.md#fix_batches--fix_batch_results-tables-fg-639-fixbatch-delivery).

- review-contract validation;
- deterministic verification entry;
- final-diff contract confirmation;
- one discovery pass;
- selected-lens completeness enforcement;
- normalization/deduplication;
- disposition stop;
- one batch fixer;
- guaranteed docs reconciliation;
- exact-ID recheck plus bounded remediation-delta review;
- shipping-review ledger/AC check;
- `forge review start|continue`;
- recovery from persisted stage.

Pilot through explicit `forge review`; do not migrate `feature` yet.

### Change 3 — authority and workflow migration

- add `review_disposition` gate derivation;
- migrate `feature` from six authoritative build reds to the evidence-led
  lifecycle;
- risk-targeted red selection;
- formalize the shipping reviewer's existing AC/evidence/path duties and narrow
  free-form late finding authority;
- update orchestrator, red, fixer, and review skills;
- deprecate `review-loop` as the default.

Do not create additional implementation children before these three prove an
actual boundary that cannot ship together.

### Migration safety

- Persist exactly one `review_mode` per run:
  `legacy_verdict`, `legacy_review_loop`, or `evidence_led`.
- Never combine gate authority from two review modes in one run.
- Keep the coexistence window short and migrate `feature` through an explicit
  cutover rather than implicit command behavior.
- Freeze new `review-loop` workflow investment during the migration except for
  correctness, recovery, and evidence-preservation fixes. FG-541 must be
  folded into or explicitly superseded by this lifecycle before independent
  implementation.
- Change 0 activates the interim policy before ledger implementation begins;
  Change 3 replaces that temporary policy with the evidence-led default.

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
19. A fixer retry receives the same immutable FixBatch revision and verified
    payload hash; a changed disposition creates a new revision instead of
    changing the running task's inputs.
20. A fixer result that omits an expected finding ID or names a finding outside
    its FixBatch is refused during host ingestion.
21. One selected risk lens crashes while the others pass; the gate remains
    blocked because no reviewer-authored outcome exists for that lens.
22. A reviewer-authored `inconclusive` result counts as completed discovery but
    remains evidence that must be dispositioned; a synthesized inconclusive
    result does not count as completed discovery.
23. The implementation surface drifts beyond the approved risk lenses before
    discovery; Forge requires contract confirmation or amendment rather than
    guessing from file paths.
24. A fixer resolves every known finding but introduces a new reachable defect;
    bounded review of the remediation delta creates a new ledger finding.
25. `rejected_premise` without candidate-bound disproving evidence cannot
    settle a finding.
26. A demonstrated finding cannot be marked `resolved` solely from model
    re-inspection; it requires deterministic resolution evidence or an
    explicit authorized limitation.
27. The final diff adds a risk-sensitive surface not covered by the approved
    lenses; the coordinator may add the relevant lens with recorded evidence,
    but cannot remove a lens or change the threat model without the original
    approving authority.
28. The dedicated rechecker cannot establish a domain-specific resolution; it
    returns `inconclusive` to disposition rather than synthesizing closure or
    launching another discovery panel.
29. A recheck cites a test that skipped as resolution evidence; it is refused
    even though the enclosing suite exited green and the skip was named. The
    coverage is recorded `not_executed` and the finding stays `inconclusive`
    unless a named mandatory lane executed the same assertion against the same
    candidate SHA.

## Interim operating policy

Until this lifecycle ships:

- use one discovery pass rather than repeated open-ended red sampling;
- keep a manual finding ledger;
- disposition findings before dispatching a fixer;
- send all accepted findings to one targeted fixer;
- recheck the known findings explicitly once and inspect the fix delta for
  regressions;
- treat a new finding as new disposition work, not an automatic loop;
- never infer resolution from a finding not being re-raised;
- never treat a skipped test as evidence: a resolution or acceptance claim must
  name a test that actually executed against the candidate SHA, verified per
  test rather than by a suite exiting green;
- record required coverage that no mandatory lane executed as `not_executed`
  or `blocked_environment`, never as green and never as `resolved`;
- refuse unnamed "covered elsewhere": any claimed alternate coverage names the
  lane, the candidate SHA, and the executed assertion;
- do not let a red finding silently change the threat model or acceptance scope.

The alternate-lane condition is not category-wide satisfiable on Forge today,
so assume it is unmet until a specific lane is named. CI does not build the
agent image, so agent-image tests can skip there; host reruns are not required
on every merge; and FG-621's live proof is one-time operator evidence outside
CI. A skip in any of those paths is unexecuted coverage, not coverage carried
by a second mandatory lane.

`review-loop --max-rounds 1` can be used as a discovery-only stop, but its
output is not a durable ledger and must not be represented as the finished
model. This is advisory policy until `docs/autonomous-run-prompt.md` and the
orchestrator seed are updated; both currently encode the legacy repeated-loop
behavior and remain authoritative for autonomous runs. Change 0 performs that
activation before ledger implementation begins.

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

## Appendix A — Durable FixBatch storage and delivery

This appendix is an implementation sketch for the Stage 5 handoff. The
normative requirements are in the lifecycle above: a FixBatch is durable,
immutable at a revision, candidate-bound, and delivered by ID with a verified
snapshot.

### Storage split

Use SQLite for the two pieces of authoritative review-specific state that do
not already exist:

- `fix_batches`: ID, review ID, revision, candidate SHA, superseded batch ID,
  immutable payload JSON, payload hash, and creation time;
- `fix_batch_results`: batch ID, task ID, finding ID, result, structured
  evidence, and references to existing task output files.

The FixBatch payload contains the ordered finding membership; a separate join
table is unnecessary for the first consumer. The FixBatch identity and payload
do not change after creation. A changed disposition or candidate creates a new
batch revision.

Existing task rows and append-only events represent dispatch, consumption,
completion, retry, and failure. Existing per-task input/output directories hold
the immutable delivery snapshot and large evidence. SQLite stores paths and
hashes needed to bind those files to the batch; this PRD does not introduce a
second delivery ledger or a new global artifact store.

### Container delivery

Agents do not receive write access to the host control database. At dispatch,
Forge materializes an immutable input bundle in the task input mount. Its
envelope has this shape:

```json
{
  "kind": "review_fix_batch",
  "schema_version": 1,
  "fix_batch_id": "fix-batch-...",
  "revision": 1,
  "review_id": "review-...",
  "candidate_sha": "...",
  "payload_sha256": "..."
}
```

The bundle includes the structured finding set and references to any existing
task files needed by the fixer. Forge verifies the materialized payload against
the persisted hash before container start. The files are the delivery snapshot;
SQLite remains authoritative for the batch.

A FixBatch is intentionally not live-mutating. The fixer must see one stable
scope for its lifetime. If the operator changes disposition while it runs, the
existing task remains bound to its recorded revision and the coordinator
creates a superseding revision for subsequent work.

### Result ingestion

The fixer writes `result.json` and optional evidence files only to its existing
task output area. The host then:

1. validates the result schema and batch identity;
2. requires one result for every expected finding ID;
3. rejects unknown, duplicate, or omitted finding IDs;
4. stores structured results in SQLite;
5. records paths and hashes for large evidence left in the task output area;
6. records ingestion and completion events through the existing event log.

Agents never update `fix_batches`, findings, dispositions, task rows, or events
directly.

### Retry and recovery semantics

Delivery is at-least-once; durable application is idempotent. A retry of the
same work references the same FixBatch revision and payload hash. Result
ingestion is keyed by batch and task identity so repeating an ingest cannot
apply the same result twice.

An orchestrator crash resumes from the existing task row/event state and the
persisted batch. It does not reconstruct the batch from a prior brief or
reviewer output. A candidate change invalidates the batch for further dispatch
and requires a new revision.

### Deliberate boundary

Do not introduce a generic `messages` table or real-time agent inbox for this
PRD. The current workflow is coordinator-driven and pull-based; FixBatch is a
domain object, not free-form chat.

If a second concrete workflow needs durable post-dispatch communication,
revisit a shared delivery table and content-addressed artifact store using
measured payload and recovery needs. Until then, keep the implementation
review-specific and reuse task storage and events.
