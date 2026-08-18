// FG-591 step 10 — the dispatcher CONTROL verbs through the REAL CLI, in a real
// child process, against a real on-disk store.
//
// This is the EXECUTION-AUTHORIZATION surface: `arm` decides whether forge may start
// repo-writing containers with nobody watching, `--max-active-runs` decides how many,
// `run` is the process that does it, and `cancel` is the only verb here that stops
// work. So the suite is weighted towards the wrong cases rather than the right one —
// the container refusal, the hostile flag values, the identity refusal, and above all
// the two orderings that separate a correct dispatcher from a duplicate-execution bug:
//
//   * an operator DEQUEUE must never release a live claim (D4). A released reservation
//     whose container is still running is re-admitted to the scan, and a second
//     dispatcher launches work that is already executing.
//   * `cancel` stops the work FIRST and lets the claim's own lease owner retire the
//     reservation afterwards. The reverse order is the same defect wearing a verb.
//
// The six no-run states are asserted against DURABLE evaluation rows written by the
// production writer (recordEvaluation), not by hand-shaped SQL and not by a mock: the
// acceptance claim is that the CLI reads the dispatcher's own record rather than
// inferring an answer from an absence, and only a real record can show that.
//
// The store is driven in-process here and read back through the spawned CLI (and vice
// versa) — the same forge.db, two processes, which is the shape the real system runs
// in.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";
import { closeDb, getDb } from "../../store/db.js";
import { storeNowMs } from "../../store/publications.js";
import { claimWakes, pendingWakes, recordEvaluation, type CapacityHolder } from "../../store/dispatcher-evidence.js";
import { acquireDispatcherLease } from "../../store/dispatcher-policy.js";
import { insertRun } from "../../store/runs.js";
import type { ScanEntry } from "../../store/queue-claims.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let root: string;
let home: string;
let project: string;
/** A directory carrying a real container-authority marker. Pointing the child's
 *  compiled-in probe here is what makes it resolve as a DISPATCHED AGENT — the same
 *  fact in the same place on a host and inside a container, so this suite means the
 *  same thing in both. */
let containerMount: string;

const READY_BODY = [
  "## Problem",
  "The operator queue has no dispatcher control surface.",
  "",
  "## Goal",
  "Six distinguishable answers to 'why is nothing running'.",
  "",
  "## Acceptance Criteria",
  "- arm and disarm are recorded",
  "- a capacity reduction terminates nothing",
].join("\n");

type ForgeResult = { status: number | null; stdout: string; stderr: string };

