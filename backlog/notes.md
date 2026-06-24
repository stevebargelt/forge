**Last session ended 2026-06-24.**

**Where we left off:** Shipped FG-381 (Reviewer Context Packet) and FG-389 (legacy BACKLOG.md removal) end-to-end through the full pipeline, both reviewed hard by the user and closed. Tree is now CLEAN and fully pushed (origin/main at 6ae7b23): the concurrent other-session work that was sitting uncommitted was committed at user request (6ae7b23) alongside the handoff note. Next move was left open between FG-384 (the Shipping Reviewer that consumes the packet) and the FG-397/398/399 robustness cluster.

**Picked up next:**
1. **FG-384 — LLM Shipping Reviewer role** that consumes the FG-381 Reviewer Context Packet. The payoff for FG-381 and what makes FG-388 (deferred packet docs) reachable; advances the FG-372 epic. BLOCKER to wire first: the packet reads `run.metadata.ticketId` but NOTHING writes that field yet, so `assembleReviewerContextPacket` fail-louds (required missingContext) on every real run — FG-384 (or a small precursor) must add a ticketId populate-path at run creation.
2. **FG-397 / FG-398 / FG-399 — structured backlog close/file robustness cluster** (filed this session): FG-397 close write-then-unlink is non-atomic (crash leaves a ghost active copy shadowing the done file); FG-398 `file` id generation is a read-then-write race; FG-399 `close --commit <sha>` is accepted but never recorded for structured tickets (audit-trail gap vs the old legacy path). Bounded fixes; good to harden the backlog CLI before building on it.
3. **FG-376** (worktree node_modules parity) + **FG-357** (post-merge integration gate) — the worktree-arc next moves from the prior session, untouched this session and still ready.

**External state to remember:**
- Several ACTIVE tickets in the backlog are OTHER orchestrator sessions' threads, not part of the FG-381/FG-389 work (now committed but not mine): FG-370 -> epic + FG-390..396 (campaign runner) and FG-400/401/402 (dashboard overview/capability-matrix/attention-inbox). Don't assume they're yours to pick up; another session owns them. When committing FG-work, stage with explicit pathspecs (concurrent sessions dirty the tree).
- The FG-381 packet's `run.metadata.ticketId` reader is DORMANT (no writer exists) — see FG-384 blocker above.
- Supacode auto-locks forge-created worktrees (lock owner=supacode); `git worktree remove --force` refuses them — unlock-first or `-f -f`. Relevant to FG-356 cleanup design.

**Decisions worth not relitigating:**
- **FG-389 kept ONE legacy surface only:** `forge backlog-migrate` (isolated one-way import, reads via the retained minimal `parseBacklog`); structured `backlog/` is the sole active model. Do not reintroduce any BACKLOG.md runtime path.
- **Feature pipeline build fans out per plan-step and REQUIRES file-independent steps.** Cohesive work (a new primitive, or a tightly-coupled removal) must be ONE coherent build step, or it merge-conflicts (FG-381) / fails isolated typecheck (FG-389). Scrutinize this at the PLAN gate; docs/seed prose goes to the docs phase, not a build step.
- **FG-381 packet is structured-backlog-only** (`readTicket`, exact string ids, blocking fail-loud on missing required context). The `reviewer-context-packet.test.ts` BACKLOG.md fixture is an intentional adversarial CANARY (proves the packet ignores a present BACKLOG.md) — do not delete it.
- **FG-397/398/399 were deliberately scoped OUT of FG-389** (pre-existing structured close/file behavior surfaced by reds), filed as separate tickets rather than expanding the removal story.
- **Packet-contract docs deferred to FG-388** — write them when FG-384 makes the reviewer reachable; documenting now would describe an unreachable knob (the FG-379 anti-pattern).

**Shipped (for reference):** FG-381 (Reviewer Context Packet — assembler over the blackboard + dispatchReds shipping-reviewer wiring + shipping-reviewer seed; structured-only; blocking fail-loud; `ebdfece`) · FG-389 (remove legacy BACKLOG.md; structured canonical; isolated `backlog-migrate` one-way import; `backlog list --search` fix; CLAUDE.md re-render; `934facc`). Filed FG-388 (deferred packet docs) + FG-397/398/399 (backlog robustness). Closed FG-381 and FG-389. Host suite 1776/1776 green at session end.
