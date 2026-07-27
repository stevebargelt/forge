---
id: FG-626
type: story
status: active
title: forge launch run silently drops the caller's environment — every FORGE_* env gate is inert under the mandated launch pattern
created: 2026-07-27
---

**Found by dogfooding FG-621 (2026-07-27).** The first real run on the private-clone substrate
failed in 10 seconds, and the cause was not the substrate.

## What happens

`forge launch run` starts the workload in a tmux session that does NOT inherit the invoking
process's environment. Per-invocation env vars are silently dropped. Proven directly:

```
FORGE_WORKTREES=1 forge launch run --name envprobe -- env      # FORGE_WORKTREES absent from the log
forge launch run --name envprobe2 -- env FORGE_WORKTREES=1 env # present
```

Ambient/profile environment survives — the tmux SERVER inherited it when it first started, which is
why auth (AWS_PROFILE, CLAUDE_CODE_USE_BEDROCK) has always worked under launch and masked this.
Only per-invocation vars are lost.

## Why this matters more than it looks

`seeds/orchestrator-template.md` MANDATES `forge launch run` for all long-running work (FG-535,
because the harness SIGTERM-sweeps background tasks). So the prescribed dispatch path silently
disables every env-gated behavior forge has:

- `FORGE_WORKTREES=1` — isolation never arms
- `FORGE_WORKTREE_IGNORE_DIRTY=1` — the dirty gate never relaxes
- `FORGE_NO_WORKTREES=1` — the kill switch never engages
- `FORGE_CI_POLL_SECONDS` / `FORGE_CI_WAIT_TIMEOUT_SECONDS`, `FORGE_CONTROLLER_ID`, and any future
  env gate

There is no error and no warning. The command runs, does the wrong thing, and reports success at
the launch level. In the FG-621 dogfood the only reason this surfaced at all is that the FG-612
self-host guard independently refused the dispatch — it saw isolation off and protected the live
source. Without that guard, agents would have written directly into the executing forge checkout
while the operator believed isolation was armed. **A safety gate the operator thinks is on and is
actually off is the worst shape this can take.**

## Fix direction (not prescriptive)

Forward the caller's environment into the launched command, or — if a deliberately clean environment
is the intended contract — make that contract explicit and fail loudly rather than silently: refuse
or warn when the invocation carries `FORGE_*` vars that will not survive, and document the
`env VAR=… <cmd>` wrapper as the supported way to pass them. The current behavior is neither
inherited nor refused; it is silently dropped, which is the one option that cannot be reasoned about.

Note `--require-control-toolchain` already refuses a shell wrapper in order to control PATH, so
deliberate environment control clearly exists in this code path — the gap is that FORGE_* gates are
neither preserved nor reported.

## Acceptance criteria

1. A per-invocation `FORGE_*` env var set on a `forge launch run` invocation either reaches the
   launched command, or the launch REFUSES/WARNS naming the variable that will not survive.
2. Silent drop is gone: no supported path lets an operator believe an env gate is armed when it is
   not.
3. Regression test proving `FORGE_WORKTREES=1 forge launch run -- <cmd>` results in the gate being
   armed (or an explicit refusal), driven through the real launch path.
4. `forge-test` green; required CI checks green.

Refs: FG-535 (launch ownership), FG-612 (the guard that caught it), FG-621 (the dogfood that
exposed it), FG-555 (`--require-control-toolchain`, the existing deliberate env/PATH control).
