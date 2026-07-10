---
id: FG-510
type: story
status: done
title: "host-verification gate coverage: require command equality with the required gate — close the --gate override spoof (audit N-D/F13)"
created: 2026-07-10
closed: 2026-07-10
closed_commit: 363128b
---

Source: notes/forge-engineering-review-2026-07-09.md finding N-D (MEDIUM, verified), sharpening F13. Trust-perimeter item.

Evidence: the ship-gate read path resolveGateCoverage (src/campaign/reconcile-collect.ts:120-135, gate_name-keyed query src/store/host-verifications.ts:148-161, exitCode-only filter) never checks that the recorded row command equals the required gate command — so a row recorded with a --gate override (gate_name forced to match, command different) spoofs reconcile pre-check, out-of-band lane, and done-audit coverage. The review-loop reuse path DOES check command equality (host-verifications.ts:456) — the hardening exists but is applied to only one of two readers.

Fix shape (from the audit): require command equality with the required gate in the coverage filter (canonical writers set command and gate_name equal, so no legitimate row is lost) — and/or kill the spoofable override at the recorder. Keep semantics consistent with the review-loop reuse predicate (shared helper or mirrored check).

Review dispositions (orchestrator, 2026-07-09, review-loop run-review-loop-fg-510-bb5205 round 2 — recorded here per the FG-502 lesson so subsequent reviewers see them):
- backlog/done/FG-419-*.md stale closeout prose ("collector matches on gate_name alone", "--gate remains valid when commands differ"): NO CHANGE NEEDED. A closed ticket's body is the historical record of what that ticket delivered under the contract of its time; FG-510 deliberately reversed that contract, and the CURRENT contract lives in docs/concepts.md (updated in this ticket's range). Done-ticket bodies are not rewritten to track later semantics — same treatment as campaign-runner-plan.md delivered-history entries (FG-509 precedent).
- "npm run test:extended not green in the review environment" (esbuild darwin-arm64 vs linux-arm64 in the reviewer container): ENVIRONMENT ARTIFACT, not a diff defect. Per FG-474/FG-495 policy the exact-head extended-tier proof is the required CI check "test-extended" (off-host, once per push), which this ticket's AC names explicitly; it was green at 122504a and gates the merge at the final head. In-container full-tier runs are not the acceptance mechanism and a platform-mismatched scratch node_modules cannot fail the review.

Acceptance:
- [ ] a host_verifications row whose command differs from the required gate command NEVER satisfies required-gate coverage (reconcile pre-check, out-of-band lane, done-audit), even when gate_name matches via override
- [ ] negative test: an override-recorded row (gate_name matches, command differs) is rejected by coverage
- [ ] regression test: canonical rows (command equals gate) still satisfy coverage — no legitimate row lost
- [ ] coverage semantics consistent with the review-loop reuse predicate (one definition of a covering row)
- [ ] test and test-extended green on the exact PR head; review-loop closeable before merge
