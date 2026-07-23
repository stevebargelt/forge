**Last session ended 2026-07-23.**

**Where we left off:** A long FG-583 arc plus its follow-through closed cleanly. The FG-561 durable-orchestration-continuation EPIC is now COMPLETE — no in-flight thread carried over.

**Picked up next:** No forced thread. The active backlog is broad — pick by operator priority. Candidate clusters: dashboard surfaces (FG-348 Run Map, FG-349 control-plane sources, FG-386 readiness/done audits, FG-395 campaign view, FG-402 attention inbox), worktrees-for-all-agents (FG-345 parent + FG-356 orphan cleanup, needs an architecture pass first), FG-477 (workflow lifecycle evaluator — centralize task/run state semantics), FG-496 (DB-backed active backlog, relates to FG-593 epic), and provider adapters (FG-253). Nothing is blocked.

**External state to remember:**
- Both clones synced to origin/main (`532a881`). Control checkout `~/code/forge` (the live npm-linked `forge`) had 4 local docs/planning commits (competitive-research + backlog/PLAN.md) — rebased onto origin and pushed this session; no longer diverged. Writer clone `~/code/forge-agent-work` is a few commits behind (the 4 docs commits) — `git pull` there before next use.
- Host test caution: running tests directly on the host with `env -u FORGE_HOME` can leak into the real `~/.forge` (a stray `constraints/note.md` appeared mid-session and blocked all `forge invoke` until removed). Isolate FORGE_HOME per test; if invokes start failing, check `~/.forge/constraints` for frontmatter-less strays.

**Decisions worth not relitigating:**
- FG-583 routing: `route compile` (host) / `raci apply` are REFUSE-and-DIRECT, not republish (a republish from an operator action would mix release-owned + operator-authored provenance in one manifest). Fresh-install dispatchability is DOCUMENTATION (the required `forge upgrade --skip-project` bootstrap), not install-seeds.sh publication (runs pre-promotion = dev bytes; promote-time publish is a two-pointer problem).
- Don't re-close a ticket on a "children/tests pass" basis without walking its actual AC — the first FG-583 close was premature (overclaimed); FG-553 got a genuine aggregate-AC walk (F29 executed under hostile PATH, F28/T9 empirical, F30 R1/R2 + R3/R4 contract) before closing.

**Shipped (for reference):**
- **FG-583** — atomic seed generation + move-the-invariant (no flat dispatch fallback) + full routing authority model (host policy from the generation; refuse-and-direct; policy manifest-verified; preflight/dispatch anchored) + documented bootstrap + real-CLI acceptance test. `8272e5b` (PR #154) + `b0dd651` (PR #155).
- **FG-572** — installed-surface-compatibility umbrella (all 7 children FG-577–583).
- **FG-605** — absorbed into FG-583's routing authority model.
- **FG-553** — forge-on-forge stable control runtime (Slice 1), closed on aggregate evidence of FG-567–572.
- **FG-561 [EPIC]** — durable orchestration continuation COMPLETE (all 8 slices; FG-565 closeout verified the F1–F35 + T9 matrix).
