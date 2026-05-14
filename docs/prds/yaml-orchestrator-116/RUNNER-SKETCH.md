# forge v2 — runner sketch (pseudo-code)

The v2 runner replaces `src/spine/{dispatch,spawn,spawnRed,next,composeSystemPrompt}.ts`.
It reads YAML, walks steps in topological order, spawns containers via the
resolved runtime YAML, writes to SQLite, and calls `gate.ts` / `reconcile.ts`
unchanged.

Target size: ~400-600 lines of TypeScript. This sketch is in TS-flavored
pseudo-code to make the shape concrete. Real types come from `src/v2/schema.ts`
(Zod-derived).

## File layout

```
src/v2/
├── schema.ts          # Zod schemas for Workflow + Runtime YAML. Validation entry point.
├── loader.ts          # Read YAML from ~/.forge/ and project .forge/, apply overrides.
├── runner.ts          # The topological walk; main loop.
├── spawn.ts           # Translate Runtime YAML → docker args; exec container; capture result.
├── resolve.ts         # Template substitution: ${TASK_DIR}, ${MODEL}, ${SYSTEM_PROMPT}, etc.
├── inputs.ts          # forge new wiring: collect Workflow.inputs from CLI/dashboard.
└── types.ts           # Hand-written types that don't infer from Zod cleanly.
```

These are *new* files. The runner *calls* the kept files:
- `src/spine/gate.ts` — unchanged. Verdict aggregation, force-advance, on-reject.
- `src/spine/reconcile.ts` — unchanged. Orphan recovery, transactional writes.
- `src/spine/constraints.ts` — unchanged. Constraint filtering by role/workflow/phase.
- `src/store/*` — unchanged. SQLite accessors.
- `src/dashboard/*` — unchanged. Reads SQLite.

Deleted at cutover:
- `src/spine/{dispatch,spawn,spawnRed,next,composeSystemPrompt}.ts`
- `src/workflows/*.ts` (replaced by `~/.forge/workflows/*.yml`)
- `src/util/creds.ts` — partly. `exportAwsCreds`, `resolveAwsProfile`, etc.
  stay (referenced by runtime YAML template substitution); the
  mode-detection logic (`detectCredsMode`) moves into runtime YAML
  `detect:` clauses.

## Main loop

```ts
// runner.ts
async function runNext(runId: string): Promise<void> {
  const run = store.getRun(runId);
  const workflow = await loadWorkflow(run.workflowName, run.projectDir);
  const tasks = store.getTasksForRun(runId);

  const readyStepIds = computeReadyQueue(workflow.steps, tasks);

  if (readyStepIds.length === 0) {
    // Either everything's done OR everything's gated. Distinguish:
    const pendingGates = tasks.filter(t => t.status === "awaiting_gate");
    if (pendingGates.length > 0) {
      // Human action required. Caller sees: "forge next: tasks awaiting gate".
      return;
    }
    // Nothing pending; run is done.
    store.markRunComplete(runId);
    return;
  }

  // Spawn all ready steps in parallel. This is the "parallel within wave"
  // behavior — siblings with no remaining deps fire concurrently.
  await Promise.all(readyStepIds.map(stepId =>
    dispatchStep(run, workflow, stepId)
  ));
  // dispatchStep writes to SQLite when it completes; reconcile.ts handles
  // partial-failure recovery. Caller re-invokes runNext to advance further.
}

function computeReadyQueue(steps: Step[], tasks: Task[]): string[] {
  return steps
    .filter(step => {
      const task = tasks.find(t => t.stepId === step.id);
      if (task) return false;  // already created (running/gated/done/failed)
      const deps = step.depends_on ?? [];
      return deps.every(depId => {
        const depTask = tasks.find(t => t.stepId === depId);
        // Step's dep must exist AND be advanced past its gate.
        return depTask && (depTask.status === "complete" || depTask.gateAdvanced);
      });
    })
    .map(s => s.id);
}
```

## Step dispatch

