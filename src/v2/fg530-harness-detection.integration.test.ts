// FG-530 independent verification (integration tier): does the crash harness
// actually DETECT what it claims to?
//
// Every cell of the matrix is green. Green is only evidence if the checkers can go
// red — and the engineer proved that for exactly ONE shape (the two-write dance,
// via invariant 1). The other four invariants have never been shown to fail on a
// state that violates them, so nothing yet distinguishes "the runner is correct"
// from "the checker is blind". This file closes that: EVERY one of the five
// checkers gets at least one hand-written violating fixture it is proven to flag,
// each paired with a control the same checker is proven to pass.
//
// It also pins the fixpoint CAP: a recovery that never converges must fail with a
// named error, not spin forever or quietly report success.
//
// HOW IT REACHES THE CHECKERS. They are module-private to the matrix, and the
// matrix registers one test per (scenario × kill point) on import — importing it
// directly would re-run the whole suite inside this file. So we mechanically derive
// a scratch copy at test time: `node:test`'s test/beforeEach/afterEach are replaced
// with no-ops (every registration becomes a dead call) and the checkers are exported.
// The bodies are the ENGINEER'S, byte-for-byte — if a checker changes, this file
// exercises the changed one. The copy lives in a temp dir (never in src/), with
// relative imports rewritten to absolute, so it cannot pollute typecheck or the
// test globs.

import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import type { Task, TaskStatus } from "../types/index.js";

const MATRIX_PATH = fileURLToPath(new URL("./fg530-crash-matrix.integration.test.ts", import.meta.url));

// Everything we lift out of the matrix. Note this includes the STORE accessors:
// they are re-exported through the scratch copy on purpose, so that seeding a row
// here and checking it there provably go through ONE module instance. (Importing
// `../store/db.js` directly in this file instead gives tsx a second module key —
// the checkers then read an empty DB, report nothing, and the controls pass
// vacuously. That is a real trap; it cost a debug cycle, and the harness-integrity
// test below is the tripwire that keeps it from coming back.)
const LIFTED = [
  // the five checkers under verification
  "checkNoCompleteWithoutEvidence",
  "checkNoPermanentWedge",
  "checkAbandonedNeverOverwritten",
  "checkPersistedWorkNeverDiscarded",
  "checkFixpointIdempotent",
  // harness machinery
  "capturePersistedWork",
  "recoverToFixpoint",
  "snapshot",
  "FIXPOINT_CAP",
  "PLAIN_WF",
  "PLAIN_YAML",
  "RED_WF",
  "RED_YAML",
  "RUNTIME",
  "ensureRuntime",
  "writeWorkflowYaml",
  "makeExec",
  "step",
  // store + runtime, re-exported so this file shares the harness's module graph
  "makeInMemoryDb",
  "setDbForTest",
  "insertTask",
  "getTask",
  "insertVerdict",
  "newVerdictId",
  "updateRunStatus",
  "taskDir",
  "startRun",
  "setCrashHookForTest",
] as const;

type Violation = { invariant: string; detail: string };
/** The scratch module is derived at runtime, so it carries no static type. */
type Harness = Record<(typeof LIFTED)[number], any>;

let H: Harness;
let scratchDir: string;

/** Derive the scratch module: neuter node:test, export the checkers, make the
 *  relative imports absolute so the copy can live outside src/. */
function buildScratchModule(): string {
  const src = readFileSync(MATRIX_PATH, "utf8");

  const testImport = /import \{ test, beforeEach, afterEach \} from "node:test";/;
  assert.match(
    src,
    testImport,
    "the matrix's node:test import changed shape — this file's scratch transform must be updated to match, not silently skipped",
  );

  let out = src.replace(
    testImport,
    // The top-level test() registrations become no-ops; the module body
    // (registry, workflows, checkers) still evaluates exactly as written.
    [
      "const test = (..._a: unknown[]): void => {};",
      "const beforeEach = (..._a: unknown[]): void => {};",
      "const afterEach = (..._a: unknown[]): void => {};",
      "void test; void beforeEach; void afterEach;",
    ].join("\n"),
  );

  // Relative → absolute, AND .js → .ts. The extension matters: tsx keys a module
  // by its resolved URL, so importing ".../db.js" here while this file imports
  // "../store/db.js" yields TWO instances of the store — the scratch checkers
  // would then read an empty DB and report zero violations, i.e. every detection
  // test would pass VACUOUSLY. Resolving both to the same .ts URL is what makes
  // the checkers observe the rows this file seeds. (Guarded by the shared-DB test.)
  out = out.replace(/from "(\.\.?\/[^"]+)"/g, (_m, spec: string) => {
    const abs = resolve(dirname(MATRIX_PATH), spec);
    return `from "${abs.replace(/\.js$/, ".ts")}"`;
  });

  out += `\n\nexport { ${LIFTED.join(", ")} };\n`;

  for (const name of LIFTED) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(src),
      `the matrix no longer declares or imports '${name}' — the harness was refactored and this verification must be updated, not quietly weakened`,
    );
  }
  return out;
}

