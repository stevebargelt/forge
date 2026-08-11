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

/** `canonical` defaults to null — the payload shape written BEFORE the fix batch,
 *  which carries a spelling and nothing that proves it. Pass a value to write the
 *  shape today's observer produces: the caller's bytes, and the PROVEN identity
 *  beside them. */
function addCi(
  runId: string | null,
  projectDir: string,
  sha: string,
  ticketId = "FG-693",
  canonical: string | null = null,
): void {
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`).run(
    runId,
    CI_OBSERVED_EVENT_TYPE,
    JSON.stringify({
      attemptId: `attempt-${sha.slice(0, 4)}`,
      ticketId,
      projectDir,
      ...(canonical === null ? {} : { projectDirCanonical: canonical }),
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
    // RECORDED LINK-FREE, so the row is RETARGET-PROOF: its bytes already ARE the
    // physical path, and no link under them can have been repointed since it was
    // written. That is the compatibility AC6 promises, and it is the only shape a
    // NULL-canonical row can claim (see the retarget case below). Every SCOPE
    // spelling below still differs from those bytes, so raw string equality would
    // reach none of them.
    addRun("run-legacy", physical, null);
    addTask("task-legacy", "run-legacy");

    for (const [label, spelling] of identityDidTheWork(physical)) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.deepEqual(activity.agents.map((a) => a.taskId), ["task-legacy"], `legacy row scoped by ${label}`);
    }
    assert.ok(identityDidTheWork(physical).length >= 5, "or nothing here is falsifiable");
  });

  test("a legacy row recorded with a TRAILING SEPARATOR is still retarget-proof — the bytes are the physical path", () => {
    addRun("run-trailing", physical + sep, null);
    addTask("task-trailing", "run-trailing");

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [join(links, "alpha")] } });
    assert.deepEqual(
      activity.agents.map((a) => a.taskId),
      ["task-trailing"],
      "a separator is not a symlink traversal, and declining it would be a compatibility loss for nothing",
    );
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
    // `physical`, not `asCreated`: on a host whose temp root is itself a symlink
    // (macOS /var → /private/var) `asCreated` traverses a link, and a legacy row that
    // traversed a link is declined by the retarget-proof rule. Pinning the recorded
    // bytes to the physical path is what keeps this case host-independent rather than
    // Linux-green and Darwin-red — the exact trap AC9 exists for.
    addLaunch("lch-legacy0", physical, null);
    addLaunch("lch-sibling", sibling, sibling);

    for (const [label, spelling] of identityDidTheWork(physical)) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.deepEqual(activity.hostVerification.map((l) => l.launchId), ["lch-legacy0"], `scoped by ${label}`);
    }
  });
});

describe("FG-693: the required-CI section is scoped by identity", () => {
  test("an observation recorded under one spelling is current under every other spelling", () => {
    // The payload shape today's observer writes: an ALIASED spelling, with the proven
    // identity beside it. That is what lets an observation of a checkout reached
    // through a link still be its checkout's — the spelling alone could not say so.
    addRun("run-ci", asCreated, physical);
    addCi("run-ci", join(links, "alpha"), CURRENT_SHA, "FG-693", physical);

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
    // Recorded link-free, so the run-less observation is this project's whatever the
    // host's temp root does — the review's own aliased workspace spelling is what the
    // case is about, and it is anchored by TICKET, not by its spelling.
    addCi(null, physical, CURRENT_SHA);

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

// ── FG-693 (fix batch): the two things read-time resolution may not do ────────
//
// RF-5. A legacy row was credited from a FRESH realpath of its recorded spelling.
// That establishes only that the spelling resolves TODAY — never that it resolved to
// the tree the row was written against — so a symlink recorded before the migration
// and since repointed carried one checkout's run, launch and CI evidence to another.
// The rule is now the shared retarget-proof decision (src/store/legacy-path-
// attribution.ts), which is also what receipts and gate evidence take.
//
// RF-6. Rows declaring no run were admitted to the 500-row window whatever the scope,
// so 500 newer run-less observations belonging to OTHER projects evicted a requested
// project's current one before any identity check could see it — and a scoped read
// that answers "not observed" because SQLite ran out of window is reporting an
// absence it never observed.
describe("FG-693 (fix batch): a legacy row is credited only when RETARGET-PROOF", () => {
  /** A link this test owns, pointed wherever it says, repointable in place. */
  function movingLink(name: string, target: string): string {
    const link = join(links, name);
    rmSync(link, { force: true });
    symlinkSync(target, link);
    return link;
  }

  test("a spelling REPOINTED since the row was written does not carry that row to the new tree", () => {
    const link = movingLink("retargeted", join(root, "trees", "alpha"));
    addRun("run-retargeted", link, null);
    addTask("task-retargeted", "run-retargeted");

    // The retarget. The recorded bytes are untouched and still resolve — to a tree
    // this row was never written against.
    rmSync(link, { force: true });
    symlinkSync(join(root, "trees", "alpha-sibling"), link);
    assert.equal(
      realpathSync(link),
      sibling,
      "NOT vacuous: read-time resolution now answers `sibling`, so the pre-fix rule WOULD have credited it there",
    );

    assert.deepEqual(
      deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [sibling] } }).agents,
      [],
      "one checkout's history must never appear under another because a link moved",
    );
    assert.deepEqual(
      deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [physical] } }).agents,
      [],
      "and it is not claimed for the tree it WAS written against either — nothing ever proved that",
    );
    assert.deepEqual(
      deriveCurrentActivity(db, { now: NOW }).agents.map((a) => a.taskId),
      ["task-retargeted"],
      "what a decline costs is a claim on ONE scope: the row itself stays fully readable",
    );
  });

  test("the same decline applies to a legacy LAUNCH row and to a legacy CI payload", () => {
    const link = movingLink("retargeted-evidence", join(root, "trees", "alpha"));
    addLaunch("lch-retargeted", link, null);
    addCi(null, link, CURRENT_SHA);
    db.prepare(
      `INSERT INTO reviews (id, run_id, ticket_id, workspace_dir, state, created_at, updated_at)
       VALUES ('rev-retargeted', NULL, 'FG-693', ?, 'verifying', ?, ?)`,
    ).run(physical, ago(3_600_000), ago(60_000));

    rmSync(link, { force: true });
    symlinkSync(join(root, "trees", "alpha-sibling"), link);

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [sibling] } });
    assert.deepEqual(activity.hostVerification, [], "a launch row is evidence too");
    assert.deepEqual(
      activity.requiredCi.observations,
      [],
      "and an observation credited to the wrong checkout reports checks that never ran against it",
    );
  });

  test("an observation carrying its PROVEN identity is unaffected — that is what the write side is for", () => {
    const link = movingLink("proven-beside", join(root, "trees", "alpha"));
    addCi(null, link, CURRENT_SHA, "FG-693", physical);
    db.prepare(
      `INSERT INTO reviews (id, run_id, ticket_id, workspace_dir, state, created_at, updated_at)
       VALUES ('rev-proven', NULL, 'FG-693', ?, 'verifying', ?, ?)`,
    ).run(physical, ago(3_600_000), ago(60_000));

    assert.deepEqual(
      deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [join(links, "alpha")] } }).requiredCi.observations.map(
        (o) => o.candidateSha,
      ),
      [CURRENT_SHA],
      "identity proven AT WRITE TIME is the thing a read-time resolution cannot reconstruct",
    );
    assert.deepEqual(
      deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [sibling] } }).requiredCi.observations,
      [],
      "and it claims the tree it names, not whatever its spelling reaches today",
    );
  });
});

describe("FG-693 (fix batch): a scoped read never loses a run-less observation to other projects", () => {
  test("an in-scope run-less observation survives 500 newer run-less rows belonging elsewhere", () => {
    db.prepare(
      `INSERT INTO reviews (id, run_id, ticket_id, workspace_dir, state, created_at, updated_at)
       VALUES ('rev-window', NULL, 'FG-693', ?, 'verifying', ?, ?)`,
    ).run(physical, ago(3_600_000), ago(60_000));

    const insert = db.prepare(
      `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (NULL, NULL, ?, ?, ?)`,
    );
    const payload = (projectDir: string, sha: string): string =>
      JSON.stringify({
        attemptId: `attempt-${sha.slice(0, 4)}`,
        ticketId: "FG-693",
        projectDir,
        candidateSha: sha,
        observedAt: ago(60_000),
        outcome: "pending",
        unavailableReason: null,
        contexts: [{ context: "test", state: "pending", url: null, observedAt: ago(60_000) }],
      });

    // The requested project's observation, recorded FIRST and therefore oldest.
    insert.run(CI_OBSERVED_EVENT_TYPE, payload(physical, CURRENT_SHA), ago(3_000_000));
    // 600 NEWER run-less observations anchored in other checkouts. Each is its own
    // pair, so none of them supersedes anything of ours — they only take slots.
    const FILLER = 600;
    for (let i = 0; i < FILLER; i++) {
      insert.run(
        CI_OBSERVED_EVENT_TYPE,
        payload(join(root, "trees", `elsewhere-${i}`), `e${String(i).padStart(39, "0")}`),
        ago(1_000_000 - i),
      );
    }

    // NOT vacuous: the pre-fix window admitted every run-less row and stopped at 500,
    // so the row under test was outside whatever SQLite returned.
    const windowed = db
      .prepare(
        `SELECT json_extract(payload, '$.candidateSha') AS sha FROM events
          WHERE event_type = ? AND run_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 500`,
      )
      .all(CI_OBSERVED_EVENT_TYPE) as Array<{ sha: string }>;
    assert.equal(
      windowed.some((r) => r.sha === CURRENT_SHA),
      false,
      "fixture: the un-narrowed 500-row window never reached this project's observation",
    );

    for (const [label, spelling] of spellings()) {
      const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [spelling] } });
      assert.deepEqual(
        activity.requiredCi.observations.map((o) => o.candidateSha),
        [CURRENT_SHA],
        `a scoped read may not answer from a window other projects spent (${label})`,
      );
      assert.equal(activity.requiredCi.state, "observed", `and the state follows the row (${label})`);
    }
  });

  test("the narrowing claims nothing extra — another project's run-less observation stays out", () => {
    db.prepare(
      `INSERT INTO reviews (id, run_id, ticket_id, workspace_dir, state, created_at, updated_at)
       VALUES ('rev-negative', NULL, 'FG-693', ?, 'verifying', ?, ?)`,
    ).run(sibling, ago(3_600_000), ago(60_000));
    addCi(null, sibling, "d".repeat(40));

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [physical] } });
    assert.deepEqual(activity.requiredCi.observations, [], "the sibling's round is not this checkout's");
  });
});
