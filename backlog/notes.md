**Last session ended 2026-08-13.**

**Where we left off:** Three tickets shipped and closed in one session, each with a full
acceptance-evidence grid: **FG-626** (`af81d851`, PR #241), **FG-707** (`af12a82d`, PR #242) and
**FG-706** (`1f36d4cd`, PR #243). All three went engineer -> test-engineer -> evidence-led review ->
required CI -> merge. One follow-up remains open from this work: **FG-708** (unstarted). The session
ended cleanly after FG-706 closed and its clone was removed, not mid-thread.

**Picked up next:**

1. **FG-708** — acceptance/resolution evidence cannot cite a test whose name contains a semicolon.
   Filed from real friction: it refused two of FG-707's acceptance criteria for tests that had
   demonstrably passed. `test_name` (`src/v2/review-evidence.ts:82`) is `z.string()` while its
   sibling `ran` already accepts `string | string[]` — the fix pattern is one field over, and the
   asymmetry is the defect, not the splitting. Small and well-specified.
2. **FG-626 was the head of release-train section 1 and is now DONE**, so the next release-train item
   is whatever PLAN.md lists after it — re-read PLAN.md before assuming.
3. **FG-670** — remove the frozen Markdown ticket corpus. Still cheap, still causes friction.

**Do NOT pick up FG-699, FG-701, FG-702, FG-704, FG-705** — all five remain in PLAN.md's post-v0.1.0
polish section. FG-704 is non-preempting by operator decision.

**What shipped, and why it mattered:**

- **FG-626** — `forge launch run` forwards per-invocation `FORGE_` env into the launched workload.
  Before this, the MANDATED dispatch path silently disarmed every env gate forge has
  (`FORGE_WORKTREES`, `FORGE_CI_*`, `FORGE_CONTROLLER_ID`, ...) with no error and no warning. A tmux
  session inherits only what the tmux SERVER had at startup.
- **FG-707** — inverted the launch-record redaction rule from a fail-OPEN denylist of
  credential-shaped name segments to a fail-CLOSED allowlist of ten enumerated non-secret gates.
  Membership is exact: prefix, suffix and casing near-misses are redacted.
- **FG-706** — the FG-555 control-toolchain PATH pin now actually reaches the workload. It never did:
  tmux overrides `-e PATH` with the server's own value on BOTH `new-session -e` and `respawn-pane
  -e`, so the pin sat in the session env doing nothing while the workload ran under the ambient
  login-shell PATH. The pin now lives in forge's own recorder.

**External state to remember:**

- **The dashboard is running** — pid 40628, up since Aug 10, and now predates FG-663, FG-703,
  FG-626, FG-707 and FG-706. `tsx` does not hot-reload, so it serves stale server code. The operator
  starts/stops it; do not restart unasked.
- `~/code/forge-fg626`, `~/code/forge-fg707` and `~/code/forge-fg706` were all deleted after merge.
  Each run's `project_identity` was verified as `pk-03539752d53cb9e5b609` BEFORE deletion, so none
  were orphaned — FG-663 working as designed. `~/code/forge-fg576` and `~/code/fg584-dogfood` remain
  deliberately retained for prior evidence.
- A `src/v2/docker-exec.test.ts` ENOTEMPTY cleanup failure was seen ONCE locally during FG-706 and
  passed 29/29 on rerun, with CI's full unit tier green. Treated as a flake, not filed. If it
  recurs, it is real.

**Mechanics learned this session (each cost real time):**

- **`forge invoke` on the forge checkout itself is REFUSED by the FG-612 self-host guard** — it
  provisions no task-scoped workspace, so FG-345's default-on isolation does not cover it. The fix
  is a disposable clone (`git clone` + `git remote add github` + copy `node_modules`), NOT
  `FORGE_NO_WORKTREES=1`. Budget this into every forge-on-forge dispatch.
- **Set the clone's branch upstream to the GITHUB remote** (`git branch --set-upstream-to=github/<branch>`).
  A clone whose `origin` is the local checkout resolves reviewed-tip trust against `origin/HEAD` and
  reports `local_only` at the shipping gate even after pushing to github.
- **The review coordinator refuses to auto-confirm the contract against a diff nobody evaluated.**
  Pass `--evaluated-no-drift "<statement>"` on `review start` when you have just read the diff — it
  saves a full round trip.
- **A review gets exactly ONE remediation cycle.** A second `fix_now` on the same finding is refused
  with "this review will not dispatch another fixer". Make the first disposition rationale complete:
  state what to fix, what NOT to fix, and why.
- **Acceptance evidence must be a structured OBJECT**, not prose: `{kind: "regression_test",
  test_name, runner_output}` or `{kind: "replayed_reproduction", command, output}`.
  `assessAcceptanceClaims` accepts every evidence kind, which is the escape hatch when a test name
  cannot be cited (FG-708).
- **Avoid semicolons in test names.** See FG-708 — a semicolon makes a test name uncitable.
- **`npx forge-test` is container-only.** On the host use `node --import tsx --import
  ./src/test-setup.ts --test <files>`.

**Decisions worth not relitigating:**

- **Redaction is a property of the NAME, never a scan of the value.** A value scan is exactly the
  heuristic FG-707 deleted. When a reviewer says "an allowlisted name's value is recorded without
  validating it", that is the design, not a defect — the correct response is to remove a name that
  does not belong, which is what happened to `FORGE_CONTROLLER_ID`.
- **`FORGE_CONTROLLER_ID` is deliberately NOT on the allowlist.** It is the lease-fencing controller
  identity (`src/cli/commands/continue.ts:178`), so it is capability-adjacent rather than
  configuration. All three lenses flagged it; the backend lens returned inconclusive naming exactly
  that variable and was right. There is a "do not add it back" comment at the removal site.
- **`FORGE_AUTH_MODE` is also deliberately absent** despite holding a non-credential mode selector.
  Under fail-closed, membership is earned by the value being genuine audit signal.
- **The FG-706 pin lives in the recorder and must precede every PATH-dependent step.** Applying it
  after the R3 walk would make the provenance record describe a different executable than the one
  that ran — worse than no pin, because it looks authoritative.
- **The inert `new-session -e PATH=` pin was removed, not kept.** An armed-but-does-nothing mechanism
  is the trap these tickets exist to eliminate. Do not reintroduce it; tmux cannot carry PATH.
