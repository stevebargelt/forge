// FG-591 (step 16) — THE REQUIRED FALSIFICATION.
//
// The ticket exists because of a recorded live reproduction: the interactive
// orchestrator went away, the first ticket finished, and the second one never started,
// because nothing was left running to notice. Every other suite in this slice proves a
// PROPERTY of the machinery. This one tries to reproduce the FAILURE against the
// shipped system, through the production entry point, and fails to.
//
// So the shape here is deliberately not a unit test's:
//
//   * The dispatcher is a REAL OS PROCESS started the way the CLI's own help text says
//     to start it — `forge launch run -- … forge queue dispatcher run …`, the tmux
//     ownership transfer — by a REAL orchestrator process that is then SIGKILLed with
//     its whole process GROUP. A dispatcher that was a child of that group dies with
//     it; the reproduction is exactly that difference, and it is not observable
//     in-process.
//   * The work a claim launches is a REAL `forge new <workflow> "<title>" --ticket <id>
//     --project <dir>` — the ordinary single-ticket run path, spawned by the production
//     launcher, creating a real run row in the shared store. The workflow is a
//     disposable project-local one whose single step is MANUAL, so a run is genuinely
//     created and nothing spawns a container: the falsification is about the
//     DISPATCHER, and it must not depend on Docker being reachable to mean anything.
//   * Nothing is mocked. The one seam used anywhere in this file is the wake
//     suppression in leg (b), which dispatcher-loop.ts declares for this falsification
//     by name; see the leg's own header for why the CLI cannot express it and what is
//     held identical to the CLI's composition.
//
// The three legs, in the ticket's words:
//   (a) with the orchestrator gone and NO operator message, the second ticket starts
//       through the ordinary single-ticket run path;
//   (b) with the primary wake signal suppressed, the watchdog recovers it EXACTLY once
//       — one launch, one durable recovery record, no second container;
//   (c) across a dispatcher-process restart the successor ADOPTS the lease and the
//       claim rather than starting a duplicate, and the durable evidence names it.
//
// WHAT COUNTS AS "NO OPERATOR MESSAGE" HERE, stated so the claim is checkable: every
// forge command this file runs goes through `forge()`, which appends to `issued`. Each
// leg snapshots `issued.length` at the moment the orchestrator dies and asserts it is
// UNCHANGED when the next ticket's container has started. The only store write the test
// itself makes in that window is completeRun() — the run reaching a terminal state,
// which is the agent's work finishing, not an operator acting.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityTestkitBinEnv } from "../backlog/container-authority.testkit-spawn.js";
import { closeDb, getDb } from "../store/db.js";
import { completeRun } from "../store/runs.js";
import { claimHistoryForTicket, liveClaims, type QueueClaim } from "../store/queue-claims.js";
import { latestEvaluation, listWakes, nextWatchdogDeadlineMs } from "../store/dispatcher-evidence.js";
import { getDispatcherLease } from "../store/dispatcher-policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const FORGE_BIN = join(REPO_ROOT, "bin", "forge");
const WORKER = join(here, "fg591-falsification-worker.ts");

// The tmux ownership transfer IS the mechanism under test in leg (a); without tmux
// there is nothing to prove, so the suite skips cleanly rather than passing vacuously.
const skipNoTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0 ? false : "tmux not available";

/** test-setup.ts's per-process temp home, put back after each case. */
const originalForgeHome = process.env["FORGE_HOME"];

/** The health bound, at its floor. Short enough that leg (b) finishes, long enough that
 *  the wake path is unambiguously what moved legs (a) and (c). */
const WATCHDOG_MS = 10_000;
const WAKE_POLL_MS = 300;

const READY_BODY = [
  "## Problem",
  "An operator queue that stops when the orchestrator does is not a queue.",
  "",
  "## Goal",
  "The next queued ticket starts on its own.",
  "",
  "## Acceptance Criteria",
  "- the second ticket starts with nobody watching",
  "- no ticket is ever launched twice",
].join("\n");

/** A disposable workflow whose only step is MANUAL: `forge new` creates the run row and
 *  nothing spawns. Project-local, so it resolves without a published seed generation. */
