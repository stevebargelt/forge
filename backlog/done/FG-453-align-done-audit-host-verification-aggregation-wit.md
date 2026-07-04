---
id: FG-453
type: story
status: done
title: Align done-audit host-verification aggregation with reconcile passing-row model (or document/report stricter audit semantics)
created: 2026-07-03
closed: 2026-07-04
closed_commit: d029183
---

## Problem

`forge campaign reconcile` (both scope-blocked "shape 1" and out-of-band "shape 2" lanes) uses a **passing-row** model: among covering host-verification rows, any covering PASS ships the item; a historical covering failure does not wedge it (FG-440). But the done-audit surface (`src/done-audit/collect.ts`, rendered on `forge campaign report`) computes `hostVerified = !anyFail` — **any-fail-wins** across covering rows.

Consequence: an item with a **fail-then-pass** covering history ships via reconcile, yet the done-audit line on the *same* `forge campaign report` reports `hostVerified: false` → `complete_with_issues`. A shipped/reconciled item then shows an "unresolved done-audit gap" that is not actually unresolved under the passing-row model.

Surfaced during FG-452 (the documentation-maintainer flagged the divergence). FG-452 deliberately did NOT expand to cover this: the literal FG-422 shape has a single passing capture (no prior fail), so its report is clean and FG-452's AC is met. This is a broader policy inconsistency between reconcile and done-audit, not an FG-452 regression.

## Disposition (operator, this session)

File follow-up; do not expand FG-452 unless red-wide shows a direct FG-452 regression.

## Product lean (not binding — decide at implementation)

done-audit host-verification should probably adopt the passing-row model too: a covering PASS means `hostVerified: true`, with historical failed rows still visible as **audit history**, not as a current failure. The alternative — keep the stricter any-fail-wins audit — is acceptable only if the surface explicitly labels it as stricter-than-shipping-gate semantics so a clean-but-historically-failed item is not read as broken.

## Acceptance criteria

- **AC1** — Decide and implement ONE model for done-audit host_verification aggregation: either (a) passing-row (any covering PASS → `hostVerified: true`, earlier covering failures retained as visible history, not a current failure), or (b) keep any-fail-wins but make the operator surface explicitly distinguish "stricter audit semantics" so a shipped item with a fail-then-pass history is not reported as an unresolved gap.
- **AC2** — fail-then-pass case: an item whose covering rows are [fail, then pass] is NOT reported as `complete_with_issues` for host_verification under the chosen model (or, if (b), is clearly labeled as passing-with-historical-failure, not an unresolved gap). Written as a test.
- **AC3** — fail-only case: an item whose covering rows are all failing IS still reported as a host_verification gap (a genuine failure must not be laundered). Written as a test.
- **AC4** — Consistency: for the same set of covering rows, the done-audit host_verification verdict agrees with reconcile's ship/refuse decision (no case where reconcile ships but done-audit reports an unresolved host_verification gap, absent an explicit stricter-semantics label).
- **AC5** — docs/concepts.md done-audit section reconciled to whichever model is chosen (it currently documents any-fail-wins at the "Done audit" section — see the FG-452 docs pass).

## Pointers

- `src/done-audit/collect.ts` — `hostVerified = !anyFail` aggregation (the any-fail-wins site).
- `src/campaign/reconcile-collect.ts` / `reconcile-outofband-collect.ts` — the passing-row model to align to.
- FG-440 (passing-row model origin), FG-452 (where the divergence was surfaced).

## Related low findings from the FG-452 red-wide re-check (absorb here)

- **Test coverage-guard (red-wide finding 2):** `src/done-audit/collect.integration.test.ts` has the off-branch (base-reachability) negative but no direct **non-ancestor** negative (a row whose commit_sha does NOT have closedCommit as an ancestor). When this ticket rewrites the done-audit aggregation + tests, add that non-ancestor negative to guard done-audit's own call site (the shared `checkClosedCommitCoveredByTestedSha` is currently only exercised for the ancestry half via reconcile's tests).
- **Layering (red-wide finding 4, optional):** `src/done-audit/collect.ts:7` now statically imports `checkClosedCommitCoveredByTestedSha` from `../campaign/reconcile-collect.js`, coupling the audit module to campaign internals. Cosmetic only (no cycle, no side effects). Since this ticket already edits both files, consider relocating that helper (+ its SHA/ref validators) to a neutral module (e.g. `src/git-coverage.ts`) so done-audit doesn't depend on campaign.
