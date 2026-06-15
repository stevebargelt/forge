---
id: FG-138
type: story
status: done
title: forge status is host-global; per-workspace orchestrators see runs from other projects
---

**Closed:** 2026-05-23. Commit `741e6f2`.

**Why:** Surfaced 2026-05-14 when Steven started a Claude Code orchestrator session in `~/code/audit-workspace` and it (correctly per the orchestrator template) ran `forge status --json` on startup, then picked up two `awaiting_gate` runs that actually belong to `~/code/forge`. The orchestrator's mental model is "I'm the forge orchestrator"; the reality is "I'm an orchestrator for ONE project, but forge state in `~/.forge/forge.db` is host-global."

Same category mismatch we already hit with BACKLOG.md being unscoped. Now for runs.

**Blast radius is small (not a data bug):** the orchestrator can't corrupt anything across workspaces. `forge next <runId>` uses the run's stored `projectDir`, so any dispatch goes to the original project. The worst case is a confused orchestrator wasting context on runs that aren't its responsibility.

**Fix shape (lean):**

1. **`forge status` filters by current workspace by default.** Add `--all` for the cross-project view. Resolves the "orchestrator sees foreign runs" problem at the CLI level — no orchestrator-template logic needed for the default case. ~30 LoC in `src/cli/commands/status.ts` + a filtered query in `src/store/runs.ts`.

2. **Stamp workspace into run metadata at invoke/new time.** Add `--workspace` flag defaulting to `cwd` on `forge invoke` + `forge new`; write to `run.metadata.workspace`. ~20 LoC. `forge status` matches `cwd === run.projectDir OR cwd === run.metadata.workspace` — the second clause handles audit-workspace cases where the orchestrator's workspace ≠ the target repo.

3. **Orchestrator template tweak.** Change the "pick up watching" instruction to: "Only pick up runs whose `projectDir` or `metadata.workspace` matches this workspace. Ignore others." Belt-and-suspenders complement to (1) and (2). ~10 LoC edit to `seeds/orchestrator-template.md`.

4. **Dashboard already does the right thing** (shows all runs intentionally — it's the cross-project survey surface). No change there.

**Sizing:** small fast-follow. Probably one short session for all three pieces.

**Workaround until landed:** tell the orchestrator in conversation "you're the X-workspace orchestrator; ignore runs whose projectDir isn't under this workspace." It listens.

**Caught:** 2026-05-14 — during audit-workspace bring-up.