# PRD — Evidence-Led Review Lifecycle

**Status:** DELIVERED. Implementation was decomposed serially into FG-638 →
FG-639 → FG-640, and **all three changes have shipped** — see their banners under
[Change 1](#change-1--durable-ledger-and-read-surfaces),
[Change 2](#change-2--staged-review-coordinator), and
[Change 3](#change-3--authority-and-workflow-migration). The lifecycle is fully
live: the ledger is durable, the coordinator drives it, the `feature` workflow
declares `review_mode: evidence_led`, and its build gate is settled by the
`review_disposition` gate rather than by verdict aggregation. **Change 0's
interim operating policy is RETIRED** — Change 3 replaced it with the
evidence-led default in the orchestrator seed and the rendered `CLAUDE.md` block.
The Change-0 text below is preserved as the accepted historical record, not as
current policy. Unmigrated workflows keep `verdict` / `blocked_by_red` unchanged.

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

The **coordinator** commits this phase's work — the docs agent does not, and
neither does the orchestrator. It commits only the paths the agent's own result
declared and advances the candidate to the commit it authored, so the post-docs
SHA is known rather than read; see the FG-655 correction to refinement (d)
below.

A documentation-only correction discovered AFTER this stage has already
completed and recorded does not re-run it: see the FG-682 refinement below for
the bounded `forge review amend-docs` verb that lands it.

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
bounded delta review — narrowed to the amendment's own superseded→amended span
rather than the full confirmed-sha→candidate range when that change was a
FG-682 late-docs amendment (below), so an amendment recheck reviews only the
amended prose.

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
dispatch another fixer. Stage 5 is review-wide: once its single remediation
batch completes, no later disposition can create another batch or recheck
cycle inside that review. If no batch was needed, completing recheck closes the
same window; a late finding cannot become a post-recheck “first” batch. A
remaining `fix_now` finding stops at disposition
until the operator chooses a non-`fix_now` disposition and records follow-up
work where remediation is still required. A new
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
and writes nothing. Both verbs also carry the three recorded evaluations of the
final diff — `--add-lens <lens:reason:evidence>` (repeatable) and `--drift <text>`
for the two halves of the widening asymmetry, plus `--evaluated-no-drift
<statement>` to record an examined diff that needs no lens change — as well as
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
  leave findings `fix_now`, unresolved. Retry the same immutable batch; a
  failed attempt that never completed Stage 5 does not consume the review's
  single remediation cycle.
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

> **[RETIRED 2026-07-30 by Change 3 (FG-640).]** This was the interim operating
> policy that held the discipline by hand while the ledger was being built. It is
> preserved as the accepted historical record. The standing policy is now the
> evidence-led review as written in the orchestrator seed
> (`seeds/orchestrator-template.md`) and the rendered `CLAUDE.md` block: the
> ledger is durable rows rather than session notes, and the `review_disposition`
> gate reads it.

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

> **[SHIPPED 2026-07-30 (FG-639) — `424c8d8a` + `ecf5750d` + `a5030efb` +
> `5c772aa0`.]** Every
> bullet below landed, as a pilot reachable only through the explicit
> `forge review start` / `forge review continue` verbs: the `feature` workflow is
> NOT migrated and no gate authority changed, both of which remained Change 3
> **and have since shipped with it (FG-640) — read this banner as the record of
> what was true on the day Change 2 landed, not as current behavior.** Five
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
> — so an unknown reachability is not the cheap path to resolution. (5) The
> first bullet above — "confirms an unchanged contract when its declared lenses
> still plausibly cover the implementation" — has no classifier behind it by
> design, so confirmation is **fail-closed**: it needs a base sha to compute the
> diff at all, and it needs a *recorded* evaluation of that diff (a widening
> claim, an explicit `no_drift` statement, or named unclassifiable drift). An
> evaluation concluding no lens change is needed advances and is persisted with
> the diff it examined; only the silent unevaluated auto-confirm is forbidden.
> Note also that
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

> **[SHIPPED 2026-07-30 (FG-640) — `2cffe86b` + `0c465b01` + `a2007b8d`.]** Every
> bullet below landed, and with it the lifecycle is fully live: the `feature`
> workflow declares `review_mode: evidence_led`, its six build reds are
> `authority: specialist` / `gate_on_verdict: false`, and its build gate is
> settled by the ledger. Eight refinements the implementation settled that this
> scope did not state. (1) The cutover is a **workflow-level `review_mode`
> field** (`legacy_verdict` | `legacy_review_loop` | `evidence_led`, defaulting
> to `legacy_verdict`), stamped onto the run row at creation by `startRun`. No
> command flag turns it on; migrating a workflow is a visible edit to one line.
> (2) The **workflow's declaration is the source** both `gate()` and
> `dispatchReds` read, so a narrowed red panel and the gate that judges it can
> never disagree about which model applies; the run row is the durable per-run
> record and FG-638's reconciliation anchor. (3) Run/workflow disagreement is
> assessed **before** the gate branches and refuses **symmetrically** as
> `review_mode_drift` — reading either side would be the silent fallback the
> condition exists to refuse, and the reverse direction (a run stamped
> `evidence_led` under a reverted workflow) is the same defect seen from the
> other side. (4) Thirteen named blocking conditions, plus an **explicit
> non-blocking half** (`nonBlocking`) reported rather than implied: an advisory
> red `fail` whose findings are dispositioned, a settled disposition, and a
> superseded-sha decision are each things the legacy gate would have blocked on,
> so "we no longer refuse over this" is testable rather than inferred. Two of
> the thirteen are facts about the run rather than about any review —
> `review_absent` and `mixed_authority_model`, the latter keyed on the step's
> **declaration** as well as on outcomes, because a half-migrated step whose
> authoritative reds happen to pass would otherwise read settled while carrying
> two authority models. (5) The gate resolves a **run-scoped** review when no
> task-scoped one exists: `forge review start` binds a review to a ticket and a
> run and no verb binds one to a task after the fact, so a task-only lookup
> would report `review_absent` on every real run. (6) The third absent-lens
> clearing route is mechanized as an operator verb, `forge review accept-lens`
> — `--operator` required, the missing evidence named, bound to the confirmed
> candidate, stored beside the outcomes in its own shape so nothing reads it as
> a review that happened. (7) The shipping review gained an **eighth** check,
> `docs_closeout` (the reviewer's sixth duty), where an omitted assessment
> blocks exactly as a named gap does; free-form late findings are now **ingested
> as ordinary untriaged ledger rows** rather than only reported, deduplicated by
> summary so a re-entered Stage 9 does not append the same concern again. (8)
> Stage 9 persists `trusted_remote_sha` when tip trust is equality, because the
> gate is a read of durable state and cannot re-fetch — without it the gate
> would be permanently stuck on `tip_not_trusted`. The scope below is preserved
> as the accepted record; operator-facing detail is
> [`review_disposition` gate](../concepts.md#review_disposition-gate),
> [Review coordinator](../concepts.md#review-coordinator),
> [Review ledger](../concepts.md#review-ledger),
> [Shipping Reviewer](../concepts.md#shipping-reviewer), and
> [SCHEMA-CONTRACT](../SCHEMA-CONTRACT.md#fg-640-gate-and-lens-selection-events).

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

### FG-649 refinement — fix-cycle commit authority and unresolved-only batches

> **[SHIPPED 2026-07-30 (FG-649).]** A lifecycle correctness defect observed
> live on `review-29d1000750b0`: the fix stage recorded the candidate the
> review already had, because the coordinator read HEAD immediately after
> ingestion while the ORCHESTRATOR did the commit — after the process had
> exited. Recheck was therefore bound to a tree the fixes were not in, honestly
> reported `still_present`, and — since an unresolved `fix_now` is a
> disposition blocker and no verb moves a candidate — the review could only be
> freed by re-anchoring the row by hand. Four semantics decisions are recorded
> here so they are not re-derived, or silently regressed, later.
>
> **(a) Commit authority for the fix cycle moved from the orchestrator to the
> coordinator.** Stage 5 now commits the fixer's work itself and advances the
> candidate to the commit it authored, so the post-fix sha is *known* rather
> than inferred from a HEAD read that races the committer. It commits ONLY the
> paths the batch's own results declared (`fix_batch_results.files_changed_json`)
> — never `git add -A` — and reconciles the worktree against that declared set,
> refusing by name (`fix_cycle_declared_changes_absent`,
> `fix_cycle_tree_dirty_outside_declared_scope`, `fix_cycle_commit_failed`,
> `fix_cycle_commit_raced`) with the stage left open and nothing recorded. The
> reconciliation is TWO-DIRECTIONAL and its two directions are deliberately not
> the same stop: a tree that moved beyond the declaration refuses, a wholly
> unsupported declaration refuses, but a PARTLY supported one commits what moved
> and NAMES what did not (`meta.fixCommit.declaredNotMoved`) — `committed ⊆
> declared` still holds, and refusing there would dead-end a converging review
> whose next cycle honestly declares a file it already committed. Its commit
> subject deliberately does not reference the ticket, because a later review
> infers its comparison base from the oldest commit whose subject does; the
> subject is ALSO the per-revision idempotency key that lets a crash between the
> irreversible git commit and the ledger writes recording it be RECOVERED
> (subject match AND candidate anchor, never either alone) rather than refusing
> forever — the same stuck loop in a second form. Recognition IDENTIFIES the
> commit; it does not vet it, so a recognized commit is adopted only on the
> SAME predicate the post-commit check applies (one parent, that parent — or,
> once the candidate advance has landed, the commit itself — the candidate, and
> no undeclared path), and otherwise refuses `fix_cycle_commit_raced` under that
> name. One question, one answer: a weaker recovery test would make the
> post-commit refusal reversible by the next `continue`, adopting through the
> other door exactly what it just refused. Because the
> advance goes through the single place the candidate ever moves, scenario #14
> invalidation fires by construction and Stages 6–9 re-anchor through the
> existing per-sha rules with no new key. The fix stage record's own sha is
> UNCHANGED — still the pre-fix candidate, since coverage is per finding
> (refinement 3 of Change 2); the post-fix sha is `meta.candidateAfter`, which
> before this change recorded a read that could not have moved. A companion
> boundary: `forge review continue` resolves its dispatch workspace from the
> persisted review row rather than cwd (`review_workspace_unbound` /
> `review_workspace_unusable` / `review_workspace_identity_mismatch`), because
> a wrong workspace is no longer a wrong read but a write into a different
> repository — and a `--dry-run` preview resolves and refuses identically but
> RECORDS nothing, since rebinding which repository later stages commit into is
> not a change a preview may make.
>
> **(b) A fix batch carries the UNRESOLVED `fix_now` findings only.** RF-8: a
> `fix_now` already `resolved` at the current candidate is not re-dispatched
> and its resolution is preserved — preserved by NON-MEMBERSHIP in the batch,
> since fix-cycle invalidation is scoped to batch membership. No preservation
> flag and no third invalidation authority were added; invalidation stays
> exactly the candidate advance and the fix cycle. The narrowing is applied to
> what goes INTO a payload and never as a filter at ingestion, so the delivered
> scope and the judged scope (Appendix A) cannot disagree. A retry still
> receives the same immutable revision and payload hash. A changed decision
> can mint a replacement revision only while Stage 5 has not completed; once
> the fix stage record exists, the review-wide one-batch boundary wins and the
> decision returns to disposition for follow-up.
>
> **(c) Correction, 2026-08-01: an extra completed fix/recheck cycle is NOT
> accepted.** The earlier refinement treated “return to disposition, no
> automatic fixer” as satisfied when a fresh disposition could immediately
> mint revision n+1. That was the loophole that recreated the open-ended loop
> this PRD replaced. `fixCycleKey` remains monotone for crash recovery,
> pre-completion replacement revisions, and legacy rows, but one completed fix
> stage — or completed recheck when no fix stage was needed — is the
> cardinality boundary for all new transitions.
>
> **(d) The pinned-candidate invariant is UNCHANGED.** No path adopts the
> candidate from a bare HEAD read outside a coordinator-driven stage —
> including as a migration convenience. `candidate_not_checked_out` and the
> `identity_continuity` shipping check therefore remain real detectors and not
> tautologies the coordinator satisfies by construction. Relaxing this would be
> a change to the lifecycle's stated semantics and returns to this PRD's
> approving authority.
>
> **Correction, 2026-08-05 (FG-655): the invariant above was UNCHANGED and is
> still unchanged — what was wrong is that Stage 6's code did not honour it.**
> (d) described intent accurately and Stage 5's code accurately, and described
> the docs stage not at all: Stage 6 read HEAD after the documentation-maintainer
> returned and adopted whatever it found. A docs agent that edited files and did
> not commit them therefore advanced the stage on a statement that was true about
> HEAD and false about the work, leaving the edits in the workspace — where final
> verification silently degraded to a dirty-tree local run, and where committing
> them by hand moved HEAD while the ledger candidate stayed put, so the next
> stage refused `candidate_not_checked_out` and the review could only proceed by
> DISCARDING the docs work. Observed nine or more times across three docs agents;
> one occurrence shipped documentation asserting the opposite of shipped
> behaviour and one stranded fragment was lost outright. FG-655 closed the gap by
> giving Stage 6 the same commit authority (a) gave Stage 5, on the same terms
> and with its own refusal names rather than a second vocabulary: declared paths
> only, passed to `git commit` itself; two-directional reconciliation whose only
> stop is a tree that moved beyond the declaration
> (`docs_cycle_tree_dirty_outside_declared_scope`,
> `docs_cycle_declared_changes_absent`, `docs_cycle_commit_failed`,
> `docs_cycle_commit_raced`, and the reused `candidate_not_checked_out` for an
> agent that committed its own work); nothing recorded and the candidate unmoved
> on any refusal; and a durable dispatch binding consulted before the decision to
> dispatch, so re-entry after a crash recognizes the commit it already authored
> instead of authoring a second one or dispatching a second docs agent. Two
> consequences are recorded here so they are not re-derived. A docs stage that
> genuinely changed nothing records candidate-unchanged with a CLEAN tree, and a
> stage claiming that with a dirty tree refuses — the legitimate no-op and the
> stranded stage must not render identically. And a dirty tree at the candidate
> is now a named refusal at both review-lifecycle readers, the coordinator's
> verification seam (Stages 1 and 7) and the Stage 9 shipping reader, rather than
> a silent fall-through to local verification; it is deliberately not installed
> in `forge review-loop`, whose dirty-tree local arm is intended behaviour for
> standalone callers with uncommitted work. The docs stage record's own sha is
> the POST-advance one — unlike the fix stage's, per refinement 3 of Change 2 —
> because Stage 6 completeness is checked against the current candidate and a
> pre-docs record would loop the review on its own docs stage.
>
> The threat model, the acceptance scenarios, and every scope bullet above are
> unaltered by this note. Operator-facing detail is
> [Review coordinator](../concepts.md#review-coordinator).

### FG-710 refinement — the fixer-result boundary

> **[SHIPPED 2026-08-19 (FG-710).]** Two defects sat on either side of one
> boundary: the point where a fixer's `result.json` is judged. Stage 5's fixer
> template prints four OPTIONAL conditional fields (`interaction`,
> `scope_change_reason`, `evidence_path`, `evidence_sha256`) unconditionally as
> a worked example, and an agent copying that shape naturally emitted `""` for
> the ones its own result did not use — an empty string on a `min(1)` optional
> is a refusal, not an omission, so completed remediation work was discarded
> over four bytes nobody meant as data. And every pre-ingest refusal, of any
> shape, discarded the fixer's actual code changes along with the rejected
> result: the coordinator owns the fix-cycle commit (FG-649), so nothing else
> could land work sitting in a refused task's workspace, and the only recovery
> was a second real fixer re-doing code that already existed. Two shapes, one
> fix each, recorded here so they are not re-derived later.
>
> **(a) Shape A — four named optional keys normalize `""` to absence,
> everything else still refuses exactly as before.** The normalization is
> scoped to precisely `interaction`, `scope_change_reason`, `evidence_path`,
> `evidence_sha256` — never `evidence` or `remediation_summary`, the two
> REQUIRED fields, which still refuse loudly on an empty string. `.strict()`
> unknown-key rejection is unchanged; what changed is that the refusal message
> now enumerates every offending key a strict-object issue carries, rather than
> the first, so a fixer that emitted three implementer-result keys by mistake
> learns about all three in one pass instead of rediscovering them one refusal
> at a time.
>
> **(b) Shape B — a `fixed` result on a `demonstrated` finding must name the
> executed assertion it proved with.** `executed_assertion` — the
> candidate-bound test name, or several joined with `"; "`, the fixer's proof
> actually executed — is schema-optional, because the per-finding schema has
> no reachability to reason from. The requirement is enforced in
> `ingestFixBatchResults`, which reads the batch's own immutable payload and
> does: a `fixed` result against a finding whose original `reachability` was
> `demonstrated` that omits `executed_assertion`, or names one with no
> resolvable test identity, refuses BEFORE anything is written
> (`demonstrated_evidence_missing`). The same batch stays open, every finding
> in it stays `fix_now` and unresolved, and no new batch revision is minted.
> Stage 8's recheck executes THAT named assertion rather than re-deriving one
> — this is prevention before stage completion, never a "trust me it was
> fixed" escape hatch, since the recheck still runs the assertion itself and
> remains the only thing that can record `resolved`.
>
> **(c) AC4 — a pre-ingest refusal captures the completed workspace instead of
> discarding it.** Both Shape A and Shape B (the demonstrated-evidence-missing
> arm specifically, not the membership refusals — a foreign, duplicate, or
> omitted finding id names a result about the wrong scope, which a repair of
> the *same* edits cannot correct) now capture, into a durable
> `fix_batch_refused_deliveries` row keyed on the SAME batch and revision, the
> raw result bytes and a re-appliable `git diff --binary HEAD` patch —
> untracked files folded in via a scoped, always-undone intent-to-add, and
> bounded to the paths that became dirty or newly appeared since a baseline
> snapshotted immediately before the fixer container started, so an unrelated
> pre-existing dirty edit or a file already sitting in the checkout is never
> captured into a patch a repair later re-applies — before the stage refuses.
> The next `forge review continue` dispatches a REPAIR
> fixer against that same batch/revision — never a new revision, never a
> second code cycle, preserving acceptance scenario 19's retry guarantee —
> informed by every prior refusal reason and the captured patch (rendered into
> the repair prompt as labeled, untrusted reference data rather than
> instructions, since it is another agent's raw, unvalidated output), and
> instructed to emit a CORRECTED `result.json` for the SAME edits, re-applying
> the patch first only if the worktree was reset in between. A compare-and-set
> claim (`open` → `repairing`, stamping a `FIX_REPAIR_LEASE_MS` = 30-minute
> repair lease) serializes two concurrent `continue`s so only one dispatches a
> repair; a `continue` that finds the record already `repairing` with a lease
> still live refuses `fix_delivery_repair_in_flight` instead of dispatching a
> second repair over the same batch/worktree, and only once that lease has
> strictly expired may a later `continue` reclaim the crash-stranded record —
> renewing the lease without counting a new attempt — and re-drive it from the
> durable patch. Repair attempts are capped at
> `MAX_FIX_REPAIR_ATTEMPTS` (2); once a batch/revision has exhausted them with
> the record still `open`, the review PARKS for the operator
> (`fix_delivery_repair_exhausted`) rather than
> looping, with the completed edits and every refusal reason preserved in the
> row rather than lost. Post-ingest refusals — a fix-cycle commit that could
> not land — are untouched: those already re-enter through the
> already-ingested-results short-circuit refinement (a) above describes, and
> leave nothing pre-ingest to preserve.
>
> **(d) Stage 8 binds a `resolved` verdict to the assertion the fixer actually
> named.** Naming an `executed_assertion` (b) is decorative unless the
> recheck that records `resolved` is bound to it: `ingestRecheck` reads the
> fixer's named identity per finding and compares it against the executed
> identity the rechecker's OWN evidence establishes (a `regression_test`'s
> `test_name`, or an `anchored_verification`'s test step's `ran`; a command
> step, a `replayed_reproduction`, or a `bounded_inspection` establishes none).
> A recheck that resolved on evidence that did not execute every name the
> fixer cited is recorded `inconclusive`/`not_executed`, never `resolved` on a
> different test than the one remediation identified — Stage 8 remains the
> sole candidate-bound executor (FG-639) and the only thing that can record
> `resolved`; this only narrows what evidence is ACCEPTED as satisfying that.
>
> New schema: `fix_batch_results.executed_assertion` (nullable column), the
> brand-new `fix_batch_refused_deliveries` table, and that table's
> `lease_expires_at_ms` (nullable column), all additive —
> [SCHEMA-CONTRACT](../SCHEMA-CONTRACT.md#fix_batch_refused_deliveries-table-fg-710-refused-delivery-recovery).
> The threat model, the acceptance scenarios, and every scope bullet above are
> otherwise unaltered by this note. Operator-facing detail is
> [Review coordinator](../concepts.md#review-coordinator).

### FG-682 refinement — the bounded late-docs amendment

> **[SHIPPED 2026-08-19 (FG-682).]** FG-678 (2026-08-05) surfaced the gap this
> ticket closes. A review batch-fixed its findings by collapsing three
> dispatch lanes into one shared resolver, which falsified a documentation
> statement Stage 6 had already reconciled for the pre-fix topology. The
> orchestrator caught the falsehood only after Stage 6 had committed and
> recorded, and there was no supported way to land the three-line prose
> correction into the pinned candidate: committing it out of band left the
> candidate stale while the branch tip drifted ahead, so shipping's
> `tip_equality` and `docs_closeout` checks both failed honestly, and the only
> way through was an operator override of both — ceremony a three-line fix did
> not warrant, and a precedent this ticket exists to remove.
>
> **`forge review amend-docs <review-id> --path <doc> [--path <doc> ...]
> --rationale <text>`** is a bounded coordinator verb, not a stage: it is
> driven directly rather than through `forge review continue`, since there is
> no finding to trigger it and `continue` never repeats a completed stage. It
> is bounded by construction, never a re-anchor:
>
> - **AC1 — eligibility.** Refuses unless the review has a candidate and has
>   completed discovery at a confirmed sha (`docs_amendment_no_candidate`,
>   `docs_amendment_before_discovery`). `contractConfirmedSha` is read and
>   never written here, so discovery can never re-open through this door.
> - **AC2 — documentation-only, enforced by name.** Every declared path is
>   classified by a pure, default-deny authority: a known prose extension is
>   documentation (with a named carve-out for `.txt` dependency manifests, and
>   test-named files always code); anything else — source, tests,
>   configuration, lockfiles, the FG-732 orchestrator-policy surface, or an
>   undeclared dirty path — refuses the WHOLE amendment by name before any git
>   write, with nothing committed and the candidate unmoved.
> - **AC3 — the coordinator commits, never the orchestrator.** Same discipline
>   as the FG-649 fix cycle and FG-655 docs cycle: the declared paths are
>   staged and passed to the commit itself, not merely `git add`ed, because the
>   index is shared with whatever else is running in the operator's checkout.
>   Unlike those two cycles, there is no `no_change` arm — an amendment that
>   moved nothing is always the named refusal
>   (`docs_amendment_declared_changes_absent`), because an amendment exists to
>   bring a correction IN.
> - **AC4 — the candidate advance re-opens exactly what it should.** The
>   commit lands through the SAME `advanceCandidate` choke point the fix and
>   docs cycles use, so CI is required at the amended sha and
>   `verified_final`/`recheck`/`shipping` re-open there, while
>   `contractConfirmedSha` stays untouched.
> - **AC5 — Stage 6 stays complete, at the new candidate.** The docs stage
>   record is rewritten at the amended sha carrying an `amendment: true`
>   marker, so the amended candidate reads as a completed Stage 6 rather than
>   reopening it, and Stage 8's bounded delta narrows to
>   `supersededSha..amendedSha` instead of the full
>   `contractConfirmedSha..candidate` span — an amendment recheck reviews only
>   the amended prose, not remediation an earlier recheck already settled.
> - **AC6 — the durable lineage.** A dedicated ledger record (`kind:
>   "docs_amendment"`, a fifth shape in `lens_outcomes_json` — see
>   [SCHEMA-CONTRACT](../SCHEMA-CONTRACT.md#reviews--review_findings-tables-fg-638-dashboard-read-path)) carries `supersededSha`,
>   `amendedSha`, the committed `paths`, and the `rationale`, because the
>   stage-6 record it sits beside is last-write-wins and is overwritten when
>   shipping re-runs at the amended sha — only a record naming both endpoints
>   lets a later reader see the move happened AS an amendment rather than a
>   candidate that always contained the prose. Written BEFORE the candidate
>   advance so a crash after it can still recover the superseded sha, and it
>   GATES the advance: a ledger write suppressed by the same no-clobber rule
>   its sibling writers apply (a non-array outcomes column, left alone rather
>   than overwritten) refuses `docs_amendment_ledger_unwritable` and leaves the
>   candidate at the superseded sha even though the commit already exists —
>   advancing without a recorded lineage is exactly what AC6 exists to
>   prevent. The mirroring `review.docs_amended` event is emitted in the same
>   transaction.
> - **AC7 — end to end against a real repository.** Proved against a real git
>   worktree and the real ledger rather than closure-variable seams, because
>   the whole contract is about a real commit landing on top of the pinned
>   candidate and the candidate advancing to the sha the coordinator authored.
>
> **The commit is built compare-and-set, not a plain `git commit`,** closing a
> race a first pass at this ticket left open: the pre-commit "is HEAD the
> candidate" check is just that, a check, not a lock, so a second `amend-docs`
> invocation could advance HEAD in the window before a plain `git commit` ran.
> That commit moves HEAD unconditionally, so the loser would author an
> unadopted child sitting on the racer's tip and leave it there — refused
> correctly as not-adopted, but with the workspace HEAD now parked on a stray
> commit nobody's ledger recorded, needing a manual reset to recover. The
> commit is now built as an explicit child of the candidate (`write-tree` over
> the staged declared paths, then `commit-tree` naming the candidate as sole
> parent) without ever touching HEAD, and only then does
> `update-ref HEAD <new-sha> <candidate-sha>` move the branch tip, with the
> candidate as the ref's required old value. A lost race now leaves that
> compare-and-set failing atomically — the built commit stays unreferenced
> (`git gc` reclaims it) and the branch tip untouched — and the amendment
> refuses
> `docs_amendment_commit_raced` rather than adopting a commit nobody's ledger
> write recorded — the same FG-428 `campaign_id` compare-and-set precedent
> applied to a branch tip instead of a row.
>
> New schema: `lens_outcomes_json`'s fifth record shape and the
> `review.docs_amended` event, both additive —
> [SCHEMA-CONTRACT](../SCHEMA-CONTRACT.md#reviews--review_findings-tables-fg-638-dashboard-read-path). No new table, no
> migration. The threat model, the acceptance scenarios, and every scope
> bullet above are otherwise unaltered by this note. Operator-facing detail is
> [Review coordinator](../concepts.md#review-coordinator).

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
  **SATISFIED as of FG-640.** The condition the operator amendment of
  2026-07-28 set — a durable mapping from each FG-541 requirement to the
  mechanism, enforcing code, test, and gate condition that satisfies it — is
  recorded at
  [FG-541 evidence mapping](../concepts.md#fg-541-evidence-mapping) in
  `docs/concepts.md`. All four requirements (local-only fixer commits, no
  silent publication of unrelated work, exact-head CI, trusted-tip equality)
  map to shipped mechanisms, so FG-541 may be marked superseded rather than
  implemented independently.
- Change 0 activated the interim policy before ledger implementation began;
  Change 3 has since replaced that temporary policy with the evidence-led
  default, in the orchestrator seed and the rendered `CLAUDE.md` block. Change 0
  is **retired** — the text under
  [Change 0](#change-0--activate-the-interim-operating-policy) is the historical
  record of what stood in the interim, not current policy.

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
    payload hash. A changed disposition never changes a running task's inputs;
    if Stage 5 has not completed it may create a replacement revision, while a
    completed Stage 5 stops at disposition and cannot dispatch another fixer.
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
model. This was advisory policy until `docs/autonomous-run-prompt.md` and the
orchestrator seed were updated. **Both now encode the evidence-led review**:
Change 0 activated the interim sequence in them, and Change 3 (FG-640) replaced
it with the standing default — `forge review-loop` is deprecated, prints a
deprecation note naming `forge review`, and is no longer the documented
discovery transport.

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
do not change after creation. Before Stage 5 completes, a changed disposition
or candidate may create a replacement revision. A completed Stage 5 consumes
the review's one remediation cycle, so later changes return to disposition
instead of creating another batch.

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
existing task remains bound to its recorded revision. If that task completes
Stage 5, the changed decision is follow-up work and no superseding revision is
created inside the review. If the task fails before Stage 5 completes, the
coordinator may create a replacement revision for the still-unconsumed cycle.

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
reviewer output. Before Stage 5 completes, a candidate change invalidates the
batch for further dispatch and requires a replacement revision. After Stage 5
completes, candidate drift cannot authorize another remediation batch in the
same review.

### Deliberate boundary

Do not introduce a generic `messages` table or real-time agent inbox for this
PRD. The current workflow is coordinator-driven and pull-based; FixBatch is a
domain object, not free-form chat.

If a second concrete workflow needs durable post-dispatch communication,
revisit a shared delivery table and content-addressed artifact store using
measured payload and recovery needs. Until then, keep the implementation
review-specific and reuse task storage and events.
