// FG-745 (AC9): the five-shape acceptance matrix over the SHARED projection seam.
//
// This exercises aggregateProjectSignals + operatorProjects PURELY — an injected
// identity resolver and an injected purpose resolver, no DB and no filesystem — so
// the membership rule is provable in isolation:
//
//   (a) a Forge disposable clone with a recorded owner + purpose  -> SUPPRESSED
//   (b) a retained evidence_fixture                               -> SUPPRESSED
//   (c) an ACTIVE artifact (in-flight run + live session)         -> SUPPRESSED from the
//                                                                    grid, but its runs /
//                                                                    live session remain in
//                                                                    the FULL annotated set
//   (d) a genuinely independent project, one run, no remote        -> VISIBLE
//   (e) an unclassified legacy directory                          -> VISIBLE (flagged)
//
// The invariant under test: only an EXPLICITLY-recorded artifact kind suppresses a
// top-level entry; operator and unclassified stay visible; NO path/name/age/
// run-count/remote signal decides visibility.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateProjectSignals,
  operatorProjects,
  type ProjectPurposeInfo,
  type ProjectSignal,
  type RepositoryIdentityResolver,
  type WorkspacePurposeResolver,
} from "./projects.js";

// Five distinct repositories, each its own checkout root — a disposable clone is its
// OWN repository, so each shape is one record.
const DISPOSABLE = "/tmp/fg745/disposable-clone";
const EVIDENCE = "/Users/x/code/fg584-dogfood";
const ACTIVE = "/private/tmp/forge-fg253.J5trMO";
const INDEPENDENT = "/tmp/fg745/independent-oneRun-noRemote";
const LEGACY = "/tmp/fg745/legacy-unclassified";

const IDENTITY: RepositoryIdentityResolver = (projectDir) => {
  const map: Record<string, { key: string; remoteName?: string }> = {
    [DISPOSABLE]: { key: "repo-disposable", remoteName: "forge" },
    [EVIDENCE]: { key: "repo-evidence" },
    [ACTIVE]: { key: "repo-active" },
    // (d): NO remoteName — a real independent project with no Git remote.
    [INDEPENDENT]: { key: "repo-independent" },
    [LEGACY]: { key: "repo-legacy" },
  };
  const entry = map[projectDir];
  assert.ok(entry, `missing identity fixture for ${projectDir}`);
  return {
    key: entry.key,
    source: "remote",
    checkoutRoot: projectDir,
    exists: true,
    ...(entry.remoteName ? { remoteName: entry.remoteName } : {}),
  };
};

const PURPOSES: Record<string, ProjectPurposeInfo> = {
  [DISPOSABLE]: { purpose: "disposable_clone", owner: { projectIdentity: "pk-forge", runId: "run-1" } },
  [EVIDENCE]: { purpose: "evidence_fixture", owner: { projectIdentity: "pk-forge" } },
  [ACTIVE]: { purpose: "worktree", owner: { projectIdentity: "pk-forge", runId: "run-active" } },
  // INDEPENDENT and LEGACY have NO recorded purpose -> resolver returns undefined ->
  // annotated unclassified (visible).
};

const RESOLVE_PURPOSE: WorkspacePurposeResolver = (root) => PURPOSES[root];

const SIGNALS: ProjectSignal[] = [
  { projectDir: DISPOSABLE, runCount: 1, lastRunAt: "2026-08-01T00:00:00Z" },
  { projectDir: EVIDENCE, runCount: 1, lastRunAt: "2026-08-02T00:00:00Z" },
  { projectDir: ACTIVE, runCount: 1, inFlightCount: 1, liveSessions: 1, lastRunAt: "2026-08-20T00:00:00Z" },
  { projectDir: INDEPENDENT, runCount: 1, lastRunAt: "2026-08-03T00:00:00Z" },
  { projectDir: LEGACY, runCount: 1, lastRunAt: "2026-08-04T00:00:00Z" },
];

function records() {
  return aggregateProjectSignals(SIGNALS, IDENTITY, RESOLVE_PURPOSE);
}

function byKey(list: ReturnType<typeof records>, key: string) {
  return list.find((r) => r.key === key);
}

describe("FG-745 projection matrix (AC9)", () => {
  test("the FULL annotated set carries every shape with structured purpose/classification", () => {
    const all = records();
    assert.equal(byKey(all, "repo-disposable")?.classification, "artifact");
    assert.equal(byKey(all, "repo-disposable")?.purpose, "disposable_clone");
    assert.equal(byKey(all, "repo-evidence")?.classification, "artifact");
    assert.equal(byKey(all, "repo-active")?.classification, "artifact");
    assert.equal(byKey(all, "repo-independent")?.classification, "unclassified");
    assert.equal(byKey(all, "repo-independent")?.purpose, "unclassified");
    assert.equal(byKey(all, "repo-legacy")?.classification, "unclassified");
    // Owner attribution survives as structured data (AC7).
    assert.equal(byKey(all, "repo-disposable")?.owner?.projectIdentity, "pk-forge");
  });

  test("operatorProjects suppresses recorded artifacts and keeps operator + unclassified", () => {
    const operators = operatorProjects(records());
    const keys = new Set(operators.map((r) => r.key));
    // (a),(b),(c): explicit artifact kinds are suppressed.
    assert.ok(!keys.has("repo-disposable"), "disposable clone is not a top-level project (AC1)");
    assert.ok(!keys.has("repo-evidence"), "retained evidence fixture is not a peer project (AC2)");
    assert.ok(!keys.has("repo-active"), "an active artifact is not a top-level project");
    // (d),(e): a real one-run/no-remote project and an unclassified legacy dir stay.
    assert.ok(keys.has("repo-independent"), "a one-run/no-remote project stays visible (AC4)");
    assert.ok(keys.has("repo-legacy"), "an unclassified legacy dir stays visible & flagged (AC8)");
  });

  test("the active artifact's run/live-session signal survives in the FULL set (AC5)", () => {
    // The Projects grid drops it, but the annotated record (which the Current-Activity
    // scope path consumes) still carries its in-flight + live-session counts.
    const active = byKey(records(), "repo-active");
    assert.ok(active);
    assert.equal(active.inFlightCount, 1);
    assert.equal(active.liveSessions, 1);
  });

  test("visibility consults ONLY the recorded classification — the same no-remote shape flips with its record", () => {
    // repo-independent has no remote and one run and is VISIBLE. Give the SAME shape a
    // recorded artifact purpose and it flips to suppressed — proving the record, not
    // the remote/run-count, decides. (No path/name/age heuristic is involved.)
    const flipped = aggregateProjectSignals(
      [{ projectDir: INDEPENDENT, runCount: 1 }],
      IDENTITY,
      () => ({ purpose: "worktree" }),
    );
    assert.equal(operatorProjects(flipped).length, 0);
    const kept = aggregateProjectSignals([{ projectDir: INDEPENDENT, runCount: 1 }], IDENTITY, () => undefined);
    assert.equal(operatorProjects(kept).length, 1);
  });
});