before(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "fg530-verify-"));
  const modPath = join(scratchDir, "matrix-checkers.ts");
  writeFileSync(modPath, buildScratchModule());
  H = (await import(pathToFileURL(modPath).href)) as Harness;
});

after(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

// ── test bed (the matrix's beforeEach is neutered in the copy, so we own it) ───

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let savedApiKey: string | undefined;
const tmpDirs: string[] = [];

beforeEach(() => {
  db = H.makeInMemoryDb();
  prev = H.setDbForTest(db);
  savedApiKey = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  H.ensureRuntime();
});

afterEach(() => {
  H.setCrashHookForTest(undefined);
  H.setDbForTest(prev as DatabaseInstance);
  db.close();
  if (savedApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedApiKey;
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg530-verify-proj-"));
  writeFileSync(join(dir, ".keep"), "");
  tmpDirs.push(dir);
  return dir;
}

const GOOD_RESULT = { status: "complete", tests_run: 1, files_modified: [] };

function newRun(workflow: unknown, yaml: string, title: string): string {
  H.writeWorkflowYaml((workflow as { name: string }).name, yaml);
  return H.startRun({ workflow, title, inputs: {}, projectDir: projectDir() }).runId as string;
}

/** A hand-written task row — the whole point is to author DB states the runner
 *  would never produce, and see whether the checkers notice. */
function seedTask(
  runId: string,
  over: Partial<Task> & { id: string; status: TaskStatus },
): Task {
  const t: Task = {
    runId,
    phase: "build",
    agentRole: "engineer",
    taskPackage: {
      taskId: over.id,
      runId,
      phase: "build",
      role: "engineer",
      dispatchSource: "workflow",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-07-11T10:00:00.000Z",
    ...over,
  } as Task;
  H.insertTask(t);
  return t;
}

const details = (vs: Violation[]): string => vs.map((v) => v.detail).join("\n");

// ── anti-vacuity: the checkers must be looking at OUR database ────────────────
//
// Every detection test below is of the form "seed a bad state ⇒ expect a
// violation". If the lifted checkers read a DIFFERENT store instance than the one
// this file seeds (an easy mistake: importing `../store/db.js` here and
// `.../db.js` there resolves to two module keys under tsx), they see an empty DB,
// return zero violations, and every CONTROL test passes for entirely the wrong
// reason. This test fails first and loudly if that ever regresses.

test("FG-530 harness integrity: the lifted checkers read the SAME store instance this file seeds — otherwise every control below would pass vacuously", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "shared-db guard");
  seedTask(runId, { id: "t-shared", status: "running" });

  const vs: Violation[] = H.checkNoPermanentWedge(runId, H.PLAIN_WF);

  assert.ok(
    vs.some((v) => /t-shared/.test(v.detail)),
    "the checker (loaded from the scratch copy) must observe a task inserted through THIS file's store import — " +
      "if it does not, the two modules are separate instances and none of the detection results below mean anything",
  );
});

// ── INVARIANT 1 — arms the engineer's meta-AC does NOT cover ───────────────────

test("FG-530 detection [invariant 1]: a `complete` primary with NO result on its row is FLAGGED — completion without the artifact that justifies it", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv1 no-result");
  seedTask(runId, { id: "t-noresult", status: "complete" }); // result absent

  const vs: Violation[] = H.checkNoCompleteWithoutEvidence(runId, H.PLAIN_WF);

  assert.ok(vs.length > 0, "a complete task with no result must be flagged");
  assert.ok(
    vs.some((v) => v.invariant === "1-no-complete-without-evidence-chain" && /NO result on its row/.test(v.detail)),
    `expected the missing-result arm to fire, got:\n${details(vs)}`,
  );
});

test("FG-530 detection [invariant 1]: a `complete` primary whose step declares a gating red but carries NO verdict row is FLAGGED — shipped without the red's evidence", () => {
  const runId = newRun(H.RED_WF, H.RED_YAML, "inv1 no-verdict");
  seedTask(runId, { id: "t-noverdict", status: "complete", result: GOOD_RESULT });

  const vs: Violation[] = H.checkNoCompleteWithoutEvidence(runId, H.RED_WF);

  assert.ok(
    vs.some(
      (v) =>
        v.invariant === "1-no-complete-without-evidence-chain" &&
        /verdict rows are MISSING for \[red-security \(0\/1 verdict rows\)\]/.test(v.detail),
    ),
    `a step with an authoritative gating red that completed with zero verdicts must be flagged, got:\n${details(vs)}`,
  );
});

test("FG-530 detection [invariant 1] CONTROL: a complete primary with its result and a passing authoritative verdict is CLEAN — the checker discriminates", () => {
  const runId = newRun(H.RED_WF, H.RED_YAML, "inv1 control");
  seedTask(runId, { id: "t-ok", status: "complete", result: GOOD_RESULT });
  seedTask(runId, { id: "t-ok-red", status: "complete", parentId: "t-ok", agentRole: "red-security", result: {} });
  H.insertVerdict({
    id: H.newVerdictId(),
    taskId: "t-ok",
    redTaskId: "t-ok-red",
    redRole: "red-security",
    verdict: "pass",
    confidence: 0.9,
    authority: "authoritative",
    findings: [],
    createdAt: "2026-07-11T10:01:00.000Z",
    gateOnVerdict: true,
  });

  assert.deepEqual(
    H.checkNoCompleteWithoutEvidence(runId, H.RED_WF),
    [],
    "a completion backed by a result AND a passing gating verdict satisfies the evidence chain",
  );
});

// ── INVARIANT 2 — the wedge shapes ────────────────────────────────────────────

test("FG-530 detection [invariant 2]: a task left `running` at fixpoint is FLAGGED — reconcile never swept it and no future pass will", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv2 running");
  seedTask(runId, { id: "t-running", status: "running" });

  const vs: Violation[] = H.checkNoPermanentWedge(runId, H.PLAIN_WF);

  assert.ok(
    vs.some((v) => v.invariant === "2-no-permanent-wedge" && /is still 'running' at fixpoint/.test(v.detail)),
    `a stranded running row is the canonical wedge and must be flagged, got:\n${details(vs)}`,
  );
});

