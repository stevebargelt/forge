// The workspace guide is what an agent reads before touching the server, so its account of
// what the dashboard may mutate must match the routes server.ts actually owns.
//
// server.ts listens on import, so its routing is read as source: every non-GET branch ahead
// of the 405 fallthrough must dispatch through a closed registry this test can resolve.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUEUE_MUTATION_ROUTES } from "./queue-mutation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const guide = readFileSync(resolve(HERE, "..", "CLAUDE.md"), "utf8");
const serverSource = readFileSync(resolve(HERE, "server.ts"), "utf8");
const intro = guide.split("\n## ")[0]!;

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function exportedStringConst(name: string): string {
  const m = serverSource.match(new RegExp(`export const ${name} = "([^"]+)";`));
  assert.ok(m, `server.ts exports ${name} as a string literal`);
  return m[1]!;
}

/** Resolve every `if (req.method === "…" && <cond>)` branch ahead of the 405 fallthrough to
 *  the concrete paths it accepts. A branch shape this test cannot resolve fails outright, so
 *  a new mutating route cannot slip past the guide unnoticed. */
function serverMutatingRoutes(): { queue: string[]; all: string[] } {
  const fallthrough = serverSource.indexOf(`if (req.method !== "GET")`);
  assert.ok(fallthrough > 0, "server.ts refuses every non-GET it does not route");
  const branches = [...serverSource.slice(0, fallthrough).matchAll(/if \(req\.method === "([A-Z]+)" && ([^)]+\)?)\)\s*\{/g)];
  assert.ok(branches.length > 0, "server.ts routes at least one mutating method");
  const queue: string[] = [];
  const all: string[] = [];
  for (const [, method, cond] of branches) {
    const c = cond!.trim();
    if (c === "isQueueMutationPath(path)") {
      const paths = Object.keys(QUEUE_MUTATION_ROUTES);
      queue.push(...paths);
      all.push(...paths.map((p) => `${method} ${p}`));
      continue;
    }
    const named = c.match(/^path === ([A-Z_]+)$/);
    assert.ok(named, `unrecognised mutating-route condition in server.ts: ${c}`);
    all.push(`${method} ${exportedStringConst(named[1]!)}`);
  }
  return { queue, all };
}

/** The routes the guide's "Mutations shell out" contract names for server.ts — stopping
 *  before the Remote Board, which is a separate listener. */
function guideMutatingRoutes(): string[] {
  const bullet = guide.split("\n").find((line) => line.startsWith("- **Mutations shell out.**"));
  assert.ok(bullet, "the guide carries the route contract bullet");
  const contract = bullet.split("Every other method is refused")[0]!;
  const routes: string[] = [];
  for (const [token] of contract.matchAll(/\/api\/[a-z/-]+(?:\|[a-z-]+)*/g)) {
    const base = token.slice(0, token.lastIndexOf("/") + 1);
    for (const leaf of token.slice(base.length).split("|")) routes.push(`POST ${base}${leaf}`);
  }
  return routes;
}

test("dashboard/CLAUDE.md intro names the closed mutation set and no gate/retry mutations", () => {
  const { queue } = serverMutatingRoutes();
  assert.doesNotMatch(intro, /mutations \(gate decisions, retries\)/, "gate/retry have no dashboard routes");
  const m = intro.match(/the (\w+) `forge queue` verbs/);
  assert.ok(m, "the intro counts the forge queue verbs");
  assert.equal(NUMBER_WORDS[m[1]!], queue.length, "the intro's queue verb count matches server.ts");
  assert.match(intro, /`forge projects classify`/);
  assert.match(intro, /Gate decisions, next and retries stay CLI-only/);
});

test("dashboard/CLAUDE.md route contract lists every mutating route server.ts owns", () => {
  const { all } = serverMutatingRoutes();
  assert.deepEqual([...guideMutatingRoutes()].sort(), [...all].sort(), "the guide names exactly the mutating routes server.ts owns");
  const m = guide.match(/closed set of (\w+) mutating routes/);
  assert.ok(m, "the guide counts the mutating routes");
  assert.equal(NUMBER_WORDS[m[1]!], all.length, "the guide's route count matches server.ts");
  assert.match(guide, /There are no gate\/next\/retry routes/);
});
