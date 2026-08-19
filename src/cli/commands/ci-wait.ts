import type { Command } from "commander";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { ensureForgeDirs } from "../../util/paths.js";
import { derivePreferredRemoteIdentity } from "../../util/github-url.js";
import {
  armCiWait,
  runCiWaitLoop,
  defaultCiWaitProbe,
  type ArmCiWaitInput,
  type CiWaitOutcome,
} from "../../v2/ci-wait.js";
import { advanceCiWait, getCiWait, type CiWait, type CiWaitKind, type CiWaitRemote } from "../../store/ci-waits.js";

// FG-731 (Step 2a): `forge ci-wait` — the SINGLE Forge-owned surface that registers a
// durable CI-wait record (register-before-poll) and block-waits on it, polling `gh` in
// the writer path and emitting exactly ONE terminal outcome. Bare `gh run watch` /
// ad-hoc `gh` polling is out of contract: this is what the orchestrator uses instead.

const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const LEASE_MS = 60000;

const KINDS: readonly CiWaitKind[] = ["pr_checks", "push_actions", "workflow_dispatch"];

type IdentityOpts = {
  kind?: string;
  repo?: string;
  pr?: string;
  sha?: string;
  runId?: string;
  workflow?: string;
  ref?: string;
  inputs?: string;
  url?: string;
  project?: string;
  run?: string;
  task?: string;
  ticket?: string;
};

function fail(msg: string, json: boolean): number {
  if (json) process.stdout.write(`${JSON.stringify({ kind: "invalid_request", error: msg })}\n`);
  else process.stderr.write(`forge ci-wait: ${msg}\n`);
  return 2;
}

/** RF-2: a non-numeric or negative --timeout/--interval must be REJECTED at parse
 *  time, never coerced through. A NaN deadline never satisfies now()>=deadline and
 *  Node coerces a NaN/negative delay to a ~1ms timer, so a bad flag would turn the
 *  poll loop into an effectively unbounded, near-tight `gh` hammer against the GitHub
 *  API. `allowZero` is true only for --timeout, where 0 is the documented
 *  "no timeout" sentinel; --interval must be strictly positive. */
function parseWaitSeconds(
  raw: string | undefined,
  { allowZero }: { allowZero: boolean },
): { value: number; error?: string } {
  if (raw == null) return { value: 0 };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: 0, error: `must be a number (got '${raw}')` };
  if (n < 0 || (n === 0 && !allowZero)) {
    return { value: 0, error: `must be a ${allowZero ? "non-negative" : "positive"} number (got '${raw}')` };
  }
  return { value: n };
}

/** Assemble the arm input from flags. Repo defaults to the cwd project's preferred
 *  remote identity (owner/repo) so a plain `forge ci-wait wait --kind pr_checks --pr N`
 *  works from inside a checkout. */
function buildArmInput(opts: IdentityOpts): { input: ArmCiWaitInput; error?: string } {
  const dir = resolve(opts.project ?? process.cwd());
  const kind = opts.kind as CiWaitKind | undefined;
  if (kind === undefined || !KINDS.includes(kind)) {
    return { input: null as never, error: `--kind is required and must be one of ${KINDS.join(", ")}` };
  }
  const repo = opts.repo ?? derivePreferredRemoteIdentity(dir)?.path ?? null;
  const remote: CiWaitRemote = {
    repo,
    prNumber: opts.pr != null ? Number(opts.pr) : null,
    headSha: opts.sha ?? null,
    actionsRunId: opts.runId ?? null,
    workflowFile: opts.workflow ?? null,
    dispatchRef: opts.ref ?? null,
    dispatchInputs: opts.inputs ?? null,
  };
  if (kind === "pr_checks" && (remote.prNumber == null || Number.isNaN(remote.prNumber))) {
    return { input: null as never, error: "pr_checks requires --pr <number>" };
  }
  if (kind === "workflow_dispatch" && remote.workflowFile == null) {
    return { input: null as never, error: "workflow_dispatch requires --workflow <file>" };
  }
  if (kind === "push_actions" && remote.headSha == null && remote.actionsRunId == null) {
    return { input: null as never, error: "push_actions requires --sha <headSha> or --run-id <actionsRunId>" };
  }
  const association = {
    ...(opts.run ? { runId: opts.run } : {}),
    ...(opts.task ? { taskId: opts.task } : {}),
    ...(opts.ticket ? { ticketId: opts.ticket } : {}),
    projectDir: dir,
  };
  return {
    input: { kind, remote, url: opts.url ?? null, owner: `${hostname()}:${process.pid}`, leaseMs: LEASE_MS, association },
  };
}

