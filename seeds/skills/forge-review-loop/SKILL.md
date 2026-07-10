---
name: forge-review-loop
description: Run the bounded reviewer→fixer loop against a ticket's already-committed work via `forge review-loop`. Use after implementation is committed to get an automated red-review + fix-round pass before a human gate, without standing up a full campaign or workflow run.
---

# forge-review-loop

`forge review-loop <ticket-id>` reviews the commit range associated with a ticket's committed work, dispatching a reviewer/fixer round-trip up to a bounded number of rounds. It **never auto-closes the ticket** — it reports whether the work is closeable; closing remains an explicit operator action (`forge backlog close`).

Source of truth for exact flags: `forge review-loop --help`. This skill only summarizes when to reach for it — it does not restate the flags, which drift.

## Non-goal

Host/orchestrator skill only. It documents a CLI command run from the terminal. Containerized agents do not discover or read `.claude/skills`.

## When to use it

- Implementation work for a ticket is committed (or you can point `--since <sha>` at the range), and you want an adversarial pass before opening a gate or closing the ticket.
- You want a self-contained review/fix cycle for one ticket without planning a campaign or a full workflow run.

Check `--dry-run` first if you want to see the resolved plan (ticket, route, commit range, round count, stop conditions) before dispatching.

## `closeable` also requires a trusted reviewed tip

A reviewer pass plus green verification is not enough. Before printing its verdict the loop refreshes the branch's remote-tracking ref with a bounded fetch (`--no-tags`, 20s timeout, no credential prompt), then requires the reviewed tip to **be** the remote head — equality, not merely an ancestor of it. Anything else withholds `closeable` and exits non-zero, naming the condition and the commits involved: `local_only` (push and re-run), `remote_ahead` or `diverged` (pull/rebase and re-run), `remote_unavailable` (no remote-tracking ref resolves, or the fetch failed).

Two consequences worth knowing before you reach for the loop: it needs working remote access, so **an offline run is never closeable by design** — a stale cached ref is never trusted; and a `closeable` verdict is a statement about the remote head, so it stays valid for a merge only until someone else pushes.

## Reviewer discipline — do not fork it here

The loop's reviewer role and its rubric are owned elsewhere; this skill points to them rather than duplicating them:

- **Reviewer seed and acceptance rubric**: `seeds/agents/shipping-reviewer/CLAUDE.md` — acceptance-criteria mapping, the "tests green but wrong production path" failure mode, the operator-contract enforcement check, and the done-audit guardrail.
- **Red-review discipline** (the `--review-profile` default panelist, e.g. `red-wide`): `seeds/agents/red-wide/CLAUDE.md` and sibling `seeds/agents/red-*/CLAUDE.md` — adversarial stance, verdict schema, evidence-anchoring rules.

If the review outcome looks wrong, the fix is to read/adjust those seeds (an engineer task), not to add review policy prose to this skill.

## Stop conditions

The loop stops on: `passed`, `blocked_by_reviewer`, `needs_fix_max_rounds`, `verification_failed`, `fixer_failed`, `fixer_out_of_scope`, `closeout_guidance_only`, or `reviewer_failed`. Any non-`passed` stop needs operator judgment — inspect the run rather than re-invoking the loop blindly.
