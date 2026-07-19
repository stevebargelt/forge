// FG-552: the minimal observer for `forge launch wait`.
//
// F33 — LOAD-BEARING: this module's transitive import graph is `node:fs`,
// `node:path`, and `src/v2/launch.js` (native-free — its own graph lazily
// requires better-sqlite3 inside function bodies only). It NEVER imports the
// command registry or the native binding. `src/cli/index.ts` dispatches
// `launch wait` to `runLaunchWaitCli` BEFORE node-preflight and the eager
// command imports run, so the observer still observes + reports even when
// better-sqlite3 cannot load under this interpreter. Keep it that way: do not
// add an import that reaches the store, and do not import commander here.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  LAUNCHES_DIR,
  realWaitHarness,
  statusLine,
  waitForLaunchTerminal,
  type WaitOutcome,
} from "../../v2/launch.js";

const RECONCILE_MS = 2000;

const USAGE = [
  "usage: forge launch wait <id> [--json] [--timeout <seconds>]",
  "",
  "Block until the launch reaches a terminal disposition, then emit exactly one",
  "structured observation. Returns immediately if the launch is already terminal.",
  "SIGINT cancels the WAITER only — the tmux-owned work is never touched (OQ-4).",
].join("\n");

/** Entry for the F33 fast path in src/cli/index.ts. Parses argv (WITHOUT
 *  commander, to keep the graph native-free), runs the wait, renders, and returns
 *  the process exit code. */
export async function runLaunchWaitCli(args: string[]): Promise<number> {
  let id: string | undefined;
  let json = false;
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--timeout") {
      const raw = args[++i];
      const secs = Number(raw);
      if (raw === undefined || !Number.isFinite(secs) || secs < 0) {
        process.stderr.write("forge launch wait: --timeout expects a non-negative number of seconds (0 = no timeout)\n");
        return 2;
      }
      timeoutMs = secs === 0 ? Infinity : secs * 1000;
    } else if (a === "--") {
      continue;
    } else if (a.startsWith("-")) {
      process.stderr.write(`forge launch wait: unknown option '${a}'\n${USAGE}\n`);
      return 2;
    } else if (id === undefined) {
      id = a;
    } else {
      process.stderr.write("forge launch wait: too many arguments — expected a single launch id\n");
      return 2;
    }
  }
  if (id === undefined) {
    process.stderr.write(`forge launch wait: a launch id is required\n${USAGE}\n`);
    return 2;
  }
  return await waitAndRender(id, { json, timeoutMs, reconcileMs: RECONCILE_MS });
}

/** Shared by the fast path and the commander `wait` subcommand. */
export async function waitAndRender(
  id: string,
  opts: { json?: boolean; timeoutMs?: number; reconcileMs?: number } = {},
): Promise<number> {
  let harness;
  try {
    harness = realWaitHarness(id, { reconcileMs: opts.reconcileMs, timeoutMs: opts.timeoutMs });
  } catch (e) {
    // launchDir rejects a path-shaped / malformed id at the chokepoint — a
    // distinct refusal from a well-formed id that simply does not exist.
    const msg = (e as Error).message;
    if (opts.json) process.stdout.write(`${JSON.stringify({ kind: "invalid_launch_id", id, error: msg })}\n`);
    else process.stderr.write(`forge launch wait: ${msg}\n`);
    return 2;
  }
  const outcome = await waitForLaunchTerminal(id, harness);
  recordWaitAudit(id, outcome);
  render(outcome, !!opts.json);
  return exitCodeFor(outcome);
}

/** OQ-4 audit: the waiter's own lifecycle is recorded DISTINCTLY from any
 *  work-level cancellation. A cancelled/observed/timed-out WAIT appends here (a
 *  filesystem line in the launch dir — native-free, no store); cancelling the
 *  WORK is a separate launch-level operation reflected in the exit/owner record.
 *  Best-effort: never fail the observation on an audit write. */
function recordWaitAudit(id: string, o: WaitOutcome): void {
  if (o.kind === "unknown_launch") return; // no launch dir to record against
  const event =
    o.kind === "terminal" ? "wait_observed_terminal" : `wait_${o.kind}`;
  const detail = o.kind === "terminal" ? { status: o.view.status } : { lastObserved: o.lastObserved };
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail });
  try {
    appendFileSync(join(LAUNCHES_DIR, id, "wait.log"), `${line}\n`);
  } catch {
    /* audit is advisory; the observation on stdout is the primary record */
  }
}

function toJson(o: WaitOutcome): unknown {
  switch (o.kind) {
    case "terminal":
      return {
        kind: "terminal",
        id: o.view.id,
        status: o.view.status,
        command: o.view.command,
        startedAt: o.view.startedAt,
        forgeIds: o.view.forgeIds,
      };
    case "unknown_launch":
      return { kind: "unknown_launch", id: o.id };
    case "wait_timeout":
      return { kind: "wait_timeout", id: o.id, lastObserved: o.lastObserved };
    case "wait_cancelled":
      return { kind: "wait_cancelled", id: o.id, lastObserved: o.lastObserved };
  }
}

function render(o: WaitOutcome, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(toJson(o))}\n`);
    return;
  }
  switch (o.kind) {
    case "terminal": {
      const v = o.view;
      const lines = [`forge launch wait: ${v.id} is terminal — ${statusLine(v.status)}`];
      if (v.forgeIds.runIds.length > 0) lines.push(`  runs:  ${v.forgeIds.runIds.join(", ")}`);
      if (v.forgeIds.taskIds.length > 0) lines.push(`  tasks: ${v.forgeIds.taskIds.join(", ")}`);
      process.stdout.write(`${lines.join("\n")}\n`);
      return;
    }
    case "unknown_launch":
      process.stderr.write(
        `forge launch wait: no such launch '${o.id}' — unknown launch id (DISTINCT from a known launch whose status is 'unknown')\n`,
      );
      return;
    case "wait_timeout":
      process.stdout.write(
        `forge launch wait: timed out before '${o.id}' reached a terminal disposition — last observed: ${statusLine(o.lastObserved)}. This is a WAITER timeout, NOT a launch result.\n`,
      );
      return;
    case "wait_cancelled":
      process.stdout.write(
        `forge launch wait: cancelled — the wait process was interrupted; the launch and its tmux session were NOT touched (OQ-4). last observed: ${statusLine(o.lastObserved)}.\n`,
      );
      return;
  }
}

/** The launch's own exit code is DATA (carried in the observation's status), not
 *  this command's exit status. A terminal observation — including owner_gone and
 *  unknown — is a SUCCESSFUL observation (exit 0). The waiter's own outcomes get
 *  distinct codes so automation can tell them apart. */
function exitCodeFor(o: WaitOutcome): number {
  switch (o.kind) {
    case "terminal": return 0;
    case "unknown_launch": return 1;
    case "wait_timeout": return 124;
    case "wait_cancelled": return 130;
  }
}
