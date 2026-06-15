---
id: FG-135
type: story
status: done
title: Build reds review the wrong artifact (commit metadata, not the diff)
---

**Closed:** 2026-05-14. Commit `4b67e8a`.

**Why:** Surfaced on `run-smoke-v3-491805` (forge v2's first full real run). The build step's red-wide and red-narrow agents both came back as `inconclusive` because they reviewed the **previous commit** (`b83329f` — the v2 fix commit that pre-dated this run) instead of the engineer's actual diff in `src/cli/index.ts`. The pipeline isn't broken: the architecture sends each red the primary's `result.json` as `artifact`. But the engineer's `result.json` contains a textual *summary* of the diff, not the diff itself.

**Notes from the failing red:** *"Commit claims three fixes: (1) TASK_PACKAGE_MARKDOWN added to SpawnContext ✓ Verified—was missing, now present in both runNext.ts and invoke.ts; (2) Bedrock Haiku model ID fixed ✓ Verified; (3) runMetadata threaded through ✓ Verified. Tests updated (BASE_CTX, spawn.test.ts). All three claimed fix..."* — proves the red verified the *prior* commit, not the engineer's output.

**The fix:** seed update for `red-wide` / `red-narrow` (and probably the discipline reds) — when reviewing a build step's output, the red should:
1. Read the engineer's `files_modified` array from result.json
2. `git diff HEAD` or read each file via the `/project` mount (already there)
3. Review the actual code change, not the engineer's prose summary

**Sequencing:** before the next end-to-end forge run. Easy seed-only change (~5 lines in 2 seed CLAUDE.mds); no code change to the runner.

**Caught:** 2026-05-14 — during forge v2 smoke test post-merge.