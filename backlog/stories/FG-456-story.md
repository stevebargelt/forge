---
id: FG-456
type: story
status: active
title: Autonomous mode for long-running Forge work queues
created: 2026-07-04
---

## Problem
Forge still treats many routine sequencing, review-disposition, and product-scope decisions as human-blocking prompts. That makes overnight or long-running work queues hard to use: the orchestrator stops even when it has a clear recommendation and the decision is reversible or low-risk.

The opposite failure mode also showed up during autonomous runs: Forge can finish fewer tickets than it opens because every low-severity review note, hypothetical hardening idea, or extra regression-test suggestion becomes a new active backlog item. A run that closes four tickets and files six new lows is not converging. Autonomous mode needs backlog-growth discipline, not just "file follow-ups for anything new."

## Goal
Add an explicit autonomous mode for campaigns/work queues where Forge proceeds with its own recommendations, records would-have-asked decisions in a durable decision journal, and stops only for well-defined hard-stop conditions.

## Acceptance Criteria
- Provide an explicit operator entry point, for example `forge autonomous run --tickets FG-1,FG-2` or `forge campaign resume --autonomous`.
- Autonomous mode requires or creates a decision journal, defaulting to a markdown file under `notes/` when not supplied.
- For every decision that would normally ask the human, Forge chooses its recommended option, continues, and appends a journal entry with timestamp, ticket/run/task, decision, alternatives considered, rationale, risk, and follow-up.
- Hard-stop categories are explicit and enforced: destructive action, preserved-evidence mutation, credential/auth/payment/legal/security approval, data deletion, force-push/history rewrite, and irreversible trust-gate ambiguity.
- Merge policy is explicit: if host verification/CI is green and required reviews pass, Forge may merge without human PR review; low fail-safe/cosmetic findings may be filed as follow-ups, while small trust-gate hardening should be fixed immediately.
- Follow-up filing policy is explicit and enforced. Autonomous mode must not file active backlog tickets for low-severity pass-notes, hypothetical hardening, exhaustive-test requests, or maintainability polish unless at least one is true:
  - the issue is correctness, safety, trust-gate, data-loss, wrong-ship, or security relevant;
  - it is user-visible operator pain;
  - it blocks review-loop closeability;
  - it requires a product decision;
  - it is a repeated pattern across multiple runs.
- Low-severity review residue that does not meet the follow-up threshold is recorded in the decision journal under "deferred review notes" and is not added to active backlog.
- Related low-severity findings are batched into at most one follow-up per subsystem or folded into an existing relevant backlog item, instead of filing one new ticket per observation.
- End-of-run handoff summarizes completed work, PRs opened/merged, tickets closed/left open, tests/reviews run, autonomous decisions recorded, blockers, and recommended next action.
- End-of-run handoff includes backlog delta: tickets closed, tickets opened, why each opened ticket met the follow-up threshold, and any review notes intentionally not filed.
- Autonomous decisions are clearly marked as autonomous in reports/logs so morning review can audit them.
- The mode works with campaign execution lanes and does not force every item through the full feature pipeline.

## Non-goals
- No bypass of hard-stop approvals.
- No destructive mutation of preserved evidence such as campaign-922c83b7c577 without explicit human approval.
- No silent ticket closure when acceptance criteria are only partially met.
