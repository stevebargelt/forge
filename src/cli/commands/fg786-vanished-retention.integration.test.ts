// FG-786 AC3 (sweep composition): performAutomaticCleanup composes vanished-owner launches
// into the sweep under the DEFAULT retention policy, from ANY project, WITHOUT weakening
// RF-5 for a project that still exists.
//
// The load-bearing SECURITY invariant is RF-5: a project-local zero-window retention override
// must never reach across projects. This change ADDS a second, DEFAULT-policy sweep scoped to
// provably-vanished owners; the risk it introduces is over-reach — a mis-scoped "vanished"
// verdict, or the override leaking into the vanished sweep, purging a LIVE project's launches.
// So these tests pin BOTH directions under one zero-window override policy:
//   - a vanished-owner launch PAST the DEFAULT window is retired (convergence), while
//   - a live OTHER-project launch is untouched (RF-5 preserved), and
//   - a vanished-owner launch INSIDE the DEFAULT window is retained (the default windows —
//     not the caller's zero-window override — govern the vanished sweep).
//
// Real store (in-memory SQLite) + REAL temp dirs for the parent/leaf presence checks. The
// git-identity + registry probes are injected (vanishedOwnerDeps) so a vanished owner is posed
// deterministically without standing up a git repo per case — the fs presence checks stay real.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeInMemoryDb, setDbForTest, closeDb, storeExists } from "../../store/db.js";
import { recordLaunchObservation } from "../../store/launch-observations.js";
import type { VanishedOwnerDeps } from "../../store/launch-observations.js";
import type { RepositoryCheckoutIdentity } from "../../util/repository-identity.js";
import { LAUNCHES_DIR, type TmuxRunner } from "../../v2/launch.js";
import type { RetentionPolicy } from "../../v2/retention-policy.js";
import type { CwdHolderResult } from "../../v2/launch.js";
import { performAutomaticCleanup, registerOps } from "./ops.js";

// A project-local ZERO-WINDOW override — the exact RF-5 threat: it would retire every terminal
// launch instantly if it could reach one. The vanished sweep must ignore it (it uses the
// built-in DEFAULT windows), and it must never touch a live OTHER project's launches.
const ZERO_WINDOW: RetentionPolicy = { success: 0, failureAmbiguous: 0 };
const T0 = 1_700_000_000_000; // 2023
const LONG_AGO = "2020-01-01T00:00:00.000Z"; // > DEFAULT 15-min success window before T0
const FRESH = new Date(T0 - 60_000).toISOString(); // 1 min before T0 — inside the DEFAULT window

// tmux that reports every session dead — so removeLaunch's re-probe never sees a running
// launch and the sweep's never-remove-a-running-launch rule is not the thing under test here.
const deadTmux: TmuxRunner = (args) => {
  if (args[0] === "-V") return "tmux 3.4";
  if (args[0] === "has-session") throw new Error("no session");
  return "";
};
// No workspace is ever held — keeps the owned closeout from touching real tmux/lsof.
const noHolder = (): CwdHolderResult => ({ held: false });

let base: string;

afterEach(() => {
  closeDb();
  if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
});

function resetLaunches(): void {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
  mkdirSync(LAUNCHES_DIR, { recursive: true });
}

/** Write the on-disk launch record (meta.json + exit) AND the durable terminal marker whose
 *  `terminalAt` anchors the retention clock. sweepTerminalLaunches reads the marker via the
 *  cheap path, then removeLaunch re-reads meta+exit at the destroy chokepoint. */
function makeTerminalLaunchFile(id: string, terminalAt: string): void {
  const dir = join(LAUNCHES_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ id, command: ["x"], tmuxSession: `forge-${id}`, launcherPid: 999999, ownerPid: null, startedAt: "2026-01-01T00:00:00.000Z", logPath: join(dir, "out.log"), cwd: "/tmp" }),
  );
  writeFileSync(join(dir, "exit"), JSON.stringify({ code: 0, signal: null }));
  writeFileSync(join(dir, "terminal.json"), JSON.stringify({ terminalAt, state: "exited_ok", cls: "success" }));
}

/** Seed a terminal launch observation owned by `projectDir` (present at write time, exactly
 *  as a real launch records it). */
function seedObservation(launchId: string, projectDir: string): void {
  recordLaunchObservation({
    launchId,
    command: ["forge", "launch", "run"],
    cwd: projectDir,
    projectDir,
    startedAt: "2026-09-01T00:00:00.000Z",
    observedAt: "2026-09-01T00:00:00.000Z",
    status: { state: "exited_ok", code: 0 },
  });
}

/** An injected identity resolver: any dir reads as a GONE git identity (no live root up-tree),
 *  with the registry knowing nothing — so a deleted-leaf owner classifies PROVEN vanished. A
 *  present-leaf owner short-circuits to not-vanished before this is ever consulted. */
