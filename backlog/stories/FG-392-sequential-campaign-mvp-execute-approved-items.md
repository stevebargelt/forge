---
id: FG-392
type: story
status: active
title: "Sequential Campaign MVP: execute approved campaign items one at a time"
epic: FG-370
created: 2026-06-24
---

## Problem

The useful first campaign runner is not parallel. It is a durable sequential loop that can take an approved plan and work through it without the human manually dispatching every item.

## Goal

Implement the sequential campaign execution MVP.

## Acceptance Criteria

- Start only an approved campaign plan.
- Refuse to execute a campaign still in `planned` state without approval metadata.
- Record approved by, approved at, approval rationale/input, and approved `plan_hash` before execution.
- Starting execution must confirm the current plan's `plan_hash` matches the approved `plan_hash`.
- If the current resolved plan hash differs from the approved hash, refuse to start and require re-plan/re-approval.
- Dispatch one item at a time.
- Record the run id and item lifecycle status durably, using the shared Forge lifecycle vocabulary chosen in FG-390.
- Record campaign-specific outcome/blocker fields beside status; do not overload lifecycle status to mean skipped, held, or blocked-by-campaign-policy.
- On item success, continue to the next eligible item.
- On item failure/block/request-changes, record the blocker and defer continuation decision to FG-393 semantics.
- Do not run more than one campaign item concurrently.
- Do not claim an item shipped unless the existing per-item closeout gates say it shipped.
- Tests cover happy-path two-item execution, refusal to run an unapproved plan, stale `plan_hash` rejection, and failure on the first item without losing campaign state.

## Non-Goals

- No parallel execution.
- No dashboard.
- No automatic merge/conflict repair beyond existing Forge behavior.
