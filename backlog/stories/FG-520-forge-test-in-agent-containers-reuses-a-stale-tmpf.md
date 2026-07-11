---
id: FG-520
type: story
status: active
title: forge-test in agent containers reuses a stale /tmp/forge-work snapshot — false-green hazard when an agent edits source and re-runs tests
created: 2026-07-11
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