const goneEverywhere: VanishedOwnerDeps = {
  checkoutIdentity: (dir: string): RepositoryCheckoutIdentity => ({ key: `gone:${dir}`, source: "path", checkoutRoot: dir, exists: false }),
  lookupRegistry: () => undefined,
};

test("FG-786 AC3: under a project-local zero-window override, a vanished-owner launch past the DEFAULT window is retired while a live other-project launch is untouched (RF-5)", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    base = mkdtempSync(join(tmpdir(), "fg786-vanished-retention-"));
    resetLaunches();

    // The project this cleanup pass runs FROM (present on disk).
    const currentProject = join(base, "current-project");
    mkdirSync(currentProject, { recursive: true });

    // (A) vanished owner: present parent, deleted leaf. Its launch is anchored LONG_AGO, so it
    // is past the DEFAULT 15-min success window.
    const vanishedParent = join(base, "dead-parent");
    const vanishedLeaf = join(vanishedParent, "dead-clone");
    mkdirSync(vanishedLeaf, { recursive: true });
    seedObservation("la-vanished-old", vanishedLeaf);
    makeTerminalLaunchFile("la-vanished-old", LONG_AGO);
    rmSync(vanishedLeaf, { recursive: true, force: true }); // leaf gone; parent remains

    // (B) LIVE other project: a present checkout dir that is NOT the current project. It is
    // FOREIGN under RF-5 and NOT vanished (leaf present). Anchored LONG_AGO so, were the
    // zero-window override able to reach it, it WOULD be removed — proving it is excluded.
    const otherProject = join(base, "other-project");
    mkdirSync(otherProject, { recursive: true });
    seedObservation("la-live-other", otherProject);
    makeTerminalLaunchFile("la-live-other", LONG_AGO);

    // (C) a CURRENT-project launch, past window — the primary (override) sweep SHOULD retire it,
    // demonstrating the zero-window override does apply within its own project.
    seedObservation("la-current", currentProject);
    makeTerminalLaunchFile("la-current", LONG_AGO);

    const result = performAutomaticCleanup({
      projectDir: currentProject,
      now: new Date(T0),
      tmux: deadTmux,
      policy: ZERO_WINDOW, // the project-local override
      vanishedOwnerDeps: goneEverywhere,
      cwdGuard: noHolder,
      listContainers: () => [],
      reap: () => "killed",
    });

    assert.ok(!("error" in result.launches), `launch sweep errored: ${JSON.stringify(result.launches)}`);
    const l = result.launches as { removed: string[]; retained: string[] };

    // Convergence: the vanished-owner launch is retired under the DEFAULT policy from a project
    // that is not its (vanished) owner.
    assert.ok(l.removed.includes("la-vanished-old"), "vanished-owner launch past the DEFAULT window must be retired");
    assert.ok(!existsSync(join(LAUNCHES_DIR, "la-vanished-old")), "its on-disk record must be gone");

    // RF-5: the live OTHER-project launch is untouched even though the override is zero-window.
    assert.ok(!l.removed.includes("la-live-other"), "a LIVE other-project launch must never be retired by a project-local override");
    assert.ok(existsSync(join(LAUNCHES_DIR, "la-live-other")), "the live other-project launch record must remain on disk");

    // Sanity: the override DOES retire the current project's own launch (so the exclusion above
    // is scope, not a dead sweep).
    assert.ok(l.removed.includes("la-current"), "the zero-window override still retires the current project's own launch");
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-786 AC3: a vanished-owner launch INSIDE the DEFAULT window is retained (the vanished sweep uses DEFAULT windows, not the caller's zero-window override)", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    base = mkdtempSync(join(tmpdir(), "fg786-vanished-retention-"));
    resetLaunches();
    const currentProject = join(base, "current-project");
    mkdirSync(currentProject, { recursive: true });

    // Vanished owner, but its launch went terminal only a minute ago — inside the DEFAULT
    // 15-min success window. If the zero-window override governed the vanished sweep this would
    // be removed; under the DEFAULT policy it must be RETAINED.
    const parent = join(base, "fresh-dead-parent");
    const leaf = join(parent, "fresh-dead-clone");
    mkdirSync(leaf, { recursive: true });
    seedObservation("la-vanished-fresh", leaf);
    makeTerminalLaunchFile("la-vanished-fresh", FRESH);
    rmSync(leaf, { recursive: true, force: true });

    const result = performAutomaticCleanup({
      projectDir: currentProject,
      now: new Date(T0),
      tmux: deadTmux,
      policy: ZERO_WINDOW,
      vanishedOwnerDeps: goneEverywhere,
      cwdGuard: noHolder,
      listContainers: () => [],
      reap: () => "killed",
    });

    assert.ok(!("error" in result.launches), `launch sweep errored: ${JSON.stringify(result.launches)}`);
    const l = result.launches as { removed: string[]; retained: string[] };
    assert.ok(!l.removed.includes("la-vanished-fresh"), "a vanished launch inside the DEFAULT window must NOT be removed by a zero-window override");
    assert.ok(l.retained.includes("la-vanished-fresh"), "it is retained by the DEFAULT-policy vanished sweep");
    assert.ok(existsSync(join(LAUNCHES_DIR, "la-vanished-fresh")), "its on-disk record must remain");
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-786 AC3: store-less host — no store is opened or minted, cleanup runs and sweeps nothing on ownership grounds", () => {
  closeDb();
  assert.equal(storeExists(), false);
  base = mkdtempSync(join(tmpdir(), "fg786-vanished-retention-"));
  resetLaunches();
  // A terminal launch with NO observation row — host-global/unowned; the primary sweep may
  // retire it under the resolved policy, but no store is ever consulted for vanished/foreign.
  makeTerminalLaunchFile("la-nostore", LONG_AGO);

  const result = performAutomaticCleanup({
    projectDir: join(base, "current-project"),
    now: new Date(T0),
    tmux: deadTmux,
    policy: ZERO_WINDOW,
    vanishedOwnerDeps: goneEverywhere,
    cwdGuard: noHolder,
    listContainers: () => [],
    reap: () => "killed",
  });

  assert.ok(!("error" in result.launches), `launch sweep errored: ${JSON.stringify(result.launches)}`);
  assert.equal(storeExists(), false, "answering vanished/foreign ownership must not mint a store");
});

