---
id: FG-238
type: story
status: done
title: "Docs drift — Crawl 3: docs-drift finding category in red/review output"
---

**Closed:** 2026-06-02. Commit `11fbab2`.

Add a docs-drift ("stale docs") finding category to red + review output (AWN-5 findings). The check is "do docs match SHIPPED BEHAVIOR," NOT "are docs present" — the latter passes on present-but-wrong docs, which is the actual failure mode.

Artifact-driven: the red/reviewer receives the diff + user-facing behavior summary + affected doc paths and flags docs that still describe the old behavior. Findings feed the result contract's stale_docs_found (Crawl 1). This is the semantic (L3) layer — it catches prose/status staleness ("Scope (Crawl)", "next slice", ADR contradictions) that the mechanical layers (Crawl 4/5) can't.