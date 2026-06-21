// FG-344 integration tests: deterministic report artifact.
//
// What these tests verify:
//   1. renderResearchReport end-to-end: reads synthesize result.json from disk,
//      builds markdown, writes to <projectDir>/research/<slug>-<8chars>.md (default).
//   2. reportOutputPath in run.metadata overrides the default output path.
//   3. Falls back to run.title when the frame task result.json lacks a 'question' field.
//   4. Falls back to run.title when no frame task exists at all.
//   5. Missing overall_summary in synthesize result → no crash, claims still render.
//   6. Throws when no synthesize task exists for the run.
//   7. Throws when synthesize result.json is absent from disk.
//   8. Throws when run id does not exist.
//   9. CONTROL_PLANE_METADATA_KEYS includes 'reportOutputPath'.
//  10. Top-level synthesize task is used; fanout children (with parentId) are ignored.
//
// renderResearchReport is synchronous: assert.throws is used for error cases.
// Tests use an in-memory SQLite DB and write task result.json files into
// RUNS_DIR (inside the FORGE_HOME temp dir from test-setup.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import type { Run, Task, TaskPackage } from "../types/index.js";
import { renderResearchReport } from "./report.js";
import { CONTROL_PLANE_METADATA_KEYS } from "./startRun.js";

// ---------------------------------------------------------------------------
// In-memory DB setup
// ---------------------------------------------------------------------------

let db: DatabaseInstance;
let prevDb: DatabaseInstance | null;

before(() => {
  db = makeInMemoryDb();
  prevDb = setDbForTest(db);
});