test("FG-530 detection [invariant 2]: an `active` run whose only step is done but whose ready queue is empty is FLAGGED — nothing will ever move it", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv2 stalled run");
  seedTask(runId, { id: "t-done", status: "complete", result: GOOD_RESULT });
  H.updateRunStatus(runId, "active");

  const vs: Violation[] = H.checkNoPermanentWedge(runId, H.PLAIN_WF);

  assert.ok(
    vs.some((v) => v.invariant === "2-no-permanent-wedge" && /still 'active' with an empty ready queue/.test(v.detail)),
    `a run stuck 'active' with nothing runnable and nothing live must be flagged, got:\n${details(vs)}`,
  );
});

// ── INVARIANT 3 — the cancelled run ───────────────────────────────────────────

test("FG-530 detection [invariant 3]: a run that was abandoned before recovery but is now `complete` is FLAGGED — recovery resurrected a cancelled run", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv3 resurrection");
  H.updateRunStatus(runId, "complete"); // the resurrection the invariant forbids

  const vs: Violation[] = H.checkAbandonedNeverOverwritten(runId, true);

  assert.equal(vs.length, 1, "the resurrection must be flagged exactly once");
  assert.equal(vs[0]!.invariant, "3-abandoned-never-overwritten");
  assert.match(vs[0]!.detail, /recovery resurrected a cancelled run/);
});