function outcomeJson(o: CiWaitOutcome): unknown {
  switch (o.kind) {
    case "completed_awaiting_advance":
      return {
        kind: "completed_awaiting_advance",
        id: o.id,
        ciWaitKind: o.wait.kind,
        actionsRunId: o.wait.actionsRunId,
        url: o.wait.url,
        observedState: o.wait.observedState,
        m: o.wait.observedM,
        n: o.wait.observedN,
      };
    case "abandoned":
      return { kind: "abandoned", id: o.id, ciWaitKind: o.wait.kind, url: o.wait.url, observedState: o.wait.observedState };
    case "timeout":
      return { kind: "timeout", id: o.id, lastObserved: o.lastObserved };
    case "cancelled":
      return { kind: "cancelled", id: o.id, lastObserved: o.lastObserved };
  }
}

function renderOutcome(o: CiWaitOutcome, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(outcomeJson(o))}\n`);
    return;
  }
  switch (o.kind) {
    case "completed_awaiting_advance":
      process.stdout.write(`forge ci-wait: ${o.id} — CI reached a terminal state; a forge advance/continue is owed. ${o.wait.url ?? ""}\n`);
      return;
    case "abandoned":
      process.stdout.write(`forge ci-wait: ${o.id} — the remote CI run is gone (merged/closed/deleted); resolved as abandoned.\n`);
      return;
    case "timeout":
      process.stdout.write(`forge ci-wait: ${o.id} — WAITER timed out (last observed: ${o.lastObserved ?? "none"}). The record stays live; recovery will re-observe it. This is a WAITER timeout, not a CI result.\n`);
      return;
    case "cancelled":
      process.stdout.write(`forge ci-wait: ${o.id} — WAITER cancelled (last observed: ${o.lastObserved ?? "none"}). The CI run and its record were NOT touched; recovery re-observes it.\n`);
      return;
  }
}

/** completed/abandoned are successful terminal OBSERVATIONS (exit 0). timeout/cancel
 *  are the waiter's own outcomes, given distinct codes so automation can tell them
 *  apart — the same split as `forge launch wait`. */
function exitCodeFor(o: CiWaitOutcome): number {
  switch (o.kind) {
    case "completed_awaiting_advance": return 0;
    case "abandoned": return 0;
    case "timeout": return 124;
    case "cancelled": return 130;
  }
}

export function registerCiWaitCommand(program: Command): void {
  const ciWait = program
    .command("ci-wait")
    .description("Register and block-wait on a Forge-owned CI run (FG-731). The supported alternative to bare `gh run watch`.");

  const identityOptions = (c: Command): Command =>
    c
      .option(`--kind <${KINDS.join("|")}>`, "which kind of CI wait")
      .option("--repo <owner/repo>", "target repo (default: the cwd project's origin remote)")
      .option("--pr <number>", "pr_checks: the PR whose head check-suite to wait on")
      .option("--sha <headSha>", "push_actions: the pushed head sha")
      .option("--run-id <actionsRunId>", "an already-known Actions run id")
      .option("--workflow <file>", "workflow_dispatch: the workflow file")
      .option("--ref <ref>", "workflow_dispatch: the dispatched ref")
      .option("--inputs <json>", "workflow_dispatch: inputs (verbatim string or JSON)")
      .option("--url <url>", "the run/PR url, if known at trigger time")
      .option("--project <path>", "project dir (default: cwd)")
      .option("--run <run-id>", "associate with a forge run")
      .option("--task <task-id>", "associate with a forge task")
      .option("--ticket <ticket-id>", "associate with a ticket");

  identityOptions(ciWait.command("register"))
    .description("Register the durable CI-wait record WITHOUT blocking (register-before-poll on its own). Prints the wait id.")
    .option("--json", "machine-readable output")
    .action((opts: IdentityOpts & { json?: boolean }) => {
      ensureForgeDirs();
      const { input, error } = buildArmInput(opts);
      if (error) return process.exit(fail(error, !!opts.json));
      const armed = armCiWait(input);
      if (opts.json) process.stdout.write(`${JSON.stringify({ id: armed.id, adopted: armed.adopted, kind: armed.wait.kind })}\n`);
      else process.stdout.write(`forge ci-wait: ${armed.adopted ? "adopted" : "registered"} ${armed.id}\n`);
    });

  identityOptions(ciWait.command("wait"))
    .description("Register-then-block-wait (or adopt a live twin), polling gh until the run reaches a terminal state. Emits exactly one outcome.")
    .option("--json", "machine-readable output")
    .option("--timeout <seconds>", "waiter timeout (0 = no timeout)")
    .option("--interval <seconds>", "poll interval")
    .action(async (opts: IdentityOpts & { json?: boolean; timeout?: string; interval?: string }) => {
      ensureForgeDirs();
      const { input, error } = buildArmInput(opts);
      if (error) return process.exit(fail(error, !!opts.json));
      const timeout = parseWaitSeconds(opts.timeout, { allowZero: true });
      if (timeout.error) return process.exit(fail(`--timeout ${timeout.error}`, !!opts.json));
      const interval = parseWaitSeconds(opts.interval, { allowZero: false });
      if (interval.error) return process.exit(fail(`--interval ${interval.error}`, !!opts.json));
      const timeoutMs = opts.timeout == null ? DEFAULT_TIMEOUT_MS : timeout.value === 0 ? Infinity : timeout.value * 1000;
      const intervalMs = opts.interval == null ? DEFAULT_INTERVAL_MS : interval.value * 1000;

      const controller = new AbortController();
      const onSigint = () => controller.abort();
      process.on("SIGINT", onSigint);
      try {
        // Register/adopt SYNCHRONOUSLY before the first probe — the record exists the
        // instant the wait is armed (a waiter that dies pre-probe still left a row).
        const armed = armCiWait(input);
        const outcome = await runCiWaitLoop(armed, {
          probe: defaultCiWaitProbe,
          owner: input.owner,
          leaseMs: input.leaseMs,
          intervalMs,
          timeoutMs,
          signal: controller.signal,
        });
        renderOutcome(outcome, !!opts.json);
        process.exit(exitCodeFor(outcome));
      } finally {
        process.off("SIGINT", onSigint);
      }
    });

  ciWait
    .command("cancel")
    .description("Cancel a registered wait — the record leaves the live surface as `cancelled` (an operator abandon of the wait, NOT the CI run).")
    .argument("<id>", "the ci-wait id")
    .option("--json", "machine-readable output")
    .action((id: string, opts: { json?: boolean }) => {
      ensureForgeDirs();
      const before: CiWait | undefined = getCiWait(id);
      if (before === undefined) return process.exit(fail(`no such ci-wait '${id}'`, !!opts.json));
      const ok = advanceCiWait(id, "cancelled");
      if (opts.json) process.stdout.write(`${JSON.stringify({ id, cancelled: ok, alreadyTerminal: !ok && before.terminal })}\n`);
      else process.stdout.write(`forge ci-wait: ${ok ? `cancelled ${id}` : `${id} was already terminal (${before.lifecycleState}) — left as-is`}\n`);
    });
}
