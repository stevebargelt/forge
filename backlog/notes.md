**Last session ended 2026-07-23.**

**Where we left off:** A long FG-583 arc and its follow-through closed cleanly; the FG-561 durable-orchestration-continuation EPIC is COMPLETE. No in-flight thread carried over — the next session starts fresh.

**Picked up next (no forced thread — pick by operator priority):**
1. **FG-593 [EPIC] Operator Work Management** (durable backlog / priority queue / dispatch) — pairs with **FG-496** (DB-backed active backlog: stop using git-tracked markdown as the live work-queue). Natural next big rock now that the continuation epic is done; would also end the FORGE_HOME/leak + dual-location backlog friction hit this session.
2. **FG-477** (workflow lifecycle evaluator — centralize task/run state semantics so ready-queue / completion / gate-recovery / campaign-resume / reconcile / operator surfaces can't drift). Cross-cutting; reduces the class of state-drift bugs seen repeatedly.
3. **FG-345** (git worktrees for ALL agents) — needs an architecture pass FIRST (parent design story); + **FG-356** orphan-worktree cleanup. Only start if you want to invest in the isolation model.
   Dashboard cluster (FG-348/349/386/395/402) is available for lighter-weight work. Nothing is blocked.

**External state to remember:**
- Both clones on main. Control checkout `~/code/forge` (the live npm-linked `forge`) synced to origin/main (`83e5d90`), clean. Its 4 local docs/planning commits (competitive-research + `backlog/PLAN.md`) were rebased onto origin and pushed this session — no longer diverged. Writer clone `~/code/forge-agent-work` is a few commits behind (those 4 docs commits) — `git pull` there before its next use.
- Host test caution: running tests directly on the host with `env -u FORGE_HOME` can leak into the real `~/.forge` (a stray `constraints/note.md` appeared mid-session and blocked ALL `forge invoke` until removed). Isolate FORGE_HOME per test; if invokes start failing with "missing required frontmatter", check `~/.forge/constraints` for frontmatter-less strays.

**Decisions worth not relitigating:**
- FG-583 routing authority: `route compile` (host) / `raci apply` are REFUSE-and-DIRECT, not republish (a republish from an operator action would mix release-owned + operator-authored provenance in one manifest). Fresh-install dispatchability is DOCUMENTATION (the required `forge upgrade --skip-project` bootstrap), not install-seeds.sh publication (runs pre-promotion = dev bytes; promote-time publish is a two-pointer problem).
- Don't re-close a ticket on a "children/tests pass" basis without walking its actual AC. The first FG-583 close was premature (overclaimed) and got reopened; FG-553 got a genuine aggregate-AC walk (F29 executed under a hostile PATH, F28/T9 empirical, F30 R1/R2 + explicit R3/R4 contract) before closing.
- Agent unreliability pattern: engineer invokes sometimes exit `no_result_json` (container-wait bug) but the work is on disk — verify on disk before re-running; an agent's in-container "green" is NOT authoritative (reused FORGE_HOME state), CI (clean, sharded) is the gate.

**Shipped (for reference):**
- **FG-561 [EPIC]** — durable orchestration continuation COMPLETE (8 slices; FG-565 closeout verified the F1–F35 + T9 matrix).
- **FG-553** — forge-on-forge stable control runtime (Slice 1), closed on aggregate evidence of children FG-567–572.
- **FG-583** — atomic seed generation + move-the-invariant (no flat dispatch fallback) + full routing authority model + documented bootstrap + real-CLI acceptance test (`8272e5b` PR #154, `b0dd651` PR #155).
- **FG-572** — installed-surface-compatibility umbrella (all 7 children). **FG-605** — absorbed into FG-583.
