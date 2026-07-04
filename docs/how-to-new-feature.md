# How-to: start a feature workflow

Three feature workflows: `feature` (no UI design needed), `feature-ui-design-provided` (design already done — pass with `--prd`), and `feature-ui-design-needed` (design needed first).

This doc walks the design-needed flow with a concrete example. All three workflows share an architect → plan → build → verify → docs core; `feature-ui-design-needed` prepends a `brief` (prompt-author) and `ui-review` (manual) phase before that.

## Example

You have a feature brief but no design yet. Designs will land at `~/code/atlas/designs/`.

```bash
forge new feature-ui-design-needed "clock-skew-fix" \
  --brief "fix clock skew between services" \
  --design-dir ~/code/atlas/designs
forge next run-clock-skew-fix-<suffix> --project ~/code/atlas
```

`--project` is the directory mounted into agent containers. Blue agents get it `rw`; reds get it `ro`.

## What to expect at each phase

### `architect`

Output: `{decisions, components, interfaces, openQuestions}` written to `~/.forge/runs/<run-id>/<task-id>/result.json`.

Reds: wide + narrow, specialist authority (informs but doesn't block). The narrow red gets the `atlas-stack-rn` anti-prompt — it tries to demonstrate the design uses anything other than React Native + TypeScript + @atlas/ui + Re.Pack 5.x.

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

Reds: wide + narrow, **authoritative authority + `gateOnVerdict: true`**. If either red returns `fail`, the task is set to `blocked_by_red` and the run halts. To override:

```bash
forge gate task-build-<suffix> advance --force --rationale "specific reason for overriding the red"
```

Gate: `verdict`. The phase advances automatically if reds pass.

### `verify`

Output: `{test_files_written, tests_written, tests_run, tests_passed, tests_failed, coverage_summary}`. No reds. Gate: `human`.

### `docs`

Output: `{docs_updated, docs_not_updated_reason, stale_docs_found, operator_behavior_changed}`. No reds. Gate: `auto` — the orchestrator reviews the contract and advances without a human stop.

## When something goes wrong

- **Container crash** (Docker issue, expired creds, or an OOM/kill that couldn't be positively confirmed as such): task is marked `failed` with `error: "container_crash"`. A death `docker inspect` positively confirms as an OOM kill or exit 137 is classified more specifically as `failure_kind: "oom_killed"` instead (see [Orphaned task recovery](concepts.md#orphaned-task-recovery)). Inspect `~/.forge/runs/<run-id>/<task-id>/container.stderr.log`. Re-run `forge next` after fixing the underlying issue — forge does not auto-restart crashed tasks in v0.
- **Agent failure**: the agent reported it couldn't complete the task. Look at the result JSON for the error string. Either `forge gate <task-id> reject --rationale "..."` to abandon, or manually create a child task with revised inputs.
- **Red blocks the build**: review the verdict's findings (`forge show task-build-<suffix>`). Either fix the underlying issue and `forge gate ... request-changes --rationale "..."` to re-queue, or override with `--force`.

## Where output lands

The architect doc, plan, diffs, and test results all live under `~/.forge/runs/run-clock-skew-fix-<suffix>/<task-id>/result.json`. The actual code edits land in `~/code/atlas/` (the `--project` you passed).
