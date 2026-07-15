---
id: FG-568
type: story
status: active
title: "FG-553 Child 1: store-compatibility policy — additive-only open path, schema-version stamp, quiesce-gated destructive migration, backward-compatible overlap window"
created: 2026-07-14
---

## Clarifications (operator decisions, 2026-07-14)

**Read-only opens (accepted):** ordinary opens — INCLUDING logically read-only callers — MAY perform
backward-compatible ADDITIVE evolution (add nullable/defaulted columns, indexes). No ordinary open may
perform destructive DDL or cross a one-way boundary. "Fixes read-only-open-still-migrates" means the
DESTRUCTIVE DROP is gone from read-only opens — NOT that read-only opens perform no schema maintenance.
Destructive convergence stays explicit and quiesce-gated (`forge store converge`).

**Usage capture on legacy stores (rejected the loss; dual-shape required):** a version-B usage writer must
NOT lose capture on an unconverged 0.1.x store. `insertUsageRows` inspects `model_calls` once and writes
the fresh shape when the legacy columns are absent, the legacy shape (prompt_tokens/completion_tokens/cost
= 0,0,0 placeholders) when all three are present, and refuses with a named actionable error on an
inconsistent subset. No auto-drop, no auto-converge.
