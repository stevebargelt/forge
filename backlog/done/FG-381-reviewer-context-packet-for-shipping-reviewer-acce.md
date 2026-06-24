---
id: FG-381
type: story
status: done
title: Reviewer Context Packet for Shipping Reviewer acceptance review
epic: FG-372
created: 2026-06-23
closed: 2026-06-24
---

## Problem

A reviewer that only sees a diff can do generic code review, but it cannot reliably judge whether the implementation satisfies the original ask. Recent Forge-on-Forge reviews showed that the most important misses were not syntax or local correctness problems; they were mismatches against accepted intent, canonical workflow paths, and prior design decisions.

The Shipping Reviewer needs a bounded packet of context from the orchestrator so it can perform acceptance review rather than generic review.

## Goal

Define and assemble a **Reviewer Context Packet** for every mutating work item before the Shipping Reviewer runs.

The packet should let the reviewer answer:

- What was the operator actually asking for?
- What acceptance criteria and design decisions were accepted?
- What findings and request-changes history shaped the implementation?
- What exact diff and verification evidence is being reviewed?
- What scope was deferred and where is it tracked?

## Acceptance Criteria

- Define the packet schema or structured shape.
- Include backlog item body, acceptance criteria, parent/epic, and status.
- Include kickoff/latest operator ask and any later scope changes.
- Include accepted architect/tech-lead decisions, non-goals, and deferrals.
- Include request-changes history and red/test-engineer findings with disposition.
- Include engineer summary, commit SHA(s), diff range, changed files, and verification commands.
- Include host-vs-container distinction for verification.
- Include linked follow-up tickets for accepted deferrals.
- Shipping Reviewer prompt is updated to start from the packet before inspecting the diff.
- Tests or fixtures cover a packet that catches "tests green but wrong production path" style misses.

## Non-Goals

- Do not build the full Shipping Reviewer role in this story.
- Do not require a dashboard surface yet.
- Do not require perfect conversation capture; include the best available latest operator instructions and fail loud when required context is missing.

## Relations

- Child of FG-372.
- Feeds FG-384.
- Related to FG-380 for host-local conversation/session state.

