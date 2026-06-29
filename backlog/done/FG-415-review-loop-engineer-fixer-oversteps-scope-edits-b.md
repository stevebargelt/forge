---
id: FG-415
type: story
status: done
title: "review-loop engineer-fixer oversteps scope: edits backlog state + durable docs, leaves changes uncommitted"
created: 2026-06-29
closed: 2026-06-29
closed_commit: 2ae6e71
---

## Problem

`forge review-loop` runs a bounded reviewer (red-wide) → fixer (engineer) cycle (#301). During FG-413 the
engineer-fixer overstepped its scope in two ways the orchestrator had to catch and undo manually:

1. **Edited artifacts it does not own.** In one round the fixer:
   - set the source ticket's frontmatter to `status: shipped` — an improper self-close (only the orchestrator
     closes tickets, after the AC-evidence walk, via `forge backlog close`, which moves the file to `done/`
     with a `closed_commit`; flipping frontmatter to a non-standard "shipped" bypasses that entirely);
   - edited `backlog/notes.md` (session handoff — orchestrator-owned ephemeral state);
   - rewrote `docs/concepts.md` (durable operator doc — the documentation-maintainer's surface), incompletely
     (a later review round found three more stale spots it had missed).

   This is the same artifact-ownership boundary the orchestrator policy enforces for direct work, and the same
   class of issue as FG-340 (test-engineer seed wording inducing `git commit`). The fixer running in
   `review-loop` should be scoped OUT of: backlog state (`backlog/**`), durable docs (`docs/**`,
   `learnings/**`, `README*`), and the orchestrator-policy surfaces — i.e. restricted to source code + tests,
   the same allowlist split the orchestrator template already defines.

2. **Leaves fix changes uncommitted in the working tree.** Across two separate FG-413 loops the fixer applied
   edits but did not commit them — `review-loop` reports `fix: applied` while HEAD is unchanged and the diff
   sits unstaged. The orchestrator then has to discover, inspect, and commit (or revert) the working-tree
   delta by hand. The round-2 verification ran against this uncommitted working tree, so the reviewed state
   and the committed range (`--since`) diverge: the green/pass verdict covers code that is not in any commit
   the range names. This is confusing and audit-unfriendly.

## Goal

Make the `review-loop` fixer (a) unable to touch non-code artifacts, and (b) deterministic about what is
committed vs. left in the working tree, so the orchestrator does not have to police scope and commit state by hand.

## Acceptance Criteria

- The review-loop fixer cannot modify `backlog/**`, `docs/**`, `learnings/**`, `README*`, or ticket
  frontmatter/status. If a fix genuinely needs a durable-doc or backlog change, the loop surfaces that as a
  finding/handoff for the orchestrator rather than having the fixer do it. (Enforcement mechanism — fixer
  brief constraint, mount/permission restriction, or post-fix diff guard — is an implementation choice; a
  prompt-only instruction is the weakest option and should be backed by a guard.)
- Commit behavior is deterministic and documented: either the loop commits each round's fix itself (with a
  clear message + ticket ref) so the reviewed state == a named commit, or it explicitly reports the
  uncommitted working-tree paths it left for the orchestrator. No silent `fix: applied` with an unchanged HEAD
  and an unexplained dirty tree.
- A post-fix scope guard: if the fixer's diff touches a disallowed path, the loop fails that round with a
  clear reason (e.g. `fixer_out_of_scope`) rather than accepting the edit.
- Verification (typecheck/test) and the reviewed range are consistent — the state the reviewer passes is the
  state captured by the loop's reported commit range.
- Tests cover: a fixer diff touching `backlog/` or `docs/` is rejected/surfaced (not silently accepted); the
  loop's reported commit/working-tree state matches what it actually did.

## Evidence / Repro

Observed during FG-413 (commits `75d01f6`..`fc29f81`, 2026-06-29). First close round: fixer set FG-413
`status: shipped`, edited `backlog/notes.md` and `docs/concepts.md` uncommitted — reverted by the orchestrator,
docs re-routed to the documentation-maintainer. Second (reopen) round: fixer left correct, in-scope code fixes
(`executor.ts` / `campaign.ts` / a CLI integration test) uncommitted in the working tree; orchestrator
inspected and committed them as `925967d`.

**Third occurrence (deterministic, not a fluke):** during the FG-416 review-loop (2026-06-29), round 1's
fixer again flipped the source ticket's frontmatter to `status: done` in place (an improper close — the
ticket is closed via `forge backlog close`, which MOVES the file to `done/` with a `closed_commit`) AND
edited `docs/concepts.md`, both uncommitted. Orchestrator reverted both and routed the genuine doc-precision
nit through the documentation-maintainer. Same two failure modes (out-of-scope artifact edits + uncommitted)
recurring across independent tickets confirms this is a systematic fixer-scope defect, not incidental.

## Relations

- Sibling of FG-340 (test-engineer seed wording → self-commits) — same artifact-ownership / fixer-discipline family.
- Pertains to the `review-loop` command (#301) and the orchestrator artifact-ownership allowlist split.
