---
id: FG-495
type: story
status: done
title: "test suite tiering: canonical deterministic gate <=60s (hard ceiling 120s); move slow integration/control-plane/stress coverage to an explicit extended CI tier"
created: 2026-07-08
closed: 2026-07-08
closed_commit: 63f342dff911e34ed92c21126b635d1eee33593f
---

## Problem

The canonical deterministic gate (`npm run test:all`: root suite + dashboard workspace) takes ~4–8 minutes per run. Even after FG-474 removes duplicate executions, a single run of the gate is still too slow for the autonomous loop — every review-loop round and every CI check pays the full cost. The suite mixes fast unit coverage with long-running integration, control-plane, and stress coverage in the same default tier.

This is a SEPARATE problem from FG-474: FG-474 is duplicate execution / CI wiring / evidence reuse (run the gate ONCE per commit, visibly). FG-495 is the runtime of that one canonical run. Do not fold this budget into FG-474.

## Goal

Make the canonical deterministic gate fast by deliberate test tiering: target <= 60s, hard ceiling <= 120s, with long-running coverage moved to an explicit extended tier that still runs (CI-only or risk-triggered) — not deleted, not silently skipped.

## Acceptance Criteria

- [ ] Timing data exists: per-file (or per-suite) durations for the current full gate are measured and recorded, and the slow set is identified from that data — not from guesses.
- [ ] The canonical gate (the command CI and the review-loop treat as the deterministic check for every commit) completes in <= 60s target, <= 120s hard ceiling, on the host and in CI.
- [ ] Long-running integration / control-plane / stress coverage moves to an explicit extended tier with a named command (e.g. `npm run test:extended`), wired to run in CI (on PRs as a separate non-blocking-or-blocking job per classification, or risk-triggered) — the tier is visible and enumerable, not a dumping ground.
- [ ] Trust-sensitive coverage is NOT weakened: every test moved out of the canonical gate is classified deliberately with a stated reason (slow-but-covered-elsewhere, stress-only, control-plane boundary, etc.). A classification list (file → tier → reason) ships with the change.
- [ ] Tier purity holds under the FG-406/FG-408 content-guard precedent: the fast tier has a guard against child_process/sleep-style slow patterns creeping back in (extend the existing guard, don't just partition by suffix).
- [ ] No test is deleted or made permanently skipped as part of tiering; the extended tier runs somewhere routinely (CI) with its results visible.
- [ ] Docs (`docs/how-to-testing.md`) reconciled: the tier model, the commands, and when each tier runs.

## Non-Goals

- Duplicate-execution / evidence-reuse / CI-as-required-check wiring — that's FG-474.
- Making individual slow tests faster by rewriting them (fine if cheap, but the deliverable is the tiering, not per-test optimization).
- Weakening or removing trust-sensitive coverage.

## Refs

- FG-474 (CI + evidence reuse — the sibling problem, keep separate)
- FG-406 / FG-408 (test tiering + tier-purity content guard precedent, docs/how-to-testing.md)
- package.json `test`, `test:all` scripts
- Operator directive 2026-07-07: canonical gate <= 60s target / <= 120s ceiling; classify slow coverage deliberately.
