// FG-745: `forge projects` CLI parity + the classify/repair path.
//
//  - `projects list` returns the OPERATOR-project membership (operatorProjects),
//    the same set GET /api/projects exposes (AC7).
//  - `projects show <path>` still resolves a SUPPRESSED artifact (AC1/AC2 — the
//    artifact stays reachable from the owner surface).
//  - `projects classify` records via the atomic REFUSE-on-conflict claim (AC8).
//
// Real Commander program against a real in-memory store; real temp directories so
// provenPhysical resolves.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import type { Run } from "../../types/index.js";
import { getWorkspacePurpose, recordWorkspacePurpose } from "../../store/workspace-purpose.js";
import { registerProjects } from "./projects.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
let scanRoot: string;

function realDir(prefix = "forge-cli-wp-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  scanRoot = realDir("forge-cli-scanroot-"); // an empty scan root so no real ~/code is walked
});
afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run `forge <argv…>` against a fresh program, capturing stdout/stderr and the exit
 *  code the action set. */
async function runCli(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const program = new Command();
  program.exitOverride();
  registerProjects(program);
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "forge", ...argv]);
  } catch {
    /* commander exitOverride throws on some paths; the action's process.exitCode is what we assert */
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const code = process.exitCode ?? 0;
  process.exitCode = origExit;
  return { out: out.join("\n"), err: err.join("\n"), code };
}

function seedRun(projectDir: string, id: string): void {
  insertRun({ id, workflow: "invoke", title: "t", status: "complete", createdAt: "2026-08-01T00:00:00Z", projectDir } as Run);
}

describe("FG-745 forge projects classify", () => {
  test("records a purpose via the atomic claim", async () => {
    const dir = realDir();
    const { code } = await runCli("projects", "classify", dir, "--purpose", "evidence_fixture", "--json");
    assert.equal(code, 0);
    assert.equal(getWorkspacePurpose(dir)?.kind, "evidence_fixture");
  });

  test("REFUSES a conflicting reassignment with a non-zero exit and a reason", async () => {
    const dir = realDir();
    await runCli("projects", "classify", dir, "--purpose", "evidence_fixture");
    const { code, err } = await runCli("projects", "classify", dir, "--purpose", "operator");
    assert.equal(code, 1);
    assert.match(err, /refusing to classify/);
    assert.equal(getWorkspacePurpose(dir)?.kind, "evidence_fixture", "the recorded fact is unchanged");
  });

  test("rejects an unknown --purpose", async () => {
    const dir = realDir();
    const { code, err } = await runCli("projects", "classify", dir, "--purpose", "banana");
    assert.equal(code, 1);
    assert.match(err, /Unknown --purpose/);
  });
});

describe("FG-745 forge projects list / show membership (AC7)", () => {
  test("list omits a recorded artifact and keeps an unclassified project", async () => {
    const artifact = realDir("forge-cli-artifact-");
    const operatorDir = realDir("forge-cli-operator-");
    seedRun(artifact, "run-artifact");
    seedRun(operatorDir, "run-operator");
    recordWorkspacePurpose({ path: artifact, kind: "disposable_clone", owner: { runId: "run-artifact" } });

    const { out, code } = await runCli("projects", "list", "--json", "--scan-root", scanRoot);
    assert.equal(code, 0);
    const parsed = JSON.parse(out) as { projects: Array<{ projectDirs: string[]; classification?: string }> };
    const dirs = parsed.projects.flatMap((p) => p.projectDirs);
    assert.ok(!dirs.includes(artifact), "the disposable clone is not a top-level Projects entry (AC1)");
    assert.ok(dirs.includes(operatorDir), "an unclassified independent project stays visible (AC4/AC8)");
    const kept = parsed.projects.find((p) => p.projectDirs.includes(operatorDir));
    assert.equal(kept?.classification, "unclassified");
  });

  test("show reaches a SUPPRESSED artifact by path", async () => {
    const artifact = realDir("forge-cli-artifact-");
    seedRun(artifact, "run-artifact");
    recordWorkspacePurpose({ path: artifact, kind: "disposable_clone", owner: { runId: "run-artifact" } });

    const { out, code } = await runCli("projects", "show", artifact, "--json", "--scan-root", scanRoot);
    assert.equal(code, 0);
    const parsed = JSON.parse(out) as { project: { projectDirs: string[]; classification?: string; purpose?: string } };
    assert.ok(parsed.project.projectDirs.includes(artifact), "the artifact is still resolvable from `projects show` (AC1)");
    assert.equal(parsed.project.classification, "artifact");
    assert.equal(parsed.project.purpose, "disposable_clone");
  });
});
