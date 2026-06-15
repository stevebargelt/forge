---
id: FG-237
type: story
status: done
title: "Docs drift — Crawl 2: narrow orchestrator direct-edit allowlist; route docs-impact tasks"
---

**Closed:** 2026-06-02. Commit `64aa226`.

The orchestrator routes durable/operator-facing doc changes to documentation-maintainer (Crawl 1) and stops casual direct edits — that's exactly where drift keeps happening (5x this session). Docs are an artifact, like code.

Update seeds/orchestrator-template.md (+ re-render forge's own CLAUDE.md via forge upgrade).

STAYS orchestrator-direct: BACKLOG.md (via forge backlog CLI), session notes, small handoff/status notes. (Not "orchestrator writes nothing durable" — it must keep working memory + backlog state.)

ROUTES through the documenter: docs/**, learnings/decisions/**, seeds/** prose/comments/templates, CLI how-tos, runtime/model/auth/notification examples, README-style guidance.

Also: add orchestrator guidance "when behavior changes, route a docs-impact task," and a "Docs impact: none/updated/deferred" line in PR/review output.