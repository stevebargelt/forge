---
id: FG-250
type: story
status: done
title: "Ops intelligence substrate — forge ops check: read-only incident detection with recommended-action metadata"
closed: 2026-06-19
---

**Reframe:** not an "Ops dashboard MVP" — an **Ops intelligence substrate**. One detection core off the SQLite blackboard, many consumers. Derived from two research lenses (run-ops-surface-lens-a-detection-surface-6fbb91 = detection surface: 15 surfaced / 24 latent-detectable / 7 schema-blocked; run-ops-surface-lens-b-operator-pain-e2645a = 8 ranked operator pains) + user direction 2026-06-02.

**Why the reframe:** the consumer is the ORCHESTRATOR, not a human at a terminal. The user never issues CLI; the orchestrator runs every command and the user converses with it. So the first deliverable is an orchestrator-facing primitive, not a web board.

**Supersession note (2026-07-10, FG-516):** the "read-only" claim in this ticket's title and body describes forge ops check as SHIPPED BY THIS TICKET and is preserved as historical record (done tickets are never rewritten for later semantics). Since FG-516, only `forge ops check --json` is read-only/side-effect-free; the default human invocation records orchestrator.milestone events and can push one deduped notification per new incident. Current contract: docs/how-to-set-up-notifications.md + the ops --help.
