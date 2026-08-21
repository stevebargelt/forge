// FG-745: the durable workspace-purpose store.
//
// The load-bearing properties here are (1) the codec FAILS OPEN — an unknown /
// absent kind reads as `unclassified` (VISIBLE), NEVER as an artifact kind that
// would suppress a real project; (2) the classify claim is atomic and
// REFUSE-on-conflict — it never silently overwrites a recorded purpose; (3) a store
// that predates the table degrades to `unclassified` via a shape-probe rather than
// throwing. Real store code against a real in-memory SQLite DB.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import {
  DEFAULT_WORKSPACE_KIND,
  WORKSPACE_KIND_VALUES,
  ARTIFACT_WORKSPACE_KINDS,
  attachRetentionReason,
  classificationForKind,
  classifyWorkspacePurpose,
  decodeWorkspaceKind,
  getWorkspacePurpose,
  hasWorkspacePurposeTable,
  isWorkspaceKind,
  recordWorkspacePurpose,
  workspacePurposesByCanonical,
  WorkspacePurposeConflictError,
  type WorkspaceKind,
} from "./workspace-purpose.js";

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

/** A real directory whose realpath provenPhysical will resolve. */
function realDir(prefix = "forge-wp-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

describe("FG-745 workspace-purpose — the codec", () => {
  test("every kind in the closed vocabulary decodes to itself", () => {
    for (const kind of WORKSPACE_KIND_VALUES) {
      assert.equal(decodeWorkspaceKind(kind), kind);
      assert.ok(isWorkspaceKind(kind));
    }
  });

  test("an unknown value, NULL, empty, and undefined all decode to unclassified — NEVER an artifact kind", () => {
    for (const raw of ["disposable_clone_typo", "OPERATOR", "", null, undefined, "generic"]) {
      const decoded = decodeWorkspaceKind(raw as string | null | undefined);
      assert.equal(decoded, "unclassified", `${JSON.stringify(raw)} must fail OPEN to unclassified`);
      assert.ok(!ARTIFACT_WORKSPACE_KINDS.includes(decoded), "the fail-safe never decodes to an artifact kind");
    }
    assert.equal(DEFAULT_WORKSPACE_KIND, "unclassified");
    assert.ok(!isWorkspaceKind("nope"));
  });

  test("classification maps operator/unclassified to visible and artifact kinds to artifact", () => {
    assert.equal(classificationForKind("operator"), "operator");
    assert.equal(classificationForKind("unclassified"), "unclassified");
    for (const kind of ARTIFACT_WORKSPACE_KINDS) {
      assert.equal(classificationForKind(kind), "artifact");
    }
  });
});

describe("FG-745 workspace-purpose — round trip", () => {
  test("records and reads back every kind with owner + reason for a canonical path", () => {
    for (const kind of WORKSPACE_KIND_VALUES) {
      const dir = realDir();
      const recorded = recordWorkspacePurpose({
        path: dir,
        kind,
        owner: { projectIdentity: "pk-owner", runId: "run-1", taskId: "task-1" },
        ...(kind === "unclassified" ? { reason: "ownership_ambiguous" as const } : {}),
      });
      assert.ok(recorded, "a resolvable path records");
      const back = getWorkspacePurpose(dir);
      assert.ok(back, "the row reads back");
      assert.equal(back.kind, kind);
      assert.equal(back.path, dir, "keyed on the proven canonical path");
      assert.equal(back.projectIdentity, "pk-owner");
      assert.equal(back.runId, "run-1");
      assert.equal(back.taskId, "task-1");
    }
  });

  test("a bulk lookup returns only the paths with recorded rows", () => {
    const a = realDir();
    const b = realDir();
    const c = realDir();
    recordWorkspacePurpose({ path: a, kind: "worktree" });
    recordWorkspacePurpose({ path: b, kind: "evidence_fixture" });
    const map = workspacePurposesByCanonical([a, b, c]);
    assert.equal(map.get(a)?.kind, "worktree");
    assert.equal(map.get(b)?.kind, "evidence_fixture");
    assert.equal(map.get(c), undefined, "an unrecorded path is a miss (reads unclassified)");
  });

  test("an unresolvable path is a best-effort no-op, not a throw", () => {
    const recorded = recordWorkspacePurpose({ path: "/nonexistent/forge-745/never", kind: "worktree" });
    assert.equal(recorded, false);
    assert.equal(getWorkspacePurpose("/nonexistent/forge-745/never"), undefined);
  });
});

describe("FG-745 workspace-purpose — the classify claim", () => {
  test("claims an absent directory for the requested kind", () => {
    const dir = realDir();
    const result = classifyWorkspacePurpose({ path: dir, kind: "evidence_fixture" });
    assert.equal(result.kind, "evidence_fixture");
    assert.equal(result.previousKind, undefined);
    assert.equal(getWorkspacePurpose(dir)?.kind, "evidence_fixture");
  });

  test("claims an unclassified row (the legacy-repair door) and reports the prior kind", () => {
    const dir = realDir();
    attachRetentionReason({ path: dir, reason: "ownership_ambiguous" }); // records unclassified + reason
    const result = classifyWorkspacePurpose({ path: dir, kind: "evidence_fixture" });
    assert.equal(result.previousKind, "unclassified");
    assert.equal(getWorkspacePurpose(dir)?.kind, "evidence_fixture");
  });

  test("REFUSES a conflicting reassignment instead of silently overwriting", () => {
    const dir = realDir();
    classifyWorkspacePurpose({ path: dir, kind: "evidence_fixture" });
    assert.throws(
      () => classifyWorkspacePurpose({ path: dir, kind: "operator" }),
      (err: unknown) => {
        assert.ok(err instanceof WorkspacePurposeConflictError);
        assert.equal(err.detail.existingKind, "evidence_fixture");
        assert.equal(err.detail.requestedKind, "operator");
        return true;
      },
    );
    // The stored fact is unchanged — no silent overwrite.
    assert.equal(getWorkspacePurpose(dir)?.kind, "evidence_fixture");
  });

  test("re-classifying to the SAME kind is idempotent, not a conflict", () => {
    const dir = realDir();
    classifyWorkspacePurpose({ path: dir, kind: "worktree" });
    const again = classifyWorkspacePurpose({ path: dir, kind: "worktree" });
    assert.equal(again.kind, "worktree");
    assert.equal(again.previousKind, "worktree");
  });

  test("refuses to classify a path that does not resolve to a real directory", () => {
    assert.throws(() => classifyWorkspacePurpose({ path: "/nonexistent/forge-745/phantom", kind: "operator" }));
  });
});

describe("FG-745 workspace-purpose — retention reasons (AC6)", () => {
  test("records unclassified + reason when nothing was recorded at creation", () => {
    const dir = realDir();
    attachRetentionReason({ path: dir, reason: "active_process_cwd", owner: { projectIdentity: "pk-x", runId: "run-9" } });
    const back = getWorkspacePurpose(dir);
    assert.equal(back?.kind, "unclassified", "a retained-but-undeclared workspace stays unclassified/visible");
    assert.equal(back?.reason, "active_process_cwd");
    assert.equal(back?.projectIdentity, "pk-x");
  });

  test("preserves an existing artifact kind while attaching the reason", () => {
    const dir = realDir();
    recordWorkspacePurpose({ path: dir, kind: "worktree", owner: { runId: "run-2" } });
    attachRetentionReason({ path: dir, reason: "active_mount" });
    const back = getWorkspacePurpose(dir);
    assert.equal(back?.kind, "worktree", "the recorded artifact kind is never clobbered by a retention reason");
    assert.equal(back?.reason, "active_mount");
  });
});

describe("FG-745 workspace-purpose — the shape-probe (unmigrated store)", () => {
  test("a store with no workspace_purposes table degrades to unclassified, never a 500", () => {
    // Hand-shape a minimal DB that has runs but NOT workspace_purposes.
    const minimal = new Database(":memory:");
    minimal.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, project_dir TEXT)`);
    const restore = setDbForTest(minimal);
    try {
      assert.equal(hasWorkspacePurposeTable(minimal), false);
      const dir = realDir();
      // A read against the missing table must not throw — it degrades to undefined.
      assert.equal(getWorkspacePurpose(dir), undefined);
      assert.equal(workspacePurposesByCanonical([dir]).size, 0);
    } finally {
      setDbForTest(restore as DatabaseInstance);
      minimal.close();
    }
  });

  test("the migrated store DOES carry the table", () => {
    assert.ok(hasWorkspacePurposeTable(db));
  });
});