```ts
async function dispatchStep(run, workflow, stepId): Promise<void> {
  const step = workflow.steps.find(s => s.id === stepId);

  if (step.manual) {
    return dispatchManualStep(run, step);
  }

  if (step.fanout) {
    return dispatchFanoutStep(run, workflow, step);
  }

  return dispatchAgentStep(run, workflow, step);
}

async function dispatchAgentStep(run, workflow, step) {
  const task = store.createTask({
    runId: run.id,
    stepId: step.id,
    role: step.agent,
    phase: step.id,  // 1:1 step:phase mapping in v2 (no separate phase concept)
    status: "running",
  });

  const runtime = await loadRuntime(step.runtime ?? "claude");
  const taskPackage = renderTaskPackage(run, step, /* upstream results */);
  const systemPrompt = composeSystemPrompt(step, run.workflowName);

  const exitCode = await spawnContainer(runtime, {
    taskDir: taskDir(run.id, task.id),
    taskId: task.id,
    projectDir: run.projectDir,
    projectMode: "rw",  // agent steps get rw; reds get ro (overridden later)
    designDir: run.designDir,
    model: resolveModelAlias(step.model, runtime),
    systemPrompt,
    taskPackageMarkdown: taskPackage,
  });

  const result = readResultJson(taskDir(run.id, task.id));

  if (exitCode !== 0 || !result || result.status === "failed") {
    store.markTaskFailed(task.id, ...);
    return;
  }

  // Spawn reds (if any) after the primary agent completes.
  if (step.reds?.length) {
    await spawnReds(run, step, task, runtime, result);
  }

  // Gate decision goes through gate.ts unchanged.
  gate.evaluate(task.id);  // → status: complete | awaiting_gate | blocked_by_red
}

async function spawnReds(run, step, parentTask, runtime, parentResult) {
  await Promise.all(step.reds.map(redDef => {
    const redTask = store.createTask({
      runId: run.id,
      stepId: step.id,
      parentTaskId: parentTask.id,
      role: redDef.agent,
      phase: step.id,
      status: "running",
    });

    return spawnContainer(runtime, {
      taskDir: taskDir(run.id, redTask.id),
      taskId: redTask.id,
      projectDir: run.projectDir,
      projectMode: "ro",   // reds are always read-only
      model: resolveModelAlias(redDef.model, runtime),
      systemPrompt: composeRedSystemPrompt(redDef, step, parentResult),
      taskPackageMarkdown: renderRedTaskPackage(parentResult, redDef),
    }).then(exitCode => {
      const verdict = readResultJson(taskDir(run.id, redTask.id));
      store.writeVerdict({
        taskId: parentTask.id,
        redTaskId: redTask.id,
        redRole: redDef.agent,
        verdict: verdict?.verdict ?? "inconclusive",
        confidence: verdict?.confidence ?? 0.5,
        authority: redDef.authority,
        findings: JSON.stringify(verdict?.findings ?? []),
      });
    });
  }));
}
```

## Fanout dispatch

```ts
async function dispatchFanoutStep(run, workflow, step) {
  const upstreamStepId = step.fanout.from_upstream.step;
  const arrayKey = step.fanout.from_upstream.array_key;
  const inputKey = step.fanout.from_upstream.input_key;

  const upstreamTask = store.getTaskByStepId(run.id, upstreamStepId);
  const upstreamResult = readResultJson(taskDir(run.id, upstreamTask.id));
  const items: unknown[] = upstreamResult?.[arrayKey] ?? [];

  if (items.length === 0) {
    // Empty array → fanout is a no-op. Mark the step complete with no children.
    store.markStepCompleteEmpty(run.id, step.id);
    return;
  }

  const maxConc = step.fanout.max_concurrency ?? items.length;
  const failureMode = step.fanout.failure_mode ?? "fail-phase";

  // Spawn with concurrency cap. p-limit or hand-rolled semaphore.
  const sem = semaphore(maxConc);
  const results = await Promise.all(items.map((item, i) =>
    sem.acquire().then(async () => {
      try {
        return await dispatchAgentStep(run, workflow, {
          ...step,
          id: `${step.id}-${i}`,    // synthetic per-item step id
          fanout: undefined,        // strip fanout to avoid recursion
          inputs_override: { [inputKey]: item },
        });
      } finally {
        sem.release();
      }
    })
  ));

  // Apply failure_mode policy.
  applyFanoutFailureMode(results, failureMode);
}
```

## Manual dispatch

```ts
async function dispatchManualStep(run, step) {
  // Create the task row but DON'T spawn. Wait for `forge submit <task-id>`.
  store.createTask({
    runId: run.id,
    stepId: step.id,
    role: "manual",
    phase: step.id,
    status: "pending",   // not "running" — no container, just waiting
  });
  // forge submit transitions to awaiting_gate after validation.
}
```

