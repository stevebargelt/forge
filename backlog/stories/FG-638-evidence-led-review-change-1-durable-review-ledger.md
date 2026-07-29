---
id: FG-638
type: story
status: active
title: "Evidence-led review Change 1: durable review ledger and read surfaces"
created: 2026-07-28
---

## Problem

Change 1 of `docs/prds/evidence-led-review-lifecycle.md` (confirmed 2026-07-27, revised 2026-07-28).
Review state currently lives scattered across verdict JSON, task statuses, review-loop markdown notes,
fixer commits, and operator memory. The evidence-led lifecycle needs a durable ledger before any
coordinator (FG-639) or gate-authority (FG-640) work can exist.

## Scope

Durable state + read surfaces ONLY. No gate behavior change, no coordinator, no workflow migration.

- Additive `reviews` and `review_findings` schema + migrations per the PRD persistence model:
  - `reviews`: run/subject-task/ticket linkage; four-SHA semantics (`base_sha` /
    `contract_confirmed_sha` / `candidate_sha` / `trusted_remote_sha`); `contract_json`;
    `lens_outcomes_json`; `review_mode` copy; the 11 states (`confirming_contract` … `settled`,
    `blocked_environment`, `failed`); timestamps.
  - `review_findings`: fingerprint, summary, severity, risk_lens, finding_type, evidence, hypothesis,
    reachability, anchors (file/line/quoted_text), acceptance_ref, invariant_ref, `sources_json`,
    disposition + rationale + evidence + `decided_by`, followup_ticket_id, resolution +
    resolution_evidence_kind + resolution_evidence, discovered_sha, resolved_sha, timestamps.
    Disposition and resolution are SEPARATE fields (what Forge decided vs whether a fix is proven).
- `review_mode` persisted per run: `legacy_verdict` | `legacy_review_loop` | `evidence_led`; a legacy
  run without a `reviews` row still has one unambiguous authority model.
- Store methods + lifecycle events: rows give current state; append-only events give audit history;
  every state transition emits an event.
- Ingestion of raw verdict findings with Forge-assigned stable IDs (`RF-n`). Models never mint
  authoritative IDs. Raw `verdicts` rows remain immutable provenance; `sources_json` preserves every
  source reviewer/verdict.
- Disposition CLI — `forge review disposition <finding-id> <decision> --rationale "…"` — enforcing the
  vocabulary (`fix_now` / `accepted_risk` / `deferred` / `rejected_premise` / `duplicate` /
  `architecture_question`) and per-value preconditions:
  - `rejected_premise`: refuses without candidate-bound disproving evidence (replayed command+output,
    deterministic reproduction, or anchored contradicting fact).
  - `deferred`: refuses without a durable destination (an existing ticket id, or an
    operator-authorized new one).
  - `duplicate`: MUST cite the canonical finding ID it duplicates — refuses without it; the canonical
    row absorbs the duplicate's sources as provenance (operator amendment 2026-07-28).
  - `accepted_risk`: requires rationale; when it changes a stated threat model, protected invariant,
    acceptance criterion, security promise, or data-integrity guarantee it REQUIRES operator
    authority (mechanism specified below).
  - `architecture_question`: recordable; leaves the review unsettled.
  - Every disposition records who decided (`decided_by`), when, against which candidate sha, and why.
- **Operator-authority representation (specified — operator amendment 2026-07-28, not
  implementer-invented):** reuse the existing explicit operator-confirm CLI pattern already used by
  `forge gate --advance/--reject --rationale` (human gate decisions) and
  `forge raci apply --confirm` (governance writes). Concretely: authority-requiring decisions take an
  explicit `--operator` flag on `forge review disposition`; without it the command REFUSES, naming the
  authority requirement, and writes nothing; with it the finding row persists
  `decided_by: "operator"` (routine dispositions persist `decided_by: "orchestrator"`) plus the
  rationale, and an append-only disposition event carries the same fields. The explicit flagged CLI
  invocation IS the operator act, exactly as a `forge gate` human decision is; no new identity or
  auth system is introduced.
- Read surfaces: `forge review show <review-id> [--json]`; `forge show` integration; read-only
  dashboard rendering (review summary + findings rows per the PRD dashboard section).

## Acceptance criteria

- Migrations are additive; existing verdict/run history remains readable. The migration is flagged as
  machine-wide (`~/.forge/forge.db` — every running forge re-migrates on next writable open; back up
  before shipping).
- Exactly one `review_mode` per run; a legacy run without a `reviews` row resolves unambiguously.
- Ingested findings receive Forge-assigned stable `RF-n` IDs; a model-supplied authoritative ID is
  never honored.
- **Persistence-capability proof (scope narrowed by operator amendment 2026-07-28 — the
  normalization/dedup/schema-handling POLICY executes in FG-639):** the model can (a) hold multiple
  reviewer/verdict sources as provenance on ONE finding via `sources_json` without loss, and (b) hold
  two distinct findings as separate rows with distinct stable IDs. Capability tests only; PRD
  scenarios #2/#3/#10 are FG-639 acceptance.
- Disposition CLI enforces every per-value precondition with negative tests: PRD scenarios #12
  (threat-model-changing `accepted_risk` refused without operator authority), #13 (`deferred` cannot
  settle without an authorized durable destination), #25 (`rejected_premise` without candidate-bound
  evidence cannot settle); `duplicate` without a canonical finding ID refused; authority-requiring
  decision without `--operator` refused with nothing written.
- `decided_by` distinguishes operator vs orchestrator dispositions; authority-requiring
  `accepted_risk` rows carry `decided_by: operator` + rationale + event.
- `forge review show` and the dashboard render a review's summary and findings read-only.
- No gate reads ledger state: verdict/`blocked_by_red` behavior is unchanged (explicit non-goal
  regression test).

## Non-goals

Coordinator/stage machine, discovery/recheck schema validation, normalization/deduplication
execution, FixBatch, gate derivation, workflow migration — FG-639 / FG-640.

## Dependencies

First of the serial chain FG-638 → FG-639 → FG-640. Blocks FG-639.

## Authority caveat (operator, 2026-07-28)

The `--operator` flag is an explicit confirmation under Forge's single-user trust model — it is NOT
authenticated identity (same class as `FORGE_CONTROLLER_ID`, see FG-597). Documentation written for
this ticket must not later overclaim it as an identity or auth mechanism.
