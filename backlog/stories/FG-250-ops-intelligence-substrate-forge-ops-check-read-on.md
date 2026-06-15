---
id: FG-250
type: story
status: active
title: "Ops intelligence substrate — forge ops check: read-only incident detection with recommended-action metadata"
---

**Reframe:** not an "Ops dashboard MVP" — an **Ops intelligence substrate**. One detection core off the SQLite blackboard, many consumers. Derived from two research lenses (run-ops-surface-lens-a-detection-surface-6fbb91 = detection surface: 15 surfaced / 24 latent-detectable / 7 schema-blocked; run-ops-surface-lens-b-operator-pain-e2645a = 8 ranked operator pains) + user direction 2026-06-02.

**Why the reframe:** the consumer is the ORCHESTRATOR, not a human at a terminal. The user never issues CLI; the orchestrator runs every command and the user converses with it. So the first deliverable is an orchestrator-facing primitive, not a web board.