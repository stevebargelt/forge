// FG-521 (d): `awaiting_human_input` was removed from the TaskStatus union by
// FORGE-DEC-020, but the dashboard kept selecting it in queries.ts and carrying
// a badge rule for it in shell.ts. Both are now gone, and acceptance (d) is that
// the name appears NOWHERE under dashboard/src — a dead status in a live query
// reads as a reachable state and misleads the next person editing it.
//
// This guard lives in the root tree on purpose: a test asserting the name's
// absence cannot itself sit under dashboard/src and spell the name. Scanning by
// path (the same shape as test-tiers.test.ts's dashboard content guard) keeps
// the literal on this side of the boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD_SRC_ROOT = fileURLToPath(new URL("../dashboard/src/", import.meta.url));

const PHANTOM_STATUS = "awaiting_human_input";

function gatherFiles(dir: string, root: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...gatherFiles(fullPath, root));
    } else if (entry.isFile()) {
      results.push(relative(root, fullPath));
    }
  }
  return results;
}

test(`FG-521: the removed '${PHANTOM_STATUS}' status appears nowhere under dashboard/src`, () => {
  const files = gatherFiles(DASHBOARD_SRC_ROOT);
  assert.ok(files.length > 0, "scanned no dashboard/src files — the path or the layout changed");

  const hits: string[] = [];
  for (const rel of files) {
    const body = readFileSync(join(DASHBOARD_SRC_ROOT, rel), "utf8");
    body.split("\n").forEach((line, i) => {
      if (line.includes(PHANTOM_STATUS)) hits.push(`dashboard/src/${rel}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    hits,
    [],
    `'${PHANTOM_STATUS}' was removed from TaskStatus (FORGE-DEC-020) and must not be referenced by the dashboard:\n${hits.join("\n")}`,
  );
});
