// FG-357: post-merge integration gate.
//
// Worktrees (FG-351/352/353) turn same-file textual races into detectable git
// conflicts, but semantic cross-file breakage merges CLEAN: agent A changes a
// signature in foo.ts, agent B (own worktree) still calls the old signature in
// bar.ts — `git merge` sees no overlapping lines and succeeds. Only building
// and testing the MERGED tree catches that.
//
// Runs on the host, not in a container: the merge already landed on the host
// git checkout (run.projectDir, or the integration worktree pre-HEAD-merge),
// so there is nothing container-specific left to reproduce, and reusing
// forge's own `npm run test:unit` entrypoint means no second test runner or
// config to maintain.
//
// FG-425 (crash/timeout ownership): the gate runs in its OWN process group,
// durably associated with the project's integration lock (sidecar next to the
// lock file). On timeout the WHOLE group is terminated — SIGTERM, grace,
// SIGKILL — and confirmed gone before this function returns; a lingering
// descendant after a natural exit gets the same treatment. The sidecar is
// cleared only on confirmed termination, so a forge crash mid-gate leaves it
// behind for the next lock acquirer to reap (see project-integration-lock.ts).
// An unconfirmable group is surfaced in the result (and the sidecar retained)
// rather than silently released over.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recordGateProcessGroup,
  clearGateProcessGroup,
  terminateProcessGroup,
  type KillFn,
} from "./project-integration-lock.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export type IntegrationGateResult =
  | { ok: true; output: string }
  | {
      ok: false;
      output: string;
      error: string;
      // Raw process-exit evidence — surfaced (not discarded) so callers can
      // distinguish an infra/platform failure (timeout, signal-kill) from a
      // genuine non-zero test-suite exit.
      status: number | null;
      signal: string | null;
      timedOut: boolean;
      /** FG-425: false when the gate's process group could not be CONFIRMED
       *  terminated after SIGTERM→SIGKILL. The sidecar is retained in that
       *  case, so the next window acquirer reaps (or refuses over) the orphan
       *  instead of merging under it. */
      groupTerminationConfirmed?: boolean;
    };

/** Mirrors forge-test's own `_pkg_has_script`: true only if package.json parses
 *  and declares the named script. A project with no test:unit script has
 *  nothing for this gate to run — that's a project-config gap, not a merge
 *  defect, so it must not block every worktree merge. */
function hasTestUnitScript(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return typeof pkg.scripts?.["test:unit"] === "string";
  } catch {
    return false;
  }
}

/** Build+test the merged tree at `dir` via the project's own test:unit
 *  entrypoint, in an owned process group. `runId` rides into the lock sidecar
 *  for operator-facing attribution of an orphaned group. */
export async function runIntegrationGate(
  dir: string,
  opts?: { runId?: string; killFn?: KillFn; graceMs?: number; confirmTimeoutMs?: number },
): Promise<IntegrationGateResult> {
  if (!hasTestUnitScript(dir)) {
    return { ok: true, output: "no test:unit script in package.json — integration gate skipped" };
  }
  const envTimeout = Number(process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS);
  const timeout = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS;

  // detached: true makes the child a process-group LEADER (pgid === pid), so
  // group signals reach every descendant the test runner forks.
  const child = spawn("npm", ["run", "test:unit"], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pgid = child.pid;
  if (pgid === undefined) {
    return { ok: false, output: "", error: "integration gate failed to spawn npm", status: null, signal: null, timedOut: false };
  }
  recordGateProcessGroup(dir, pgid, opts?.runId);

  let stdout = "";
  let stderr = "";
  const cap = (cur: string, chunk: unknown): string =>
    cur.length < MAX_OUTPUT_BYTES ? cur + String(chunk) : cur;
  child.stdout.on("data", (d) => { stdout = cap(stdout, d); });
  child.stderr.on("data", (d) => { stderr = cap(stderr, d); });

  const exited = new Promise<{ status: number | null; signal: string | null }>((resolvePromise) => {
    child.on("close", (status, signal) => resolvePromise({ status, signal }));
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void terminateProcessGroup(pgid, terminateOpts(opts)); }, timeout);
  const { status, signal } = await exited;
  clearTimeout(timer);

  // Confirm the WHOLE group is gone on every path — a passing npm exit can
  // still leave a forked test-runner descendant behind, and the merge window
  // must never be released over one.
  const groupOutcome = await terminateProcessGroup(pgid, terminateOpts(opts));
  if (groupOutcome === "confirmed") {
    clearGateProcessGroup(dir); // sidecar cleared ONLY on confirmed termination
  }

  const output = [stdout, stderr].filter(Boolean).join("\n").trim();

  if (groupOutcome === "unconfirmable") {
    return {
      ok: false,
      output,
      error:
        `integration gate process group ${pgid} could not be confirmed terminated after SIGTERM→SIGKILL — ` +
        `refusing to report a clean gate over a possibly-live test process. ` +
        `Inspect with \`ps -g ${pgid}\`, terminate it (e.g. \`kill -9 -${pgid}\`), then retry.`,
      status,
      signal,
      timedOut,
      groupTerminationConfirmed: false,
    };
  }
  if (timedOut) {
    return {
      ok: false,
      output,
      error: `integration gate timed out after ${timeout}ms — process group ${pgid} terminated and confirmed gone`,
      status,
      signal,
      timedOut: true,
      groupTerminationConfirmed: true,
    };
  }
  if (status === 0) return { ok: true, output };
  return {
    ok: false,
    output,
    error: `npm run test:unit exited ${status === null ? `on signal ${signal}` : `with status ${status}`}`,
    status,
    signal,
    timedOut: false,
    groupTerminationConfirmed: true,
  };
}

function terminateOpts(opts?: { killFn?: KillFn; graceMs?: number; confirmTimeoutMs?: number }): {
  killFn?: KillFn; graceMs?: number; confirmTimeoutMs?: number;
} {
  return {
    ...(opts?.killFn !== undefined ? { killFn: opts.killFn } : {}),
    ...(opts?.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
    ...(opts?.confirmTimeoutMs !== undefined ? { confirmTimeoutMs: opts.confirmTimeoutMs } : {}),
  };
}
