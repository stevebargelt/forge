---
id: FG-390
type: story
status: done
title: "Campaign data model: durable campaign and campaign-item state"
epic: FG-370
created: 2026-06-24
closed: 2026-06-25
closed_commit: b2ca27b
---

## Problem

A campaign runner cannot be trustworthy if its state lives only in process memory or project-tracked notes. Overnight execution needs durable state that survives process restarts and can explain exactly what happened.

## Goal

Add a durable campaign model and campaign-item model to Forge host-local state.

## Acceptance Criteria

- Define campaign statuses and lifecycle transitions.
- Define campaign-item lifecycle status by reusing or aligning with existing Forge run/task status vocabulary where practical; do not introduce a separate campaign-only item status enum unless the implementation proves the existing lifecycle vocabulary cannot represent the state.
- Add durable storage for campaigns and campaign items.
- Store source input: explicit list, epic id, or mixed source.
- Store item order, ticket id, current run id when known, branch/worktree/PR fields when known, lifecycle status, outcome, blocker kind, continue policy, reason, and requested human action.
- Support campaign item outcomes such as `shipped`, `blocked`, `skipped`, `held`, `needs_refinement`, and `failed` as data beside lifecycle status.
- Support blocker kinds such as `scope`, `readiness`, `tests`, `merge_conflict`, `auth`, `dependency`, `git_state`, `infrastructure`, `campaign_system`, and `human_decision`.
- Support continue policy values such as `continue_allowed`, `hold_dependents`, and `hold_campaign`.
- State survives process restart.
- Reconcile/show can distinguish planned, running, paused, complete, failed, and abandoned campaigns.
- Tests cover create/read/update lifecycle and restart persistence.

## Non-Goals

- Do not implement execution yet.
- Do not implement dashboard UI.
- Do not implement parallelism.
