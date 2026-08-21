// FG-590: the daemon-free automatic cleanup orchestrator. Proves it drives BOTH the
// launch sweep and the container reap under one policy, is a no-op with no store side
// effect on a store-less host, never throws into its caller when a path errors, and that
// `forge ops cleanup` is registered as the manual sweep.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeInMemoryDb, setDbForTest, closeDb, storeExists } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import type { Run, Task, TaskStatus, RunStatus } from "../../types/index.js";
import type { ContainerReap, ContainerLister, ContainerListEntry } from "../../v2/reconcile.js";
import type { ContainerExitInfo } from "../../v2/failure-kind.js";
import { LAUNCHES_DIR, type TmuxRunner } from "../../v2/launch.js";
import { performAutomaticCleanup, registerOps } from "./ops.js";
import type { RetentionPolicy } from "../../v2/retention-policy.js";

const PROJECT = "/tmp/test-project";
const POLICY: RetentionPolicy = { success: 1000, failureAmbiguous: 5000 };
const LONG_AGO = "2020-01-01T00:00:00.000Z";
const T0 = 1_700_000_000_000; // 2023 — AFTER LONG_AGO, so an injected clock sees LONG_AGO as past

afterEach(() => closeDb());

function mkRun(id: string, status: RunStatus): Run {
  return { id, workflow: "feature", title: id, status, createdAt: "2026-06-02T12:00:00Z", projectDir: PROJECT };
}
function mkTask(id: string, runId: string, status: TaskStatus): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}
function containerList(entries: Array<{ name: string; running?: boolean; finishedAt?: string }>): ContainerLister {
  const list: ContainerListEntry[] = entries.map((e) => ({ name: e.name, running: e.running ?? false, ...(e.finishedAt !== undefined ? { finishedAt: e.finishedAt } : {}) }));
  return () => list;
}
const exitInfo: ContainerExitInfo = () => ({ exitCode: 1 });

function resetLaunches(): void {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
  mkdirSync(LAUNCHES_DIR, { recursive: true });
}
function makeTerminalLaunch(id: string): void {
  const dir = join(LAUNCHES_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, command: ["x"], tmuxSession: `forge-${id}`, launcherPid: 999999, ownerPid: null, startedAt: "2026-01-01T00:00:00.000Z", logPath: join(dir, "out.log"), cwd: "/tmp" }));
  writeFileSync(join(dir, "exit"), JSON.stringify({ code: 0, signal: null }));
}
const deadTmux: TmuxRunner = (args) => {
  if (args[0] === "-V") return "tmux 3.4";
  if (args[0] === "has-session") throw new Error("no session");
  return "";
};

test("FG-590 cleanup: drives BOTH paths — retires an eligible launch and reaps an eligible container", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    insertRun(mkRun("run-orch", "failed"));
    insertTask(mkTask("t-orch", "run-orch", "failed"));
    resetLaunches();
    makeTerminalLaunch("launch-orch");

    const reaped: string[] = [];
    const reap: ContainerReap = (n) => { reaped.push(n); return "killed"; };

    // Anchor pass then a past-window pass so the launch marker ages past its window.
    performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0), tmux: deadTmux, reap, listContainers: containerList([{ name: "forge-t-orch", finishedAt: LONG_AGO }]), containerExitInfo: exitInfo });
    const result = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0 + 6000), tmux: deadTmux, reap, listContainers: containerList([{ name: "forge-t-orch", finishedAt: LONG_AGO }]), containerExitInfo: exitInfo });

    assert.ok(!("error" in result.launches) && result.launches.removed.includes("launch-orch"));
    assert.ok(!("error" in result.containers) && result.containers.reaped.includes("forge-t-orch"));
    assert.ok(reaped.includes("forge-t-orch"));
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-590 cleanup: store-less host — no store is opened or minted, and it does not throw", () => {
  closeDb(); // ensure no injected handle; FORGE_HOME temp has no forge.db
  assert.equal(storeExists(), false);
  resetLaunches();

  const result = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, tmux: deadTmux, reap: () => "killed", listContainers: containerList([{ name: "forge-t-nostore" }]), containerExitInfo: exitInfo });

  // The container path saw a store-less host and did nothing; the store was never minted.
  assert.ok(!("error" in result.containers) && result.containers.reaped.length === 0);
  assert.equal(storeExists(), false, "reading must not mint a store");
});

test("FG-590 cleanup: a failing path is captured, never thrown, and the other path still runs", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    insertRun(mkRun("run-throw", "failed"));
    insertTask(mkTask("t-throw", "run-throw", "failed"));
    resetLaunches();
    makeTerminalLaunch("launch-throw");

    const boom: ContainerLister = () => { throw new Error("docker exploded"); };
    const result = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0), tmux: deadTmux, reap: () => "killed", listContainers: boom, containerExitInfo: exitInfo });

    assert.ok("error" in result.containers && /docker exploded/.test(result.containers.error));
    // The launch sweep is independent and still ran (anchored the launch this pass).
    assert.ok(!("error" in result.launches));
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-590 cleanup: `forge ops cleanup` is registered as the manual sweep", () => {
  const program = new Command();
  registerOps(program);
  const ops = program.commands.find((c) => c.name() === "ops");
  assert.ok(ops, "ops command exists");
  const cleanup = ops!.commands.find((c) => c.name() === "cleanup");
  assert.ok(cleanup, "`forge ops cleanup` is registered");
  // The existing manual commands remain available.
  assert.ok(ops!.commands.find((c) => c.name() === "reap-containers"), "reap-containers still registered");
});