## Container spawn

Today's `spawn.ts:buildDockerArgs` becomes `src/v2/spawn.ts`. The difference:
instead of hardcoded env / mount / claude-args logic, it reads from the
runtime YAML and substitutes template variables.

```ts
function buildDockerArgs(runtime, ctx): string[] {
  const args = ["run", "--rm", "-i"];

  // Container name
  const name = substitute(runtime.container.name, ctx);
  args.push("--name", name);

  // Auth
  if (runtime.auth.mode === "env-snapshot" && process.env.FORGE_AUTH_MODE !== "mount") {
    const creds = exportAwsCreds(resolveAwsProfile());
    args.push("-e", `AWS_ACCESS_KEY_ID=${creds.AWS_ACCESS_KEY_ID}`);
    args.push("-e", `AWS_SECRET_ACCESS_KEY=${creds.AWS_SECRET_ACCESS_KEY}`);
    args.push("-e", `AWS_SESSION_TOKEN=${creds.AWS_SESSION_TOKEN}`);
  } else if (runtime.auth.mode === "mount" || process.env.FORGE_AUTH_MODE === "mount") {
    args.push("-e", `AWS_PROFILE=${resolveAwsProfile()}`);
    args.push("-v", `${awsConfigDir()}:/home/agent/.aws:ro`);
  }
  // (apikey, oauth: other runtime YAML files; same shape.)

  // Static env
  for (const [k, v] of Object.entries(runtime.env ?? {})) {
    args.push("-e", `${k}=${substitute(v, ctx)}`);
  }

  // Mounts
  for (const mount of runtime.mounts) {
    const host = substitute(mount.host, ctx);
    if (mount.optional && !existsSync(host)) continue;
    args.push("-v", `${host}:${mount.container}:${substitute(mount.mode, ctx)}`);
  }

  // Image
  args.push(runtime.image);

  // Invocation
  args.push(substitute(runtime.invocation.command, ctx));
  for (const arg of runtime.invocation.args) {
    args.push(substitute(arg, ctx));
  }

  return args;
}
```

## What stays the same from today

- **Idle watchdog** in spawn.ts — kill containers with no stdout for N
  seconds. Moves to `src/v2/spawn.ts` verbatim.
- **`--include-partial-messages` + `--output-format stream-json`** — moved into
  runtime YAML's `invocation.args`. Same flags, declaration moves from code to
  YAML.
- **`forge-test` wrapper** for the verify container — already in the image,
  doesn't change.
- **agent-entrypoint.sh** starts Chromium before `exec "$@"` — runtime YAML
  doesn't need to know; the image's ENTRYPOINT handles it.
- **Result parsing** — `_readResultJson` envelope unwrapping (the
  `{type:"result", result:"..."}` shape from `--output-format=json|stream-json`)
  moves to `src/v2/spawn.ts`.

## Estimated LOC

| file | rough size |
|---|---|
| `schema.ts` | 200 (Zod schemas + types) |
| `loader.ts` | 80 (read + merge override) |
| `runner.ts` | 150 (main loop + step dispatch) |
| `spawn.ts` | 200 (docker args build + container exec + result read) |
| `resolve.ts` | 60 (template substitution) |
| `inputs.ts` | 80 (forge new wiring) |
| `types.ts` | 30 |
| **total** | **~800** |

Higher than the PRD's 400-600 estimate but within reason. The PRD didn't
count the fanout primitive — that's another 100-150 LOC.

## Test surface

| test file | what it covers |
|---|---|
| `schema.test.ts` | Zod schemas accept all 7 workflow drafts; reject malformed YAML with useful errors. |
| `loader.test.ts` | Workspace + project override resolution. |
| `runner.test.ts` | Topological walk, parallel-within-wave, ready-queue computation. |
| `spawn.test.ts` | Docker args from runtime YAML — env-snapshot vs mount, optional mounts, template substitution. |
| `fanout.test.ts` | From-upstream array binding, concurrency cap, failure_mode policies. |
| `manual.test.ts` | Manual step lifecycle: pending → submitted → awaiting_gate. |
| `forge-new.test.ts` | inputs: block drives flag/form generation. |

Existing gate.ts + reconcile.ts + store/* tests pass unchanged — they test
concerns that survive.
