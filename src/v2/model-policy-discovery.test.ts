// FG-560 (step 6): evidence-based host + project policy discovery.
//
// Real store code against a real in-memory SQLite DB (makeInMemoryDb) plus real temp
// directories, so reachability and policy-file detection exercise the actual
// filesystem contract. Asserts the four states, linked-worktree collapse, the
// known-but-no-path registry case, registry read-only-ness, and the no-fleet-
// completeness honesty marker.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { discoverModelPolicies } from "./model-policy-discovery.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDir(withPolicy: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg560-disc-")));
  tmpDirs.push(dir);
  if (withPolicy) {
    mkdirSync(join(dir, ".forge"), { recursive: true });
    writeFileSync(join(dir, ".forge", "model-policy.yml"), "schema_version: 2\n");
  }
  return dir;
}

let runSeq = 0;
function insertRun(opts: {
  projectDir: string;
  canonical?: string | null;
  identity?: string | null;
  createdAt: string;
}): void {
  runSeq += 1;
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir, project_dir_canonical, project_identity)
     VALUES (?, 'wf', 't', 'complete', ?, ?, ?, ?)`,
  ).run(
    `run-${runSeq}`,
    opts.createdAt,
    opts.projectDir,
    opts.canonical ?? null,
    opts.identity ?? null,
  );
}

let campSeq = 0;
function insertCampaign(opts: { projectDir: string; canonical?: string | null; createdAt: string }): void {
  campSeq += 1;
  db.prepare(
    `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir, project_dir_canonical)
     VALUES (?, 'active', 'epic', 'x', 'auto', ?, ?, ?, ?)`,
  ).run(`camp-${campSeq}`, opts.createdAt, opts.createdAt, opts.projectDir, opts.canonical ?? null);
}

function insertHostVerification(opts: {
  projectDir: string;
  canonical?: string | null;
  recordedAt: string;
}): void {
  db.prepare(
    `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, recorded_at, project_dir_canonical)
     VALUES ('FG-1', ?, 'abc', 'gate', 'cmd', 0, ?, ?)`,
  ).run(opts.projectDir, opts.recordedAt, opts.canonical ?? null);
}

function registerProject(projectKey: string, evidenceKey: string): void {
  db.prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, 'remote', '2026-01-01T00:00:00Z')`,
  ).run(projectKey, evidenceKey);
}

const EMPTY_HOME = join(tmpdir(), "fg560-nonexistent-home-do-not-create");

test("host with no policy reports reachable-no-policy and never claims fleet completeness", () => {
  const d = discoverModelPolicies({ forgeHome: EMPTY_HOME });
  assert.equal(d.host.scope, "host");
  assert.equal(d.host.state, "reachable-no-policy");
  assert.equal(d.completeness, "historical-best-effort");
  assert.deepEqual(d.projects, []);
});

test("host with a policy file reports has-policy", () => {
  const home = makeDir(false);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "model-policy.yml"), "schema_version: 2\n");
  const d = discoverModelPolicies({ forgeHome: home });
  assert.equal(d.host.state, "has-policy");
  assert.equal(d.host.policyPath, join(home, "model-policy.yml"));
});

test("classifies has-policy, reachable-no-policy, and unreachable-deleted", () => {
  const withPolicy = makeDir(true);
  const noPolicy = makeDir(false);
  const gone = join(tmpdir(), "fg560-deleted-checkout-never-existed");

  insertRun({ projectDir: withPolicy, canonical: withPolicy, createdAt: "2026-08-03T00:00:00Z" });
  insertCampaign({ projectDir: noPolicy, canonical: noPolicy, createdAt: "2026-08-02T00:00:00Z" });
  insertHostVerification({ projectDir: gone, canonical: gone, recordedAt: "2026-08-01T00:00:00Z" });

  const d = discoverModelPolicies({ forgeHome: EMPTY_HOME });
  const byDir = new Map(d.projects.map((p) => [p.canonicalDir ?? p.projectDir, p]));

  assert.equal(byDir.get(withPolicy)?.state, "has-policy");
  assert.equal(byDir.get(withPolicy)?.policyPath, join(withPolicy, ".forge", "model-policy.yml"));
  assert.equal(byDir.get(noPolicy)?.state, "reachable-no-policy");

  const goneEntry = d.projects.find((p) => p.state === "unreachable-deleted");
  assert.ok(goneEntry, "expected an unreachable-deleted entry");
  assert.equal(goneEntry?.canonicalDir, null);
  assert.equal(goneEntry?.projectDir, gone);
});

