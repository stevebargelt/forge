# How-to: start a feature workflow

Three feature workflows: `feature` (no UI design needed), `feature-ui-design-provided` (design already done — pass with `--prd`), and `feature-ui-design-needed` (design needed first).

This doc walks the design-needed flow with a concrete example. All three workflows share an architect → plan → build → verify → docs core; `feature-ui-design-needed` prepends a `brief` (prompt-author) and `ui-review` (manual) phase before that.

## Workflows with a shipping-reviewer red require a backlog ticket

The rule is per-workflow, not per-family: `forge new` requires `--ticket <id>` iff the workflow has a `shipping-reviewer` red on any step. Today that's only the plain **`feature`** workflow, whose `build` phase's `shipping-reviewer` red is authoritative — it reviews the diff against the ticket's acceptance criteria and non-goals, and blocks the gate if it can't resolve one. `feature-ui-design-needed` and `feature-ui-design-provided` do not carry a `shipping-reviewer` red today, so they do not require `--ticket` (if another workflow adds one later, the same requirement kicks in for it automatically).

For a workflow that does require it, there are two ways to give it one:

- Drive the work through a **campaign** (`forge campaign ...`), which stamps `run.metadata.ticketId` on every run it creates.
- Pass **`--ticket <id>`** directly to `forge new` for a standalone run, e.g. `--ticket FG-123`. The id must reference a real ticket under `backlog/` (ideas/epics/stories/done).

If neither is given, `forge new` fails immediately — before the run is created — with `workflow '<name>' requires --ticket <id> because shipping-reviewer needs backlog acceptance criteria`. (Legacy `--meta '{"ticketId":"FG-123"}'` still works; `--ticket` is the documented path, and the two must agree if both are passed.)

## Example

You have a feature brief, a backlog ticket, but no design yet. Designs will land at `~/code/atlas/designs/`. `--ticket` isn't required for `feature-ui-design-needed` (it has no `shipping-reviewer` red), but passing it links the run to the ticket for traceability.

```bash
forge new feature-ui-design-needed "clock-skew-fix" \
  --brief "fix clock skew between services" \
  --ticket FG-123 \
  --design-dir ~/code/atlas/designs
forge next run-clock-skew-fix-<suffix> --project ~/code/atlas
```

`--project` is the directory mounted into agent containers. Blue agents get it `rw`; reds get it `ro`.

## What to expect at each phase

### `architect`

Output: `{decisions, components, interfaces, openQuestions}` written to `~/.forge/runs/<run-id>/<task-id>/result.json`.

Reds: wide + narrow, specialist authority — a verdict either one **authors** informs but doesn't block, `fail` included. The narrow red gets the `atlas-stack-rn` anti-prompt — it tries to demonstrate the design uses anything other than React Native + TypeScript + @atlas/ui + Re.Pack 5.x.

Authority governs the weight of an *opinion*, so it does not cover a red that produced no opinion at all. If either specialist fails to return a review — a crash, an idle timeout, an OOM, an unreadable result, a provider rejection — forge synthesizes the `inconclusive` itself, and a synthesized verdict blocks regardless of authority: the task lands `blocked_by_red` with a high-severity "produced NO review" finding rather than advancing to the human gate. Fix the underlying failure and re-run, or waive the missing review explicitly:

```bash
forge gate task-architect-<suffix> advance --force --rationale "specific reason for advancing without this red's review"
```

See [Blocked by red](concepts.md#blocked-by-red).

Gate: `human`.

```bash
forge show task-architect-<suffix>
forge gate task-architect-<suffix> advance
forge next run-clock-skew-fix-<suffix> --project ~/code/atlas
```

### `plan`

Output: `{steps: [{id, summary, files, acceptance}]}`. No reds. Gate: `human`.

### `build`

Output: `{steps_completed, diff_summary, files_modified}`. The engineer (or discipline specialist) edits files inside the container; the host project directory is mounted `rw`.

Reds include wide/narrow/frontend/backend/security specialists — all **`authority: authoritative` + `gate_on_verdict: true`**. If any returns `fail`, the task is set to `blocked_by_red` and the run halts. The plain `feature` workflow's `build` phase additionally includes a **shipping-reviewer** red (see "Workflows with a shipping-reviewer red require a backlog ticket" above); `feature-ui-design-needed` (used in the example above) and `feature-ui-design-provided` do not carry one. Where present, shipping-reviewer needs the run's ticket — without it, it pre-fails and blocks the gate too. To override:

```bash
forge gate task-build-<suffix> advance --force --rationale "specific reason for overriding the red"
```

Gate: `verdict`. The phase advances automatically if reds pass.

### `verify`

Output: `{test_files_written, tests_written, tests_run, tests_passed, tests_failed, coverage_summary}`. No reds. Gate: `human`.

### `docs`

Output: `{docs_updated, docs_not_updated_reason, stale_docs_found, operator_behavior_changed}`. No reds. Gate: `auto` — the orchestrator reviews the contract and advances without a human stop.

## When something goes wrong

- **Container crash** (Docker issue, expired creds, or an OOM/kill that couldn't be positively confirmed as such): task is marked `failed` with `error: "container_crash"`. A death positively identified as an OOM kill or exit 137 is classified more specifically as `failure_kind: "oom_killed"` instead — either because a later `docker inspect` confirms it (reconcile-time), or because the container's exit code was read directly as 137 with no result while forge was still attached to it (attached-exit, no `docker inspect` needed) — see [Orphaned task recovery](concepts.md#orphaned-task-recovery). Inspect `~/.forge/runs/<run-id>/<task-id>/container.stderr.log`. Re-run `forge next` after fixing the underlying issue — forge does not auto-restart crashed tasks in v0.
- **Agent failure**: the agent reported it couldn't complete the task. Look at the result JSON for the error string. Either `forge gate <task-id> reject --rationale "..."` to abandon, or manually create a child task with revised inputs.
- **Red blocks the build**: review the verdict's findings (`forge show task-build-<suffix>`). Either fix the underlying issue and `forge gate ... request-changes --rationale "..."` to re-queue, or override with `--force`.
- **Task fails instantly with `backlog_authority_*`**: on a project that declares a `project_key`, a `--ticket` run whose backlog authority can't answer for that ticket is refused *before* its container starts, rather than letting the agent build against the brief and then be judged on criteria it never saw (FG-666). Nothing ran, so there is no container log to read — the error names the reason. `backlog_authority_conflict` is a project identity mismatch and needs a config fix before `forge retry` (see [the cutover runbook](how-to-backlog-db-cutover.md#agents-and-containers-after-cutover)); `backlog_authority_unresolvable` and `backlog_ticket_unreadable` are retryable once the store or the ticket is reachable. Markdown-mode projects never hit this.

## Where output lands

The architect doc, plan, diffs, and test results all live under `~/.forge/runs/run-clock-skew-fix-<suffix>/<task-id>/result.json`. The actual code edits land in `~/code/atlas/` (the `--project` you passed).
