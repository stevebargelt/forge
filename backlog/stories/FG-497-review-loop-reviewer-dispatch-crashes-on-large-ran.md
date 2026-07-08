---
id: FG-497
type: story
status: active
title: "review-loop reviewer dispatch crashes on large ranges: agent-entrypoint exec fails with 'argument list too long' (packet passed inline instead of file-mounted)"
created: 2026-07-08
---

## Problem

Observed 2026-07-07, run-review-loop-fg-474-fd2c31 (FG-474 second loop, 6-commit range 95ff8e1..265c7d4): the red-wide reviewer container died at exec with:

    exec /usr/local/bin/agent-entrypoint: argument list too long

- task dir: ~/.forge/runs/run-review-loop-fg-474-fd2c31/task-red-wide-c260de/ — result.json 0 bytes, container.stdout.log empty; the agent never started.
- package.md in the task dir is 123,337 bytes; rendered CLAUDE.md 133,638 bytes. Linux MAX_ARG_STRLEN is 131,072 per argv/env string — a single inline string of the packet (or the rendered context) breaches it on large review ranges.
- The loop classified this as reviewer_failed (correct: genuinely absent result), but the failure is deterministic for large ranges — retrying the loop cannot succeed.
- Contrast: the FIRST FG-474 loop (run-review-loop-fg-474-37cd7c, 2-commit range) ran the same reviewer fine, and engineer/test-engineer/documentation-maintainer containers with the same rendered CLAUDE.md were unaffected — the inline-delivery path is specific to the review-loop reviewer dispatch.

## Goal

Reviewer dispatch delivers the packet via a bind-mounted file (the task dir already holds package.md) and the entrypoint reads it from disk, so packet size cannot crash exec. Large-range review-loops complete instead of failing structurally.

## Acceptance criteria

- [ ] A review-loop over a range whose packet exceeds 128KB dispatches the reviewer successfully (regression test with a synthetic large packet through the real dispatch path, container exec boundary stubbed or integration-tagged).
- [ ] No agent dispatch path passes agent prompt/packet content as a single argv or env string with unbounded size; content of unbounded size travels via file mount.
- [ ] A genuinely absent/unparseable reviewer result still stops reviewer_failed.

## Refs
- ~/.forge/runs/run-review-loop-fg-474-fd2c31/ (preserved evidence)
- FG-493 (verdict-vocabulary reviewer_failed — DIFFERENT failure, don't conflate: that one has a well-formed result.json)
