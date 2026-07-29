---
id: FG-644
type: story
status: done
title: "zero-red test signal: precondition-failing suites must EXECUTE everywhere they claim coverage (release suites, fg612, container-marker) — red always means defect, skips are not validation"
created: 2026-07-29
closed: 2026-07-29
closed_commit: 9623a704
---

## Direction amended (operator, 2026-07-29) — supersedes the title's "named skips" framing

Zero-red means DETERMINISTIC TESTS THAT EXECUTE in every environment where they claim coverage — not
converting structurally failing tests into skips. A skip cannot count as validation when the code
under test changed.

- Release suites: make the forge-test scratch a valid clean candidate, or have the tests construct an
  isolated clean candidate that still exercises the agent's CURRENT source changes. They must execute
  from a dirty tree, unweakened.
- FG-612 cases: move the fixture under a writable test-owned root while preserving the production
  assertion. Never skip because /project has the intended container permissions.
- Add one fail-closed regression running the affected path in an agent-shaped environment from a
  dirty source tree, proving the tests EXECUTED (per-test identity), not that the command exited
  green with skips.
- The one-off docker-exec ENOTEMPTY event stays on watch; no retry without a demonstrated race
  mechanism.

## Skip-evidence rules (operator, 2026-07-29 — second amendment; binding for this ticket's AC)

The Docker-skip precedent itself overstates: a missing capability explains a non-execution, it does
not make the skip valid evidence. A skip is sound ONLY when another MANDATORY lane executes the same
assertion against the same candidate SHA — which is not category-wide true today (CI does not build
the agent image, so agent-image tests can skip there; host reruns are not required on every merge;
FG-621's live proof is one-time operator evidence outside CI).

Binding rules:
- This ticket must introduce NO new skips.
- Release tests receive a clean candidate containing the agent's current changes.
- FG-612 tests use a writable test-owned fixture while preserving their assertions.
- A named skip improves visibility but proves nothing.
- Skipped tests cannot satisfy acceptance or regression evidence — an AC row citing a skipped test
  is NOT met.
- If required coverage has no mandatory alternate execution, the honest record is `not_executed` or
  `blocked_environment`, never green.
- Any claimed alternate coverage must name the lane, the candidate SHA, and the executed assertion.
- The unreproduced docker-exec ENOTEMPTY event stays on watch; no retry without an established
  mechanism.

## Acceptance Evidence

Shipped in `9623a704` (PR #176 + fixes ee6c8aba/6ada5898 squashed). All evidence cites lane + SHA + executed assertion per this ticket's skip-evidence rules.

| AC | Evidence | Verdict |
|----|----------|---------|
| No new skips introduced | Host worktree tier @ 9623a704: 435 pass / 0 fail / 0 SKIPPED; in-container dirty-tree targeted run: 105/105, 0 skipped; CI @ 6ada5898 all 9 jobs green | met |
| Release tests receive a clean candidate containing the agent's current changes | docker/forge-test.sh commits the scratch into a candidate carrying the in-flight tree; executed from a 14-file-dirty container tree: release.integration 36/36, launch-cli 14/14, launch-r2 5/5 — including FG-569 GAP 2 (dirty-source REFUSAL) executing and passing | met |
| FG-612 tests use a writable test-owned fixture while preserving assertions | Post-review fix ee6c8aba: _setSourceRootForTest seam (function setter, null default, production byte-identical — recheck-verified no ambient disarm surface); collision spelling traverses real invoke() with a refused-root control; exact-ID recheck: RESOLVED | met |
| Fail-closed regression proves tests EXECUTED in agent-shaped env from dirty tree | src/v2/fg644-dirty-tree-execution.integration.test.ts asserts per-test identity (unskipped pass) for release+fg612 sets; proved itself live by failing closed on CI's missing global tsx ("no result at all" → named precondition + inner stderr after 6ada5898); green in CI integration_1 @ 6ada5898 and host tier @ 9623a704 | met |
| Skipped tests cannot satisfy evidence; not_executed over false green; alternate coverage names lane+SHA+assertion | Rules persisted in this ticket, FG-639 acceptance, and the PRD (commit 4df364c7 content); applied live in this closeout | met |
| ENOTEMPTY stays on watch, no blind retry | Engineer result: "No change made to the docker-exec ENOTEMPTY path — no retry, no touch" | met |

Known remainder, separately scoped: 63 in-container spawned-CLI integration reds (one root cause) → FG-645, repair pattern shipped here (container-authority.testkit.ts). verify-launch-tier-in-image.sh committed-checkout constraint folded into FG-645.
