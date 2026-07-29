---
id: FG-644
type: story
status: active
title: "zero-red test signal: precondition-failing suites must EXECUTE everywhere they claim coverage (release suites, fg612, container-marker) — red always means defect, skips are not validation"
created: 2026-07-29
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
