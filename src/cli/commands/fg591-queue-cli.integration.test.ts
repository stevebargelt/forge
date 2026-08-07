// FG-591 step 9 — `forge queue` through the REAL CLI, in a real child process,
// against a real on-disk store and a real git checkout.
//
// What only this tier can show:
//   * the MARKDOWN-MODE refusal per verb, because it is the CLI that resolves the
//     store — an in-process store test never sees that decision at all;
//   * that a refusal writes NOTHING, asserted against durable state read back with a
//     second connection rather than against the CLI's own output;
//   * the --json SHAPES a dashboard and a script depend on, as they actually appear
//     on stdout;
//   * and the one distinction the board must never collapse: a genuine blocker and a
//     temporary scheduling incompatibility rendered as DIFFERENT things, in different
//     columns, under different labels.
//
// The last test is a PARITY GUARD rather than an example: `queue list`'s per-entry
// reason is a live re-derivation of claimNextEligible's own scan classification, and
// two copies of a classification drift. So the same store is scanned by the real
// primitive and the two answers are compared entry by entry, reason AND detail.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const entry = resolve(here, "..", "index.ts");
const localTsx = resolve(repoRoot, "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let root: string;
let home: string;
let project: string;

const READY_BODY = [
  "## Problem",
  "The operator queue has no board.",
  "",
  "## Goal",
  "A board an operator can read.",
  "",
  "## Acceptance Criteria",
  "- five projections",
  "- a reason per queued entry",
].join("\n");

const NOT_READY_BODY = "## Problem\nOnly half a ticket.\n";

type ForgeResult = { status: number | null; stdout: string; stderr: string };

function forge(args: string[], input = ""): ForgeResult {
  const res = spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: project,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: home,
      FORGE_DB_PATH: join(home, "forge.db"),
      ...authorityTestkitEnv(),
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
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
  root = mkdtempSync(join(tmpdir(), "fg591-queue-cli-"));
  home = join(root, "home");
  project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(project, ".forge"), { recursive: true });
  writeFileSync(join(project, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  writeTicketFile("FG-1", "first", READY_BODY);
  writeTicketFile("FG-2", "second", READY_BODY);
  writeTicketFile("FG-3", "third", NOT_READY_BODY);
  writeTicketFile("FG-4", "fourth", READY_BODY);
  writeFileSync(join(project, "README.md"), "# fixture\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function migrate(): void {
  const res = forge(["backlog", "migrate"]);
  assert.equal(res.status, 0, `migrate failed: ${res.stderr}`);
}

/** The project_key `forge backlog migrate` committed to .forge/config.yml. */
function readProjectKey(): string {
  const yml = readFileSync(join(project, ".forge", "config.yml"), "utf8");
  const m = yml.match(/^project_key:\s*(\S+)\s*$/m);
  assert.ok(m, `expected a committed project_key in .forge/config.yml, got:\n${yml}`);
  return m![1]!;
}

function withStore<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(join(home, "forge.db"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Durable state, read with a SECOND connection: "the refusal wrote nothing" is a
 *  claim about the store, not about what the CLI printed. */
function durableQueue(): { order: string[]; version: number } {
  const pk = readProjectKey();
  return withStore((db) => {
    const order = (
      db
        .prepare(
          `SELECT t.ticket_id FROM tickets t
             JOIN queue_membership m ON m.project_key = t.project_key AND m.ticket_id = t.ticket_id
            WHERE t.project_key = ? AND t.priority_rank IS NOT NULL
            ORDER BY t.priority_rank ASC, t.ticket_id ASC`,
        )
        .all(pk) as { ticket_id: string }[]
    ).map((r) => r.ticket_id);
    const version = (
      db
        .prepare(
          `SELECT COALESCE(MAX(id), 0) AS v FROM queue_events
            WHERE project_key = ? AND event_type IN ('rank','unrank','enqueue','dequeue','reorder')`,
        )
        .get(pk) as { v: number }
    ).v;
    return { order, version };
  });
}

function ranksById(): Record<string, number | null> {
  const pk = readProjectKey();
  return withStore((db) => {
    const rows = db
      .prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`)
      .all(pk) as { ticket_id: string; priority_rank: number | null }[];
    return Object.fromEntries(rows.map((r) => [r.ticket_id, r.priority_rank]));
  });
}

type BoardRow = {
  ticketId: string;
  rank: number | null;
  queued: boolean;
  blocked: boolean;
  inProgress: boolean;
  projection: string;
  readiness: { outcome: string; stale: boolean } | null;
  scan: { reason: string; detail: string | null };
  claim: { owner: string } | null;
};

type Board = {
  projectKey: string;
  version: number;
  capacityScope: string;
  capacityApplied: boolean;
  rows: BoardRow[];
};

function board(extraArgs: string[] = []): Board {
  const res = forge(["queue", "list", "--json", ...extraArgs]);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout) as Board;
}

function rowFor(b: Board, ticketId: string): BoardRow {
  const row = b.rows.find((r) => r.ticketId === ticketId);
  assert.ok(row, `expected ${ticketId} on the board, got ${b.rows.map((r) => r.ticketId).join(", ")}`);
  return row!;
}

/** A LIVE claim, inserted the way the claim primitive would have. No launch and no
 *  run: the reservation exists and where it will execute is not yet knowable, which
 *  is the state a just-granted claim is actually in. */
function insertLiveClaim(ticketId: string, owner: string, leaseMs = 10 * 60_000): void {
  const pk = readProjectKey();
  const now = Date.now();
  withStore((db) => {
    db.prepare(
      `INSERT INTO queue_claims
         (id, project_key, ticket_id, owner, generation, ticket_revision, lease_expires_at_ms,
          heartbeat_at_ms, launch_id, run_id, state, outcome, scan_evidence, claimed_at, released_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?, NULL, NULL, 'live', NULL, NULL, ?, NULL)`,
    ).run(
      `claim-${ticketId}`,
      pk,
      ticketId,
      owner,
      now + leaseMs,
      now,
      new Date(now).toISOString(),
    );
  });
}

/** A GENUINE blocker: a status-bearing blocker_evidence row, the durable per-ticket
 *  fact someone has to clear. Deliberately NOT how a scheduling wait is expressed. */
function insertBlocker(ticketId: string, reason: string): void {
  const pk = readProjectKey();
  withStore((db) => {
    db.prepare(
      `INSERT INTO blocker_evidence
         (id, project_key, ticket_id, reason, source, created_at, kind, detail, body_hash, queue_projection)
       VALUES (?, ?, ?, ?, 'import-legacy-blocked', ?, 'legacy_blocked', NULL, NULL, NULL)`,
    ).run(`be-${ticketId}`, pk, ticketId, reason, new Date().toISOString());
  });
}

// ─── the markdown-mode refusal, per verb ────────────────────────────────────

test("FG-591: every `forge queue` verb refuses BY NAME on a markdown-mode project", () => {
  const cases: [string, string[]][] = [
    ["list", ["queue", "list"]],
    ["enqueue", ["queue", "enqueue", "FG-1"]],
    ["dequeue", ["queue", "dequeue", "FG-1"]],
    ["rank-before", ["queue", "rank-before", "FG-1", "FG-2"]],
    ["rank-after", ["queue", "rank-after", "FG-1", "FG-2"]],
    ["reorder", ["queue", "reorder", "FG-1", "--to", "1"]],
  ];
  for (const [verb, args] of cases) {
    const res = forge(args);
    assert.equal(res.status, 1, `${verb} must exit non-zero on a markdown-mode project`);
    assert.match(res.stderr, new RegExp(`queue ${verb} refuses`), `${verb}: ${res.stderr}`);
    assert.match(res.stderr, /markdown mode|no resolvable project_key/);
    assert.match(res.stderr, /forge backlog migrate/, `${verb} must name the way forward`);
    assert.equal(res.stdout, "", `${verb} must print nothing on stdout when it refuses`);
  }
});

test("FG-591: a markdown-mode refusal writes NOTHING to the DB shadow", () => {
  // Seed the write-only shadow first, so "wrote nothing" is asserted against a
  // populated table rather than an empty one.
  assert.equal(forge(["backlog", "import"]).status, 0);
  const pk = withStore(
    (db) =>
      (db.prepare(`SELECT project_key FROM tickets LIMIT 1`).get() as { project_key: string }).project_key,
  );
  const before = withStore((db) => ({
    membership: (db.prepare(`SELECT COUNT(*) AS n FROM queue_membership`).get() as { n: number }).n,
    events: (db.prepare(`SELECT COUNT(*) AS n FROM queue_events`).get() as { n: number }).n,
    ranks: db
      .prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`)
      .all(pk),
  }));

  for (const args of [
    ["queue", "enqueue", "FG-1"],
    ["queue", "dequeue", "FG-1"],
    ["queue", "rank-before", "FG-1", "FG-2"],
    ["queue", "reorder", "FG-1", "--to", "1"],
  ]) {
    assert.equal(forge(args).status, 1, args.join(" "));
  }

  const after = withStore((db) => ({
    membership: (db.prepare(`SELECT COUNT(*) AS n FROM queue_membership`).get() as { n: number }).n,
    events: (db.prepare(`SELECT COUNT(*) AS n FROM queue_events`).get() as { n: number }).n,
    ranks: db
      .prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`)
      .all(pk),
  }));
  assert.deepEqual(after, before, "a refusing queue verb must write nothing at all");
});

// ─── every verb, end to end, with its --json shape pinned ───────────────────

test("FG-591: every planning verb works end to end and has a stable --json shape", () => {
  migrate();

  // enqueue — the same writer `forge backlog enqueue` calls, reached by this spelling.
  let res = forge(["queue", "enqueue", "FG-1", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  let parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "action",
    "enqueued",
    "message",
    "position",
    "projectKey",
    "queue",
    "readiness",
    "ticketId",
    "version",
  ]);
  assert.equal(parsed["action"], "enqueue");
  assert.equal(parsed["enqueued"], true);
  assert.equal(parsed["position"], 1);
  assert.deepEqual(parsed["queue"], ["FG-1"]);

  assert.equal(forge(["queue", "enqueue", "FG-2"]).status, 0);
  assert.equal(forge(["queue", "enqueue", "FG-4"]).status, 0);
  assert.deepEqual(durableQueue().order, ["FG-1", "FG-2", "FG-4"]);

  // rank-before — RELATIVE intent, not a position.
  res = forge(["queue", "rank-before", "FG-4", "FG-1", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "action",
    "message",
    "position",
    "projectKey",
    "queue",
    "relativeTo",
    "ticketId",
    "version",
  ]);
  assert.equal(parsed["action"], "rank-before");
  assert.equal(parsed["relativeTo"], "FG-1");
  assert.deepEqual(parsed["queue"], ["FG-4", "FG-1", "FG-2"]);

  // rank-after — same shape, other direction.
  res = forge(["queue", "rank-after", "FG-4", "FG-2", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.equal(parsed["action"], "rank-after");
  assert.deepEqual(parsed["queue"], ["FG-1", "FG-2", "FG-4"]);

  // reorder --to, then reorder --order.
  res = forge(["queue", "reorder", "FG-2", "--to", "1", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "action",
    "message",
    "position",
    "projectKey",
    "queue",
    "ticketId",
    "version",
  ]);
  assert.deepEqual(parsed["queue"], ["FG-2", "FG-1", "FG-4"]);

  res = forge(["queue", "reorder", "--order", "FG-1,FG-2,FG-4", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["action", "message", "projectKey", "queue", "version"]);
  assert.deepEqual(parsed["queue"], ["FG-1", "FG-2", "FG-4"]);

  // dequeue — rank RETAINED.
  const ranksBefore = ranksById();
  res = forge(["queue", "dequeue", "FG-2", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  parsed = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "action",
    "message",
    "projectKey",
    "queue",
    "ticketId",
    "version",
  ]);
  assert.deepEqual(parsed["queue"], ["FG-1", "FG-4"]);
  assert.deepEqual(ranksById(), ranksBefore, "dequeue is not a deprioritization — the rank is retained");

  // list — the board's own shape.
  const b = board();
  assert.deepEqual(Object.keys(b).sort(), [
    "capacityApplied",
    "capacityScope",
    "projectKey",
    "rows",
    "version",
  ]);
  assert.equal(b.capacityScope, "host");
  assert.equal(b.capacityApplied, false);
  assert.equal(b.version, durableQueue().version);
  assert.deepEqual(Object.keys(rowFor(b, "FG-1")).sort(), [
    "blocked",
    "claim",
    "inProgress",
    "projection",
    "queued",
    "rank",
    "readiness",
    "scan",
    "status",
    "ticketId",
    "title",
    "type",
  ]);
  // The dequeued ticket is still on the board, ranked, no longer a member.
  assert.equal(rowFor(b, "FG-2").queued, false);
  assert.equal(rowFor(b, "FG-2").rank, 2);
  assert.equal(rowFor(b, "FG-2").projection, "backlog");
  assert.equal(rowFor(b, "FG-2").scan.reason, "not_a_queue_member");

  // --all widens the domain to tickets that were never ranked or queued.
  assert.equal(
    b.rows.some((r) => r.ticketId === "FG-3"),
    false,
    "FG-3 is neither ranked nor queued, so it is outside the default board domain",
  );
  assert.equal(rowFor(board(["--all"]), "FG-3").projection, "backlog");
});

test("FG-591: the human board renders the five projections with rank, membership and readiness", () => {
  migrate();
  assert.equal(forge(["queue", "enqueue", "FG-1"]).status, 0);
  const res = forge(["queue", "list"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /queue version \d+/);
  assert.match(res.stdout, /Queued \(1\)/);
  assert.match(res.stdout, /1 {2}FG-1 {2}first {2}\[queued, readiness=ready\]/);
  assert.match(res.stdout, /ready to dispatch/);
  assert.match(res.stdout, /capacity is not applied to this view/);
});

// ─── refusals: non-zero, concrete, and nothing written ──────────────────────

test("FG-591: enqueue refuses a not-ready ticket with the concrete refinement proposal", () => {
  migrate();
  const res = forge(["queue", "enqueue", "FG-3"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /enqueue refuses/);
  assert.match(res.stderr, /Missing Goal section/);
  assert.match(res.stderr, /Missing Acceptance Criteria section/);
  assert.match(res.stderr, /CURRENT revision/);
  assert.deepEqual(durableQueue().order, [], "a refused enqueue writes no membership");
  // The assessment DID commit — that is the audit record — and the board shows why,
  // including for a ticket that is neither ranked nor queued.
  const row = rowFor(board(["--all"]), "FG-3");
  assert.equal(row.readiness?.outcome, "needs_refinement");
  assert.equal(row.readiness?.stale, false);
  assert.equal(row.scan.reason, "not_a_queue_member");
});

test("FG-591: dequeue is a PLANNING act — it never releases a live claim", () => {
  migrate();
  assert.equal(forge(["queue", "enqueue", "FG-1"]).status, 0);
  insertLiveClaim("FG-1", "dispatcher-alpha");
  const rankBefore = ranksById()["FG-1"];

  assert.equal(forge(["queue", "dequeue", "FG-1"]).status, 0);

  // The RESERVATION is untouched. Releasing it here would re-admit a ticket whose
  // container may still be running, which is the duplicate execution the claim
  // primitive exists to prevent — stopping work is `forge queue cancel`, not this.
  const claim = withStore(
    (db) =>
      db
        .prepare(`SELECT state, owner, generation, outcome, released_at FROM queue_claims WHERE id = ?`)
        .get("claim-FG-1") as {
        state: string;
        owner: string;
        generation: number;
        outcome: string | null;
        released_at: string | null;
      },
  );
  assert.deepEqual(claim, {
    state: "live",
    owner: "dispatcher-alpha",
    generation: 1,
    outcome: null,
    released_at: null,
  });

  // And the board renders the state that creates: no longer a queue member, rank
  // retained, still holding its reservation.
  const row = rowFor(board(), "FG-1");
  assert.equal(row.queued, false);
  assert.equal(row.rank, rankBefore);
  assert.equal(row.claim?.owner, "dispatcher-alpha");
});

test("FG-591: a stale --expect-version refuses BY NAME and leaves the order byte-identical", () => {
  migrate();
  for (const id of ["FG-1", "FG-2", "FG-4"]) assert.equal(forge(["queue", "enqueue", id]).status, 0);

  const composedAgainst = board().version;
  // Something else moves the queue between the operator's read and their submission.
  assert.equal(forge(["queue", "reorder", "FG-4", "--to", "1"]).status, 0);
  const before = durableQueue();
  assert.deepEqual(before.order, ["FG-4", "FG-1", "FG-2"]);

  for (const args of [
    ["queue", "rank-before", "FG-2", "FG-4", "--expect-version", String(composedAgainst)],
    ["queue", "rank-after", "FG-2", "FG-4", "--expect-version", String(composedAgainst)],
    ["queue", "reorder", "FG-2", "--to", "1", "--expect-version", String(composedAgainst)],
    ["queue", "reorder", "--order", "FG-2,FG-1,FG-4", "--expect-version", String(composedAgainst)],
  ]) {
    const res = forge(args);
    assert.equal(res.status, 1, args.join(" "));
    assert.match(res.stderr, /refuses — the queue moved underneath this/);
    assert.match(res.stderr, new RegExp(`queue version ${composedAgainst}`));
    assert.match(res.stderr, /Nothing was written/);
    assert.deepEqual(durableQueue(), before, `${args.join(" ")} must write nothing`);
  }

  // The control: the SAME submission against the version the queue is actually at
  // applies, so the guard refuses staleness and not the verb.
  const res = forge([
    "queue",
    "rank-before",
    "FG-2",
    "FG-4",
    "--expect-version",
    String(before.version),
    "--json",
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(durableQueue().order, ["FG-2", "FG-4", "FG-1"]);
});

test("FG-591: a malformed --expect-version or --to is refused, never reinterpreted", () => {
  migrate();
  for (const id of ["FG-1", "FG-2"]) assert.equal(forge(["queue", "enqueue", id]).status, 0);
  const before = durableQueue();

  for (const raw of ["1.9", "2x", "-1", "abc", "+2", " 2", ""]) {
    const res = forge(["queue", "reorder", "FG-1", "--to", "2", "--expect-version", raw]);
    assert.equal(res.status, 1, `--expect-version '${raw}' must refuse`);
    assert.match(res.stderr, /queue reorder refuses — --expect-version must be a whole non-negative number/);
    assert.deepEqual(durableQueue(), before, `--expect-version '${raw}' must write nothing`);

    const moved = forge(["queue", "reorder", "FG-1", "--to", raw]);
    assert.equal(moved.status, 1, `--to '${raw}' must refuse`);
    assert.match(moved.stderr, /queue reorder refuses — --to must be a whole positive number/);
    assert.deepEqual(durableQueue(), before, `--to '${raw}' must write nothing`);
  }

  // 0 is a LEGAL queue version (a queue that has never moved) and an ILLEGAL
  // position — the two flags parse differently on purpose.
  const zero = forge(["queue", "reorder", "FG-1", "--to", "0"]);
  assert.equal(zero.status, 1);
  assert.match(zero.stderr, /--to must be a whole positive number/);
  const versionZero = forge(["queue", "reorder", "FG-1", "--to", "2", "--expect-version", "0"]);
  assert.equal(versionZero.status, 1);
  assert.match(versionZero.stderr, /the queue moved underneath this/);
  assert.deepEqual(durableQueue(), before);
});

test("FG-591: rank-before refuses a non-member and a self-reference, and writes nothing", () => {
  migrate();
  assert.equal(forge(["queue", "enqueue", "FG-1"]).status, 0);
  assert.equal(forge(["queue", "enqueue", "FG-2"]).status, 0);
  const before = durableQueue();

  let res = forge(["queue", "rank-before", "FG-1", "FG-4"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /queue rank-before refuses/);
  assert.match(res.stderr, /is not in the operator queue/);
  assert.deepEqual(durableQueue(), before);

  res = forge(["queue", "rank-after", "FG-1", "FG-1"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot be ranked relative to itself/);
  assert.deepEqual(durableQueue(), before);

  res = forge(["queue", "dequeue", "FG-4"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /dequeue refuses — FG-4 is not in the operator queue/);
  assert.deepEqual(durableQueue(), before);
});

// ─── the distinction the board must not collapse ────────────────────────────

test("FG-591: a compatibility wait is QUEUED with its explanation and never Blocked", () => {
  migrate();
  for (const id of ["FG-1", "FG-2", "FG-4"]) assert.equal(forge(["queue", "enqueue", id]).status, 0);

  // FG-1 is reserved and executing. FG-2 therefore cannot safely overlap it — a
  // TEMPORARY scheduling fact that clears itself. FG-4 carries a real blocker —
  // a DURABLE per-ticket fact somebody has to clear.
  insertLiveClaim("FG-1", "dispatcher-alpha");
  insertBlocker("FG-4", "waiting on an upstream release");

  const ranksBefore = ranksById();
  const b = board();

  const waiting = rowFor(b, "FG-2");
  assert.equal(waiting.projection, "queued", "a scheduling wait stays QUEUED");
  assert.equal(waiting.blocked, false, "a scheduling wait is NOT a blocker");
  assert.equal(waiting.scan.reason, "incompatible");
  assert.match(String(waiting.scan.detail), /waiting for FG-1 to finish/);

  const blocked = rowFor(b, "FG-4");
  assert.equal(blocked.projection, "blocked");
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.scan.reason, "queue_blocked");
  assert.equal(blocked.queued, true, "a blocked entry keeps its membership");
  assert.equal(blocked.rank, ranksBefore["FG-4"], "a blocked entry keeps its rank");

  // The claimed ticket is distinguishable from both.
  const claimed = rowFor(b, "FG-1");
  assert.equal(claimed.scan.reason, "already_claimed");
  assert.equal(claimed.claim?.owner, "dispatcher-alpha");

  // Reading the board writes nothing — no rank moved, and no blocker_evidence row
  // was invented for the scheduling wait.
  assert.deepEqual(ranksById(), ranksBefore);
  assert.equal(
    withStore(
      (db) =>
        (db.prepare(`SELECT COUNT(*) AS n FROM blocker_evidence`).get() as { n: number }).n,
    ),
    1,
    "a scheduling wait must never become a blocker_evidence row",
  );

  // And the human board renders them as different things, in different columns.
  const res = forge(["queue", "list"]);
  assert.equal(res.status, 0, res.stderr);
  const sections = splitSections(res.stdout);
  assert.match(sections["Queued"] ?? "", /FG-2/);
  assert.match(sections["Queued"] ?? "", /waiting \(scheduling\): waiting for FG-1 to finish/);
  assert.match(sections["Blocked"] ?? "", /FG-4/);
  assert.match(sections["Blocked"] ?? "", /blocked: /);
  assert.doesNotMatch(sections["Blocked"] ?? "", /FG-2/, "a scheduling wait must not render as Blocked");
  assert.doesNotMatch(sections["Queued"] ?? "", /FG-4/);
});

/** Split the human board into its projection sections, so "renders under Blocked"
 *  is asserted structurally rather than by hunting for a substring anywhere. */
function splitSections(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | null = null;
  for (const line of stdout.split("\n")) {
    const header = line.match(/^ {2}([A-Za-z ]+) \(\d+\)$/);
    if (header) {
      current = header[1]!;
      out[current] = "";
      continue;
    }
    if (current !== null && line.startsWith("    ")) out[current] += `${line}\n`;
    else if (current !== null && line.trim().length > 0) current = null;
  }
  return out;
}

// ─── the parity guard ───────────────────────────────────────────────────────

test("FG-591: `queue list`'s reasons agree with claimNextEligible's own scan, entry by entry", () => {
  migrate();
  for (const id of ["FG-1", "FG-2", "FG-4"]) assert.equal(forge(["queue", "enqueue", id]).status, 0);
  insertLiveClaim("FG-1", "dispatcher-alpha");
  insertBlocker("FG-4", "waiting on an upstream release");
  // Ranked but never selected, so the scan has a `not_a_queue_member` entry too.
  assert.equal(forge(["backlog", "rank", "FG-3"]).status, 0);

  // The board FIRST: the probe below may grant a claim, and the comparison must be
  // between two views of the same store state.
  const b = board();
  const scanned = runScanProbe();

  assert.ok(scanned.length >= 4, `expected the primitive to scan the whole domain, got ${scanned.length}`);
  for (const entry of scanned) {
    const row = rowFor(b, entry.ticketId);
    assert.equal(
      row.scan.reason,
      entry.reason,
      `${entry.ticketId}: the board says '${row.scan.reason}', the claim primitive says '${entry.reason}'`,
    );
    assert.equal(
      row.scan.detail,
      entry.detail,
      `${entry.ticketId}: the two detail strings must be the same sentence, not two paraphrases`,
    );
  }
});

type ScanEntryJson = { ticketId: string; rank: number | null; reason: string; detail: string | null };

/** Run the REAL claim primitive over the same store, in its own process, with the
 *  same host-scope compatibility predicate `queue list` uses. Written to the temp
 *  dir rather than the repo: it is this test's fixture, not a shipped module. Its
 *  imports are absolute repo paths, so the store modules still resolve
 *  better-sqlite3 from the repo's own node_modules. */
function runScanProbe(): ScanEntryJson[] {
  const probe = join(root, "scan-probe.ts");
  writeFileSync(
    probe,
    [
      `import { claimNextEligible } from ${JSON.stringify(join(repoRoot, "src/store/queue-claims.ts"))};`,
      `import { hydrateActiveRunFacts, makeCompatibilityPredicate } from ${JSON.stringify(
        join(repoRoot, "src/queue/compatibility.ts"),
      )};`,
      `const projectKey = process.argv[2]!;`,
      `const facts = hydrateActiveRunFacts({ projectKey, capacityScope: "host" });`,
      `const res = claimNextEligible({`,
      `  projectKey,`,
      `  owner: "parity-probe",`,
      `  capacity: 99,`,
      `  capacityScope: "host",`,
      `  leaseTtlMs: 15 * 60_000,`,
      `  isCompatible: makeCompatibilityPredicate(facts),`,
      `});`,
      `process.stdout.write(JSON.stringify(res.scanned));`,
      "",
    ].join("\n"),
  );
  const res = spawnSync(tsx, [probe, readProjectKey()], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: home,
      FORGE_DB_PATH: join(home, "forge.db"),
    },
  });
  assert.equal(res.status, 0, `scan probe failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as ScanEntryJson[];
}
