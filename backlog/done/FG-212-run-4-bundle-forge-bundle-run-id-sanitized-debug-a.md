---
id: FG-212
type: story
status: done
title: "RUN-4 bundle: forge bundle <run-id> — sanitized debug archive of a run"
---

**Closed:** 2026-05-30. Commit `c01bd8d`.

Observability RUN stage §4 (docs/observability.md). Produce a sanitized archive for debugging forge itself or handing a failed run to a reviewer without the whole project.

  forge bundle <run-id>            # writes <run-id>-bundle.tar.gz (or a dir)

Contents: run metadata, tasks, events, verdicts, task manifests, result.json files, stdout/stderr logs, prompts/packages (optional), usage records.

SANITIZATION (hard requirement):
- NEVER include raw auth state (auth-state files, NTFY_TOKEN, AWS creds, bearer tokens). The manifest auth block is already booleans-only (Crawl) — safe.
- Redact known secret-bearing paths; do not bundle ~/.forge/runtimes or notify.env or any auth-profile material.
- Bundle is per-run: copy from ~/.forge/runs/<runId>/ + the run/task/event/verdict rows for that run, not the whole DB.

Notes: bounded log inclusion (cap or note truncation — reuse the bounded-tail discipline). --json manifest of what was included. Pure assembly helper (testable: given a temp FORGE_HOME, assert archive contents + that no secret files are included).