import type { Command } from "commander";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { listLaunches, readLaunch, removeLaunch, startLaunch, type LaunchStatus, type LaunchView } from "../../v2/launch.js";

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
    case "owner_terminated": return "owner terminated (wrapper died before recording an exit — sender not recorded)";
    case "unknown": return "unknown (no exit record, owner gone — e.g. host reboot)";
  }
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
    .argument("<command...>", "the command to run (prefix with -- to stop option parsing)")
    .action((command: string[], opts: { name?: string; json?: boolean }) => {
      const meta = startLaunch(command, { name: opts.name });
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
    .description("List launches with derived status (running / exited / externally terminated / unknown)")
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
