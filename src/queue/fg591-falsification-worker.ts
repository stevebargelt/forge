// FG-591 (step 16) — the REAL processes the required falsification needs.
//
// This is NOT a test file (no `.test.ts` suffix, so neither the unit nor the
// integration find picks it up). It is spawned as a genuine OS process by
// fg591-falsification.integration.test.ts, pointed at ONE shared SQLite store via
// FORGE_HOME/FORGE_DB_PATH, because every claim the falsification makes is about
// process boundaries: an orchestrator that dies, a dispatcher that must not, a
// successor that adopts rather than duplicates. None of that is observable in-process,
// where "the orchestrator went away" is a variable going out of scope.
//
// Modes (env MODE):
//   orchestrate      — the INTERACTIVE ORCHESTRATOR stand-in, and the whole point of
//                      the reproduction. It starts the dispatcher through the
//                      PRODUCTION path the CLI's own help text prescribes —
//                      `forge launch run -- … forge queue dispatcher run …`, i.e. the
//                      tmux ownership transfer — records what it started, and then
//                      stays open like an interactive session does. The test then
//                      SIGKILLs its whole process GROUP. A dispatcher that was a
//                      child of this process dies there; a tmux-owned one does not,
//                      and that difference IS the ticket's reproduction.
//   wake-suppressed  — the dispatcher with its PRIMARY WAKE OBSERVER suppressed, via
//                      the one seam dispatcher-loop.ts documents as existing for this
//                      falsification (DispatcherLoopSeams.observeWakes). See the long
//                      note on that mode below for why this leg cannot be driven
//                      through the CLI, and what is kept identical to it.
//
// Everything else about both modes is production code: the same runDispatcherLoop, the
// same owner formula (resolveDispatcherOwner), the same forge argv `bin/forge` exec's,
// the same store.

import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { authorityTestkitBinEnv } from "../backlog/container-authority.testkit-spawn.js";
import { resolveDispatcherOwner, runDispatcherLoop, DISPATCHER_ID_ENV } from "./dispatcher-loop.js";

const MODE = process.env["MODE"] ?? "orchestrate";
const REPO_ROOT = process.env["REPO_ROOT"] ?? "";
const PROJECT_DIR = process.env["PROJECT_DIR"] ?? "";
const PROJECT_KEY = process.env["PROJECT_KEY"] ?? "";
const BARRIER_DIR = process.env["BARRIER_DIR"] ?? "";
const DISPATCHER_ID = process.env["DISPATCHER_ID"] ?? "falsification";
const WATCHDOG_MS = Number(process.env["WATCHDOG_MS"] ?? "10000");
const WAKE_POLL_MS = Number(process.env["WAKE_POLL_MS"] ?? "300");
const MAX_TICKS = Number(process.env["MAX_TICKS"] ?? "400");

function report(name: string, value: unknown): void {
  writeFileSync(join(BARRIER_DIR, name), JSON.stringify(value, null, 2));
}

/**
 * The argv `bin/forge` exec's, spelled out.
 *
 * bin/forge is `exec node --import <root>/bin/forge-loader.mjs <root>/src/cli/index.ts
 * "$@"`, so INSIDE a real forge CLI process `[process.execPath, ...process.execArgv,
 * process.argv[1]]` — which is exactly what the CLI's own forgeSelfArgv() returns and
 * hands to the dispatcher as `forgeBin` — is this array. Every element is absolute,
 * which is what lets a launched child resolve from a project directory that has no
 * node_modules of its own.
 *
 * The integration test asserts this equality rather than trusting the comment: the
 * launch argv this worker's dispatcher produces must match, element for element, the
 * one the CLI-driven legs produce.
 */
function forgeBinArgv(): string[] {
  return [process.execPath, "--import", join(REPO_ROOT, "bin", "forge-loader.mjs"), join(REPO_ROOT, "src", "cli", "index.ts")];
}

// ── the interactive orchestrator ─────────────────────────────────────────────

/**
 * Start the dispatcher the way the operator surface says to start it, and then stay
 * open.
 *
 * The `env NAME=VALUE …` prefix is the campaign launcher's and step 7's, for their
 * stated reason: a long-lived tmux server does not pick up the submitter's
 * environment, so a launched child would otherwise resolve a DIFFERENT store (and, in
 * a container, a different backlog authority) than the process that launched it. The
 * variables named here are exactly the ones that decide those two things plus the
 * private tmux socket the test tier is required to stay on.
 */