after(() => {
  setDbForTest(prevDb as DatabaseInstance);
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function uid(prefix: string): string {
  return `${prefix}-fg344-${String(++_seq).padStart(4, "0")}`;
}

function seedRun(projectDir: string, overrides: Partial<Run> = {}): Run {
  const run: Run = {
    id: uid("run"),
    workflow: "research-synthesis",
    title: "Does cache invalidation cause stale reads?",
    status: "complete",
    createdAt: "2026-06-01T00:00:00Z",
    projectDir,
    ...overrides,
  };
  insertRun(run);
  return run;
}

function seedTask(runId: string, phase: string, overrides: Partial<Task> = {}): Task {
  const id = uid(`task-${phase}`);
  const pkg: TaskPackage = {
    taskId: id,
    runId,
    phase,
    role: phase,
    inputs: {},
    composedSystemPrompt: "",
  };
  const task: Task = {
    id,
    runId,
    phase,
    agentRole: phase,
    status: "complete",
    taskPackage: pkg,
    createdAt: "2026-06-01T00:01:00Z",
    ...overrides,
  };
  insertTask(task);
  return task;
}

function writeResult(runId: string, taskId: string, result: unknown): void {
  const dir = taskDir(runId, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result), "utf8");
}

const FULL_SYNTH = {
  status: "complete",
  overall_summary:
    "The evidence strongly supports that cache invalidation causes stale reads under high concurrency. Mitigations exist but are not universally applied.",
  claims: [
    {
      id: "c1",
      claim: "Stale reads occur within 500ms of a write under high concurrency",
      verdict: "supported",
      confidence: "high",
      evidence: "Load-test data from both research branches confirmed sub-500ms staleness.",
      disagreements: "Skeptic branch noted one benchmark ran outside typical production load.",
    },
    {
      id: "c2",
      claim: "Read-through caching eliminates all stale reads",
      verdict: "refuted",
      confidence: "medium",
      evidence: "Primary branch found 2 counter-examples with read-through enabled.",
      disagreements: "Both branches agree read-through reduces but does not eliminate staleness.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Test 1: default output path end-to-end
// ---------------------------------------------------------------------------

test("FG-344: renderResearchReport writes markdown to <projectDir>/research/<slug>-<8chars>.md by default", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg344-default-"));
  try {
    const run = seedRun(projectDir);

    const frameTask = seedTask(run.id, "frame");
    writeResult(run.id, frameTask.id, {
      status: "complete",
      question: "Does cache invalidation cause stale reads?",
      lanes: [],
    });

    const synthTask = seedTask(run.id, "synthesize");
    writeResult(run.id, synthTask.id, FULL_SYNTH);

    const { markdown, outputPath } = renderResearchReport(run.id);

    // Output path must be under <projectDir>/research/
    assert.ok(
      outputPath.startsWith(join(projectDir, "research")),
      `outputPath must be under <projectDir>/research/, got: ${outputPath}`
    );
    assert.ok(outputPath.endsWith(".md"), "outputPath must end with .md");

    // Last 8 chars of run.id appear in the filename
    const last8 = run.id.slice(-8);
    assert.ok(
      outputPath.includes(last8),
      `outputPath must include last 8 chars of run.id (${last8}), got: ${outputPath}`
    );

    // File written to disk
    assert.ok(existsSync(outputPath), `report file must exist on disk at ${outputPath}`);

    // Content: question as H1, summary paragraph, both claims
    assert.ok(markdown.includes("# Does cache invalidation cause stale reads?"), "H1 must contain the question");
    assert.ok(markdown.includes("strongly supports"), "overall_summary must appear in the report");
    assert.ok(markdown.includes("## Stale reads occur within 500ms"), "claim 1 heading must appear");
    assert.ok(markdown.includes("## Read-through caching eliminates"), "claim 2 heading must appear");
    assert.ok(markdown.includes("SUPPORTED"), "supported verdict must appear");
    assert.ok(markdown.includes("REFUTED"), "refuted verdict must appear");
    assert.ok(markdown.includes("Load-test data from both research"), "claim 1 evidence must appear");
    assert.ok(markdown.includes("Skeptic branch noted"), "claim 1 disagreements must appear");

    // Disk content matches returned markdown
    const onDisk = readFileSync(outputPath, "utf8");
    assert.equal(onDisk, markdown, "file on disk must exactly match returned markdown");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: reportOutputPath metadata override
// ---------------------------------------------------------------------------

test("FG-344: renderResearchReport writes to run.metadata.reportOutputPath when set", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg344-override-"));
  const customOutDir = mkdtempSync(join(tmpdir(), "fg344-custom-"));
  const customPath = join(customOutDir, "my-custom-report.md");
  try {
    const run = seedRun(projectDir, { metadata: { reportOutputPath: customPath } });

    const frameTask = seedTask(run.id, "frame");
    writeResult(run.id, frameTask.id, { status: "complete", question: "Custom path question?", lanes: [] });

    const synthTask = seedTask(run.id, "synthesize");
    writeResult(run.id, synthTask.id, { ...FULL_SYNTH, overall_summary: "Custom path summary." });

    const { outputPath } = renderResearchReport(run.id);

    assert.equal(
      outputPath,
      customPath,
      "outputPath must be the custom path from run.metadata.reportOutputPath"
    );
    assert.ok(existsSync(customPath), `report must be written to the custom path: ${customPath}`);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(customOutDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: fallback to run.title when frame result lacks 'question'
// ---------------------------------------------------------------------------

test("FG-344: renderResearchReport falls back to run.title when frame result has no question field", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg344-fallback-"));
  try {
    const run = seedRun(projectDir, { title: "My Research Run Title" });

    const frameTask = seedTask(run.id, "frame");
    // Frame result.json exists but has no 'question' field
    writeResult(run.id, frameTask.id, { status: "complete", lanes: [] });

    const synthTask = seedTask(run.id, "synthesize");
    writeResult(run.id, synthTask.id, FULL_SYNTH);

    const { markdown } = renderResearchReport(run.id);

    assert.ok(
      markdown.includes("# My Research Run Title"),
      "H1 must use run.title when frame result lacks a question field"
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4: fallback to run.title when no frame task at all
// ---------------------------------------------------------------------------

test("FG-344: renderResearchReport falls back to run.title when no frame task is found", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg344-nframe-"));
  try {
    const run = seedRun(projectDir, { title: "Title Without Frame Task" });

    // No frame task — only synthesize
    const synthTask = seedTask(run.id, "synthesize");
    writeResult(run.id, synthTask.id, FULL_SYNTH);

    const { markdown } = renderResearchReport(run.id);

    assert.ok(
      markdown.includes("# Title Without Frame Task"),
      "H1 must fall back to run.title when no frame task exists"
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5: missing overall_summary — no crash, claims still render
// ---------------------------------------------------------------------------

test("FG-344: renderResearchReport handles missing overall_summary — no crash, claims render", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg344-nosummary-"));
  try {
    const run = seedRun(projectDir);

    const synthTask = seedTask(run.id, "synthesize");
    writeResult(run.id, synthTask.id, {
      status: "complete",
      // no overall_summary field
      claims: [
        {
          id: "c1",
          claim: "X causes Y",
          verdict: "inconclusive",
          confidence: "low",
          evidence: "Insufficient data.",
          disagreements: "Both branches agree: more data needed.",
        },
      ],
    });

    let md: string;
    assert.doesNotThrow(
      () => { md = renderResearchReport(run.id).markdown; },
      "renderResearchReport must not throw when overall_summary is absent"
    );

    md = renderResearchReport(run.id).markdown;
    assert.ok(!md.includes("undefined"), "output must not contain literal 'undefined'");
    assert.ok(!md.includes("null"), "output must not contain literal 'null'");
    assert.ok(md.includes("## X causes Y"), "claim heading must render without overall_summary");
    assert.ok(md.includes("INCONCLUSIVE"), "claim verdict must render without overall_summary");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 6: throws (synchronously) when synthesize task not found
// ---------------------------------------------------------------------------

test("FG-344: renderResearchReport throws when no synthesize task is found for the run", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg344-nosynth-"));
  try {
    const run = seedRun(projectDir);

    // Insert only a frame task — no synthesize task
    const frameTask = seedTask(run.id, "frame");
    writeResult(run.id, frameTask.id, { status: "complete", question: "Q?", lanes: [] });

    assert.throws(
      () => renderResearchReport(run.id),
      /no synthesize task/,
      "must throw when no synthesize task exists"
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 7: throws when synthesize result.json is absent from disk
// ---------------------------------------------------------------------------

test("FG-344: renderResearchReport throws when synthesize result.json is absent from disk", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg344-noresult-"));
  try {
    const run = seedRun(projectDir);

    // Task exists in DB but NO result.json written to disk
    const synthTask = seedTask(run.id, "synthesize");
    // Intentionally do NOT call writeResult() here

    assert.throws(
      () => renderResearchReport(run.id),
      /synthesize result not found/,
      "must throw when synthesize result.json is missing from disk"
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 8: throws when run id does not exist in DB
// ---------------------------------------------------------------------------

test("FG-344: renderResearchReport throws when run id does not exist", () => {
  assert.throws(
    () => renderResearchReport("run-does-not-exist-fg344-xxxx"),
    /run not found/,
    "must throw with a clear error when run id is unknown"
  );
});

// ---------------------------------------------------------------------------
// Test 9: CONTROL_PLANE_METADATA_KEYS includes 'reportOutputPath'
// ---------------------------------------------------------------------------

test("FG-344: CONTROL_PLANE_METADATA_KEYS includes 'reportOutputPath'", () => {
  assert.ok(
    (CONTROL_PLANE_METADATA_KEYS as readonly string[]).includes("reportOutputPath"),
    "reportOutputPath must be in CONTROL_PLANE_METADATA_KEYS so --meta cannot set it directly"
  );
});

// ---------------------------------------------------------------------------
// Test 10: top-level synthesize task is selected; fanout children (parentId set)
//          are filtered out — the top-level task's content appears in the report.
// ---------------------------------------------------------------------------

test("FG-344: renderResearchReport uses top-level synthesize task, not fanout children", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "fg344-toplevel-"));
  try {
    const run = seedRun(projectDir);

    // Insert a parent task (so the child's FK constraint is satisfied)
    const parentTask = seedTask(run.id, "synthesize");
    writeResult(run.id, parentTask.id, {
      status: "complete",
      overall_summary: "WRONG: fanout parent used — should be filtered by parentId",
      claims: [],
    });

    // Insert a CHILD synthesize task (parentId set — must be ignored by renderResearchReport)
    const childTask = seedTask(run.id, "synthesize", {
      parentId: parentTask.id,
      createdAt: "2026-06-01T00:02:00Z",
    });
    writeResult(run.id, childTask.id, {
      status: "complete",
      overall_summary: "WRONG: child task used instead of top-level",
      claims: [],
    });

    // Insert the real top-level synthesize task (later createdAt → picked as "last" top-level)
    const topTask = seedTask(run.id, "synthesize", {
      parentId: undefined,
      createdAt: "2026-06-01T00:03:00Z",
    });
    writeResult(run.id, topTask.id, {
      status: "complete",
      overall_summary: "Correct: top-level synthesize task, no parentId.",
      claims: [
        {
          id: "c1",
          claim: "Top-level claim is authoritative",
          verdict: "supported",
          confidence: "high",
          evidence: "Derived from full synthesis across both branches.",
          disagreements: "None.",
        },
      ],
    });

    const { markdown } = renderResearchReport(run.id);

    assert.ok(
      markdown.includes("Correct: top-level synthesize task"),
      "must use the last top-level synthesize task (no parentId)"
    );
    assert.ok(
      !markdown.includes("WRONG"),
      "must NOT include content from fanout parent or child tasks"
    );
    assert.ok(
      markdown.includes("## Top-level claim is authoritative"),
      "top-level synthesize claim must appear in the report"
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