test("two linked worktrees sharing a project_identity collapse to one entry", () => {
  const wtA = makeDir(true);
  const wtB = makeDir(false);
  const identity = "pk-shared-identity";

  insertRun({ projectDir: wtA, canonical: wtA, identity, createdAt: "2026-08-05T00:00:00Z" });
  insertRun({ projectDir: wtB, canonical: wtB, identity, createdAt: "2026-08-06T00:00:00Z" });

  const d = discoverModelPolicies({ forgeHome: EMPTY_HOME });
  assert.equal(d.projects.length, 1, "linked worktrees must collapse to one logical project");
  const only = d.projects[0]!;
  // wtA carries the policy; a reachable checkout WITH a policy wins the classification.
  assert.equal(only.state, "has-policy");
  assert.equal(only.identityKey, `id:${identity}`);
});

test("a campaign row with no identity folds into a run's identity group by proven path", () => {
  const dir = makeDir(false);
  const identity = "pk-folded";
  insertRun({ projectDir: dir, canonical: dir, identity, createdAt: "2026-08-05T00:00:00Z" });
  insertCampaign({ projectDir: dir, canonical: dir, createdAt: "2026-08-06T00:00:00Z" });

  const d = discoverModelPolicies({ forgeHome: EMPTY_HOME });
  assert.equal(d.projects.length, 1);
  const only = d.projects[0]!;
  assert.equal(only.identityKey, `id:${identity}`);
  assert.deepEqual([...only.evidenceSources].sort(), ["campaigns", "runs"]);
});

test("a registered project with no run row is known-but-no-path; registry is not modified", () => {
  const withRun = makeDir(false);
  registerProject("pk-has-runs", "repo-has-runs");
  insertRun({ projectDir: withRun, canonical: withRun, identity: "pk-has-runs", createdAt: "2026-08-04T00:00:00Z" });
  registerProject("pk-orphan", "repo-orphan");

  const before = db.prepare(`SELECT * FROM project_identity ORDER BY project_key`).all();
  const d = discoverModelPolicies({ forgeHome: EMPTY_HOME });
  const after = db.prepare(`SELECT * FROM project_identity ORDER BY project_key`).all();
  assert.deepEqual(after, before, "discovery must never mutate the registry");

  const orphan = d.projects.find((p) => p.state === "known-but-no-path");
  assert.ok(orphan, "expected a known-but-no-path entry");
  assert.equal(orphan?.projectKey, "pk-orphan");
  assert.equal(orphan?.projectDir, null);
  assert.equal(d.registeredNoPath, 1);

  // The registered project WITH a run is inspected, not orphaned.
  const inspected = d.projects.find((p) => p.projectKey === "pk-has-runs");
  assert.equal(inspected?.state, "reachable-no-policy");
  assert.equal(d.registeredInspected, 1);
});

test("registry match by repo-evidence key when a run recorded the evidence key, not the pk key", () => {
  const dir = makeDir(false);
  registerProject("pk-evidence-linked", "repo-evidence-linked");
  // The run recorded the repo- evidence key (declared before registration).
  insertRun({ projectDir: dir, canonical: dir, identity: "repo-evidence-linked", createdAt: "2026-08-04T00:00:00Z" });

  const d = discoverModelPolicies({ forgeHome: EMPTY_HOME });
  assert.equal(d.registeredNoPath, 0, "the evidence-key run links the registered project to a path");
  const entry = d.projects.find((p) => p.projectKey === "pk-evidence-linked");
  assert.ok(entry, "registered project should be linked via its repo-evidence key");
  assert.equal(entry?.state, "reachable-no-policy");
});
