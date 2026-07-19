import type { Command } from "commander";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { controlRuntimeProfile, listLaunches, readLaunch, removeLaunch, startLaunch, statusLine, type ControlRuntime, type LaunchView, type WorkloadNestedShell, type WorkloadTopLevel } from "../../v2/launch.js";
import { waitAndRender } from "./launch-wait.js";

// FG-535: `forge launch` — the supported durable launch path for long-running
// forge commands (`forge invoke`, `forge next`, `forge review-loop`, …) when
// the submitting shell is owned by an interactive orchestrator harness that
// may SIGTERM its children. See src/v2/launch.ts for the ownership model.

// FG-569 (R1): the submitting forge CLI's own runtime + release identity. A
// release CLI names its manifest id + commit; a dev CLI is the explicit
// "dev (unversioned)" marker — never a manufactured or inferred release.
function controlLine(c: ControlRuntime): string {
  const rel = c.release.kind === "release"
    ? `release ${c.release.releaseId} (commit ${c.release.commit.slice(0, 7)}, ${c.release.path})`
    : "dev (unversioned)";
  return `${c.execPath}  abi ${c.abi} (node ${c.nodeVersion})  ${rel}`;
}

// FG-555 (R3): the launched top-level executable, resolved at spawn time. A
// distinct fact from R1/R2 (forge's own runtimes) — argv is a string, this is
// its resolution.
function workloadR3Line(r3: WorkloadTopLevel): string {
  switch (r3.kind) {
    case "captured": return `R3 captured — argv[0] '${r3.argv0}' is a path: ${r3.execPath}`;
    case "derived": return `R3 derived — argv[0] '${r3.argv0}' resolved on PATH → ${r3.execPath}`;
    case "unresolved": return `R3 unresolved — argv[0] '${r3.argv0}' not found on PATH (recorded as fact, never guessed)`;
  }
}

// FG-555 (R4): whether the launched command — a nested shell, a script, or a
// launcher/wrapper (npm, vitest, a `#!/usr/bin/env node` script) — will resolve
// node/npm/forge later, inside the workload. UNKNOWABLE is stated explicitly, and
// the render never calls a non-shell launcher a "nested shell": argv never implies
// R4 is covered.
function workloadR4Line(r4: WorkloadNestedShell): string {
  return r4.kind === "unknowable"
    ? `R4 UNKNOWABLE — the launched command '${r4.shell}' resolves node/npm/forge at runtime (shebang/PATH); not knowable at launch (argv does not cover it)`
    : `R4 not applicable — argv executed directly, no nested shell resolves anything later`;
}

function renderView(v: LaunchView, logTailLines = 15): string {
  const lines = [
    `launch:   ${v.id}`,
    `command:  ${v.command.join(" ")}`,
    `session:  ${v.tmuxSession}  (tmux attach -t ${v.tmuxSession})`,
    `owner:    ${v.ownerPid === null || v.ownerPid === undefined ? "pid not recorded" : `pid ${v.ownerPid} (tmux pane)`}  launched by pid ${v.launcherPid ?? "unrecorded"}`,
    `cwd:      ${v.cwd}`,
    `started:  ${v.startedAt}`,
    `log:      ${v.logPath}`,
    `status:   ${statusLine(v.status)}`,
  ];
  // FG-569: R1 and R2 are surfaced as SEPARATE lines. R1 (control) = the CLI that
  // SUBMITTED the launch; R2 (recorder) = the exit recorder. They are distinct
  // runtimes and never merged. R1 is ALWAYS rendered: an old record with no R1
  // says "not recorded" rather than being silently dropped or inferred from R2.
  lines.push(`control:  ${v.control ? controlLine(v.control) : "not recorded (launch predates R1 capture)"}`);
  if (v.recorder) {
    // FG-569 (R2): the recorder's OWN runtime, captured inside the recorder — not
    // the forge CLI (R1) that submitted the launch.
    lines.push(`recorder: ${v.recorder.execPath}  abi ${v.recorder.abi} (node ${v.recorder.nodeVersion})${v.recorder.releaseId ? `  release ${v.recorder.releaseId}` : ""}`);
  } else {
    lines.push(`recorder: not recorded (exit recorder has not written its runtime yet)`);
  }
  // FG-555: R3/R4 — the launched workload's execution environment, distinct from
  // R1/R2. Always rendered; a pre-FG-555 launch says "not recorded", never inferred.
  if (v.workload) {
    lines.push(`workload: ${workloadR3Line(v.workload.r3)}`);
    lines.push(`nested:   ${workloadR4Line(v.workload.r4)}`);
    // FG-555: the effective Node interpreter the workload actually ran under, and
    // the launch-environment contract that was pinned — the runtime provenance that
    // lets a reader diagnose whether a direct node/npm workload used the compatible
    // toolchain. Both always rendered; absent reads as "not recorded", never guessed.
    lines.push(`runtime:  ${v.workload.interpreter
      ? `${v.workload.interpreter.execPath}  abi ${v.workload.interpreter.abi} (node ${v.workload.interpreter.nodeVersion})`
      : "not recorded (argv[0] is not a probed Node interpreter, or the probe did not run)"}`);
    lines.push(`profile:  ${v.workload.profile
      ? `${v.workload.profile.label ? `${v.workload.profile.label} — ` : ""}requires abi ${v.workload.profile.requireAbi}; pinned PATH = ${v.workload.profile.path}`
      : "none declared (launch inherited the ambient env)"}`);
  } else {
    lines.push(`workload: not recorded (launch predates R3/R4 capture, or the recorder has not run yet)`);
  }
  if (v.forgeIds.runIds.length > 0) lines.push(`runs:     ${v.forgeIds.runIds.join(", ")}`);
  if (v.forgeIds.taskIds.length > 0) lines.push(`tasks:    ${v.forgeIds.taskIds.join(", ")}`);
  if (logTailLines > 0) {
    let tail = "";
    try {
      const all = readFileSync(v.logPath, "utf8").split("\n");
      tail = all.slice(Math.max(0, all.length - 1 - logTailLines)).join("\n").trimEnd();
    } catch { /* no log yet */ }
    if (tail) lines.push("", `── log tail (${basename(v.logPath)}) ──`, tail);
  }
  return lines.join("\n");
}

