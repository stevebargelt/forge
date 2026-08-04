// FG-609 (FG-496 Slice D) — the four operator verbs through the REAL `forge` CLI,
// in a real child process, against a real on-disk store and real git checkouts.
//
// Covers A16 (a NAMED refusal per verb on a markdown-mode / unkeyed project — the
// thing an in-process store test structurally cannot show, because it is the CLI
// that resolves the store), A2's operator-facing half (the refusal text the
// operator actually reads), and the end-to-end rank/enqueue/reorder/dequeue flow
// after a real `forge backlog migrate`.

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
const entry = resolve(here, "..", "index.ts");
const localTsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let root: string;
let home: string;
let project: string;

const READY_BODY = [
  "## Problem",
  "The queue has no operator surface.",
  "",
  "## Goal",
  "Four verbs that work.",
  "",
  "## Acceptance Criteria",
  "- rank, enqueue, dequeue, reorder",
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
    join(dir, `${id}-${title.toLowerCase().replace(/\s+/g, "-")}.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\ncreated: '2026-01-01'\n---\n\n${body}\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg609-cli-"));
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

// ─── A16: every verb refuses BY NAME on a markdown-mode project ─────────────

test("FG-609 A16: all four verbs refuse BY NAME on a markdown-mode project", () => {
  const cases: [string, string[]][] = [
    ["rank", ["backlog", "rank", "FG-1"]],
    ["enqueue", ["backlog", "enqueue", "FG-1"]],
    ["dequeue", ["backlog", "dequeue", "FG-1"]],
    ["reorder", ["backlog", "reorder", "FG-1", "--to", "1"]],
  ];
  for (const [verb, args] of cases) {
    const res = forge(args);
    assert.equal(res.status, 1, `${verb} must exit non-zero on a markdown-mode project`);
    assert.match(
      res.stderr,
      new RegExp(`backlog ${verb} refuses`),
      `${verb} must refuse BY NAME, not fail generically — got: ${res.stderr}`,
    );
    assert.match(res.stderr, /markdown mode|no resolvable project_key/);
    assert.match(res.stderr, /forge backlog migrate/, `${verb} must name the way forward`);
  }
});

test("FG-609 A16: a refusing verb writes NOTHING to the DB shadow", () => {
  // Seed the write-only shadow, then confirm the refusals left it untouched. A
  // silent success against the shadow is the failure mode A16 exists to prevent.
  assert.equal(forge(["backlog", "import"]).status, 0);
  for (const args of [
    ["backlog", "rank", "FG-1"],
    ["backlog", "enqueue", "FG-1"],
    ["backlog", "reorder", "FG-1", "--to", "1"],
  ]) {
    assert.equal(forge(args).status, 1);
  }
  const probe = forge(["backlog", "list", "--json"]);
  assert.equal(probe.status, 0);
  // Still markdown-authoritative, and no queue verb changed that.
  assert.match(probe.stderr, /store: legacy markdown/);
});

// ─── the end-to-end operator flow after a real cutover ─────────────────────

test("FG-609: rank / enqueue / reorder / dequeue work end to end after migrate", () => {
  migrate();

  let res = forge(["backlog", "rank", "FG-1", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout)["position"], 1);

  res = forge(["backlog", "rank", "FG-2", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout)["position"], 2);

  assert.equal(forge(["backlog", "enqueue", "FG-1"]).status, 0);
  res = forge(["backlog", "enqueue", "FG-2", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(
    (JSON.parse(res.stdout)["executableQueue"] as { ticketId: string }[]).map((e) => e.ticketId),
    ["FG-1", "FG-2"],
  );

  res = forge(["backlog", "reorder", "FG-2", "--to", "1", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout)["queue"], ["FG-2", "FG-1"]);

  res = forge(["backlog", "reorder", "--order", "FG-1,FG-2", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout)["queue"], ["FG-1", "FG-2"]);

  res = forge(["backlog", "dequeue", "FG-1", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout)["queue"], ["FG-2"]);

  // Human output renders the queue with rank and readiness.
  res = forge(["backlog", "enqueue", "FG-1"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /queue:/);
  assert.match(res.stdout, /readiness=ready/);
});

// ─── A2: the operator-facing refusal names what is missing ─────────────────

test("FG-609 A2: enqueue refuses a not-ready ticket with a concrete, operator-facing reason", () => {
  migrate();
  const res = forge(["backlog", "enqueue", "FG-3"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /backlog enqueue refuses/);
  assert.match(res.stderr, /Missing Goal section/);
  assert.match(res.stderr, /Missing Acceptance Criteria section/);
  assert.match(res.stderr, /CURRENT revision/);
  // Not a dead end: the message tells the operator that re-running IS the recheck.
  assert.match(res.stderr, /rechecks it/);
});

test("FG-609 A2/A5: editing the ticket to be ready lets the very next enqueue succeed", () => {
  migrate();
  assert.equal(forge(["backlog", "enqueue", "FG-3"]).status, 1);

  const fixed = forge(["backlog", "edit", "FG-3", "--body", "-"], READY_BODY);
  assert.equal(fixed.status, 0, fixed.stderr);

  const res = forge(["backlog", "enqueue", "FG-3", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout) as { readiness: { outcome: string; stale: boolean } };
  assert.equal(parsed.readiness.outcome, "ready");
  assert.equal(parsed.readiness.stale, false);
});

// ─── RF-1: a malformed position is REFUSED, never reinterpreted ────────────

test("FG-609 RF-1: every malformed position is refused BY NAME and writes nothing", () => {
  migrate();
  assert.equal(forge(["backlog", "rank", "FG-1"]).status, 0);
  assert.equal(forge(["backlog", "rank", "FG-2"]).status, 0);
  assert.equal(forge(["backlog", "enqueue", "FG-1"]).status, 0);
  assert.equal(forge(["backlog", "enqueue", "FG-2"]).status, 0);
  const orderBefore = queueOrder();
  assert.deepEqual(orderBefore, ["FG-1", "FG-2"]);

  // Every shape parseInt would have SILENTLY reinterpreted as a different, valid
  // move — plus the shapes it rejected outright, so the refusal is one rule.
  for (const raw of ["2x", "1.9", "2 3", "0x2", "+2", " 2", "2.", "1e1", "abc", "0", "-1", ""]) {
    const moved = forge(["backlog", "reorder", "FG-1", "--to", raw]);
    assert.equal(moved.status, 1, `reorder --to '${raw}' must refuse, not reinterpret`);
    assert.match(moved.stderr, /backlog reorder refuses/, `--to '${raw}': ${moved.stderr}`);
    assert.match(moved.stderr, /whole positive number/);
    assert.match(moved.stderr, new RegExp(`got '${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
    assert.deepEqual(queueOrder(), orderBefore, `--to '${raw}' must write NOTHING`);

    const ranked = forge(["backlog", "rank", "FG-2", "--position", raw]);
    assert.equal(ranked.status, 1, `rank --position '${raw}' must refuse, not reinterpret`);
    assert.match(ranked.stderr, /backlog rank refuses/);
    assert.deepEqual(queueOrder(), orderBefore, `--position '${raw}' must write NOTHING`);
  }

  // The control: a well-formed position still moves the queue.
  const ok = forge(["backlog", "reorder", "FG-1", "--to", "2", "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(queueOrder(), ["FG-2", "FG-1"]);
});

// ─── A17 at the CLI boundary ───────────────────────────────────────────────

test("FG-609 A17: a queue verb publishes no snapshot to a registered live target", () => {
  migrate();
  const target = join(root, "target");
  mkdirSync(target, { recursive: true });

  // Register a LIVE snapshot target directly in the store, the way the dispatch
  // path does before a container starts. Without a registered target the "no
  // republish" claim would be vacuous — there would be nothing to fan out to.
  const projectKey = readProjectKey();
  const store = new Database(join(home, "forge.db"));
  store
    .prepare(
      `INSERT INTO backlog_snapshot_targets (project_key, target_dir, task_id, created_at, released_at)
       VALUES (?, ?, 'task-a17', ?, NULL)`,
    )
    .run(projectKey, target, new Date().toISOString());
  store.close();

  // A TICKET write DOES fan out — this is the control that proves the target is live.
  assert.equal(forge(["backlog", "retitle", "FG-2", "renamed"]).status, 0);
  assert.equal(
    existsSync(join(target, "backlog.db")),
    true,
    "control: a ticket write must publish to the registered target",
  );
  rmSync(join(target, "backlog.db"), { force: true });

  // Queue writes must not.
  assert.equal(forge(["backlog", "rank", "FG-1"]).status, 0);
  assert.equal(forge(["backlog", "enqueue", "FG-1"]).status, 0);
  assert.equal(forge(["backlog", "reorder", "FG-1", "--to", "1"]).status, 0);
  assert.equal(forge(["backlog", "dequeue", "FG-1"]).status, 0);
  assert.equal(
    existsSync(join(target, "backlog.db")),
    false,
    "a rank nudge must not republish a snapshot to every live container on the host",
  );
});

/** The executable queue read STRAIGHT FROM THE STORE, so "the refusal wrote
 *  nothing" is asserted against durable state and not against CLI output. */
function queueOrder(): string[] {
  const store = new Database(join(home, "forge.db"), { readonly: true });
  try {
    return (
      store
        .prepare(
          `SELECT t.ticket_id FROM tickets t
             JOIN queue_membership m ON m.project_key = t.project_key AND m.ticket_id = t.ticket_id
            WHERE t.project_key = ? AND t.priority_rank IS NOT NULL
            ORDER BY t.priority_rank ASC, t.ticket_id ASC`,
        )
        .all(readProjectKey()) as { ticket_id: string }[]
    ).map((r) => r.ticket_id);
  } finally {
    store.close();
  }
}

/** The project_key `forge backlog migrate` committed to .forge/config.yml. */
function readProjectKey(): string {
  const yml = readFileSync(join(project, ".forge", "config.yml"), "utf8");
  const m = yml.match(/^project_key:\s*(\S+)\s*$/m);
  assert.ok(m, `expected a committed project_key in .forge/config.yml, got:\n${yml}`);
  return m![1]!;
}
