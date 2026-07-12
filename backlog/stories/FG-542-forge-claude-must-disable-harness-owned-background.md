---
id: FG-542
type: story
status: active
title: forge claude must disable harness-owned background tasks for every orchestrator session
created: 2026-07-12
---

## Problem

FG-535 proved that Claude Code's harness can SIGTERM all registered background tasks in a session, killing attached Forge work and previously propagating exit 143 into agent containers. `forge launch` and detached agent execution now make long work durable, but operators can still accidentally expose work through Claude's `run_in_background` channel unless the orchestrator session starts with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.

The operator requested that Forge enforce this at its own Claude launch boundary rather than relying on shell setup. Implementation commit `380c79c` added `buildClaudeChildEnv` and injects the variable into every `forge claude` child.

## Merge State Correction

PR #111 merged `380c79c` to main as `931d6e3` while this ticket was being filed. Both required CI checks were green, but no FG-542 review-loop ran because the ticket did not yet exist. Treat the remaining work as an honest post-merge audit and retrospective AC closeout: do not reimplement or remerge the change, do not claim that review-loop authorized the already-completed merge, and route any substantive audit finding through a new corrective PR before closing.

## Goal

Every orchestrator session started through `forge claude` has Claude's harness-owned background-task facility disabled by construction. Durable work remains owned by `forge launch`/tmux and ScheduleWakeup remains the wait/reminder mechanism.

## Acceptance Criteria

- [ ] Every `forge claude` child receives `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in OAuth, API-key, and Bedrock modes.
- [ ] An inherited unsafe value such as `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0` is overridden for the child.
- [ ] Building the child environment never mutates `process.env` or the parent shell environment.
- [ ] Existing environment variables are preserved; Bedrock launches still receive the resolved `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_PROFILE` values.
- [ ] Regression coverage exercises non-Bedrock, Bedrock, hostile inherited-value, and parent-nonmutation cases at the launch-environment boundary.
- [ ] Operator documentation states that the setting applies to newly started sessions and requires restarting an existing Claude session to take effect.
- [ ] Durable-work guidance remains consistent: `forge launch run` owns long commands, ScheduleWakeup owns delays, and short synchronous status checks inspect durable state.
- [ ] Run and record a post-merge reviewer audit of the shipped diff. If it finds substantive issues, fix them through a normal reviewed PR; if it passes, explicitly label it post-merge evidence rather than merge authorization.
- [ ] Close with merge commit `931d6e3` only after the per-AC evidence walk; record that PR #111 preceded ticket/review-loop creation.

## Non-Goals

- Do not alter direct `claude` invocations that bypass `forge claude`.
- Do not reintroduce attached/background ownership as a fallback.
- Do not add an operator flag that silently disables this safety invariant.
