// The synthetic workflow shape `forge invoke` (and `forge retry` of an ad-hoc row)
// composes against. Its own module so a reader that composes a role's prompt without
// dispatching — the dashboard's Roles surface (FG-817) — does not load invoke.ts's
// dispatch graph (store writers, docker exec) to get it.

import type { Workflow, Step } from "./schema.js";

// The synthetic single-step workflow + step invoke dispatches against. The runner
// machinery (compose, spawn) takes Workflow + Step types; for invoke we create
// minimal ones in-memory rather than loading from YAML. The runner's heavy step
// lifecycle (depends_on, gates, reds) isn't exercised here.
export function invokeWorkflowShape(
  agentRole: string,
  modelAlias: string | undefined,
  runtimeName: string | undefined,
): { step: Step; workflow: Workflow } {
  const step: Step = {
    id: "task",                           // synthetic phase id; matches v1 single-task runs
    agent: agentRole,
    activity: modelAlias,                 // capability alias (CLI --model); legacy field name was `model`
    runtime: runtimeName ?? "claude",
    depends_on: [],
    gate: "auto",
    manual: false,
    reds: [],
    // FG-497: do NOT embed the task text here — workflow_additions folds into the
    // composed system prompt, which every claude/pi runtime passes as a single
    // argv string (--append-system-prompt), capped by Linux's 128KB
    // MAX_ARG_STRLEN. A large task (e.g. a >120KB review-loop packet) blew past
    // that limit and crashed the container exec with E2BIG before the agent even
    // started. The task reaches the agent instead via TASK_PACKAGE_MARKDOWN,
    // piped over stdin (unbounded) — see renderInvokeTaskPackage below.
    workflow_additions:
      `You are receiving a single freeform task. The task description arrives as ` +
      `your input message (the task package). Read it carefully and produce a result.\n`,
  };
  return {
    step,
    workflow: {
      name: "invoke",
      description: "Single-agent invocation (forge invoke)",
      // FG-640: an ad-hoc invoke has no review ledger and no reviewed step, so it carries the
      // legacy authority model. Naming it beats inheriting it silently.
      review_mode: "legacy_verdict",
      inputs: [],
      steps: [step],
    },
  };
}