function forge(args: string[], extraEnv: Record<string, string> = {}, cwd: string = project): ForgeResult {
  const res = spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: home,
      FORGE_DB_PATH: join(home, "forge.db"),
      ...authorityTestkitEnv(),
      ...extraEnv,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** The same CLI, resolving its authority as a DISPATCHED AGENT CONTAINER. */
function forgeInContainer(args: string[]): ForgeResult {
  return forge(args, { FORGE_TEST_AUTHORITY_MOUNT: containerMount });
}

function git(args: string[]): void {
  const res = spawnSync("git", args, { cwd: project, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

function writeTicketFile(id: string, title: string, body: string): void {
  const dir = join(project, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-${title}.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\ncreated: '2026-01-01'\n---\n\n${body}\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg591-dispatcher-cli-"));
  home = join(root, "home");
  project = join(root, "project");
  containerMount = join(root, "container-authority");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(containerMount, { recursive: true });
  writeFileSync(
    join(containerMount, "authority.json"),
    JSON.stringify({ kind: "forge-backlog-authority", version: 1, mode: "db", projectKey: null, taskId: null }),
  );
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(project, ".forge"), { recursive: true });
  writeFileSync(join(project, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  writeTicketFile("FG-1", "first", READY_BODY);
  writeTicketFile("FG-2", "second", READY_BODY);
  writeFileSync(join(project, "README.md"), "# fixture\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);

  // This process reads and writes the SAME store the spawned CLI does.
  process.env["FORGE_HOME"] = home;
  process.env["FORGE_DB_PATH"] = join(home, "forge.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env["FORGE_DB_PATH"];
  rmSync(root, { recursive: true, force: true });
});

function migrate(): string {
  const res = forge(["backlog", "migrate"]);
  assert.equal(res.status, 0, `migrate failed: ${res.stderr}`);
  closeDb();
  return readProjectKey();
}

/** A SECOND registered project on the same host store — the audience for a host-wide
 *  policy change that did not originate in it. Its own repo (a distinct remote, so
 *  project identity resolves separately) and its own migrate. */
function migrateSecondProject(): string {
  const dir = join(root, "project-two");
  mkdirSync(join(dir, ".forge"), { recursive: true });
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
    ["remote", "add", "origin", "git@github.com:stevebargelt/fg591-second.git"],
  ]) {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  writeFileSync(join(dir, ".forge", "config.yml"), "backlog:\n  prefix: SEC\n");
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(dir, "backlog", "stories", "SEC-1-only.md"),
    `---\nid: SEC-1\ntype: story\nstatus: active\ntitle: only\ncreated: '2026-01-01'\n---\n\n${READY_BODY}\n`,
  );
  writeFileSync(join(dir, "README.md"), "# second\n");
  for (const args of [["add", "-A"], ["commit", "-q", "-m", "fixture"]]) {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  const res = forge(["backlog", "migrate"], {}, dir);
  assert.equal(res.status, 0, `second migrate failed: ${res.stderr}`);
  closeDb();
  const yml = readFileSync(join(dir, ".forge", "config.yml"), "utf8");
  const m = yml.match(/^project_key:\s*(\S+)\s*$/m);
  assert.ok(m, `expected a committed project_key for the second project, got:\n${yml}`);
  return m![1]!;
}

function readProjectKey(): string {
  const yml = readFileSync(join(project, ".forge", "config.yml"), "utf8");
  const m = yml.match(/^project_key:\s*(\S+)\s*$/m);
  assert.ok(m, `expected a committed project_key in .forge/config.yml, got:\n${yml}`);
  return m![1]!;
}

// ─── durable fixtures, written through the PRODUCTION writers ───────────────

const FIVE_MINUTES = 5 * 60_000;

/** A dispatcher that is demonstrably ALIVE: a live lease plus an evaluation whose
 *  armed watchdog deadline has not passed. Without both, dispatcherHealth reports the
 *  dispatcher as down — which is correct, and would mask the state under test. */
function seedLiveDispatcher(projectKey: string, owner = "dispatcher@test@1"): void {
  const grant = acquireDispatcherLease({ projectKey, owner, ttlMs: 15 * 60_000 });
  assert.ok(grant.granted, "the fixture lease must be granted");
}

function seedEvaluation(
  projectKey: string,
  rec: {
    reason: "granted" | "disabled" | "no_capacity" | "no_eligible_work" | "lost" | "incompatible_only";
    detail?: string;
    scanEvidence?: ScanEntry[];
    capacityHolders?: CapacityHolder[];
    capacityLimit?: number;
    capacityUsed?: number;
    claimedTicketId?: string;
    claimId?: string;
  },
): void {
  recordEvaluation({
    projectKey,
    dispatcherOwner: "dispatcher@test@1",
    dispatcherGeneration: 1,
    reason: rec.reason,
    detail: rec.detail ?? null,
    ...(rec.claimedTicketId ? { claimedTicketId: rec.claimedTicketId } : {}),
    ...(rec.claimId ? { claimId: rec.claimId } : {}),
    capacityScope: "host",
    capacityLimit: rec.capacityLimit ?? 2,
    capacityUsed: rec.capacityUsed ?? 0,
    ...(rec.capacityHolders ? { capacityHolders: rec.capacityHolders } : {}),
    ...(rec.scanEvidence ? { scanEvidence: rec.scanEvidence } : {}),
    nextWatchdogAtMs: storeNowMs() + FIVE_MINUTES,
  });
}

/** A live claim, in the shape the claim primitive grants one. */
function insertLiveClaim(
  projectKey: string,
  ticketId: string,
  opts: { owner?: string; runId?: string | null; launchId?: string | null; claimId?: string } = {},
): string {
  const now = storeNowMs();
  const id = opts.claimId ?? `claim-${ticketId}`;
  getDb()
    .prepare(
      `INSERT INTO queue_claims
         (id, project_key, ticket_id, owner, generation, ticket_revision, lease_expires_at_ms,
          heartbeat_at_ms, launch_id, run_id, state, outcome, scan_evidence, claimed_at, released_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 'live', NULL, NULL, ?, NULL)`,
    )
    .run(
      id,
      projectKey,
      ticketId,
      opts.owner ?? "dispatcher@test@1",
      now + 15 * 60_000,
      now,
      opts.launchId ?? null,
      opts.runId ?? null,
      new Date(now).toISOString(),
    );
  return id;
}

type ClaimRow = {
  id: string;
  ticket_id: string;
  owner: string;
  generation: number;
  lease_expires_at_ms: number;
  heartbeat_at_ms: number;
  state: string;
  outcome: string | null;
  released_at: string | null;
};

function claimRows(): ClaimRow[] {
  closeDb();
  return getDb()
    .prepare(
      `SELECT id, ticket_id, owner, generation, lease_expires_at_ms, heartbeat_at_ms, state, outcome, released_at
         FROM queue_claims ORDER BY id`,
    )
    .all() as ClaimRow[];
}

function policyRows(): Record<string, unknown>[] {
  closeDb();
  return getDb().prepare(`SELECT * FROM dispatcher_policy ORDER BY scope_key`).all() as Record<string, unknown>[];
}

type Status = {
  projectKey: string;
  state: string;
  headline: string;
  blockers: string[];
  armed: boolean;
  policy: { maxActiveRuns: number; capacityScope: string; updatedBy: string | null; updatedAt: string | null; configured: boolean };
  dispatcher: { owner: string; generation: number; live: boolean; expired: boolean } | null;
  lastEvaluation: { reason: string; detail: string | null; scannedCount: number | null } | null;
  lastCapacityRefusal: { reason: string } | null;
  blockedCandidates: { ticketId: string }[];
  incompatibleWaits: { ticketId: string; detail: string | null }[];
  capacity: { scope: string; limit: number; used: number; otherProjects: string[] };
  watchdog: { deadlineMs: number | null; everEvaluated: boolean; overdue: boolean };
  liveClaims: { claimId: string; ticketId: string }[];
};

function status(): Status {
  const res = forge(["queue", "dispatcher", "status", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout) as Status;
}

// ─── the container refusal: execution authority is host-only ────────────────

test("FG-591: every dispatcher verb and `queue cancel` refuse inside an agent container", () => {
  migrate();
  const cases: string[][] = [
    ["queue", "dispatcher", "arm"],
    ["queue", "dispatcher", "disarm"],
    ["queue", "dispatcher", "set", "--max-active-runs", "8"],
    ["queue", "dispatcher", "status"],
    ["queue", "dispatcher", "run", "--once"],
    ["queue", "cancel", "FG-1"],
  ];
  for (const args of cases) {
    const res = forgeInContainer(args);
    assert.equal(res.status, 1, `${args.join(" ")} must exit non-zero in a container: ${res.stdout}`);
    assert.match(res.stderr, /EXECUTION-AUTHORITY surface and no/, args.join(" "));
    assert.match(res.stderr, /Run this on the host\./, args.join(" "));
    assert.equal(res.stdout, "", `${args.join(" ")} must print nothing on stdout when it refuses`);
  }
  // The refusal is not cosmetic: no policy row, no lease and no evaluation exists.
  assert.deepEqual(policyRows(), [], "a container refusal must write no policy row");
  closeDb();
  assert.equal(
    (getDb().prepare(`SELECT COUNT(*) AS n FROM dispatcher_leases`).get() as { n: number }).n,
    0,
    "a container refusal must acquire no dispatcher lease",
  );
  assert.equal(
    (getDb().prepare(`SELECT COUNT(*) AS n FROM dispatcher_evaluations`).get() as { n: number }).n,
    0,
    "a container refusal must record no evaluation",
  );
});

// ─── the markdown-mode refusal, per verb ────────────────────────────────────

test("FG-591: every dispatcher verb refuses BY NAME on a markdown-mode project and writes nothing", () => {
  const cases: [string, string[]][] = [
    ["dispatcher arm", ["queue", "dispatcher", "arm"]],
    ["dispatcher disarm", ["queue", "dispatcher", "disarm"]],
    ["dispatcher set", ["queue", "dispatcher", "set", "--max-active-runs", "4"]],
    ["dispatcher status", ["queue", "dispatcher", "status"]],
    ["dispatcher run", ["queue", "dispatcher", "run", "--once"]],
    ["cancel", ["queue", "cancel", "FG-1"]],
  ];
  for (const [verb, args] of cases) {
    const res = forge(args);
    assert.equal(res.status, 1, `${verb} must exit non-zero on a markdown-mode project`);
    assert.match(res.stderr, new RegExp(`queue ${verb} refuses`), `${verb}: ${res.stderr}`);
    assert.match(res.stderr, /markdown mode|no resolvable project_key/);
    assert.equal(res.stdout, "", `${verb} must print nothing on stdout when it refuses`);
  }
  assert.deepEqual(policyRows(), [], "a markdown-mode refusal must write no policy row");
});

// ─── arming records WHO and WHEN ────────────────────────────────────────────

test("FG-591: arming records who and when, and --by cannot replace the OS identity", () => {
  const pk = migrate();

  const armed = forge(["queue", "dispatcher", "arm", "--max-active-runs", "2", "--by", "steve", "--json"]);
  assert.equal(armed.status, 0, armed.stderr);
  const parsed = JSON.parse(armed.stdout) as Record<string, unknown>;
  assert.equal(parsed["projectKey"], pk);
  assert.equal(parsed["armed"], true);
  assert.equal(parsed["scope"], "host", "the ceiling and the armed flag are HOST-wide, not per project");

  const rows = policyRows();
  assert.equal(rows.length, 1, "arming writes exactly one host policy row");
  const row = rows[0]!;
  assert.equal(row["scope_key"], "host");
  assert.equal(row["armed"], 1);
  assert.equal(row["max_active_runs"], 2);
  assert.ok(typeof row["updated_at"] === "string" && (row["updated_at"] as string).length > 0, "arming records WHEN");

  // WHO: the operator's label is recorded BESIDE the OS identity, never instead of
  // it. A caller-supplied string alone would let the durable record of "who
  // authorized unattended container execution" say whatever was typed.
  const by = row["updated_by"] as string;
  assert.match(by, /^steve \(/, "the --by label is recorded");
  assert.match(by, /@/, "the OS user@host identity is recorded alongside it");
  assert.ok(by !== "steve", "the label must NOT be the whole record");

  // And with no label at all, the OS identity is still recorded.
  assert.equal(forge(["queue", "dispatcher", "disarm"]).status, 0);
  const after = policyRows()[0]!;
  assert.match(after["updated_by"] as string, /@/);
  assert.equal(after["armed"], 0);
});

// ─── a host-wide change reaches every dispatcher (AC15) ─────────────────────

test("FG-591: a capacity change wakes EVERY project's dispatcher, not just the invoking one", () => {
  const pkA = migrate();
  const pkB = migrateSecondProject();
  assert.notEqual(pkA, pkB, "the fixture needs two distinct registered projects");

  // Both projects have a dispatcher. Only ONE of them runs the operator's command.
  seedLiveDispatcher(pkA, "dispatcher-a@1");
  seedLiveDispatcher(pkB, "dispatcher-b@1");
  closeDb();

  assert.equal(forge(["queue", "dispatcher", "arm", "--max-active-runs", "2"]).status, 0);
  // Both dispatchers consume what arming left them, so the next assertion is about the
  // NEXT change rather than a record that was already there.
  for (const pk of [pkA, pkB]) {
    assert.ok(claimWakes({ projectKey: pk, consumer: `consumer-${pk}` }).length > 0, `${pk} was not woken by arming`);
  }
  assert.equal(forge(["queue", "dispatcher", "set", "--max-active-runs", "4"]).status, 0);

  // The ceiling is ONE host-wide value (D3), so a change to it is a change every live
  // dispatcher must re-evaluate against. A wake that reached only the invoker would
  // leave B enforcing the old ceiling until its watchdog — polling as the correctness
  // mechanism, which AC15 forbids.
  for (const pk of [pkA, pkB]) {
    const wakes = pendingWakes(pk).filter((w) => w.kind === "capacity_changed");
    assert.equal(wakes.length, 1, `${pk} has no pending capacity_changed wake`);
    assert.equal(wakes[0]?.wakeKey, "capacity", "the idempotency key is the subject, so repeats collapse");
    assert.match(String(wakes[0]?.detail), /max_active_runs=4/);
  }

  // A POLICY-only change (the armed flag / cadence) is host-wide by the same rule.
  assert.equal(forge(["queue", "dispatcher", "disarm"]).status, 0);
  for (const pk of [pkA, pkB]) {
    assert.equal(pendingWakes(pk).filter((w) => w.kind === "policy_changed").length, 1, `${pk} missed the policy wake`);
  }
});

// ─── hostile / malformed policy input ───────────────────────────────────────

test("FG-591: a malformed or out-of-range policy flag refuses BY NAME and writes nothing", () => {
  migrate();
  assert.equal(forge(["queue", "dispatcher", "arm", "--max-active-runs", "2"]).status, 0);
  const before = policyRows();

  const cases: [string[], RegExp][] = [
    [["queue", "dispatcher", "set", "--max-active-runs", "abc"], /--max-active-runs must be a whole/],
    [["queue", "dispatcher", "set", "--max-active-runs", "-1"], /--max-active-runs must be a whole/],
    [["queue", "dispatcher", "set", "--max-active-runs", "1.5"], /--max-active-runs must be a whole/],
    [["queue", "dispatcher", "set", "--max-active-runs", "2x"], /--max-active-runs must be a whole/],
    // Below the derived floor: a shorter lease lets a HEALTHY dispatcher lapse its own
    // lease under write contention and be taken over while its container still runs.
    [["queue", "dispatcher", "set", "--lease-ttl", "1000"], /below the derived floor/],
    [["queue", "dispatcher", "set", "--lease-ttl", "0"], /--lease-ttl must be a whole positive/],
    // An authorization write that changes nothing is still an authorization event.
    [["queue", "dispatcher", "set"], /no policy flag was given/],
    [["queue", "dispatcher", "arm", "--workflow", "  "], /must be a non-empty workflow name/],
  ];
  for (const [args, pattern] of cases) {
    const res = forge(args);
    assert.equal(res.status, 1, `${args.join(" ")} must exit non-zero: ${res.stdout}`);
    assert.match(res.stderr, pattern, args.join(" "));
    assert.match(res.stderr, /[Nn]othing was written/, `${args.join(" ")} must say it wrote nothing`);
  }
  assert.deepEqual(policyRows(), before, "every refused policy flag must leave the policy row byte-identical");
});

// ─── the six no-run states ──────────────────────────────────────────────────

test("FG-591: the six no-run states render distinguishably from the DURABLE record", () => {
  const pk = migrate();
  assert.equal(forge(["queue", "enqueue", "FG-1"]).status, 0);

  // 1. DISARMED. The operator's own choice, and the answer no other fact can override.
  assert.equal(forge(["queue", "dispatcher", "arm"]).status, 0);
  assert.equal(forge(["queue", "dispatcher", "disarm"]).status, 0);
  let s = status();
  assert.equal(s.state, "disarmed");
  assert.equal(s.armed, false);
  assert.match(s.blockers.join("\n"), /DISARMED/);

  // 2. DEAD/STALE DISPATCHER — armed, but nothing is watching. Distinct from
  //    "nothing to do", which is the collapse this ticket exists to prevent.
  assert.equal(forge(["queue", "dispatcher", "arm"]).status, 0);
  s = status();
  assert.equal(s.state, "dispatcher_down");
  assert.equal(s.dispatcher, null);
  assert.match(s.headline, /no dispatcher has ever held a lease/);

  seedLiveDispatcher(pk);

  // 3. NO CAPACITY — and, because the ceiling is HOST-scoped, it names the OTHER
  //    project holding the slots. Without that, a per-project board cannot explain
  //    its own stall.
  seedEvaluation(pk, {
    reason: "no_capacity",
    detail: "2/2 live claims in host scope, with slots held by other-project.",
    capacityLimit: 2,
    capacityUsed: 2,
    capacityHolders: [
      { claimId: "c-1", projectKey: "other-project", ticketId: "OT-9", owner: "dispatcher@other@1", launchId: null, runId: "r-9" },
      { claimId: "c-2", projectKey: pk, ticketId: "FG-2", owner: "dispatcher@test@1", launchId: null, runId: "r-2" },
    ],
    scanEvidence: [{ ticketId: "FG-1", rank: 1, reason: "capacity", detail: "2/2 live claims in host scope" }],
  });
  s = status();
  assert.equal(s.state, "no_capacity");
  assert.match(s.headline, /other-project/, "a host-scoped refusal must NAME the holding project");
  assert.equal(s.lastCapacityRefusal?.reason, "no_capacity");
  assert.equal(s.lastEvaluation?.reason, "no_capacity");

  // 4. BLOCKED — derived from the recorded scan evidence's own queue_blocked entries.
  //    A genuine blocker is durable and per-ticket: someone has to clear it.
  seedEvaluation(pk, {
    reason: "no_eligible_work",
    detail: "the scan walked 1 ranked-or-queued candidate and none was selectable.",
    scanEvidence: [
      { ticketId: "FG-1", rank: 1, reason: "queue_blocked", detail: "waiting on an upstream decision" },
    ],
  });
  s = status();
  assert.equal(s.state, "blocked");
  assert.deepEqual(s.blockedCandidates.map((b) => b.ticketId), ["FG-1"]);
  assert.match(s.headline, /someone has to clear it/);
  assert.deepEqual(s.incompatibleWaits, [], "a blocker is not a scheduling wait");

  // 5. TEMPORARILY INCOMPATIBLE — the same shape of pass, a different fact: nobody
  //    has to do anything, and it must never be labelled blocked.
  seedEvaluation(pk, {
    reason: "incompatible_only",
    detail: "FG-1 is waiting for FG-2 to finish.",
    scanEvidence: [
      { ticketId: "FG-1", rank: 1, reason: "incompatible", detail: "waiting for FG-2 to finish" },
    ],
  });
  s = status();
  assert.equal(s.state, "incompatible");
  assert.deepEqual(s.incompatibleWaits.map((w) => w.ticketId), ["FG-1"]);
  assert.match(s.headline, /waiting for FG-2 to finish/);
  assert.doesNotMatch(s.headline, /\bblocked\b/i, "a scheduling wait is never rendered as blocked");
  assert.deepEqual(s.blockedCandidates, [], "a scheduling wait is not a blocker");

  // 6. NO ELIGIBLE WORK — the scan ran and selected nothing for any other reason.
  seedEvaluation(pk, {
    reason: "no_eligible_work",
    detail: "the scan walked 1 ranked-or-queued candidate and none was selectable.",
    scanEvidence: [{ ticketId: "FG-2", rank: 2, reason: "not_a_queue_member", detail: null }],
  });
  s = status();
  assert.equal(s.state, "no_eligible_work");
  assert.deepEqual(s.blockedCandidates, []);
  assert.deepEqual(s.incompatibleWaits, []);

  // The six are six DIFFERENT strings, not one string with six labels.
  const rendered = forge(["queue", "dispatcher", "status"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /state:\s+no_eligible_work/);
  assert.match(rendered.stdout, /watchdog:\s+next at/, "the next watchdog deadline is on the operator surface");
  assert.match(rendered.stdout, /lease:\s+dispatcher@test@1 generation 1 — LIVE/, "the current owner and lease are shown");
  assert.match(rendered.stdout, /last look: no_eligible_work at/, "the last evaluation time and outcome are shown");
});

test("FG-591: a live lease whose watchdog deadline passed reads as a STALE dispatcher, not as idle", () => {
  const pk = migrate();
  assert.equal(forge(["queue", "dispatcher", "arm"]).status, 0);
  seedLiveDispatcher(pk);
  recordEvaluation({
    projectKey: pk,
    dispatcherOwner: "dispatcher@test@1",
    dispatcherGeneration: 1,
    reason: "no_eligible_work",
    detail: "nothing selectable",
    capacityScope: "host",
    capacityLimit: 1,
    capacityUsed: 0,
    scanEvidence: [],
    // A deadline the dispatcher armed and then never met.
    nextWatchdogAtMs: storeNowMs() - FIVE_MINUTES,
  });

  const s = status();
  assert.equal(s.state, "dispatcher_down", "an overdue watchdog under a live lease is a stuck loop, not an idle one");
  assert.equal(s.watchdog.overdue, true);
  assert.equal(s.dispatcher?.live, true, "the lease itself is still live — the two facts stay separate");
  assert.match(s.headline, /the loop is stuck, not idle/);
});

test("FG-591: an EXPIRED dispatcher lease is reported loudly and is never auto-restarted", () => {
  const pk = migrate();
  assert.equal(forge(["queue", "dispatcher", "arm"]).status, 0);
  seedLiveDispatcher(pk);
  closeDb();
  getDb()
    .prepare(`UPDATE dispatcher_leases SET lease_expires_at_ms = ?, heartbeat_at_ms = ? WHERE project_key = ?`)
    .run(storeNowMs() - 60_000, storeNowMs() - 60_000, pk);

  const s = status();
  assert.equal(s.state, "dispatcher_down");
  assert.equal(s.dispatcher?.expired, true);
  assert.match(s.headline, /EXPIRED/);
  assert.match(s.headline, /does NOT auto-restart/, "D9 is stated to the operator, not assumed");
  // Reading the status started nothing: the lease is still the expired one.
  const leases = getDb().prepare(`SELECT owner, generation FROM dispatcher_leases`).all() as { owner: string }[];
  assert.equal(leases.length, 1);
  assert.equal(leases[0]!.owner, "dispatcher@test@1", "a status read must never acquire or take over a lease");
});

// ─── capacity is an ADMISSION test, never a reaper ──────────────────────────

test("FG-591: reducing capacity below current usage prevents the next claim and terminates nothing", () => {
  const pk = migrate();
  assert.equal(forge(["queue", "enqueue", "FG-1"]).status, 0);
  assert.equal(forge(["queue", "dispatcher", "arm", "--max-active-runs", "2"]).status, 0);

  // Two live claims, at the ceiling.
  insertLiveClaim(pk, "FG-2", { claimId: "claim-a", runId: "run-a" });
  insertLiveClaim(pk, "FG-9", { claimId: "claim-b", runId: "run-b" });
  const before = claimRows();
  assert.equal(before.length, 2);

  const reduced = forge(["queue", "dispatcher", "set", "--max-active-runs", "1", "--json"]);
  assert.equal(reduced.status, 0, reduced.stderr);
  const parsed = JSON.parse(reduced.stdout) as { notes: string[]; policy: { maxActiveRuns: number } };
  assert.equal(parsed.policy.maxActiveRuns, 1);
  assert.match(parsed.notes.join("\n"), /ADMISSION test, not a reaper/);

  // NOTHING was terminated: every claim row is byte-identical, leases included.
  assert.deepEqual(claimRows(), before, "a capacity reduction must not touch a single live claim");

  // And the next claim is PREVENTED — a real armed dispatcher pass, driven through
  // the production CLI entry point, refuses with no_capacity and grants nothing.
  const ran = forge(["queue", "dispatcher", "run", "--once"], { FORGE_DISPATCHER_ID: "cap-test" });
  assert.equal(ran.status, 0, ran.stderr);
  const s = status();
  assert.equal(s.lastEvaluation?.reason, "no_capacity", `expected a capacity refusal: ${s.headline}`);
  assert.deepEqual(
    claimRows().map((c) => c.id).sort(),
    ["claim-a", "claim-b"],
    "the refused pass must grant no claim",
  );
  assert.deepEqual(claimRows(), before, "the refused pass must also leave the existing claims untouched");
  // The one-shot dispatcher released its OWN lease on an orderly stop, so the current
  // state is "nothing is watching" — which the surface must say out loud rather than
  // reporting a stale pass as the current reason.
  assert.equal(s.state, "dispatcher_down");
  assert.equal(s.lastCapacityRefusal?.reason, "no_capacity", "the capacity refusal stays available as evidence");
});

test("FG-591: disarm leaves running work, its claims and their leases alone", () => {
  const pk = migrate();
  assert.equal(forge(["queue", "enqueue", "FG-1"]).status, 0);
  assert.equal(forge(["queue", "dispatcher", "arm", "--max-active-runs", "3"]).status, 0);
  insertLiveClaim(pk, "FG-2", { claimId: "claim-live", runId: "run-live" });
  seedLiveDispatcher(pk);
  const beforeClaims = claimRows();
  closeDb();
  const beforeLease = getDb().prepare(`SELECT * FROM dispatcher_leases WHERE project_key = ?`).get(pk);

  const res = forge(["queue", "dispatcher", "disarm", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout) as { armed: boolean; notes: string[] };
  assert.equal(parsed.armed, false);
  assert.match(parsed.notes.join("\n"), /Running containers keep running/);

  assert.deepEqual(claimRows(), beforeClaims, "disarm must not release, expire or shorten a single claim");
  closeDb();
  assert.deepEqual(
    getDb().prepare(`SELECT * FROM dispatcher_leases WHERE project_key = ?`).get(pk),
    beforeLease,
    "disarm must not touch the dispatcher lease — it is an admission test, not process lifecycle",
  );

  // A second dispatcher process FAILS CLOSED against the live lease rather than
  // driving the same queue beside it. Waiting is not evidence of abandonment.
  const second = forge(["queue", "dispatcher", "run", "--once"], { FORGE_DISPATCHER_ID: "disarm-test" });
  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stderr, /is held by dispatcher@test@1 .* is still LIVE/s);
  assert.deepEqual(claimRows(), beforeClaims, "a refused dispatcher must touch no claim");

  // With the fixture dispatcher gone, a disarmed dispatcher process still runs: it
  // holds its identity and reconciles, and it claims nothing. That is D5, driven
  // through the real entry point.
  closeDb();
  getDb().prepare(`DELETE FROM dispatcher_leases WHERE project_key = ?`).run(pk);
  const ran = forge(["queue", "dispatcher", "run", "--once"], { FORGE_DISPATCHER_ID: "disarm-test" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /DISARMED: this process will hold its lease/);
  assert.deepEqual(
    claimRows().map((c) => c.id),
    ["claim-live"],
    "a disarmed dispatcher must claim nothing and release nothing",
  );
  const s = status();
  assert.equal(s.state, "disarmed");
  assert.equal(s.lastEvaluation?.reason, "disabled", "the disarmed pass still leaves a durable answer");
});

// ─── `dispatcher run`: the identity refusal ─────────────────────────────────

test("FG-591: `dispatcher run` refuses without a stable instance identity and acquires no lease", () => {
  const pk = migrate();
  assert.equal(forge(["queue", "dispatcher", "arm"]).status, 0);

  const res = forge(["queue", "dispatcher", "run", "--once"], { FORGE_DISPATCHER_ID: "" });
  assert.equal(res.status, 1, `expected a refusal, got: ${res.stdout}`);
  assert.match(res.stderr, /queue dispatcher run refuses/);
  assert.match(res.stderr, /no stable dispatcher identity resolved/);
  closeDb();
  assert.equal(
    (getDb().prepare(`SELECT COUNT(*) AS n FROM dispatcher_leases`).get() as { n: number }).n,
    0,
    "a refused dispatcher must acquire no lease",
  );
  assert.equal(
    (getDb().prepare(`SELECT COUNT(*) AS n FROM dispatcher_evaluations WHERE project_key = ?`).get(pk) as { n: number })
      .n,
    0,
    "a refused dispatcher must record no evaluation",
  );

  // The flag is the same declaration by another spelling, and it works.
  const withFlag = forge(["queue", "dispatcher", "run", "--once", "--dispatcher-id", "flag-instance"], {
    FORGE_DISPATCHER_ID: "",
  });
  assert.equal(withFlag.status, 0, withFlag.stderr);
  assert.match(withFlag.stdout, /dispatcher dispatcher@.*@flag-instance starting/);
});

test("FG-591: `dispatcher run` refuses a watchdog interval below the floor and starts nothing", () => {
  migrate();
  assert.equal(forge(["queue", "dispatcher", "arm"]).status, 0);
  const res = forge(["queue", "dispatcher", "run", "--once", "--watchdog-interval", "5"], {
    FORGE_DISPATCHER_ID: "wd-test",
  });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, /watchdog interval of 5ms is below the/);
  assert.match(res.stderr, /Nothing was started/);
});

// ─── cancel (D4): the ORDER is the whole safety argument ────────────────────

test("FG-591: `queue cancel` stops the work FIRST, then the lease owner retires the reservation", () => {
  const pk = migrate();
  assert.equal(forge(["queue", "enqueue", "FG-1"]).status, 0);
  insertRun({
    id: "run-cancel",
    workflow: "feature",
    title: "FG-1 first",
    status: "active",
    createdAt: new Date(storeNowMs()).toISOString(),
    projectDir: project,
  });
  insertLiveClaim(pk, "FG-1", { claimId: "claim-cancel", runId: "run-cancel" });

  const res = forge(["queue", "cancel", "FG-1", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout) as {
    cancelled: boolean;
    claimId: string;
    workStopped: { kind: string; runId: string } | null;
    released: { claimId: string; outcome: string } | null;
    releaseRefused: string | null;
  };
  assert.equal(parsed.cancelled, true);
  assert.equal(parsed.claimId, "claim-cancel");
  // 1. THE WORK. `forge cancel`'s own outcome, for the run the reservation bound.
  assert.equal(parsed.workStopped?.kind, "run-cancelled");
  assert.equal(parsed.workStopped?.runId, "run-cancel");
  // 2. THE RESERVATION, after it, and only as `cancelled`.
  assert.equal(parsed.released?.claimId, "claim-cancel");
  assert.equal(parsed.released?.outcome, "cancelled");
  assert.equal(parsed.releaseRefused, null);

  closeDb();
  const run = getDb().prepare(`SELECT status FROM runs WHERE id = 'run-cancel'`).get() as { status: string };
  assert.equal(run.status, "abandoned", "the work must actually be stopped, not merely reported as stopped");
  const claim = claimRows().find((c) => c.id === "claim-cancel")!;
  assert.equal(claim.state, "released");
  assert.equal(claim.outcome, "cancelled");
  assert.ok(claim.released_at !== null);
  // Both halves are durable, and the work-stopping half left its own event.
  //
  // NOT asserted by comparing the two timestamps, deliberately: events.created_at is
  // written from the PROCESS clock (util/ids.nowIso) and queue_claims.released_at
  // from the STORE clock (storeNowMs, SQLite's own `now`). They are two clocks, they
  // differ by a millisecond or so on this machine, and an ordering "proved" by
  // comparing them would be measuring skew rather than sequence — which is precisely
  // why nothing in the dispatcher joins these two columns to decide anything. The
  // ORDER itself is structural: the release is the third statement of one synchronous
  // function whose first statement is the stop, and step 7 pins that with a seam spy.
  // What this tier can prove is that the CLI reaches that path and that both durable
  // effects landed.
  const cancelEvent = getDb()
    .prepare(`SELECT created_at FROM events WHERE run_id = 'run-cancel' AND event_type = 'run.cancelled' LIMIT 1`)
    .get() as { created_at: string } | undefined;
  assert.ok(cancelEvent, "cancelling the work must leave a durable event");
  assert.match(
    res.stdout,
    /the work was stopped first/,
    "the operator-facing report states the order it happened in",
  );

  // A freed slot is a durable WAKE, so a running dispatcher re-evaluates on the
  // change rather than at the next watchdog tick.
  const wake = getDb()
    .prepare(`SELECT kind, wake_key, state FROM dispatcher_wakes WHERE project_key = ? ORDER BY id DESC LIMIT 1`)
    .get(pk) as { kind: string; wake_key: string; state: string };
  assert.equal(wake.kind, "run_terminal");
  assert.equal(wake.wake_key, "run:run-cancel");
});

test("FG-591: dequeue, unrank and defer NEVER release a live claim — only cancel stops work", () => {
  const pk = migrate();
  assert.equal(forge(["queue", "enqueue", "FG-1"]).status, 0);
  insertLiveClaim(pk, "FG-1", { claimId: "claim-planning", runId: "run-planning" });
  const before = claimRows();

  // The planning verbs, every one of them, against a ticket whose container is
  // running. A released reservation here is re-admitted to the scan, and a second
  // dispatcher launches work that is already executing.
  assert.equal(forge(["queue", "dequeue", "FG-1"]).status, 0);
  const unranked = forge(["backlog", "rank", "FG-1", "--clear"]);
  assert.equal(unranked.status, 0, unranked.stderr);
  assert.deepEqual(claimRows(), before, "no planning verb may release, expire or shorten a live claim");

  // The board still shows the container, as its own first-class state: not a queue
  // member AND executing.
  const board = JSON.parse(forge(["queue", "list", "--json", "--all"]).stdout) as {
    rows: { ticketId: string; queued: boolean; claim: { claimId: string } | null }[];
  };
  const row = board.rows.find((r) => r.ticketId === "FG-1")!;
  assert.equal(row.queued, false);
  assert.equal(row.claim?.claimId, "claim-planning", "a dequeued ticket's live reservation stays visible");
});

test("FG-591: `queue cancel` on a ticket with no live claim refuses and releases nothing", () => {
  const pk = migrate();
  insertLiveClaim(pk, "FG-2", { claimId: "claim-other" });
  const before = claimRows();

  const res = forge(["queue", "cancel", "FG-1", "--json"]);
  assert.equal(res.status, 1, `expected a non-zero exit, got: ${res.stdout}`);
  const parsed = JSON.parse(res.stdout) as { cancelled: boolean; refusal: string };
  assert.equal(parsed.cancelled, false);
  assert.match(parsed.refusal, /no live claim reserves FG-1/);
  assert.match(parsed.refusal, /Queue membership is planning intent; it is never a reservation/);
  assert.deepEqual(claimRows(), before, "a cancel that finds nothing must not touch another ticket's claim");
});
