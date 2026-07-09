---
id: FG-502
type: story
status: active
title: "review-loop fixer scope-guard and campaign item-state: in-diff docs revert whole fix rounds; out-of-band-shipped items stay failed/campaign_system; stranded local fixer commits"
created: 2026-07-09
---

## Problem

Three related review-loop/campaign-runner frictions, each hit repeatedly in the 2026-07-09 autonomous campaign session (campaign-7a56519b2f3d; journal: notes/autonomous-session-2026-07-09.md):

1. **Fixer scope-guard reverts entire fix rounds over in-diff docs (6 occurrences).** The review-loop fixer's DISALLOWED_RE (docs/, learnings/, README*, backlog/) reverts the WHOLE round — including valid code fixes — when the reviewed diff's own contract docs (docs/SCHEMA-CONTRACT.md, docs/concepts.md, learnings ADR) legitimately need editing to stay true against the code fix. FG-487 hit this twice, FG-492 four times; each cost a full reviewer+fixer round and forced a manual engineer invoke as the workaround. The guard's purpose (fixers must not close tickets / rewrite policy) is right; its blast radius (whole-round revert, docs of the diff's own surface) is wrong.

2. **Out-of-band-shipped full_feature items stay failed/blocker=campaign_system.** Both FG-487 and FG-492 completed their runs (or shipped via salvage) but their campaign items read failed/campaign_system because the item state derives from run history containing a gate rejection or fanout failure — and campaign reconcile explicitly reports them not_applicable (it only recovers scope blockers). The campaign then permanently displays failed items for shipped work; only quick/docs lanes (awaiting_gate shape) are reconcilable to shipped.

3. **Review-loop fixer commits can strand local-only.** FG-366's loop-2 fixer committed 609ec7d on the branch AFTER the orchestrator's last push; the loop reported closeable at that tip, but the PR merged only the pushed head — silently dropping reviewed fixer work (recovered by cherry-pick, PR #82). The loop knows it created commits; nothing surfaces "branch tip is ahead of origin" at loop exit.

## Goal

- Fixer rounds are not destroyed for touching the reviewed diff's own documentation surface: either allow docs files already present in the commit range under review, or revert ONLY the disallowed paths and keep the code fix (with the docs finding surfaced to the orchestrator like closeout guidance).
- Campaign reconcile (or a sibling verb) can derive shipped for a failed/campaign_system item from the same durable evidence used for awaiting_gate items (ticket done + closed commit reachable + lane evidence).
- Review-loop exit output states when the branch tip holds loop-created commits not present on origin (and the closeable summary includes the tip sha), so an orchestrator cannot merge a stale head unknowingly.

## Acceptance Criteria

- [ ] A fixer round whose only out-of-scope paths are docs/learnings files ALREADY MODIFIED in the commit range under review is not reverted; backlog/ and ticket-closeout writes remain hard-reverted.
- [ ] If any path is still reverted, in-scope code changes from the same round survive, and the reverted-path findings are surfaced to the orchestrator (closeout-guidance style), not silently dropped.
- [ ] campaign reconcile can ship a failed/blocker=campaign_system item when ticket/commit/lane evidence proves out-of-band delivery (same evidence bar as awaiting_gate items); the audit row records this recovery kind distinctly.
- [ ] review-loop's final report names the branch tip sha and flags loop-created commits that are not on the remote tracking branch.
- [ ] Tests cover: in-diff docs fix survives; backlog write still reverted whole; campaign_system item ships from evidence; unpushed-tip warning appears.

## Evidence

- FG-487: loops 2+3 fixer_out_of_scope on docs/SCHEMA-CONTRACT.md (runs run-review-loop-fg-487-0a79b1, run-review-loop-fg-487-133cec).
- FG-492: loops 1-3+5 fixer_out_of_scope on docs/SCHEMA-CONTRACT.md / docs/concepts.md / learnings ADR (runs …c930cd, …4e9ed5, …65d65c, …44b6d4).
- FG-487/FG-492 items: failed/campaign_system after shipped+closed (campaign-7a56519b2f3d); reconcile not_applicable both passes.
- FG-366: stranded fixer commit 609ec7d recovered via PR #82.
- FG-503: SECOND stranded fixer commit (f54d57a, loop-3 round-1) — worse than FG-366's: the reviewer's round-2 PASS evaluated the stranded tip, so the merge landed code the pass did not fully describe; recovered via PR #84. This elevates the unpushed-tip warning from nice-to-have to correctness: a `closeable` verdict must name the tip sha it reviewed, and the orchestrator must merge THAT sha or re-review.

## Non-Goals

- No relaxation of the backlog-closeout guard (FG-462 semantics stay).
- No campaign schema change beyond what the reconcile recovery needs.
