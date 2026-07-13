---
id: FG-550
type: story
status: active
title: Handoff should flag memories its own session invalidated
created: 2026-07-13
---

## Problem

Memory drift is often created by a session that already has enough local context to identify it, but discovered only weeks later by an expensive audit.

When the WNBA/Pixtron module was renamed, that same session knew it had falsified the memory `project_go_rewrite` ("module is wnba-led-scoreboard/go-scoreboard"). It also made three other remembered claims stale: the Python app was deleted rather than frozen, the `--demo` flag was removed, and brightness/timezone behavior became honored. None was captured at creation time. A later `/memory-review` had to reconstruct all four invalidations from the codebase.

`/handoff` already records decisions, unresolved work, next moves, and shipped items, but its memory guard only says not to update memory without proposing the change first. It does not require the session to preserve what it already knows it invalidated.

## Goal

Make session-created memory drift cheap and visible at handoff time without turning `/handoff` into a memory audit or weakening reviewed-stamp integrity.

## Design

Add one optional section to the handoff notes template:

> **Memories this session may have invalidated:** <specific memory file and a one-line proposed correction for each claim contradicted by this session's changes>

Rules:

- Consider only memories implicated by changes or decisions made in the current session. Do not scan or re-review the whole memory corpus.
- Name specific memory files and the contradicted claim; give a bounded one-line proposed correction for each.
- Propose only. Do not edit memory files, update `CLAUDE.md`, or write a `reviewed:` stamp.
- Omit the section entirely when no current-session change is known to contradict memory, consistent with handoff's existing no-padding rule.
- Add "never write a `reviewed:` stamp" explicitly to handoff's Do-NOT list.

The mechanisms remain complementary:

- `/handoff` catches drift at creation time using context the session already has. It is cheap, unverified, and writes no stamps.
- `/memory-review` catches accumulated drift on a deliberate audit cadence. It verifies against current sources and owns reviewed stamps.
- Dream may prescribe `/memory-review` separately when flagged-memory volume crosses its policy threshold; that is not part of handoff.

## Scope and propagation

Primary template:

- `scripts/claude-commands/handoff.md`

Forge-managed project commands are symlinks to this canonical template, not independent copies. The implementation must verify that the template change is immediately visible through current symlinks and that the existing `forge init` / `forge upgrade` provisioning path repairs stale Forge symlinks while preserving intentional project-local regular-file overrides. Do not introduce a ten-copy synchronization mechanism.

Add focused tests at the existing slash-command provisioning/template boundary. Update durable command documentation only if the implementation changes the documented handoff contract.

## Acceptance Criteria

- The canonical handoff template contains the optional `Memories this session may have invalidated` section and tells the agent to name specific memory files plus one-line proposed corrections.
- The template limits consideration to memories contradicted by the current session's own changes or decisions; it does not invoke or approximate a full `/memory-review`.
- A handoff for a session that knowingly contradicts a memory includes the memory filename, the contradicted claim or correction, and no `reviewed:` stamp.
- The section is omitted entirely when no current-session invalidation is known.
- The Do-NOT list explicitly forbids writing a `reviewed:` stamp and continues to forbid unapproved memory or `CLAUDE.md` edits.
- Running handoff does not modify any memory file or `CLAUDE.md`.
- Existing Forge-managed project symlinks expose the updated canonical template without per-project copying.
- Provisioning tests show that `forge init` / `forge upgrade` retain or repair Forge-managed command symlinks and do not overwrite project-local regular-file overrides.
- No reviewed stamp is created or refreshed merely because handoff flagged a possible invalidation.

## Non-Goals

- Running `/memory-review` automatically at handoff.
- Verifying whether every flagged correction is currently true.
- Editing memory files or `CLAUDE.md` from `/handoff`.
- Writing or refreshing reviewed stamps.
- Auditing memories unrelated to the current session.
- Changing Dream's audit-threshold policy.

## Relations

- Related to FG-380, which moves handoff operational state out of tracked project files. This story changes handoff content semantics and remains valid regardless of where the notes block is stored.
