---
id: FG-505
type: story
status: done
title: sweeper cannot heal a lost resolution write (container gone, reap_failed sticky forever); dry-run leak wording says now swept
created: 2026-07-09
closed: 2026-07-09
closed_commit: df1f06a0c2cf64456abc7c9789aaa44aab508c0c
---

## Problem

Operator review round 3 on the FG-503/FG-504 reap lifecycle (2026-07-09):

1. **Medium — lost resolution write is unhealable.** src/cli/commands/ops.ts:168 reaps first, then writes `container.reaped` at :181; `logEvent` is a plain DB insert (src/store/events.ts:146) and can throw. If docker rm succeeds but the insert fails, the container is gone, `ops check` keeps the stale `container_reap_failed` incident, and — because FG-503 candidacy is disk-truth-driven — a later sweep never sees the (absent) container to re-attempt the resolution. Permanent stickiness through the DB-write edge.
2. **Low — dry-run wording.** Dry-run adds completed leaks to `completedTaskLeaks` (ops.ts:157) and the plain output prints "now swept" (ops.ts:286) — contradicting the leading "(dry-run) would reap" line. Should read "would be swept" (or a separate dry-run wording path).

## Goal

A successful repair always eventually clears the incident — even when the resolution write itself failed — and dry-run output never claims completed actions.

## Design direction

Extend the sweep with an absence-heal pass, consistent with the FG-503 disk-truth philosophy: for every unresolved `container.reap_failed` event (no later resolution for that containerName), if the container is ABSENT from the `docker ps -a` listing the sweep already fetched, record the resolution (`container.reaped`, marked as confirmed-absent-at-scan rather than actively removed). This heals the crash window AND operator-manual `docker rm` cleanups with zero extra docker calls. Additionally make the post-rm `logEvent` non-fatal (try/catch; a failed insert is reported, the sweep continues, and the next sweep's absence-heal closes it).

## Acceptance Criteria

- [ ] A `container.reap_failed` event with no later resolution whose container is absent from the sweep's docker listing gets a resolution event recorded by `forge ops reap-containers` (live mode), and `forge ops check` no longer raises the incident afterward — covered end-to-end (reap_failed → container manually/externally gone → sweep → incident cleared).
- [ ] A thrown `logEvent` during resolution recording does not abort the sweep (remaining candidates still processed; failure reported); the next sweep heals it via absence.
- [ ] Dry-run output says "would be swept" (or equivalent conditional wording) for completed leaks — never "now swept"; live-mode wording unchanged. Both plain and --json shapes remain distinguishable.
- [ ] Absence-heal never fires in dry-run (it writes events), and never fires when the container is still present.
- [ ] Tests for each bullet, including the wording in the real CLI.

## Non-Goals

- No docker calls added to ops check/detect.ts (stays pure-DB).
- No transactional coupling of docker rm + event insert (heal-on-next-pass is the recovery model).
