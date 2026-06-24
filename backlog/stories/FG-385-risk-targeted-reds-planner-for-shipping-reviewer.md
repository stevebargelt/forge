---
id: FG-385
type: story
status: active
title: "Risk-targeted reds planner for Shipping Reviewer"
epic: FG-372
created: 2026-06-23
---

## Problem

Generic red review is often low-signal, but recent Forge-on-Forge work showed reds are valuable when pointed at explicit high-risk invariants: wedged states, no-discard cleanup, fake validation hooks, non-atomic state transitions, credential leaks, and silent success without the intended effect.

## Goal

Teach the orchestrator/Shipping Reviewer when to invoke reds and how to target them at concrete invariants instead of asking for vague generic review.

## Acceptance Criteria

- Define risk signals that require targeted reds: lifecycle, git/worktree/merge, auth, routing, durable state, test infrastructure, done-gate changes, dashboard decision surfaces, and broad cross-module contracts.
- Define red prompt shape: invariant under attack, failure modes to try, relevant files/paths, and expected evidence standard.
- Blocker-biased classes are explicit: data loss, wedged state, fake validation, credential leakage, non-atomic state, and silent success.
- Low-risk leaf docs/UI changes can use lightweight or no red review when mechanical checks and reviewer pass.
- Shipping Reviewer receives red findings and dispositions in the context packet.
- Tests or fixtures cover risk classification for a high-risk worktree change and a low-risk docs-only change.

## Non-Goals

- Do not add more generic reds everywhere.
- Do not replace the Shipping Reviewer.
- Do not implement new red agents unless existing roles cannot express the needed invariant probe.

## Relations

- Child of FG-372.
- Uses insights captured in FG-372 Red-Agent Calibration.

