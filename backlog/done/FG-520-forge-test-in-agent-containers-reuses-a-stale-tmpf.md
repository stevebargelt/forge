---
id: FG-520
type: story
status: done
title: forge-test in agent containers reuses a stale /tmp/forge-work snapshot — false-green hazard when an agent edits source and re-runs tests
created: 2026-07-11
closed: 2026-07-11
closed_commit: c30bcff
---

## Problem

`/usr/local/bin/forge-test` (agent-dev-worker image) copies `/project` to `/tmp/forge-work` ONLY when that dir does not already exist (`if [[ ! -d "$WORK_DIR" ]]`), then reuses the copy verbatim on every subsequent invocation in the same container. It never re-syncs source.

Consequence: any agent that edits source and re-runs `forge-test` inside the same container session is testing a snapshot taken at its FIRST invocation — a silent false-green (or false-red) against stale code.

## How it was caught

During FG-410 the engineer ran an old-vs-new implementation comparison: after swapping implementations, `forge-test` reported a green run against code that had already been changed on disk. Only after `rm -rf /tmp/forge-work` did the run reflect the current source. Surfaced in the FG-410 engineer result notes (run-fg-410-column-targeted-campaign-item-updates-53dec1).

## Blast radius

Fleet-wide: every implementer/test agent that follows the edit → re-test loop (i.e., all of them). First-run results are fine; any RE-run after an edit is untrustworthy.

## Acceptance criteria

- `forge-test` re-syncs the work dir from `/project` on every invocation (rsync-style, or invalidate on content change), OR removes the copy-once guard with a documented rationale for why cold-copy-per-run is acceptable.
- A re-run after a source edit provably tests the edited source (regression test or documented verification in the image build).
- Image rebuilt (docker/build.sh) and the staleness noted in `forge upgrade` release check cleared — candidate to fold into the FG-513 rebuild.

- The guard must also repair a PRESENT-BUT-BROKEN scratch dir, not just a stale one: the FG-410 test-engineer arrived to a pre-existing /tmp/forge-work with an EMPTY node_modules (project mount had no node_modules), and `[[ ! -d $WORK_DIR ]]` silently reused it — every test failed in ~20ms with ERR_MODULE_NOT_FOUND: 'tsx'. Re-sync/validate deps, don't just check dir existence.

## Notes

Filed from the FG-410 engineer's validation notes (2026-07-10); independently reproduced (empty-node_modules variant) by the FG-410 test-engineer in the same run. Relates to FG-513 (image rebuild) and the standing agent-image staleness flag from the 07-10 session handoff.


## Close evidence (2026-07-11, PR #104, merge c30bcff)

AC walk:
- **Re-sync every invocation**: docker/forge-test.sh mirrors /project into the scratch per run — byte-equality comparison (review round upgraded from stat-based), mode-bit propagation, deletes removed paths, preserves node_modules/.git. 20+ scenario tests (temp dirs + stubbed npm): edit→fresh, same-size edit→fresh, chmod→propagates, delete→gone, new-dir file, dir deletion, unchanged→skip.
- **A re-run after a source edit provably tests the edited source**: LIVE SMOKE in a real container on the rebuilt image — script identity diffed, a canary test appended to real source appeared by name on re-run, breaking it surfaced the failure (transcript in run-fg-520-forge-test-resync-ffa2df, task-test-engineer-a4a1fb).
- **Present-but-broken scratch repaired, not reported as red tests** (the empty-node_modules extension): per-invocation deps validation — missing/empty tree, lockfile fingerprint change, unloadable tsx/better-sqlite3, AND whole-tree integrity (npm ls --all, 0.15s, catches gutted transitives) → npm ci + native rebuilds via _npm_or_fatal; unrepairable → FATAL + exit 2 = ENVIRONMENT failure (contract enforced even when npm itself fails — mutation-checked).
- **Image rebuilt + staleness cleared**: agent-dev-worker rebuilt twice, finally from the exact merged tip (3b8ba3f content = c30bcff content); release-doctor fixed in-PR to treat COPY'd build inputs (forge-test.sh, agent-entrypoint.sh) as staleness triggers, so forge upgrade now catches this class.

Gates: review-loop closeable (run-review-loop-fg-520-d0ef3e; tip = remote head; 4 loop runs total — every finding real: seed prose, FATAL-on-npm-failure, doctor staleness model, docs rebuild guidance, deps-tree integrity). CI green at tip. Docs impact: **updated** — docs/how-to-testing.md (behavior section), docs/how-to-upgrade.md (rebuild triggers), docker/build.sh header, 5 implementer seeds. FG-534 resolved by the in-review byte-equality mirror (closing with this merge).
