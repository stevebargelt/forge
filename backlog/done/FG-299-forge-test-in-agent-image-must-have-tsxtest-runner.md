---
id: FG-299
type: story
status: done
title: forge-test in agent image must have tsx/test runner dependencies available
---

**Closed:** 2026-06-06.

Evidence from forge-site backlog #12: both invoked agents tried to use forge-test, but the container path failed because tsx was missing in the agent/container test environment. They fell back to running tests directly, and the host had to re-verify. This is recurring tax and weakens the validation contract.

Problem:
Engineer seeds require forge-test, but the agent image / wrapper does not reliably provide the runner dependencies needed for projects that use tsx/node test. Agents then improvise with direct test commands, which reintroduces the host/container native-module mismatch that forge-test exists to avoid.

Acceptance:
- Reproduce the failure from forge-site #12 in a container.
- forge-test succeeds for a representative tsx-based project without agents installing ad hoc globals.
- The wrapper fails loud with a useful diagnostic when a project genuinely lacks its test runner.
- Engineer/test seeds continue to require forge-test; no downgrade to direct test runs.
- Add a regression test or image smoke covering tsx availability.