---
id: FG-510
type: story
status: active
title: "host-verification gate coverage: require command equality with the required gate — close the --gate override spoof (audit N-D/F13)"
created: 2026-07-10
---

Source: notes/forge-engineering-review-2026-07-09.md finding N-D (MEDIUM, verified), sharpening F13. Trust-perimeter item.

Evidence: the ship-gate read path resolveGateCoverage (src/v2/reconcile-collect.ts:120-135, gate_name-keyed query src/store/host-verifications.ts:148-161, exitCode-only filter) never checks that the recorded row command equals the required gate command — so a row recorded with a --gate override (gate_name forced to match, command different) spoofs reconcile pre-check, out-of-band lane, and done-audit coverage. The review-loop reuse path DOES check command equality (host-verifications.ts:456) — the hardening exists but is applied to only one of two readers.

Fix shape (from the audit): require command equality with the required gate in the coverage filter (canonical writers set command and gate_name equal, so no legitimate row is lost) — and/or kill the spoofable override at the recorder. Keep semantics consistent with the review-loop reuse predicate (shared helper or mirrored check).

Acceptance:
- [ ] a host_verifications row whose command differs from the required gate command NEVER satisfies required-gate coverage (reconcile pre-check, out-of-band lane, done-audit), even when gate_name matches via override
- [ ] negative test: an override-recorded row (gate_name matches, command differs) is rejected by coverage
- [ ] regression test: canonical rows (command equals gate) still satisfy coverage — no legitimate row lost
- [ ] coverage semantics consistent with the review-loop reuse predicate (one definition of a covering row)
- [ ] test and test-extended green on the exact PR head; review-loop closeable before merge