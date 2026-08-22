// FG-745: GET /api/projects exposes OPERATOR-project membership, and the Projects
// presentation filter never hides live work.
//
//   - a Forge disposable-clone artifact (recorded purpose) is OMITTED from
//     /api/projects (AC1), yet its ACTIVE run still appears in /api/in-flight —
//     Current Activity is unaffected by the Projects filter (AC5);
//   - an unclassified, one-run, NO-REMOTE independent project stays VISIBLE and is
//     flagged `classification: "unclassified"` (AC4/AC8);
//   - every record carries structured purpose/classification, so the CLI and the
//     API agree on membership through the one shared seam (AC7).
//
// Real forge.db, real HTTP server, real fetch — the pattern the other dashboard
// route integration tests use.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const TEST_PORT = 18781;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "forge-fg745-membership-"));
const forgeHome = join(testHome, ".forge");
const reposRoot = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(reposRoot, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

function gitIn(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

// (a) A Forge disposable-clone artifact — a real dir with an ACTIVE run.
const artifactDir = join(reposRoot, "disposable-clone");
mkdirSync(artifactDir);
gitIn(artifactDir, ["init", "-b", "main"]);

// (d) A genuinely independent project: one run, NO git remote.
const independentDir = join(reposRoot, "independent-project");
mkdirSync(independentDir);
gitIn(independentDir, ["init", "-b", "main"]);

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);

  const insertRun = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  const insertRunning = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,created_at,started_at) VALUES (?,?,?,?,?,'{}',?,?)",
  );
  const insertDone = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
  );
  const insertPurpose = database.prepare(
    "INSERT INTO workspace_purposes (path,path_as_written,kind,project_identity,run_id,task_id,reason,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );

  // The artifact has a LIVE run (running task), so it survives the presentation
  // registry (inFlight>0) and its activity is real.
  insertRun.run("run-artifact", "feature", "Artifact Run", "active", "2026-08-20T10:00:00Z", artifactDir);
  insertRunning.run("running-a", "run-artifact", "engineer", "engineer", "running", "2026-08-20T10:00:00Z", "2026-08-20T10:00:00Z");
  insertPurpose.run(
    realpathSync(artifactDir), artifactDir, "disposable_clone", "pk-owner", "run-artifact", null, null, "creation",
    "2026-08-20T10:00:00Z", "2026-08-20T10:00:00Z",
  );

  // The independent project: exactly one COMPLETE run, no remote, no purpose row.
  insertRun.run("run-independent", "feature", "Independent Run", "complete", "2026-08-19T10:00:00Z", independentDir);
  insertDone.run("done-i", "run-independent", "engineer", "engineer", "complete", "2026-08-19T10:00:00Z", "2026-08-19T10:00:00Z", "2026-08-19T10:00:00Z");

  database.close();
}

const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

for (let attempt = 0; attempt < 75; attempt += 1) {
  try {
    await fetch(`${BASE}/`);
    break;
  } catch {
    if (attempt === 74) throw new Error("dashboard test server did not start");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

type Project = { key: string; label: string; projectDirs: string[]; purpose?: string; classification?: string };

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`);
  assert.equal(response.status, 200, `${path} must answer 200, not blank the surface`);
  return response.json();
}

test("GET /api/projects omits the classified disposable-clone artifact (AC1)", async () => {
  const projects = (await getJson("/api/projects")) as Project[];
  const dirs = projects.flatMap((p) => p.projectDirs);
  assert.ok(!dirs.includes(artifactDir), "a recorded disposable_clone is not a top-level Projects entry");
});

test("GET /api/projects keeps the one-run/no-remote independent project, flagged unclassified (AC4/AC8)", async () => {
  const projects = (await getJson("/api/projects")) as Project[];
  const independent = projects.find((p) => p.projectDirs.includes(independentDir));
  assert.ok(independent, "a real independent project with one run and no remote stays visible");
  assert.equal(independent.classification, "unclassified", "and is flagged so the operator can classify it");
});

test("every /api/projects record carries structured purpose + classification (AC7)", async () => {
  const projects = (await getJson("/api/projects")) as Project[];
  assert.ok(projects.length > 0);
  for (const p of projects) {
    assert.ok(typeof p.purpose === "string", "purpose is structured data on every record");
    assert.ok(typeof p.classification === "string", "classification is structured data on every record");
    assert.notEqual(p.classification, "artifact", "no artifact is ever returned as an operator project");
  }
});

test("the artifact's ACTIVE run still appears in Current Activity — the Projects filter never hides it (AC5)", async () => {
  const inFlight = (await getJson("/api/in-flight")) as unknown[];
  const serialized = JSON.stringify(inFlight);
  assert.match(serialized, /run-artifact/, "the active artifact's run is still visible in /api/in-flight");
});