test("FG-786 RF-1: `--all` (host-global) uses the CODE-DEFAULT retention windows — a FORGE_RETENTION_SUCCESS_MS=0 env cannot make it a host-wide zero-window sweep", () => {
  const prev = setDbForTest(makeInMemoryDb());
  const priorEnv = process.env.FORGE_RETENTION_SUCCESS_MS;
  process.env.FORGE_RETENTION_SUCCESS_MS = "0"; // the RF-1 threat: a zero success window via env
  try {
    base = mkdtempSync(join(tmpdir(), "fg786-vanished-retention-"));
    resetLaunches();

    // A launch owned by SOME OTHER project (present on disk — a LIVE project), terminal only a
    // minute ago — INSIDE the DEFAULT 15-min success window. If the FORGE_RETENTION_SUCCESS_MS=0
    // env reached the host-global sweep, its window would be zero and this would be retired
    // instantly (an RF-5 cross-project purge). Under the code defaults it must be RETAINED.
    const otherProject = join(base, "other-project");
    mkdirSync(otherProject, { recursive: true });
    seedObservation("la-other-fresh", otherProject);
    makeTerminalLaunchFile("la-other-fresh", FRESH);

    // A second other-project launch PAST the default window — proves the sweep still RUNS
    // (a real convergence pass, not a dead no-op that "retains" everything by doing nothing).
    seedObservation("la-other-old", otherProject);
    makeTerminalLaunchFile("la-other-old", LONG_AGO);

    const result = performAutomaticCleanup({
      projectDir: join(base, "current-project"),
      now: new Date(T0),
      tmux: deadTmux,
      allProjects: true, // host-global — the RF-1 surface
      // NO `policy` injected: exercise the REAL resolution path (RF-1 is about that path).
      cwdGuard: noHolder,
      listContainers: () => [],
      reap: () => "killed",
    });

    assert.ok(!("error" in result.launches), `launch sweep errored: ${JSON.stringify(result.launches)}`);
    const l = result.launches as { removed: string[]; retained: string[] };

    assert.ok(!l.removed.includes("la-other-fresh"), "a launch inside the DEFAULT window must NOT be retired by a FORGE_RETENTION_SUCCESS_MS=0 env under --all");
    assert.ok(l.retained.includes("la-other-fresh"), "it is retained by the code-default host-global sweep");
    assert.ok(existsSync(join(LAUNCHES_DIR, "la-other-fresh")), "its on-disk record must remain");

    // Sanity: the host-global sweep still converges an aged launch (code defaults, not a dead sweep).
    assert.ok(l.removed.includes("la-other-old"), "an aged launch past the DEFAULT window still converges under --all");

    // RF-1 surface: the report records that code defaults governed the host-global pass.
    assert.match(result.report.retentionNote ?? "", /CODE-DEFAULT/);
  } finally {
    if (priorEnv === undefined) delete process.env.FORGE_RETENTION_SUCCESS_MS;
    else process.env.FORGE_RETENTION_SUCCESS_MS = priorEnv;
    if (prev) setDbForTest(prev);
  }
});

test("FG-786 AC3: `forge ops cleanup --all` is registered as the host-global convergence surface", () => {
  const program = new Command();
  registerOps(program);
  const ops = program.commands.find((c) => c.name() === "ops");
  assert.ok(ops, "ops command exists");
  const cleanup = ops!.commands.find((c) => c.name() === "cleanup");
  assert.ok(cleanup, "`forge ops cleanup` is registered");
  const all = cleanup!.options.find((o) => o.long === "--all");
  assert.ok(all, "`forge ops cleanup --all` host-global surface is registered");
});
