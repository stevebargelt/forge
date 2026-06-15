---
id: FG-197
type: story
status: done
title: "Crawl 5 — manifest: write task manifest.json indexing artifacts"
---

**Closed:** 2026-05-30.

Crawl milestone, step 5 of 5 (docs/observability.md, Crawl §5). Independent of Crawl 1-4 — can be built in parallel; consumed by Crawl 4's artifact-manifest line.

Each task directory gets a small manifest.json indexing known artifacts: taskId, runId, files map (prompt=CLAUDE.md, package=package.md, result=result.json, stdout/stderr logs), container.name, and an auth block describing whether a profile was REQUESTED and whether state was MOUNTED.

**Secrets discipline:** the manifest describes whether sensitive capabilities were mounted — NOT where bearer credentials live. No token paths, no auth-state contents. Consistent with the #176 rule (credential never in prompts/logs/project-mount; this is the same principle for the manifest).

**Acceptance:** every task dir gets a manifest.json on dispatch; no secret paths in it; forge show (Crawl 4) reads it for the artifact list.