function runOrchestrate(): void {
  const authorityEnv = authorityTestkitBinEnv();
  const dispatcherArgv = [
    "env",
    `PATH=${process.env["PATH"] ?? ""}`,
    `FORGE_HOME=${process.env["FORGE_HOME"] ?? ""}`,
    `FORGE_DB_PATH=${process.env["FORGE_DB_PATH"] ?? ""}`,
    `TMUX_TMPDIR=${process.env["TMUX_TMPDIR"] ?? ""}`,
    ...Object.entries(authorityEnv).map(([name, value]) => `${name}=${value}`),
    `NO_NOTIFY=true`,
    join(REPO_ROOT, "bin", "forge"),
    "queue",
    "dispatcher",
    "run",
    "--project",
    PROJECT_DIR,
    "--checkout",
    PROJECT_DIR,
    "--dispatcher-id",
    DISPATCHER_ID,
    "--watchdog-interval",
    String(WATCHDOG_MS),
    "--wake-poll",
    String(WAKE_POLL_MS),
    "--max-ticks",
    String(MAX_TICKS),
  ];

  const submitted = spawnSync(
    join(REPO_ROOT, "bin", "forge"),
    ["launch", "run", "--json", "--name", "fg591-dispatcher", "--", ...dispatcherArgv],
    { cwd: PROJECT_DIR, encoding: "utf8", env: process.env },
  );

  if (submitted.status !== 0) {
    report("orchestrator.json", {
      pid: process.pid,
      ok: false,
      error: `forge launch run exited ${String(submitted.status)}: ${submitted.stderr}`,
    });
    process.exit(1);
  }

  const meta = JSON.parse(submitted.stdout) as { id: string; tmuxSession: string; ownerPid: number | null; command: string[] };
  report("orchestrator.json", {
    pid: process.pid,
    ok: true,
    launchId: meta.id,
    tmuxSession: meta.tmuxSession,
    ownerPid: meta.ownerPid,
    command: meta.command,
  });

  // An interactive session does not exit when it has finished submitting work; it sits
  // there until something kills it. So does this. The timer is the ONLY thing keeping
  // the event loop alive, which is what makes the SIGKILL the test sends the sole cause
  // of this process's death.
  setInterval(() => {}, 60_000);
}

// ── the dispatcher with its primary wake suppressed ──────────────────────────

/**
 * THE ONE DEVIATION FROM THE CLI, stated rather than hidden.
 *
 * Legs (a) and (c) drive `forge queue dispatcher run` — the production entry point,
 * unmodified. This leg cannot, and the reason is a property of the design rather than
 * an omission: the primary wake observer runs INSIDE the loop and records its wake in
 * the same iteration that then consumes it, so nothing outside the process can
 * suppress the signal without also changing what the loop does with it. Draining the
 * wake table from a competing consumer does not reproduce the condition either — the
 * loop would still tick with trigger `wake`, which is the opposite of the state under
 * test.
 *
 * So this mode uses DispatcherLoopSeams.observeWakes, the seam dispatcher-loop.ts
 * declares FOR THIS FALSIFICATION in its own words ("FG-591's required falsification
 * needs to SUPPRESS the primary signal and prove the watchdog still recovers the work
 * exactly once. Suppressing it is a legitimate configuration of the system, not a mock
 * of it"). Deliberately NOT exposed as a CLI flag: an operator-facing switch that turns
 * off the event path and leaves only the health bound is a footgun on a surface whose
 * entire purpose is that work keeps moving.
 *
 * Everything else is the CLI's composition, argument for argument — same owner formula,
 * same forgeBin, same projectDir-as-checkout default, same host/pid, same bounds. The
 * only difference is that observeWakes returns nothing, so no run-terminal transition
 * ever becomes a wake and the watchdog is the only mechanism left.
 */
async function runWakeSuppressed(): Promise<void> {
  const ownerRes = resolveDispatcherOwner(PROJECT_KEY, { ...process.env, [DISPATCHER_ID_ENV]: DISPATCHER_ID });
  if (!ownerRes.ok) {
    report("dispatcher.json", { pid: process.pid, ok: false, error: ownerRes.error });
    process.exit(1);
  }

  const forgeBin = forgeBinArgv();
  report("dispatcher.json", {
    pid: process.pid,
    ok: true,
    mode: MODE,
    owner: ownerRes.owner,
    forgeBin,
    watchdogIntervalMs: WATCHDOG_MS,
    wakePollMs: WAKE_POLL_MS,
  });

  const summary = await runDispatcherLoop({
    projectKey: PROJECT_KEY,
    owner: ownerRes.owner,
    forgeBin,
    projectDir: PROJECT_DIR,
    host: hostname(),
    pid: process.pid,
    watchdogIntervalMs: WATCHDOG_MS,
    wakePollMs: WAKE_POLL_MS,
    maxTicks: MAX_TICKS,
    seams: {
      // THE SUPPRESSION. Not "observe less" — observe NOTHING, so every wake this
      // dispatcher could have written for a run-terminal transition is absent from the
      // durable record, and the only thing left that can notice is the watchdog.
      observeWakes: () => [],
      onTick: (tick) => {
        process.stdout.write(
          `tick ${tick.trigger}: ${tick.cycle?.finalReason ?? tick.skipped ?? "no cycle"} — ` +
            `${tick.cycle?.grants.length ?? 0} grant(s), ${tick.launches.length} launch(es), ` +
            `${tick.reconciled.length} retired, ${tick.wakes.length} wake(s)\n`,
        );
      },
    },
  });
  report("dispatcher-summary.json", {
    stopReason: summary.stopReason,
    ticks: summary.ticks.length,
    alert: summary.alert,
  });
}

switch (MODE) {
  case "wake-suppressed":
    await runWakeSuppressed();
    break;
  default:
    runOrchestrate();
}
