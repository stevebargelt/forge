import { test } from "node:test";
import assert from "node:assert/strict";
import { presentationRegistry } from "./queries.js";
import type { ProjectRecord } from "@forge/projects";

type CheckoutOverrides = Partial<ProjectRecord["checkouts"][number]> & { projectDir: string };

function checkout(o: CheckoutOverrides): ProjectRecord["checkouts"][number] {
  return {
    projectDir: o.projectDir,
    projectDirs: o.projectDirs ?? [o.projectDir],
    exists: o.exists ?? true,
    runCount: o.runCount ?? 0,
    inFlightCount: o.inFlightCount ?? 0,
    liveSessions: o.liveSessions ?? 0,
    ...(o.branch ? { branch: o.branch } : {}),
    ...(o.lastRunAt ? { lastRunAt: o.lastRunAt } : {}),
  };
}

function record(o: Partial<ProjectRecord> & { key: string; checkouts: ProjectRecord["checkouts"] }): ProjectRecord {
  const primary = o.checkouts[0]!;
  return {
    key: o.key,
    projectDir: o.projectDir ?? primary.projectDir,
    primaryCheckout: o.primaryCheckout ?? primary.projectDir,
    projectDirs: o.projectDirs ?? o.checkouts.flatMap((c) => c.projectDirs),
    checkouts: o.checkouts,
    label: o.label ?? o.key,
    color: o.color ?? "#000",
    runCount: o.runCount ?? o.checkouts.reduce((s, c) => s + c.runCount, 0),
    inFlightCount: o.inFlightCount ?? o.checkouts.reduce((s, c) => s + c.inFlightCount, 0),
    liveSessions: o.liveSessions ?? o.checkouts.reduce((s, c) => s + c.liveSessions, 0),
    ...(o.lastRunAt ? { lastRunAt: o.lastRunAt } : {}),
  };
}

test("suppresses a checkout only when gone AND idle AND no live session", () => {
  const rec = record({
    key: "repo-a",
    label: "Repo A",
    runCount: 9,
    inFlightCount: 1,
    liveSessions: 1,
    lastRunAt: "2026-07-19T00:00:00Z",
    projectDirs: ["/main", "/gone-idle", "/gone-active", "/gone-live", "/present-idle"],
    checkouts: [
      checkout({ projectDir: "/main", branch: "main", exists: true, runCount: 5 }),
      checkout({ projectDir: "/present-idle", branch: "old", exists: true, runCount: 1 }),
      checkout({ projectDir: "/gone-active", exists: false, inFlightCount: 1, runCount: 1 }),
      checkout({ projectDir: "/gone-live", exists: false, liveSessions: 1, runCount: 1 }),
      checkout({ projectDir: "/gone-idle", exists: false, runCount: 1 }),
    ],
  });

  const [out] = presentationRegistry([rec]);
  assert.ok(out);
  assert.deepEqual(
    out.checkouts.map((c) => c.projectDir),
    ["/main", "/present-idle", "/gone-active", "/gone-live"],
    "only the gone+idle+no-live checkout is suppressed",
  );

  // Aggregates and the full historical projectDirs array are passed through untouched.
  assert.equal(out.runCount, 9);
  assert.equal(out.inFlightCount, 1);
  assert.equal(out.liveSessions, 1);
  assert.equal(out.lastRunAt, "2026-07-19T00:00:00Z");
  assert.deepEqual(out.projectDirs, ["/main", "/gone-idle", "/gone-active", "/gone-live", "/present-idle"]);
});

test("omits a project only when no visible checkout remains", () => {
  const active = record({
    key: "repo-active",
    checkouts: [checkout({ projectDir: "/ghost", exists: false, inFlightCount: 1 })],
  });
  const dead = record({
    key: "repo-dead",
    projectDirs: ["/dead-a", "/dead-b"],
    checkouts: [
      checkout({ projectDir: "/dead-a", exists: false, runCount: 2 }),
      checkout({ projectDir: "/dead-b", exists: false, runCount: 1 }),
    ],
  });

  const out = presentationRegistry([active, dead]);
  assert.deepEqual(out.map((r) => r.key), ["repo-active"]);
  // The surviving missing-with-work project keeps its (missing) checkout.
  assert.equal(out[0]!.checkouts.length, 1);
  assert.equal(out[0]!.checkouts[0]!.exists, false);
});

test("does not mutate the input records", () => {
  const rec = record({
    key: "repo-x",
    checkouts: [
      checkout({ projectDir: "/keep", exists: true }),
      checkout({ projectDir: "/drop", exists: false }),
    ],
  });
  presentationRegistry([rec]);
  assert.equal(rec.checkouts.length, 2, "original checkouts array is untouched");
});