test("FG-530 detection [invariant 3] CONTROL: an abandoned run that STAYS abandoned is CLEAN, and a never-abandoned run is never flagged", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv3 control");
  H.updateRunStatus(runId, "abandoned");

  assert.deepEqual(H.checkAbandonedNeverOverwritten(runId, true), [], "abandoned → abandoned is the correct outcome");

  const other = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv3 control 2");
  H.updateRunStatus(other, "complete");
  assert.deepEqual(
    H.checkAbandonedNeverOverwritten(other, false),
    [],
    "a run that was never abandoned may legitimately complete",
  );
});

// ── INVARIANT 4 — persisted work ──────────────────────────────────────────────

function seedPersisted(runId: string, taskId: string, status: TaskStatus, onRow: boolean): string {
  seedTask(runId, { id: taskId, status, ...(onRow ? { result: GOOD_RESULT } : {}) });
  const dir = H.taskDir(runId, taskId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "result.json");
  writeFileSync(p, JSON.stringify(GOOD_RESULT));
  return p;
}

test("FG-530 detection [invariant 4]: a result.json DELETED during recovery is FLAGGED — the container's work vanished", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv4 deleted");
  const p = seedPersisted(runId, "t-del", "complete", true);
  const pre = H.capturePersistedWork(runId);
  assert.equal(pre.results.length, 1, "precondition: the harness captured the persisted result before the kill");

  rmSync(p, { force: true });

  const vs: Violation[] = H.checkPersistedWorkNeverDiscarded(pre);
  assert.ok(
    vs.some((v) => v.invariant === "4-persisted-work-never-discarded" && /is GONE after recovery/.test(v.detail)),
    `a deleted result.json must be flagged, got:\n${details(vs)}`,
  );
});

test("FG-530 detection [invariant 4]: a result.json REWRITTEN during recovery is FLAGGED — persisted work must survive verbatim, not be edited", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv4 rewritten");
  const p = seedPersisted(runId, "t-rw", "complete", true);
  const pre = H.capturePersistedWork(runId);

  writeFileSync(p, JSON.stringify({ status: "complete", tests_run: 999, files_modified: ["tampered.ts"] }));

  const vs: Violation[] = H.checkPersistedWorkNeverDiscarded(pre);
  assert.ok(
    vs.some((v) => v.invariant === "4-persisted-work-never-discarded" && /was REWRITTEN during recovery/.test(v.detail)),
    `a mutated result.json must be flagged, got:\n${details(vs)}`,
  );
});

test("FG-530 detection [invariant 4]: work persisted on disk but ORPHANED off a terminal row is FLAGGED — this is the FG-530-B shape, reproduced from a hand-written state", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv4 orphaned");
  seedPersisted(runId, "t-orphan", "failed", false); // terminal, result NULL on the row
  const pre = H.capturePersistedWork(runId);

  const vs: Violation[] = H.checkPersistedWorkNeverDiscarded(pre);
  assert.ok(
    vs.some(
      (v) =>
        v.invariant === "4-persisted-work-never-discarded" &&
        /is now terminal \('failed'\) with NO result on its row/.test(v.detail),
    ),
    `a terminal row that dropped its result while the file survives on disk must be flagged, got:\n${details(vs)}`,
  );
  assert.ok(H.getTask("t-orphan")!.result == null, "precondition held: the row really did carry no result");
});

test("FG-530 detection [invariant 4] CONTROL: untouched work referenced by its terminal row is CLEAN", () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv4 control");
  seedPersisted(runId, "t-keep", "complete", true);
  const pre = H.capturePersistedWork(runId);

  assert.deepEqual(
    H.checkPersistedWorkNeverDiscarded(pre),
    [],
    "a preserved, still-referenced result.json is exactly what the invariant demands",
  );
});

// ── INVARIANT 5 — idempotence + the cap ───────────────────────────────────────

test("FG-530 detection [invariant 5]: a state that is NOT at fixpoint is FLAGGED — one more reconcile+runNext pass still changes the DB", async () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv5 not-settled");
  const exec = H.makeExec({ redVerdict: "pass" });

  // A fresh run has a ready step and zero tasks: the next pass WILL dispatch it.
  const vs: Violation[] = await H.checkFixpointIdempotent(runId, H.PLAIN_WF, exec);

  assert.ok(
    vs.some((v) => v.invariant === "5-fixpoint-idempotent" && /CHANGED state/.test(v.detail)),
    `a run with pending work must not read as an idempotent fixpoint, got:\n${details(vs)}`,
  );
});

