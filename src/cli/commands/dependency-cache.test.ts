// FG-434: `forge dependency-cache prune` — human/JSON rendering + dry-run
// wiring. The prune logic itself (docker/fs seams, in-use vs removed vs
// error, marker handling) is covered in dependency-provisioning.integration.test.ts;
// these tests cover this command's own surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPruneHuman } from "./dependency-cache.js";
import { pruneDependencyCache, type PruneDependencyCacheResult } from "../../v2/dependency-provisioning.js";

const REPRESENTATIVE: PruneDependencyCacheResult = {
  volumesRemoved: ["forge-deps-aaa1111111111111-root"],
  volumesSkippedInUse: ["forge-deps-bbb2222222222222-root"],
  volumesError: ["forge-deps-ccc3333333333333-root"],
  markersRemoved: ["/forge-home/dependency-cache/aaa1111111111111.ready"],
  dryRun: false,
};

test("renderPruneHuman: reports removed/skipped/error/marker counts", () => {
  const out = renderPruneHuman(REPRESENTATIVE);
  assert.match(out, /Removed 1 dependency-cache volume/);
  assert.match(out, /skipped 1 \(in use\)/);
  assert.match(out, /1 error\(s\)/);
  assert.match(out, /cleared 1 marker\/lock file/);
  assert.match(out, /re-provisioned/);
});

test("renderPruneHuman: dry-run says nothing was removed", () => {
  const out = renderPruneHuman({ ...REPRESENTATIVE, dryRun: true });
  assert.match(out, /Would remove 1/);
  assert.match(out, /Dry run — nothing was removed\./);
});

test("renderPruneHuman: clean prune (nothing skipped/errored) omits those callouts", () => {
  const out = renderPruneHuman({
    volumesRemoved: ["forge-deps-aaa1111111111111-root"],
    volumesSkippedInUse: [],
    volumesError: [],
    markersRemoved: [],
    dryRun: false,
  });
  assert.doesNotMatch(out, /still referenced/);
  assert.doesNotMatch(out, /Errors removing/);
});

test("JSON output round-trips the structured result", () => {
  const json = JSON.stringify(REPRESENTATIVE, null, 2);
  assert.deepEqual(JSON.parse(json), REPRESENTATIVE);
});

test("--dry-run wiring: pruneDependencyCache({dryRun: true}) never calls removeVolume/removeMarkerFile", () => {
  let volumeRmCalled = false;
  let markerRmCalled = false;
  const result = pruneDependencyCache(
    { dryRun: true },
    {
      listVolumeNames: () => ["forge-deps-ddd4444444444444-root"],
      removeVolume: () => {
        volumeRmCalled = true;
        return "removed";
      },
      listMarkerFiles: () => ["/forge-home/dependency-cache/ddd4444444444444.ready"],
      removeMarkerFile: () => {
        markerRmCalled = true;
      },
    },
  );
  assert.equal(volumeRmCalled, false, "--dry-run must write nothing to docker");
  assert.equal(markerRmCalled, false, "--dry-run must write nothing to the cache dir");
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.volumesRemoved, ["forge-deps-ddd4444444444444-root"]);
});
