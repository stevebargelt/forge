---
id: FG-157
type: story
status: done
title: forge invoke leaks active runs; needs terminal transition + sweep CLI
---

**Closed:** 2026-05-26. Forward fix: invoke.ts closes the run it owns (when args.runId is undefined) at all 7 terminal sites — success and 6 failure paths. RunStatus has no 'failed' (matches runNext convention); both success and failure flip the owned run to 'complete' with the task-level status carrying success/failure. New `forge sweep [--dry-run] [--limit]` CLI: finds runs where status='active' but all tasks are terminal, flips to 'complete' with completed_at = MAX(tasks.completed_at) to preserve historical timestamps. Ran the live sweep — closed 34 phantom invoke runs (in-flight counts across harebrained-apps/split-keyboard-teacher/meatgeekv2 dropped from 18/10/5 → 0/0/1). **Also fixed the latent getDb readonly-cache bug** (flagged after #155 backfill; bit again in this ticket's sweep) — `_db` was a single module-cached connection; first caller's mode locked in for the process so a readonly-then-writable sequence silently dropped writes. Split into `_dbRW` + `_dbRO` caches; both reachable from any call site without footgun.

**Caught:** 2026-05-26 by an agent in harebrained-apps. Confirmed: 34 phantom-active runs on this machine, all workflow=invoke.

**Symptom:** every successful \`forge invoke\` accumulates as a permanent "active" run. \`forge projects show\`, \`forge status\`, and the dashboard's live-session signal all overcount indefinitely.

**Root cause:** src/v2/invoke.ts marks the task complete at line 207 but never calls updateRunStatus(runId, "complete"). Multi-step workflows close cleanly because runNext.ts:138 flips run status when the workflow finishes; invoke skips that path. Same for invoke's 5 failure-return sites — they call markTaskFailed but leave the run "active".

**Fix:**

1. Forward fix in src/v2/invoke.ts: when invoke owns the run (args.runId === undefined), update the run status to "complete" on success and "failed" on each failure return. Don't touch the run status when invoke is attached to a caller-supplied --run id.

2. Backfill via new \`forge sweep\` CLI: scan runs where status='active', all tasks are terminal (complete/failed/blocked_by_red), at least one task exists. Update status to 'complete' (or 'failed' if any task failed) and completed_at = MAX(tasks.completed_at). Idempotent. --dry-run + --limit N flags.

**Sequencing:** forward fix first (prevents new leaks), then backfill (cleans 34 existing). Both in one commit; commit unblocks running \`forge sweep\` for real.

**Caught:** 2026-05-26 conversation while migrating harebrained-apps to the per-developer .claude/ convention.