test("FG-530 detection [invariant 5] CONTROL: a genuinely settled run is CLEAN — and recoverToFixpoint converges well inside the cap", async () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv5 settled");
  const exec = H.makeExec({ redVerdict: "pass" });

  const passes: number = await H.recoverToFixpoint(runId, H.PLAIN_WF, exec);
  assert.ok(passes >= 1 && passes <= H.FIXPOINT_CAP, `converged in ${passes} passes, within the cap of ${H.FIXPOINT_CAP}`);

  assert.deepEqual(
    await H.checkFixpointIdempotent(runId, H.PLAIN_WF, exec),
    [],
    "once settled, another full pass must change nothing",
  );
});

/** The projection the fixpoint snapshot used BEFORE the lossless rewrite: a
 *  handful of status-shaped columns plus counts. Reproduced verbatim so the test
 *  below can prove what it was blind to — the blindness is the bug, and a
 *  regression back to a projection must be visible as a test failure, not as a
 *  quietly weaker assertion. */
function lossyLegacySnapshot(runId: string): string {
  const q = (sql: string): unknown[] => db.prepare(sql).all(runId);
  return JSON.stringify({
    runStatus: db.prepare("SELECT status FROM runs WHERE id = ?").get(runId),
    tasks: q(
      "SELECT id, phase, status, parent_id, result IS NOT NULL AS has_result FROM tasks WHERE run_id = ? ORDER BY id",
    ),
    verdicts: q(
      "SELECT v.id, v.task_id, v.verdict, v.authority FROM verdicts v JOIN tasks t ON t.id = v.task_id WHERE t.run_id = ? ORDER BY v.id",
    ),
    gates: q(
      "SELECT g.id, g.task_id, g.decision FROM gates g JOIN tasks t ON t.id = g.task_id WHERE t.run_id = ? ORDER BY g.id",
    ),
    eventCount: db.prepare("SELECT COUNT(*) AS c FROM events WHERE run_id = ?").get(runId),
  });
}

test("FG-530 detection [invariant 5]: a pass that mutates ONLY a previously-invisible field (the persisted result body) is FLAGGED — the fixpoint snapshot is lossless, not a status projection", async () => {
  const runId = newRun(H.PLAIN_WF, H.PLAIN_YAML, "inv5 invisible write");
  const exec = H.makeExec({ redVerdict: "pass" });
  await H.recoverToFixpoint(runId, H.PLAIN_WF, exec);

  const settled = db.prepare("SELECT id, status FROM tasks WHERE run_id = ?").all(runId) as {
    id: string;
    status: string;
  }[];
  assert.ok(settled.length > 0, "precondition: the settled run has at least one task to mutate");

  // The write under test: rewrite the result BODY of a settled task. Status, row
  // count, verdict/gate rows, run status and event count are all untouched — the
  // recovery pass has silently rewritten the artifact that justifies a completion.
  const target = settled[0]!.id;
  const original = (db.prepare("SELECT result FROM tasks WHERE id = ?").get(target) as { result: string }).result;
  const tampered = JSON.stringify({ status: "complete", tests_run: 999, files_modified: ["tampered.ts"] });
  const rewriteResultBody = async (): Promise<void> => {
    db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(tampered, target);
  };

  // First: prove the OLD snapshot could not see it. If this ever stops holding,
  // the fixture has drifted and the detection below no longer proves anything.
  const legacyBefore = lossyLegacySnapshot(runId);
  const richBefore = JSON.stringify(H.snapshot(runId));
  await rewriteResultBody();
  assert.equal(
    lossyLegacySnapshot(runId),
    legacyBefore,
    "fixture precondition: the pre-fix projection (status + counts) is BLIND to a result-body rewrite — that blindness is the bug under test",
  );
  assert.notEqual(
    JSON.stringify(H.snapshot(runId)),
    richBefore,
    "the lossless snapshot must see the result-body rewrite the projection missed",
  );

  // Rewind, so the checker's pass performs the write itself rather than repeating
  // one already applied (which would be a genuine no-op and prove nothing).
  db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(original, target);
  assert.equal(JSON.stringify(H.snapshot(runId)), richBefore, "rewound to the settled state");

  // Now end-to-end through the checker: a pass whose only write is that rewrite
  // must NOT read as an idempotent fixpoint.
  const vs: Violation[] = await H.checkFixpointIdempotent(runId, H.PLAIN_WF, exec, rewriteResultBody);

  assert.ok(
    vs.some(
      (v) =>
        v.invariant === "5-fixpoint-idempotent" && /CHANGED state/.test(v.detail) && /\.result:/.test(v.detail),
    ),
    `a pass that rewrites persisted result content must be flagged, and the violation must NAME the column that moved, got:\n${details(vs)}`,
  );
});

