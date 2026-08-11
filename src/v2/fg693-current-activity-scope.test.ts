// FG-693 (fix batch) — THE SHARED CURRENT-ACTIVITY DERIVATION SCOPES BY IDENTITY.
//
// THE DEFECT. `deriveCurrentActivity` scoped by raw strings on both halves:
// `projectDirs.includes(projectDir)` in process and `r.project_dir IN (...)` in SQL.
// One checkout has many names — a symlinked parent, a system directory exposed under
// two prefixes, a relative spelling, a trailing separator — so a run, launch or CI
// observation recorded under one spelling was invisible to a scope naming another.
// This is the ONE derivation `forge status` and the dashboard both call (BD-9), so a
// single aliased spelling hid live work on BOTH surfaces at once, and the two
// surfaces AGREED about the wrong answer.
//
// WHAT THIS FILE ASSERTS, and how (AC5's seam rule taken literally): every assertion
// drives `deriveCurrentActivity` — the production entry point both surfaces call —
// with a scope spelled differently from what the rows recorded. Calling the identity
// helper directly would satisfy nothing. The three sections are covered separately
// because they reach their project home three different ways: `agents` through the
// run row, `launches`/`hostVerification` through the observation row, and
// `requiredCi` through the event payload plus the run and review anchors.
//
// FALSIFICATION IS STRUCTURAL: every positive case below is a scope whose bytes are
// NOT the recorded bytes, so restoring raw string equality at either seam turns it
// red. `identityDidTheWork` asserts that precondition explicitly rather than leaving
// it to inspection.
//
// PORTABLE BY CONSTRUCTION: every alias is one this file CREATES. No case depends on
// an alias a particular operating system happens to provide, and no case names a
// prefix or branches on a platform — which is the reason the earlier coverage was
// CI-green and host-red.

import { test, describe, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { makeInMemoryDb } from "../store/db.js";
import { CI_OBSERVED_EVENT_TYPE, deriveCurrentActivity, renderCurrentActivityLines } from "./current-activity.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

let root: string;
/** The project under test, as CREATED and as PROVEN. */
let asCreated: string;
let physical: string;
/** A distinct physical directory whose lexical path shares the project's prefix. */
let sibling: string;
let links: string;
/** A recorded spelling whose directory is GONE — nothing about it can be proven. */
let deleted: string;

let db: DatabaseInstance;

before(() => {
  root = mkdtempSync(join(tmpdir(), "fg693-activity-"));
  const trees = join(root, "trees");
  links = join(root, "links");
  mkdirSync(join(trees, "alpha"), { recursive: true });
  mkdirSync(join(trees, "alpha-sibling"), { recursive: true });
  mkdirSync(links, { recursive: true });
  symlinkSync(trees, join(links, "parent"));
  symlinkSync(join(trees, "alpha"), join(links, "alpha"));
  asCreated = join(trees, "alpha");
  physical = realpathSync(asCreated);
  sibling = realpathSync(join(trees, "alpha-sibling"));
  deleted = join(trees, "gone");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  db = makeInMemoryDb();
});

afterEach(() => {
  db.close();
});

/** Every spelling of ONE checkout that must resolve to ONE identity. */
function spellings(): ReadonlyArray<readonly [label: string, spelling: string]> {
  return [
    ["canonical", physical],
    ["as-created (a native alias where the temp root is itself linked)", asCreated],
    ["symlinked parent", join(links, "parent", "alpha")],
    ["direct symlink to the checkout", join(links, "alpha")],
    ["trailing separator", physical + sep],
    // Concatenated, not `join`ed: join() collapses `.` and `..`, which would hand the
    // scope a spelling the defect never saw.
    ["a `.` segment", `${join(root, "trees")}${sep}.${sep}alpha`],
    ["a `..` segment through the sibling", `${join(root, "trees")}${sep}alpha-sibling${sep}..${sep}alpha`],
    ["relative to the process cwd", relative(process.cwd(), physical)],
  ];
}

/** The spellings a raw-string comparison could NOT have matched against `recorded`. */
function identityDidTheWork(recorded: string): ReadonlyArray<readonly [string, string]> {
  return spellings().filter(([, spelling]) => spelling !== recorded);
}

function addRun(id: string, projectDir: string | null, canonical: string | null, status = "active"): void {
  // The two-column shape forge's OWN writer produces (insertRun: the caller's bytes in
  // project_dir, the PROVEN identity beside them). A legacy row passes canonical=null,
  // which is the PRE-FG-693 writer shape — a test that wrote those through today's
  // writer could not detect the compatibility defect.
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir, project_dir_canonical)
     VALUES (?, 'feature', ?, ?, ?, ?, ?)`,
  ).run(id, `run ${id}`, status, ago(3_600_000), projectDir, canonical);
}

function addTask(id: string, runId: string, status = "running"): void {
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at)
     VALUES (?, ?, 'implementation', 'engineer', ?, '{}', ?, ?)`,
  ).run(id, runId, status, ago(600_000), ago(600_000));
}

