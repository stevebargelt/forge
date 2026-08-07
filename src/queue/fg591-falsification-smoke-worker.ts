// Host-only child for the FG-591 operator falsification. It intentionally has
// no authority-test seam: this proof runs where the real authority and real
// credentials are available.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DISPATCHER_ID_ENV, resolveDispatcherOwner, runDispatcherLoop } from "./dispatcher-loop.js";

const mode = process.env.MODE ?? "orchestrate";
const root = process.env.REPO_ROOT ?? "";
const project = process.env.PROJECT_DIR ?? "";
const projectKey = process.env.PROJECT_KEY ?? "";
const barrier = process.env.BARRIER_DIR ?? "";
const dispatcherId = process.env.DISPATCHER_ID ?? "falsification";
const watchdogIntervalMs = Number(process.env.WATCHDOG_MS ?? "10000");
const wakePollMs = Number(process.env.WAKE_POLL_MS ?? "300");
const maxTicks = Number(process.env.MAX_TICKS ?? "400");

function report(name: string, value: unknown): void {
  writeFileSync(join(barrier, name), JSON.stringify(value, null, 2));
}

function forgeBin(): string[] {
  return [process.execPath, "--import", join(root, "bin", "forge-loader.mjs"), join(root, "src", "cli", "index.ts")];
}

function orchestrate(): void {
  const command = [
    "env", `PATH=${process.env.PATH ?? ""}`, `FORGE_HOME=${process.env.FORGE_HOME ?? ""}`,
    `FORGE_DB_PATH=${process.env.FORGE_DB_PATH ?? ""}`, `TMUX_TMPDIR=${process.env.TMUX_TMPDIR ?? ""}`,
    "NO_NOTIFY=true", join(root, "bin", "forge"), "queue", "dispatcher", "run", "--project", project,
    "--checkout", project, "--dispatcher-id", dispatcherId, "--watchdog-interval", String(watchdogIntervalMs),
    "--wake-poll", String(wakePollMs), "--max-ticks", String(maxTicks),
  ];
  const submitted = spawnSync(join(root, "bin", "forge"), ["launch", "run", "--json", "--name", "fg591-dispatcher", "--", ...command], {
    cwd: project, encoding: "utf8", env: process.env,
  });
  if (submitted.status !== 0) {
    report("orchestrator.json", { pid: process.pid, ok: false, error: submitted.stderr });
    process.exit(1);
  }
  const meta = JSON.parse(submitted.stdout) as { id: string; tmuxSession: string; ownerPid: number | null; command: string[] };
  report("orchestrator.json", { pid: process.pid, ok: true, launchId: meta.id, tmuxSession: meta.tmuxSession, ownerPid: meta.ownerPid, command: meta.command });
  setInterval(() => {}, 60_000);
}

async function wakeSuppressed(): Promise<void> {
  const owner = resolveDispatcherOwner(projectKey, { ...process.env, [DISPATCHER_ID_ENV]: dispatcherId });
  if (!owner.ok) {
    report("dispatcher.json", { pid: process.pid, ok: false, error: owner.error });
    process.exit(1);
  }
  const bin = forgeBin();
  report("dispatcher.json", { pid: process.pid, ok: true, mode, owner: owner.owner, forgeBin: bin, watchdogIntervalMs, wakePollMs });
  const summary = await runDispatcherLoop({
    projectKey, owner: owner.owner, forgeBin: bin, projectDir: project, host: hostname(), pid: process.pid,
    watchdogIntervalMs, wakePollMs, maxTicks,
    seams: {
      observeWakes: () => [],
      onTick: (tick) => process.stdout.write(`tick ${tick.trigger}: ${tick.cycle?.finalReason ?? tick.skipped ?? "no cycle"} — ${tick.cycle?.grants.length ?? 0} grant(s), ${tick.launches.length} launch(es), ${tick.reconciled.length} retired, ${tick.wakes.length} wake(s)\n`),
    },
  });
  report("dispatcher-summary.json", { stopReason: summary.stopReason, ticks: summary.ticks.length, alert: summary.alert });
}

if (mode === "wake-suppressed") await wakeSuppressed();
else orchestrate();
