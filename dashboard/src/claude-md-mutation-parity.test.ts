// The workspace guide is what an agent reads before touching the server, so its account of
// what the dashboard may mutate must match the routes server.ts actually owns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUEUE_MUTATION_ROUTES } from "./queue-mutation.js";

const guide = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "CLAUDE.md"), "utf8");
const intro = guide.split("\n## ")[0]!;

test("dashboard/CLAUDE.md intro names the closed mutation set and no gate/retry mutations", () => {
  assert.doesNotMatch(intro, /mutations \(gate decisions, retries\)/, "gate/retry have no dashboard routes");
  assert.match(intro, /four `forge queue` verbs/);
  assert.match(intro, /`forge projects classify`/);
  assert.match(intro, /Gate decisions, next and retries stay CLI-only/);
});

test("dashboard/CLAUDE.md route contract lists every mutating route server.ts owns", () => {
  const queuePaths = Object.keys(QUEUE_MUTATION_ROUTES);
  assert.equal(queuePaths.length, 4, "the guide says four queue verbs");
  const verbs = queuePaths.map((p) => p.replace("/api/queue/", ""));
  assert.ok(guide.includes(`/api/queue/${verbs.join("|")}`), "the guide names every queue route");
  assert.ok(guide.includes("POST /api/projects/classify"));
  assert.match(guide, /There are no gate\/next\/retry routes/);
});
