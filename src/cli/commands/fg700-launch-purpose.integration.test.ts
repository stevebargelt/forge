// FG-700 (AC2) — the SUBMISSION surface, at the real CLI boundary.
//
// The derivation only ever reads what a submitter declared, so the property that makes
// FG-700 true on an operator's machine is that `forge launch run` can DECLARE a purpose
// and that the declaration reaches the durable row. Asserting that over
// `recordLaunchObservation` would prove the store; this spawns the real CLI, against a
// real store, under a real tmux owner, and then asks `forge status --json` — the surface
// an operator actually reads — which section the launch landed in.
//
// The two launches differ ONLY in `--purpose`: same `--run`, same `--ticket`, same
// shape of command. That is the whole ticket in one fixture — association is not
// purpose, and carrying `--run`/`--ticket` is not a declaration of host verification.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CurrentActivity } from "../../v2/current-activity.js";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CLI = join(REPO, "src", "cli", "index.ts");

let home = "";
let dbPath = "";
const PROJECT = "/tmp/fg700-project";

function forge(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: dbPath, NO_NOTIFY: "true" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** The declared purpose as the STORE holds it — read through a separate connection, so
 *  this is the durable row and not the CLI's own view of it. */
function purposeOf(launchId: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT purpose FROM launch_observations WHERE launch_id = ?`).get(launchId) as { purpose: string | null } | undefined;
    return row === undefined ? null : row.purpose;
  } finally {
    db.close();
  }
}

function launchIds(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT launch_id FROM launch_observations`).all() as Array<{ launch_id: string }>).map((r) => r.launch_id);
  } finally {
    db.close();
  }
}

/** `forge launch run --json …` → the launch id. */
function launch(args: string[]): string {
  const res = forge(["launch", "run", "--json", ...args]);
  assert.equal(res.status, 0, `forge launch run failed: ${res.stderr}\n${res.stdout}`);
  return (JSON.parse(res.stdout) as { id: string }).id;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "fg700-launch-"));
  dbPath = join(home, "forge.db");
  // A registered project home and an active run, so the two launches are placed
  // identically and only their DECLARED purpose can separate them. The store is created
  // through the ordinary open path (SCHEMA_SQL + applyMigrations) — the same shape the
  // CLI subprocess will open.
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-fg700','feature','purpose run','active', ?, ?)`)
    .run(new Date().toISOString(), PROJECT);
  db.close();
});

after(() => {
  // The launches sleep on purpose — a command that exits immediately is promoted
  // terminal by the very next `forge status` and leaves the in-flight set, which would
  // make every assertion below pass for the wrong reason. So they are killed here,
  // through the CLI's own verb.
  for (const id of home === "" ? [] : launchIds()) forge(["launch", "rm", id, "--force"]);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("FG-700 AC2 — `forge launch run` declares a purpose, and only that declaration classifies", () => {
  test("an unknown --purpose is REFUSED before anything is launched", () => {
    const before = launchIds().length;
    const res = forge(["launch", "run", "--purpose", "verification", "--run", "run-fg700", "--", "true"]);
    assert.notEqual(res.status, 0, "an unreadable declaration must not be silently downgraded to `generic`");
    const said = `${res.stderr}${res.stdout}`;
    assert.match(said, /unknown --purpose 'verification'/);
    assert.match(said, /host_verification/, "the refusal NAMES the vocabulary rather than leaving a submitter to guess");
    assert.equal(launchIds().length, before, "refuse-before-execute: nothing was started and nothing was recorded");
  });

  test("`--purpose host_verification` is recorded durably and renders as THE host-verification row", () => {
    const verify = launch(["--purpose", "host_verification", "--run", "run-fg700", "--ticket", "FG-700", "--name", "verify", "--", "sleep", "60"]);
    assert.equal(purposeOf(verify), "host_verification");

    const res = forge(["status", "run-fg700", "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const activity = (JSON.parse(res.stdout) as { currentActivity: CurrentActivity }).currentActivity;
    assert.deepEqual(activity.hostVerification.map((l) => l.launchId), [verify]);
  });

  test("the SAME association with `--purpose agent_invoke` renders as a launch diagnostic, never as host verification", () => {
    const invoke = launch(["--purpose", "agent_invoke", "--run", "run-fg700", "--ticket", "FG-700", "--name", "engineer", "--", "sleep", "60"]);
    assert.equal(purposeOf(invoke), "agent_invoke");

    const activity = (JSON.parse(forge(["status", "run-fg700", "--json"]).stdout) as { currentActivity: CurrentActivity }).currentActivity;
    assert.equal(activity.hostVerification.some((l) => l.launchId === invoke), false,
      "identical --run/--ticket to the verification above — only the declaration differs");
    assert.equal(activity.launches.some((l) => l.launchId === invoke), true);
  });

  test("declaring NO purpose records `generic` — the association alone claims nothing", () => {
    const undeclared = launch(["--run", "run-fg700", "--ticket", "FG-700", "--name", "undeclared", "--", "sleep", "60"]);
    assert.equal(purposeOf(undeclared), "generic");

    const activity = (JSON.parse(forge(["status", "run-fg700", "--json"]).stdout) as { currentActivity: CurrentActivity }).currentActivity;
    assert.equal(activity.hostVerification.some((l) => l.launchId === undeclared), false);
    assert.equal(activity.launches.some((l) => l.launchId === undeclared), true);
  });

  test("`--help` publishes the vocabulary, so the flag is discoverable rather than folklore", () => {
    const help = forge(["launch", "run", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--purpose/);
    assert.match(help.stdout, /host_verification/);
  });
});
