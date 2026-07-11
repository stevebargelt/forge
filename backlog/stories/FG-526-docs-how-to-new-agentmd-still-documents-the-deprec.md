---
id: FG-526
type: story
status: active
title: "docs: how-to-new-agent.md still documents the deprecated model: workflow field instead of activity: (schema.ts aliasModelToActivity)"
created: 2026-07-11
---

## Problem

docs/how-to-new-agent.md:83 documents the workflow YAML field as `model:` — per src/v2/schema.ts (aliasModelToActivity), `model:` is a deprecated alias that still parses with a deprecation warning; the real field is `activity:`. Found by the documentation-maintainer during the FG-523 docs reconcile; adjacent to (but not part of) that scope.

## Acceptance Criteria

- docs/how-to-new-agent.md documents `activity:` as the field, mentioning `model:` only as the deprecated-but-parsing alias (verify wording against schema.ts's actual warning behavior).
- Negative search: no other LIVE doc (docs/**, README*, seeds prose — not docs/prds/** or backlog/done/**) instructs using `model:` in workflow YAML without naming the deprecation.

## Also batch (from the FG-520 docs sweep, 2026-07-11)

Seed under-descriptions of forge-test (accurate but pre-FG-520 in emphasis) — one-line touch-ups: seeds/agents/engineer/CLAUDE.md:40 ("subsequent runs reuse the work dir" → note every run re-syncs source + validates deps), frontend-specialist:70 + backend-specialist:67 (same), agentic-platform-builder:63 (name exit 2 + FATAL as the concrete infra-failure signal).

## Notes

Filed 2026-07-10. Small — fold into the next documentation reconciliation batch (candidate companion: FG-522, the forge status redTaskId polish item).