test("FG-530 detection [invariant 5]: the fixpoint snapshot covers every column of tasks/verdicts/gates — a projection would go stale the day a column is added", async () => {
  const runId = newRun(H.RED_WF, H.RED_YAML, "inv5 full fidelity");
  const exec = H.makeExec({ redVerdict: "pass" });
  await H.recoverToFixpoint(runId, H.RED_WF, exec);

  const snap = H.snapshot(runId) as {
    tasks: Record<string, unknown>[];
    verdicts: Record<string, unknown>[];
    gates: Record<string, unknown>[];
  };
  assert.ok(snap.tasks.length > 0 && snap.verdicts.length > 0, "precondition: the settled red run has tasks + verdicts");

  const columns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  for (const [table, rows] of [
    ["tasks", snap.tasks],
    ["verdicts", snap.verdicts],
    ["gates", snap.gates],
  ] as const) {
    if (rows.length === 0) continue; // gates: none on an auto-gated run
    const missing = columns(table).filter((c) => !(c in rows[0]!));
    assert.deepEqual(
      missing,
      [],
      `the snapshot dropped ${table} column(s) ${missing.join(", ")} — a recovery pass could write them and still read as a no-op`,
    );
  }
});

/** A chain longer than the cap: each pass can only advance one step, so the run
 *  is still legitimately changing state when the cap is reached. This is the
 *  cheapest honest stand-in for "recovery never converges" — a real non-convergent
 *  bug would loop forever, and the cap is the only thing standing between the
 *  suite and a hung CI job. */
function longChain(steps: number): { workflow: unknown; yaml: string } {
  const ids = Array.from({ length: steps }, (_, i) => `s${i}`);
  const workflow = {
    name: "fg530-verify-long",
    description: "FG-530 verification: a chain longer than the fixpoint cap",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: ids.map((id, i) => H.step(id, i === 0 ? {} : { depends_on: [ids[i - 1]] })),
  };
  const yaml =
    `name: fg530-verify-long\ndescription: FG-530 long chain\ninputs: []\nsteps:\n` +
    ids
      .map(
        (id, i) =>
          `  - id: ${id}\n    agent: engineer\n    gate: auto\n    runtime: ${H.RUNTIME}\n` +
          (i === 0 ? "" : `    depends_on: [${ids[i - 1]}]\n`),
      )
      .join("");
  return { workflow, yaml };
}

test("FG-530 fixpoint cap: a recovery that does not converge inside the cap FAILS LOUDLY with a named invariant error — it does not spin forever, and it does not quietly pass", async () => {
  const cap: number = H.FIXPOINT_CAP;
  assert.ok(Number.isInteger(cap) && cap > 0, `the cap must be a finite positive integer, got ${cap}`);

  const { workflow, yaml } = longChain(cap + 6);
  const runId = newRun(workflow, yaml, "fixpoint cap");
  const exec = H.makeExec({ redVerdict: "pass" });

  await assert.rejects(
    () => H.recoverToFixpoint(runId, workflow, exec),
    (err: unknown) => {
      assert.ok(err instanceof Error, "the cap must throw an Error, not reject with a bare value");
      assert.match(
        err.message,
        /INVARIANT 5 \(fixpoint\) VIOLATED/,
        "the failure must NAME the invariant it broke — a bare 'timeout' tells the operator nothing",
      );
      assert.match(
        err.message,
        new RegExp(`did not converge in ${cap} reconcile\\+runNext passes`),
        "the message must report the cap it exhausted",
      );
      assert.match(err.message, /Final state:/, "and dump the state it gave up on, so the wedge is diagnosable");
      return true;
    },
    "a non-convergent recovery MUST throw the named fixpoint error — the cap is what stops an infinite recovery loop from hanging CI",
  );
});
