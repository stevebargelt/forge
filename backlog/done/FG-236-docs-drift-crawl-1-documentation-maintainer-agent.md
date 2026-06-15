---
id: FG-236
type: story
status: done
title: "Docs drift — Crawl 1: documentation-maintainer agent seed"
---

**Closed:** 2026-06-02. Commit `b11d1c8`.

The authoring home for operator-facing docs — the docs analog of the engineer. NOT marketing copy: maintains operator docs, ADRs, examples, upgrade notes, seed prose/comments.

- Seed: seeds/agents/documentation-maintainer/CLAUDE.md.
- Artifact-driven inputs: changed files, relevant tickets, manifest/events (if any), a user-facing behavior summary, likely-affected doc paths.
- Returns a docs result contract: { docs_updated: [], docs_not_updated_reason: null|string, stale_docs_found: [], operator_behavior_changed: bool }.
- Markdown-only -> corruption-safe: FORGE-DEC-011 (grpcfuse xattr / native-module) does NOT apply (no node_modules touch), so it can run even forge-on-forge.

META (applies across the Docs Crawl set): the problem is DRIFT (present-but-wrong docs), not absence — hit 5x in one session, all caught by the user, none by the orchestrator. Build on existing machinery (AWN-4 contracts, AWN-5 reds, result schemas), NOT a new docs platform. Gate on a drift VERDICT, never a "docs task ran" checkbox. Fire on operator_behavior_changed, not "file touched". Allow deferred-with-reason. Models the #202/#203 Crawl/Walk/Run staging.