# How-to: start a feature workflow

Two feature workflows: `feature-design-provided` (PRD exists, design exists, skip architect) and `feature-design-needed` (PRD exists, no design — add architect first).

This doc walks the design-needed flow with a concrete example. The design-provided flow is identical except the architect phase is absent.

## Example

You have a PRD at `~/code/atlas/prd/clock-skew-fix.md`. You don't have a design yet.

```bash
./bin/forge new feature-design-needed "clock-skew-fix" \
  --prd ~/code/atlas/prd/clock-skew-fix.md
./bin/forge next run-clock-skew-fix-<suffix> --project ~/code/atlas
```

`--project` is the directory mounted into agent containers. Blue agents get it `rw`; reds get it `ro`.

## What to expect at each phase

### `architect`

Output: `{decisions, components, interfaces, openQuestions}` written to `~/.forge/runs/<run-id>/<task-id>/result.json`.

Reds: wide + narrow, specialist authority (informs but doesn't block). The narrow red gets the `atlas-stack-rn` anti-prompt — it tries to demonstrate the design uses anything other than React Native + TypeScript + @atlas/ui + Re.Pack 5.x.

Gate: `human`.

```bash
./bin/forge show task-architect-<suffix>
./bin/forge gate task-architect-<suffix> advance
./bin/forge next run-clock-skew-fix-<suffix> --project ~/code/atlas
```

### `plan`

Output: `{steps: [{id, summary, files, acceptance}]}`. No reds. Gate: `human`.

### `build`

Output: `{steps_completed, diff_summary, files_modified}`. The implementer edits files inside the container; the host project directory is mounted `rw`.

Reds: wide + narrow, **authoritative authority + `gateOnVerdict: true`**. If either red returns `fail`, the task is set to `blocked_by_red` and the run halts. To override:

```bash
./bin/forge gate task-build-<suffix> advance --force --rationale "specific reason for overriding the red"
```

Gate: `verdict`. The phase advances automatically if reds pass.

### `verify`

Output: `{tests_run, tests_passed, tests_failed, evidence}`. No reds. Gate: `human`.

## When something goes wrong

- **Container crash** (Docker issue, OOM, expired creds): task is marked `failed` with `error: "container_crash"`. Inspect `~/.forge/runs/<run-id>/<task-id>/container.stderr.log`. Re-run `forge next` after fixing the underlying issue — forge does not auto-restart crashed tasks in v0.
- **Agent failure**: the agent reported it couldn't complete the task. Look at the result JSON for the error string. Either `forge gate <task-id> reject --rationale "..."` to abandon, or manually create a child task with revised inputs.
- **Red blocks the build**: review the verdict's findings (`forge show task-build-<suffix>`). Either fix the underlying issue and `forge gate ... request-changes --rationale "..."` to re-queue, or override with `--force`.

## Where output lands

The architect doc, plan, diffs, and test results all live under `~/.forge/runs/run-clock-skew-fix-<suffix>/<task-id>/result.json`. The actual code edits land in `~/code/atlas/` (the `--project` you passed).