function addLaunch(id: string, projectDir: string | null, canonical: string | null, runId: string | null = null): void {
  db.prepare(
    `INSERT INTO launch_observations
       (launch_id, name, command, cwd, project_dir, project_dir_canonical, association_kind, run_id,
        started_at, observed_at, state, purpose, terminal)
     VALUES (?, 'test:all', ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'host_verification', 0)`,
  ).run(
    id,
    JSON.stringify(["npm", "run", "test:all"]),
    projectDir ?? tmpdir(),
    projectDir,
    canonical,
    runId === null ? "cwd" : "explicit",
    runId,
    ago(60_000),
    ago(60_000),
  );
}

function addCi(runId: string | null, projectDir: string, sha: string, ticketId = "FG-693"): void {
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`).run(
    runId,
    CI_OBSERVED_EVENT_TYPE,
    JSON.stringify({
      attemptId: `attempt-${sha.slice(0, 4)}`,
      ticketId,
      projectDir,
      candidateSha: sha,
      observedAt: ago(60_000),
      outcome: "pending",
      unavailableReason: null,
      contexts: [{ context: "test", state: "pending", url: null, observedAt: ago(60_000) }],
    }),
    ago(60_000),
  );
}

const CURRENT_SHA = "c".repeat(40);

describe("FG-693: the agents section is scoped by identity", () => {
  test("a task of a run recorded under an ALIAS is returned through every spelling of its checkout", () => {
    addRun("run-alias", join(links, "alpha"), physical);
    addTask("task-alias", "run-alias");

    for (const [label, spelling] of spellings()) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.deepEqual(activity.agents.map((a) => a.taskId), ["task-alias"], `agents scoped by ${label}`);
      assert.equal(activity.agents[0]?.projectDir, join(links, "alpha"), "presentation keeps the recorded bytes");
    }
    assert.ok(identityDidTheWork(join(links, "alpha")).length >= 5, "or nothing here is falsifiable");
  });

  test("a LEGACY row — recorded bytes, no proven identity — is still reached through its tree's other spellings", () => {
    addRun("run-legacy", join(links, "parent", "alpha"), null);
    addTask("task-legacy", "run-legacy");

    for (const [label, spelling] of identityDidTheWork(join(links, "parent", "alpha"))) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.deepEqual(activity.agents.map((a) => a.taskId), ["task-legacy"], `legacy row scoped by ${label}`);
    }
  });

  test("a distinct physical directory sharing a lexical prefix stays OUT of scope", () => {
    addRun("run-sibling", sibling, sibling);
    addTask("task-sibling", "run-sibling");
    addRun("run-alpha", physical, physical);
    addTask("task-alpha", "run-alpha");

    for (const [label, spelling] of spellings()) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.deepEqual(activity.agents.map((a) => a.taskId), ["task-alpha"], `the sibling is never absorbed (${label})`);
    }
    const own = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [sibling] } });
    assert.deepEqual(own.agents.map((a) => a.taskId), ["task-sibling"], "and the sibling still scopes to itself");
  });

  test("a scope whose directory is GONE claims only the rows recorded under its own bytes", () => {
    addRun("run-gone", deleted, null);
    addTask("task-gone", "run-gone");
    addRun("run-alpha", physical, physical);
    addTask("task-alpha", "run-alpha");

    const gone = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [deleted] } });
    assert.deepEqual(gone.agents.map((a) => a.taskId), ["task-gone"], "byte equality is the only relation left");
    const here = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [physical] } });
    assert.deepEqual(here.agents.map((a) => a.taskId), ["task-alpha"], "and those bytes are never re-attributed");
  });

  test("an EMPTY project scope still matches nothing", () => {
    addRun("run-alpha", physical, physical);
    addTask("task-alpha", "run-alpha");
    assert.deepEqual(deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [] } }).agents, []);
  });

  test("an array scope of many spellings of ONE checkout returns each task ONCE", () => {
    addRun("run-alpha", asCreated, physical);
    addTask("task-alpha", "run-alpha");
    const every = spellings().map(([, spelling]) => spelling);
    const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: every } });
    assert.deepEqual(activity.agents.map((a) => a.taskId), ["task-alpha"], "never one row per spelling");
  });
});

describe("FG-693: the launch sections are scoped by identity", () => {
  test("a launch recorded under an ALIAS is placed in the project through every spelling", () => {
    addLaunch("lch-alias0", join(links, "parent", "alpha"), physical);

    for (const [label, spelling] of spellings()) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.deepEqual(
        activity.hostVerification.map((l) => l.launchId),
        ["lch-alias0"],
        `host-verification launch scoped by ${label}`,
      );
      assert.equal(activity.hostVerification[0]?.projectDir, join(links, "parent", "alpha"), "recorded bytes render");
    }
  });

  test("a legacy launch row with no proven identity is still reached, and a sibling is not", () => {
    addLaunch("lch-legacy0", asCreated, null);
    addLaunch("lch-sibling", sibling, sibling);

    for (const [label, spelling] of identityDidTheWork(asCreated)) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.deepEqual(activity.hostVerification.map((l) => l.launchId), ["lch-legacy0"], `scoped by ${label}`);
    }
  });
});

describe("FG-693: the required-CI section is scoped by identity", () => {
  test("an observation recorded under one spelling is current under every other spelling", () => {
    addRun("run-ci", asCreated, physical);
    addCi("run-ci", asCreated, CURRENT_SHA);

    for (const [label, spelling] of spellings()) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.equal(activity.requiredCi.state, "observed", `CI state scoped by ${label}`);
      assert.deepEqual(
        activity.requiredCi.observations.map((o) => o.candidateSha),
        [CURRENT_SHA],
        `CI observation scoped by ${label}`,
      );
      assert.match(renderCurrentActivityLines(activity).join("\n"), new RegExp(CURRENT_SHA), `rendered for ${label}`);
    }
  });

  test("the observation's OWN project decides it — a run in another checkout does not drag it in", () => {
    addRun("run-sibling", sibling, sibling);
    addCi("run-sibling", sibling, "d".repeat(40));

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [physical] } });
    assert.deepEqual(activity.requiredCi.observations, [], "another checkout's CI is not this project's");
    assert.equal(activity.requiredCi.state, "no_current_candidate", "and nothing in scope was owed an observation");
  });

  test("`not observed` still means CURRENT WORK with no observation — through an aliased spelling too", () => {
    addRun("run-open", join(links, "alpha"), physical);

    for (const [label, spelling] of spellings()) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.equal(activity.requiredCi.state, "not_observed", `an active run in scope is owed an observation (${label})`);
    }
  });

  test("an open review anchors its workspace through an aliased spelling", () => {
    db.prepare(
      `INSERT INTO reviews (id, run_id, ticket_id, workspace_dir, state, created_at, updated_at)
       VALUES ('rev-alias', NULL, 'FG-693', ?, 'verifying', ?, ?)`,
    ).run(join(links, "parent", "alpha"), ago(3_600_000), ago(60_000));
    addCi(null, asCreated, CURRENT_SHA);

    for (const [label, spelling] of spellings()) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.deepEqual(
        activity.requiredCi.observations.map((o) => o.candidateSha),
        [CURRENT_SHA],
        `a run-less review-loop round scoped by ${label}`,
      );
    }
  });
});

describe("FG-693: the run-scoped and host-wide reads are unchanged", () => {
  test("a run-scoped read is not narrowed by any project spelling", () => {
    addRun("run-alias", join(links, "alpha"), physical);
    addTask("task-alias", "run-alias");
    addCi("run-alias", asCreated, CURRENT_SHA);

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-alias" } });
    assert.deepEqual(activity.agents.map((a) => a.taskId), ["task-alias"]);
    assert.deepEqual(activity.requiredCi.observations.map((o) => o.candidateSha), [CURRENT_SHA]);
  });

  test("a host-wide read returns every checkout, whatever it was recorded under", () => {
    addRun("run-alpha", join(links, "alpha"), physical);
    addTask("task-alpha", "run-alpha");
    addRun("run-sibling", sibling, sibling);
    addTask("task-sibling", "run-sibling");
    addRun("run-gone", deleted, null);
    addTask("task-gone", "run-gone");

    const activity = deriveCurrentActivity(db, { now: NOW });
    assert.deepEqual(
      activity.agents.map((a) => a.taskId).sort(),
      ["task-alpha", "task-gone", "task-sibling"],
      "an unscoped read filters nothing out",
    );
  });
});
