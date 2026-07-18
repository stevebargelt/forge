import type { Command } from "commander";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { controlRuntimeProfile, listLaunches, readLaunch, removeLaunch, startLaunch, type ControlRuntime, type LaunchStatus, type LaunchView, type WorkloadNestedShell, type WorkloadTopLevel } from "../../v2/launch.js";

// FG-535: `forge launch` — the supported durable launch path for long-running
// forge commands (`forge invoke`, `forge next`, `forge review-loop`, …) when
// the submitting shell is owned by an interactive orchestrator harness that
// may SIGTERM its children. See src/v2/launch.ts for the ownership model.

// FG-535 AC: never infer the sender from exit 143 alone. `signaled` carries the
// kernel's WIFSIGNALED verdict — real evidence a signal landed — but nothing
// records WHO sent it, so the line says so instead of claiming "externally
// terminated". `terminated_unattributed` has even less: a signal-shaped code
// that a deliberate exit(143) would produce identically.
function statusLine(s: LaunchStatus): string {
  switch (s.state) {
    case "running": return "running";
    case "exited_ok": return "exited 0";
    case "exited_error": return `exited ${s.code}`;
    case "signaled": return `terminated by ${s.signal} (signal sender not recorded — origin unknown)`;
    case "terminated_unattributed": return `exited ${s.code} (signal-range code, no signal evidence — origin unknown)`;
    case "owner_gone": return "owner gone without an exit record (wrapper killed, or failed before recording — cause and sender not recorded)";
    case "unknown": return "unknown (no exit record, owner gone — e.g. host reboot)";
  }
}

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

// FG-555 (R4): whether a caller-supplied nested shell will resolve node/npm/forge
// later, inside the workload. UNKNOWABLE is stated explicitly — argv never implies
// R4 is covered.
function workloadR4Line(r4: WorkloadNestedShell): string {
  return r4.kind === "unknowable"
    ? `R4 UNKNOWABLE — nested shell '${r4.shell}' resolves node/npm/forge at runtime; not knowable at launch (argv does not cover it)`
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
    .command("rm")
    .description("Remove a finished launch's record and tmux remains (refuses a running launch without --force)")
    .option("--force", "kill the tmux session even if the launch is still running")
    .argument("<id>", "launch id")
    .action((id: string, opts: { force?: boolean }) => {
      removeLaunch(id, { force: opts.force });
      console.log(`removed ${id}`);
    });
}