const HOLD_WORKFLOW = [
  "name: fg591-hold",
  "description: disposable single-step workflow for the FG-591 falsification; nothing spawns",
  "steps:",
  "  - id: hold",
  "    manual: true",
  "    gate: human",
  "",
].join("\n");

let root: string;
let home: string;
let project: string;
let barrier: string;
let projectKey: string;
/** Every forge command this file runs, in order. The "no operator message" evidence. */
let issued: string[][];
const spawned: ChildProcess[] = [];
/** What every process this file started actually did, recorded AS IT HAPPENS. A child
 *  that never execs leaves no log and no launch record, so nothing else can say so. */
let childOutcomes: string[];

type ForgeResult = { status: number | null; stdout: string; stderr: string };

/** The LIVE control entry — the same file the machine-wide `forge` on PATH resolves to
 *  — with this test's throwaway home and the host-authority seam armed (these cases run
 *  inside an agent container, where the dispatcher verbs correctly refuse). */
function forge(args: string[], extraEnv: Record<string, string> = {}): ForgeResult {
  issued.push(args);
  const res = spawnSync(FORGE_BIN, args, {
    cwd: project,
    encoding: "utf8",
    timeout: 120_000,
    env: childEnv(extraEnv),
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** THE ONE environment every process this file starts is built from. */
function childEnv(overlay: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORGE_HOME: home,
    FORGE_DB_PATH: join(home, "forge.db"),
    NO_NOTIFY: "true",
    // FG-614/FG-680: this file starts processes that start tmux sessions, and those
    // sessions must land on THIS test process's private socket — never the host-wide
    // default server, whose working directory a deleted fixture would brick. The spread
    // above already carries it; it is named here so the isolation is a stated part of
    // the contract rather than an accident of inheritance, and so the orchestrator can
    // forward it explicitly into the tmux-owned dispatcher (which the tmux server's own
    // environment would otherwise not supply).
    TMUX_TMPDIR: process.env["TMUX_TMPDIR"] ?? "",
    ...authorityTestkitBinEnv(),
    ...overlay,
  };
}

function git(args: string[]): void {
  const res = spawnSync("git", args, { cwd: project, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

function writeTicketFile(id: string, title: string): void {
  const dir = join(project, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-${title}.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\ncreated: '2026-01-01'\n---\n\n${READY_BODY}\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg591-falsification-"));
  home = join(root, "home");
  project = join(root, "project");
  barrier = join(root, "barrier");
  issued = [];
  childOutcomes = [];
  for (const d of [home, project, barrier]) mkdirSync(d, { recursive: true });

  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(project, ".forge", "workflows"), { recursive: true });
  writeFileSync(join(project, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  writeFileSync(join(project, ".forge", "workflows", "fg591-hold.yml"), HOLD_WORKFLOW);
  writeTicketFile("FG-1", "first");
  writeTicketFile("FG-2", "second");
  writeFileSync(join(project, "README.md"), "# fixture\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);

  // This process reads the SAME store the spawned processes write.
  process.env["FORGE_HOME"] = home;
  process.env["FORGE_DB_PATH"] = join(home, "forge.db");
  closeDb();

  assert.equal(forge(["backlog", "migrate"]).status, 0, "the fixture must cut over to the db store");
  closeDb();
  projectKey = readProjectKey();
  for (const id of ["FG-1", "FG-2"]) {
    const res = forge(["queue", "enqueue", id, "--json"]);
    assert.equal(res.status, 0, `enqueue ${id} failed: ${res.stderr}`);
  }
  const armed = forge([
    "queue",
    "dispatcher",
    "arm",
    "--max-active-runs",
    "1",
    "--workflow",
    "fg591-hold",
    "--json",
  ]);
  assert.equal(armed.status, 0, `arm failed: ${armed.stderr}`);
  closeDb();
});

afterEach(() => {
  for (const child of spawned.splice(0)) killGroup(child.pid ?? null);
  // Every tmux-owned dispatcher this test started, removed through the production verb.
  const launchesDir = join(home, "launches");
  if (existsSync(launchesDir)) {
    for (const id of readdirSync(launchesDir)) spawnSync(FORGE_BIN, ["launch", "rm", id, "--force"], { env: childEnv() });
  }
  closeDb();
  delete process.env["FORGE_DB_PATH"];
  // Restored rather than deleted: an absent FORGE_HOME resolves to the OPERATOR's
  // ~/.forge, which no test may reach (test-setup.ts owns the temp one).
  if (originalForgeHome !== undefined) process.env["FORGE_HOME"] = originalForgeHome;
  rmSync(root, { recursive: true, force: true });
});

function readProjectKey(): string {
  const yml = readFileSync(join(project, ".forge", "config.yml"), "utf8");
  const m = yml.match(/^project_key:\s*(\S+)\s*$/m);
  assert.ok(m, `expected a committed project_key in .forge/config.yml, got:\n${yml}`);
  return (m as RegExpMatchArray)[1] as string;
}

// ─── process control ─────────────────────────────────────────────────────────

/** SIGKILL a process GROUP — the whole point of `detached: true` above. An interactive
 *  harness tearing down its turn does not politely SIGTERM one pid; it takes the group,
 *  which is what made the original reproduction look like forge losing work. */
function killGroup(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Register a child so its fate is EVIDENCE rather than a guess. "Nothing appeared" is
 *  not a diagnosis; "the child never execed" and "the child exited 1" are, and only the
 *  spawning process can observe the difference. */
function track(label: string, child: ChildProcess): ChildProcess {
  child.on("error", (e) => childOutcomes.push(`${label} pid=${child.pid ?? "?"} NEVER STARTED: ${e.message}`));
  child.on("exit", (code, signal) =>
    childOutcomes.push(`${label} pid=${child.pid ?? "?"} exited code=${String(code)} signal=${String(signal)}`),
  );
  spawned.push(child);
  return child;
}

function spawnWorker(mode: string, env: Record<string, string>, logName: string): ChildProcess {
  const fd = openSync(join(root, logName), "a");
  const child = spawn(process.execPath, ["--import", join(REPO_ROOT, "bin", "forge-loader.mjs"), WORKER], {
    cwd: project,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: childEnv({
      MODE: mode,
      REPO_ROOT,
      PROJECT_DIR: project,
      PROJECT_KEY: projectKey,
      BARRIER_DIR: barrier,
      WATCHDOG_MS: String(WATCHDOG_MS),
      WAKE_POLL_MS: String(WAKE_POLL_MS),
      ...env,
    }),
  });
  return track(`${logName} (MODE=${mode})`, child);
}

/** The dispatcher exactly as an operator starts it: the production CLI, in its own
 *  process group so the test can kill it the way a harness would. */
function spawnDispatcherCli(dispatcherId: string, logName: string): ChildProcess {
  const fd = openSync(join(root, logName), "a");
  const child = spawn(
    FORGE_BIN,
    [
      "queue",
      "dispatcher",
      "run",
      "--project",
      project,
      "--checkout",
      project,
      "--dispatcher-id",
      dispatcherId,
      "--watchdog-interval",
      String(WATCHDOG_MS),
      "--wake-poll",
      String(WAKE_POLL_MS),
      "--max-ticks",
      "400",
    ],
    { cwd: project, detached: true, stdio: ["ignore", fd, fd], env: childEnv() },
  );
  return track(`${logName} (queue dispatcher run --dispatcher-id ${dispatcherId})`, child);
}

// ─── durable reads (this process never writes except the terminal transition) ─

/**
 * EVERY process this file caused to exist, in its own words.
 *
 * A poll() that times out can only report that nothing appeared. WHY nothing appeared
 * is entirely in the children — and the ones that matter most here are the ones this
 * process did not spawn and cannot wait on: the tmux-owned `forge queue dispatcher run`
 * and the `forge new` it launches. Their stdout, stderr, exit record and forge's own
 * launch diagnosis are on disk under the test's home the whole time; discarding them is
 * what made this leg fail three times without being understood.
 */
function logs(): string {
  const own = readdirSync(root)
    .filter((f) => f.endsWith(".log") || f.endsWith(".json"))
    .map((f) => `── ${f} ──\n${readFileSync(join(root, f), "utf8")}`);
  return [...own, childProcessEvidence(), launchEvidence()].join("\n");
}

function childProcessEvidence(): string {
  const alive = spawned
    .filter((c) => c.exitCode === null && c.signalCode === null)
    .map((c) => `pid=${String(c.pid)} still running`);
  return ["── spawned processes ──", ...childOutcomes, ...alive].join("\n");
}

function launchEvidence(): string {
  const dir = join(home, "launches");
  if (!existsSync(dir)) return "── launches ──\nno launches directory: nothing was ever submitted to tmux";
  const ids = readdirSync(dir);
  if (ids.length === 0) return "── launches ──\nthe launches directory is empty: nothing was ever submitted to tmux";
  return ids.map(launchEvidenceFor).join("\n");
}

/** Every file forge's launcher wrote for one launch — meta.json's argv/cwd/owner, the
 *  `exit` record, forge's own cwd-guard diagnosis, and out.log (the child's combined
 *  stdout+stderr). Dumped whole rather than classified: readLaunch() resolves its
 *  directory from a FORGE_HOME captured at import time, which is test-setup.ts's home,
 *  not this case's — and re-implementing its status vocabulary here would only drift. */
function launchEvidenceFor(id: string): string {
  const dir = join(home, "launches", id);
  const out: string[] = [`── launch ${id} ──`];
  let session: string | null = null;
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      command: string[];
      cwd: string;
      ownerPid: number | null;
      tmuxSession: string;
      tmuxServerCwd?: unknown;
    };
    session = meta.tmuxSession;
    out.push(
      `command: ${meta.command.join(" ")}`,
      `cwd: ${meta.cwd}`,
      `ownerPid: ${
        meta.ownerPid === null
          ? "NONE RECORDED — tmux never reported an owner, so the command may never have started"
          : `${meta.ownerPid} (${isAlive(meta.ownerPid) ? "alive" : "gone"})`
      }`,
      `tmuxServerCwd: ${JSON.stringify(meta.tmuxServerCwd ?? null)}`,
    );
  } catch (e) {
    out.push(`meta.json unreadable: ${(e as Error).message}`);
  }
  if (session !== null) {
    const has = spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf8", env: childEnv() });
    out.push(`tmux session: ${has.status === 0 ? "live" : `absent (${(has.stderr || "").trim() || "no error text"})`}`);
  }
  for (const file of readdirSync(dir).filter((f) => f !== "meta.json")) {
    let body: string;
    try {
      body = readFileSync(join(dir, file), "utf8").trimEnd();
    } catch (e) {
      body = `unreadable: ${(e as Error).message}`;
    }
    out.push(`  ── ${id}/${file} ──`, body.length === 0 ? "  (empty)" : body);
  }
  return out.join("\n");
}

async function poll<T>(label: string, fn: () => T | null | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A fresh handle per look: two other processes are writing this file.
    closeDb();
    const value = fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n\n${logs()}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function liveClaimFor(ticketId: string): QueueClaim | null {
  return liveClaims(projectKey).find((c) => c.ticketId === ticketId) ?? null;
}

function launchedClaimFor(ticketId: string): QueueClaim | null {
  const claim = liveClaimFor(ticketId);
  return claim !== null && claim.launchId !== null ? claim : null;
}

type RunRow = { id: string; project_dir: string; status: string };

function runsForTicket(ticketId: string): RunRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_dir, status FROM runs
        WHERE json_extract(metadata, '$.ticketId') = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(ticketId) as RunRow[];
}

function launchesForTicket(ticketId: string): { launch_id: string; command: string }[] {
  return getDb()
    .prepare(`SELECT launch_id, command FROM launch_observations WHERE ticket_id = ? ORDER BY started_at ASC`)
    .all(ticketId) as { launch_id: string; command: string }[];
}

function launchMeta(launchId: string): { command: string[]; ownerPid: number | null; cwd: string } {
  return JSON.parse(readFileSync(join(home, "launches", launchId, "meta.json"), "utf8")) as {
    command: string[];
    ownerPid: number | null;
    cwd: string;
  };
}

/** THE ORDINARY SINGLE-TICKET RUN PATH, asserted as a shape rather than a substring:
 *  `forge new <workflow> "<title>" --ticket <id> --project <dir>`, and no campaign verb
 *  anywhere in the argv (FG-591's non-goal: a claimed item never implicitly becomes a
 *  campaign). */
function assertOrdinarySingleTicketLaunch(argv: string[], ticketId: string): void {
  const i = argv.indexOf("new");
  assert.ok(i > 0, `the launch argv must invoke \`forge new\`: ${argv.join(" ")}`);
  assert.deepEqual(
    argv.slice(i, i + 2),
    ["new", "fg591-hold"],
    `the run launches under the dispatcher policy's workflow: ${argv.join(" ")}`,
  );
  assert.deepEqual(
    argv.slice(i + 3),
    ["--ticket", ticketId, "--project", project],
    `the run is a single-ticket run for ${ticketId} in the operator's checkout: ${argv.join(" ")}`,
  );
  for (const token of argv) {
    assert.doesNotMatch(token, /campaign/i, `no campaign verb may appear in a queue launch: ${argv.join(" ")}`);
  }
}

/** One reservation, one container, ever — for a ticket the dispatcher has finished with
 *  as well as one it is running. This is the assertion the whole claim primitive exists
 *  to make true, and every leg re-checks it because every leg has its own way to break
 *  it (a lost orchestrator, a lost wake, a restarted process). */
function assertNeverLaunchedTwice(ticketId: string): void {
  assert.equal(
    claimHistoryForTicket(projectKey, ticketId).length,
    1,
    `${ticketId} must have been reserved exactly once, ever`,
  );
  assert.equal(launchesForTicket(ticketId).length, 1, `${ticketId} must have started exactly one container`);
  assert.equal(runsForTicket(ticketId).length, 1, `${ticketId} must have exactly one run`);
}

// ─── (a) the orchestrator is gone, and nobody says anything ──────────────────

test(
  "FG-591 falsification (a): the orchestrator is SIGKILLed, the first run goes terminal, and the second ticket starts anyway",
  { skip: skipNoTmux },
  async () => {
    // The interactive orchestrator: it starts the dispatcher under tmux ownership
    // through the production launcher and then just sits there, as a session does.
    const orchestrator = spawnWorker("orchestrate", { DISPATCHER_ID: "fg591-a" }, "orchestrator.log");
    const submitted = await poll(
      "the orchestrator to submit the dispatcher launch",
      () => {
        const path = join(barrier, "orchestrator.json");
        return existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as {
              ok: boolean;
              error?: string;
              pid: number;
              launchId: string;
              tmuxSession: string;
              command: string[];
            })
          : null;
      },
      60_000,
    );
    assert.ok(submitted.ok, `the orchestrator could not start the dispatcher: ${submitted.error ?? ""}`);
    assert.match(
      submitted.command.join(" "),
      /queue dispatcher run/,
      "the orchestrator starts the PRODUCTION dispatcher verb, not a test harness",
    );

    // The dispatcher does its ordinary first job while the orchestrator is still alive:
    // claim the top of the queue and start its container.
    const claim1 = await poll("FG-1 to be claimed and launched", () => launchedClaimFor("FG-1"));
    const run1 = await poll("FG-1's run row", () => runsForTicket("FG-1")[0] ?? null);
    assert.equal(run1.project_dir, project, "the run was created in the operator's checkout");
    assertOrdinarySingleTicketLaunch(launchMeta(claim1.launchId as string).command, "FG-1");

    // ── THE REPRODUCTION. Kill the orchestrator's whole process GROUP, exactly as an
    // interactive harness tearing down a turn does, and prove it is really gone.
    const orchestratorPid = orchestrator.pid as number;
    killGroup(orchestratorPid);
    await poll("the orchestrator to be gone", () => (isAlive(orchestratorPid) ? null : true), 10_000);

    // The dispatcher is NOT in that group: tmux owns it. Its pane process is alive.
    const dispatcherOwnerPid = launchMeta(submitted.launchId).ownerPid;
    assert.ok(dispatcherOwnerPid !== null, "the launch recorded its tmux-owned owner pid");
    assert.ok(
      isAlive(dispatcherOwnerPid as number),
      "the dispatcher must survive the orchestrator's process-group kill — that survival IS the ticket",
    );

    // From here to the end of this leg, NOT ONE forge command is issued.
    const operatorMessages = issued.length;

    // The work finishes. This is the agent's run reaching a terminal state through the
    // production transition — not an operator act, and the only write this process makes.
    closeDb();
    completeRun(run1.id);

    // ── THE FALSIFICATION FAILS TO REPRODUCE: the second ticket starts on its own.
    const claim2 = await poll("FG-2 to be claimed and launched with nobody watching", () => launchedClaimFor("FG-2"));
    const run2 = await poll("FG-2's run row", () => runsForTicket("FG-2")[0] ?? null);

    assert.equal(
      issued.length,
      operatorMessages,
      `no operator message may have been sent after the orchestrator died; these were: ${JSON.stringify(
        issued.slice(operatorMessages),
      )}`,
    );
    assertOrdinarySingleTicketLaunch(launchMeta(claim2.launchId as string).command, "FG-2");
    assert.equal(run2.project_dir, project, "the second run is an ordinary run in the same checkout");
    assert.equal(
      claim2.owner,
      `dispatcher@${projectKey}@fg591-a`,
      "and it was the SURVIVING tmux-owned dispatcher that reserved it — the same identity, outliving its submitter",
    );

    // The first reservation was retired, once, with an outcome describing the
    // RESERVATION — and its ticket was never launched a second time.
    const history1 = claimHistoryForTicket(projectKey, "FG-1");
    assert.equal(history1.length, 1, "FG-1 was reserved exactly once");
    assert.equal((history1[0] as QueueClaim).state, "released");
    assert.equal((history1[0] as QueueClaim).outcome, "completed");
    assertNeverLaunchedTwice("FG-1");
    assertNeverLaunchedTwice("FG-2");
  },
);

// ─── (b) the primary wake is suppressed; only the watchdog is left ───────────

test(
  "FG-591 falsification (b): with the primary wake suppressed, the watchdog recovers the slot EXACTLY once",
  { skip: skipNoTmux },
  async () => {
    // The dispatcher process for this leg composes runDispatcherLoop exactly as the CLI
    // does, with ONE difference: observeWakes returns nothing, so a run-terminal
    // transition never becomes a durable wake and the health bound is the only mechanism
    // left. See the worker's own header for why this cannot be a CLI flag.
    spawnWorker("wake-suppressed", { DISPATCHER_ID: "fg591-b" }, "dispatcher-b.log");
    const identity = await poll(
      "the suppressed dispatcher to report its identity",
      () => {
        const path = join(barrier, "dispatcher.json");
        return existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as { ok: boolean; owner: string; forgeBin: string[]; error?: string })
          : null;
      },
      60_000,
    );
    assert.ok(identity.ok, `the suppressed dispatcher refused to start: ${identity.error ?? ""}`);
    assert.equal(
      identity.owner,
      `dispatcher@${projectKey}@fg591-b`,
      "the owner comes from the production resolveDispatcherOwner, not from a test string",
    );

    const claim1 = await poll("FG-1 to be claimed and launched", () => launchedClaimFor("FG-1"));
    const run1 = await poll("FG-1's run row", () => runsForTicket("FG-1")[0] ?? null);
    const launch1 = launchMeta(claim1.launchId as string);
    assertOrdinarySingleTicketLaunch(launch1.command, "FG-1");
    // The composition really is the CLI's: the argv this dispatcher launched through is
    // the argv `bin/forge` execs, which is what the CLI's forgeSelfArgv() hands the
    // dispatcher. A leg whose launcher differed from the CLI's would prove nothing about
    // the CLI.
    assert.deepEqual(
      launch1.command.slice(launch1.command.indexOf(identity.forgeBin[0] as string), launch1.command.indexOf("new")),
      identity.forgeBin,
      "the suppressed dispatcher launches through the same forge binary argv the CLI does",
    );

    const operatorMessages = issued.length;
    closeDb();
    // THE DEADLINE THE LOOP IS ACTUALLY WAITING ON, read from the durable record the
    // last pass wrote. The watchdog is armed PER TICK — `nextWatchdogAtMs = <that
    // tick> + interval` — NOT from the run's terminal transition, and the refill
    // follow-up that runs right after a launch is the tick that arms this one. So a
    // full interval has already been burning for however long the launch, the run row
    // and these assertions took, and "one interval after completeRun()" is a deadline
    // this leg never had. Measuring the wait from that wrong origin is what made this
    // case pass on a fast host and fail on a loaded CI runner with the same, correct,
    // watchdog-driven recovery underneath.
    const watchdogDueAtMs = nextWatchdogDeadlineMs(projectKey);
    assert.equal(typeof watchdogDueAtMs, "number", "the last pass armed a watchdog deadline to wait for");
    completeRun(run1.id);

    // The slot is recovered, and the next ticket starts — with no wake to announce it.
    const claim2 = await poll("FG-2 to be claimed after a watchdog recovery", () => launchedClaimFor("FG-2"), 90_000);
    assert.equal(issued.length, operatorMessages, "no operator message was sent");

    const wakes = listWakes(projectKey);
    assert.deepEqual(
      wakes.filter((w) => w.kind === "run_terminal").map((w) => w.wakeKey),
      [],
      "the suppression must really have suppressed the primary path: no run_terminal wake may exist",
    );

    // EXACTLY ONCE: one durable lost-signal record for that reservation, one container.
    const recoveries = wakes.filter((w) => w.kind === "recovery");
    assert.equal(recoveries.length, 1, `exactly one durable recovery record: ${JSON.stringify(recoveries)}`);
    assert.equal((recoveries[0] as { wakeKey: string }).wakeKey, `lost-signal:${claim1.id}`);
    assert.match(
      (recoveries[0] as { detail: string | null }).detail ?? "",
      /watchdog look found FG-1's reservation terminal with no delivered wake/,
      "the record names WHAT was lost and WHICH look recovered it",
    );

    // It really was the health bound, not a signal. Both halves are read off the store
    // clock the loop itself paces by, so no process clock and no tolerance enters:
    // recovery landed at or after the deadline the loop was waiting on, which no wake
    // and no refill could have anticipated.
    const recoveredAtMs = Date.parse((recoveries[0] as { createdAt: string }).createdAt);
    assert.ok(
      recoveredAtMs >= (watchdogDueAtMs as number),
      `recovery must have waited for the armed watchdog deadline (${String(watchdogDueAtMs)}), ` +
        `landed at ${recoveredAtMs} — ${(watchdogDueAtMs as number) - recoveredAtMs}ms early, so a wake got through`,
    );

    await poll("FG-2's run row", () => runsForTicket("FG-2")[0] ?? null);
    assertOrdinarySingleTicketLaunch(launchMeta(claim2.launchId as string).command, "FG-2");
    assertNeverLaunchedTwice("FG-1");
    assertNeverLaunchedTwice("FG-2");
  },
);

// ─── (c) the dispatcher process restarts ─────────────────────────────────────

test(
  "FG-591 falsification (c): a restarted dispatcher ADOPTS the lease and the live claim instead of duplicating them",
  { skip: skipNoTmux },
  async () => {
    const first = spawnDispatcherCli("fg591-c", "dispatcher-c1.log");
    const claim1 = await poll("FG-1 to be claimed and launched", () => launchedClaimFor("FG-1"));
    const run1 = await poll("FG-1's run row", () => runsForTicket("FG-1")[0] ?? null);
    const leaseBefore = await poll("the dispatcher lease", () => getDispatcherLease(projectKey) ?? null);
    assert.equal(leaseBefore.owner, `dispatcher@${projectKey}@fg591-c`);
    assert.equal(leaseBefore.pid, first.pid, "the lease records the process that holds it");

    // The dispatcher process dies without releasing anything — a crash, a reboot, a
    // harness sweep. Its lease and its claim both stay LIVE, which is the whole reason
    // a successor must adopt rather than start over.
    const lastEvaluationBefore = (latestEvaluation(projectKey) as { id: number }).id;
    const firstPid = first.pid as number;
    killGroup(firstPid);
    await poll("the dispatcher process to be gone", () => (isAlive(firstPid) ? null : true), 10_000);

    // THE DIFFERENTIAL: a STRANGER cannot take the queue over. Waiting is not evidence
    // of abandonment, so a second identity is refused against the still-live lease and
    // claims nothing — which is what makes the adoption below a property of the stable
    // identity rather than of timing.
    const stranger = spawnSync(
      FORGE_BIN,
      ["queue", "dispatcher", "run", "--project", project, "--dispatcher-id", "fg591-c-stranger", "--once"],
      { cwd: project, encoding: "utf8", timeout: 60_000, env: childEnv() },
    );
    issued.push(["queue", "dispatcher", "run", "--dispatcher-id", "fg591-c-stranger", "--once"]);
    assert.notEqual(stranger.status, 0, `a stranger must fail closed: ${stranger.stdout}${stranger.stderr}`);
    assert.match(stranger.stderr, /is NOT the dispatcher|held by/, "and must say whose lease it is");
    closeDb();
    assert.equal(claimHistoryForTicket(projectKey, "FG-1").length, 1, "the stranger reserved nothing");
    assert.equal(liveClaimFor("FG-2"), null, "the stranger started nothing");

    // ── THE RESTART: the SAME instance identity, the production entry point again.
    const operatorMessages = issued.length;
    const second = spawnDispatcherCli("fg591-c", "dispatcher-c2.log");
    const leaseAfter = await poll(
      "the successor to adopt the lease",
      () => {
        const lease = getDispatcherLease(projectKey);
        return lease !== undefined && lease.pid === second.pid ? lease : null;
      },
      60_000,
    );

    // ADOPTED, not taken over: same owner, SAME generation (a takeover bumps it), new
    // process. That row is the durable evidence naming the adoption.
    assert.equal(leaseAfter.owner, leaseBefore.owner, "the successor is the same dispatcher identity");
    assert.equal(
      leaseAfter.generation,
      leaseBefore.generation,
      "the generation is UNCHANGED — the successor renewed its own lease rather than taking one over",
    );
    assert.notEqual(leaseAfter.pid, leaseBefore.pid, "and it is a genuinely different process");

    // THE DURABLE EVIDENCE NAMING THE ADOPTION: the successor's own evaluation row. It
    // decides under the SAME owner and the SAME fenced generation as its predecessor,
    // and it counts the predecessor's reservation as a slot IT holds — with the same
    // claim id and the same launch id. That is the record an operator reads to see that
    // one dispatcher identity continued across two processes rather than two dispatchers
    // having driven one queue.
    const successorPass = await poll(
      "the successor's first evaluation",
      () => {
        const latest = latestEvaluation(projectKey);
        return latest !== undefined && latest.id > lastEvaluationBefore ? latest : null;
      },
      60_000,
    );
    assert.equal(successorPass.dispatcherOwner, leaseBefore.owner, "the successor decides as the same identity");
    assert.equal(
      successorPass.dispatcherGeneration,
      leaseBefore.generation,
      "under the same fenced generation — nothing was superseded",
    );
    assert.deepEqual(
      (successorPass.capacityHolders ?? []).map((h) => ({ claimId: h.claimId, ticketId: h.ticketId, launchId: h.launchId })),
      [{ claimId: claim1.id, ticketId: "FG-1", launchId: claim1.launchId }],
      "and the slot it counts as used is the PREDECESSOR's reservation and launch, adopted whole",
    );

    // The live claim is the SAME reservation, still stamped with the SAME launch: the
    // successor adopted the running container rather than starting a second one.
    const adopted = liveClaimFor("FG-1") as QueueClaim;
    assert.equal(adopted.id, claim1.id, "the same reservation");
    assert.equal(adopted.launchId, claim1.launchId, "stamped with the same launch — no second container");
    assert.equal(adopted.generation, claim1.generation, "and never re-fenced");
    assert.equal(adopted.owner, claim1.owner, "still owned by the one dispatcher identity");
    assertNeverLaunchedTwice("FG-1");

    // Continuity, which is what adoption is FOR: the successor is really driving this
    // reservation, so the run's terminal transition retires it and the queue moves on —
    // still with no operator message.
    closeDb();
    completeRun(run1.id);
    const claim2 = await poll("FG-2 to be claimed by the successor", () => launchedClaimFor("FG-2"), 60_000);
    assert.equal(issued.length, operatorMessages, "the restart needed no operator message");
    assertOrdinarySingleTicketLaunch(launchMeta(claim2.launchId as string).command, "FG-2");
    await poll("FG-2's run row", () => runsForTicket("FG-2")[0] ?? null);
    const history1 = claimHistoryForTicket(projectKey, "FG-1");
    assert.equal((history1[0] as QueueClaim).outcome, "completed", "the adopted reservation was retired by its owner");
    assertNeverLaunchedTwice("FG-1");
    assertNeverLaunchedTwice("FG-2");
  },
);