export function registerLaunch(program: Command): void {
  const launch = program
    .command("launch")
    .description("Run long forge commands under a durable tmux owner that survives the submitting session (FG-535)");

  launch
    .command("run")
    .description("Start a command in a detached, uniquely named tmux session; returns immediately")
    .option("--name <name>", "short name used in the launch id and tmux session")
    .option("--json", "machine-readable output")
    .option(
      "--require-control-toolchain",
      "FG-555: declare the launch-environment contract — pin the workload's PATH to forge's own control-runtime node and REFUSE before executing if the resolved toolchain's ABI does not match (for Forge-owned unattended verification callers; do not depend on ambient login-shell PATH)",
    )
    .argument("<command...>", "the command to run (prefix with -- to stop option parsing)")
    .action((command: string[], opts: { name?: string; json?: boolean; requireControlToolchain?: boolean }) => {
      const profile = opts.requireControlToolchain ? controlRuntimeProfile({ label: "control-runtime" }) : undefined;
      const meta = startLaunch(command, { name: opts.name, profile });
      if (opts.json) {
        console.log(JSON.stringify(meta, null, 2));
        return;
      }
      console.log(`forge launch: started under tmux — the submitting shell may exit freely`);
      console.log(`  id:      ${meta.id}`);
      console.log(`  session: ${meta.tmuxSession}`);
      console.log(`  log:     ${meta.logPath}`);
      console.log(`  inspect: forge launch show ${meta.id}`);
    });

  launch
    .command("list")
    .description("List launches with derived status (running / exited N / terminated-by-signal with unrecorded sender / owner gone / unknown)")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
      const all = listLaunches();
      if (opts.json) {
        console.log(JSON.stringify(all, null, 2));
        return;
      }
      if (all.length === 0) {
        console.log("no launches recorded");
        return;
      }
      for (const v of all) {
        console.log(`${v.id}  ${statusLine(v.status)}  started ${v.startedAt}  — ${v.command.join(" ")}`);
      }
    });

  launch
    .command("show")
    .description("Full record for one launch: command, session, timing, status, forge ids, log tail")
    .option("--json", "machine-readable output")
    .argument("<id>", "launch id")
    .action((id: string, opts: { json?: boolean }) => {
      const v = readLaunch(id);
      if (!v) throw new Error(`forge launch: no such launch '${id}'`);
      console.log(opts.json ? JSON.stringify(v, null, 2) : renderView(v));
    });

  launch
    .command("wait")
    .description(
      "Block until a launch reaches a terminal disposition, then emit EXACTLY ONE structured observation (FG-552). Watches the atomic exit record + reconciles owner evidence; never wakes a model. SIGINT cancels the WAITER only, never the tmux-owned work (OQ-4). The launch's own exit code is DATA in the observation, not this command's exit status.",
    )
    .option("--json", "machine-readable observation")
    .option(
      "--timeout <seconds>",
      "waiter timeout (0 = no timeout); an elapsed timeout is an explicit wait_timeout result, NEVER a fabricated launch terminal state",
    )
    .argument("<id>", "launch id")
    .action(async (id: string, opts: { json?: boolean; timeout?: string }) => {
      const timeoutMs = opts.timeout !== undefined ? Number(opts.timeout) * 1000 : undefined;
      process.exitCode = await waitAndRender(id, { json: opts.json, timeoutMs });
    });

  launch
    .command("rm")
    .description("Remove a finished launch's record and tmux remains (refuses a running launch without --force)")
    .option("--force", "kill the tmux session even if the launch is still running")
    .argument("<id>", "launch id")
    .action((id: string, opts: { force?: boolean }) => {
      removeLaunch(id, { force: opts.force });
      console.log(`removed ${id}`);
    });
}
