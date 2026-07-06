---
id: FG-472
type: story
status: done
title: forge new feature (non-campaign) has no ticketId → shipping-reviewer pre-fails and BLOCKS the run; decide the intended behavior
created: 2026-07-05
closed: 2026-07-06
closed_commit: f0307a4
---

## Problem (verified, FG-433 investigation)
The `feature` workflow's verify/build phase includes `shipping-reviewer` as an authoritative red with `gate_on_verdict: true` (seeds/workflows/feature.yml:109). `runNext.ts:665` assembles the reviewer context packet, and if `run.metadata.ticketId` is absent, the shipping-reviewer is PRE-FAILED and `runNext.ts:819` converts that to `authoritativeFail = true` ("block regardless of red configuration").

A campaign-created run carries `run.metadata.ticketId` (FG-464), so it passes. But a plain `forge new feature "title" --brief "..."` sets NO ticketId — `src/cli/commands/new.ts` only builds `inputs` from `--brief`/`--question`/`--prd`/`--meta`; the sole way to attach a ticket is `--meta '{"ticketId":"FG-xxx"}'`. So a default non-campaign feature run is BLOCKED by the shipping-reviewer for want of a ticket.

## Decision (operator, 2026-07-05) — RESOLVED
Full `forge new feature` runs are ticket-backed. Chosen path: option (a) — first-class `--ticket <id>` — combined with **fail-fast before run creation** (NOT the option-(b) silent skip).

Intended behavior:
- Add a first-class `--ticket <id>` option that stores `run.metadata.ticketId`.
- Do NOT silently skip shipping-reviewer when ticketId is absent. Instead, fail fast BEFORE creating the run when the selected workflow includes a `shipping-reviewer` red and no ticketId is supplied, with a clear message:
  `workflow 'feature' requires --ticket <id> because shipping-reviewer needs backlog acceptance criteria`
- `--meta '{"ticketId":"FG-123"}'` MAY remain supported for backward compatibility, but `--ticket` is the documented path. If both are supplied and DISAGREE, refuse.
- Validate the ticket exists in the backlog before creating the run.

## Acceptance criteria
- `forge new feature "..." --ticket FG-123` creates a run with `run.metadata.ticketId = "FG-123"`.
- Missing `--ticket` for a workflow with a `shipping-reviewer` red fails BEFORE run creation (no run row, no container).
- Missing / unknown ticket id fails before run creation.
- `--ticket` and `--meta.ticketId` disagreement fails.
- Workflows without a `shipping-reviewer` red remain unchanged.
- Docs explain: full feature runs require a backlog ticket; use campaigns or `--ticket`.

## Shipped (2026-07-06, PR #38, merge 5cf8a58)
Landed via campaign-2753b15667d7 item 0 (quick_implementation lane) + a 3-round bounded review-loop.
- `--ticket <id>` added to `forge new`; `resolveTicketId()` validates agreement/requirement/existence before `startRun()` (no run row on failure). Error message matches the AC verbatim.
- **Review refinement:** the requirement gates on ANY `shipping-reviewer` red regardless of authority — matching the runtime pre-fail in `runNext.ts:661/819-820`, which does not filter on authority. (The original AC said "authoritative"; that was too narrow and would have left a specialist-authority config hard-blocking at build. The shipped behavior is the correct superset.) Today only `feature.yml` carries a shipping-reviewer red, so no installed workflow other than `feature` starts requiring a ticket.
- Tests: 13 unit (`new.test.ts`) + 5 CLI-subprocess integration (`fg472-ticket-required.integration.test.ts`). Host `test:all` green (root 3034/3034, dashboard 27/27).
- Docs reconciled repo-wide (how-to-new-feature, orchestrator template + CLAUDE.md, README, concepts, PRDs 139/147).

## Non-goals
- Does not change the campaign path (FG-464/FG-433 — already ticket-aware).
- Does not change whether a specialist `shipping-reviewer` pre-fail should hard-block vs warn (a `runNext.ts` gate-semantics question, out of scope for the CLI fail-fast).

## Reference
seeds/workflows/feature.yml:109; src/v2/runNext.ts:661-820; src/cli/commands/new.ts; src/v2/reviewer-context-packet.ts. Surfaced by FG-433.
