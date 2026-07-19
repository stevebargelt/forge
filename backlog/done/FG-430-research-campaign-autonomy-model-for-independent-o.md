---
id: FG-430
type: story
status: done
title: "Research: campaign autonomy model for independent overnight work"
created: 2026-07-01
closed: 2026-07-19
---

## Problem

The Campaign Runner is drifting away from its intended product shape. The operator should be able to hand Forge 3-4 backlog items, or an epic, and have the system make real overnight progress with human involvement only when policy or missing product intent truly requires it. Instead, recent campaign runs have exported too many system decisions to the operator:

- asking the operator to choose a route when routing policy was decisive;
- recommending campaign abandonment for a recoverable stale-state/reconciliation problem;
- wedging shipped work behind historical red verdicts even after later durable evidence proved the work shipped;
- letting host-local operational files poison done-audit;
- repeatedly asking for human calls on mechanics the system should derive from rules and evidence.

This is not a request for a less capable "campaign-lite" mode. It is a research/design pass to make full campaigns simpler to operate, more independent, and more policy-driven.

Gas City / Gas Town appears to embody a useful contrasting posture: work is the primitive, the overseer supervises rather than hand-drives, agents run assigned work without routine confirmation, and persistent state converges across sessions. Forge should evaluate that model and decide what belongs in Forge's campaign product.

## Goal

Produce a research document that defines a revised Campaign Runner autonomy model: Forge independently executes planned work, absorbs ordinary orchestration/recovery/routing decisions, and stops for humans only at explicit, policy-defined boundaries.

The research should compare Forge's current campaign behavior with external agentic-workflow systems, especially Gas City / Gas Town, and translate the findings into concrete Forge backlog changes.

## Acceptance Criteria

- The output is clearly marked as research and lives in an appropriate docs path, e.g. `docs/research/campaign-autonomy-model.md`.
- Research compares Forge's current Campaign Runner model with Gas City / Gas Town principles, including:
  - work as the primitive;
  - overseer/controller as supervisor, not manual decision proxy;
  - independent execution when work is assigned;
  - persistent state and convergence across sessions;
  - human involvement only for policy-defined exceptions.
- Research may include other agentic workflow references where useful, but must distinguish fact from inference and cite/source the external systems it relies on.
- Defines a Forge campaign autonomy contract:
  - what the orchestrator/campaign controller decides autonomously;
  - what must stop for a human;
  - what must be reported after the fact rather than asked up front;
  - what evidence is required before Forge can mark work shipped.
- Defines deterministic rules for routing, recovery, reconciliation, and done-audit boundaries. Examples that must be addressed:
  - if routing policy is decisive, resolve and proceed rather than ask;
  - stale historical red failures must be reconciled from later durable evidence;
  - recoverable campaign state should be repaired, not abandoned;
  - host-local operational state must not poison shipped-work audits.
- Defines the intended overnight operator experience:
  - input shape for "run these items / this epic";
  - expected unattended behavior;
  - morning report contents;
  - exact categories of human decisions that may remain.
- Identifies current Forge concepts or surfaces that should be hidden, derived, automated, or made exceptional from the operator's perspective.
- Produces a backlog map of implementation work, explicitly relating or refining existing items such as FG-427, FG-428, FG-429, FG-422, and any new tickets needed.

## Non-Goals

- No implementation in this ticket.
- Do not propose a weaker or less capable campaign mode as the primary answer.
- Do not remove human-in-the-loop behavior where policy, product intent, merge/deploy ownership, or trust-gate evidence genuinely requires a human.
- Do not require Forge to copy Gas City wholesale; extract principles and adapt them to Forge's backlog/ticket/workflow model.

## Relations

- Related to FG-370 (Campaign Runner).
- Related to FG-423 (campaign items execute workflows).
- Related to FG-427 and FG-428 (campaign reconciliation and wedged-item recovery).
- Related to FG-429 (orchestrator resolves route from policy).
- Related to FG-422 (Forge workflow skills).
- Reference: Gas City / Gas Town — https://github.com/gastownhall/gascity

## Disposition — 2026-07-19

Closed as superseded during the operator backlog review. The product direction moved from an autonomous ordered campaign as the ordinary work scheduler to Operator Work Management (FG-593) and its capacity-limited queue dispatcher, with autonomous authority governed separately by FG-456. Campaigns remain explicit coordinated programs under FG-370.
