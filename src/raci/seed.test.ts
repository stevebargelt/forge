// Integration test: the shipped seeds/forge-raci.md parses cleanly under the
// record-block grammar and yields the expected routes. If this fails after a
// seed edit, either the seed drifted from the format (fix the seed) or the
// parser is wrong (fix the parser).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRaci } from "./parse.js";
import { ROUTE_PATHS } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "seeds", "forge-raci.md");

const seed = () => readFileSync(SEED_PATH, "utf8");

const EXPECTED_ROUTES = [
  "strategy",
  "planning",
  "ticketing",
  "implementation_full",
  "implementation_quick",
  "testing_automation",
  "testing_exploratory",
  "documentation_durable",
  "documentation_ephemeral",
  "research",
  "review_wide",
  "review_narrow",
  "review_frontend",
  "review_backend",
  "review_security",
  "architecture",
  "ui_design",
  "orientation",
  "meta",
];

test("seeds/forge-raci.md parses without error", () => {
  assert.doesNotThrow(() => parseRaci(seed()));
});

test("seed yields exactly the expected routes", () => {
  const routes = parseRaci(seed());
  assert.deepEqual(
    routes.map((r) => r.route),
    EXPECTED_ROUTES,
  );
});

test("every route is accountable=human with a valid path", () => {
  for (const r of parseRaci(seed())) {
    assert.equal(r.accountable, "human", `${r.route} accountable`);
    assert.ok(
      (ROUTE_PATHS as readonly string[]).includes(r.path),
      `${r.route} path ${r.path}`,
    );
  }
});

test("guidance prose below the blocks is ignored (no spurious routes)", () => {
  // The seed has a large 'Routing guidance (NOT compiled)' section; the parser
  // must not pick anything out of it. EXPECTED_ROUTES is exhaustive.
  assert.equal(parseRaci(seed()).length, EXPECTED_ROUTES.length);
});

test("implementation_quick keeps test-engineer as a mandatory followup", () => {
  const r = parseRaci(seed()).find((x) => x.route === "implementation_quick");
  assert.ok(r);
  assert.equal(r.path, "invoke_chain");
  assert.equal(r.responsible, "engineer");
  assert.deepEqual(r.requiredFollowups, ["test-engineer"]);
});

test("implementation_full dispatches the feature workflow", () => {
  const r = parseRaci(seed()).find((x) => x.route === "implementation_full");
  assert.ok(r);
  assert.equal(r.path, "workflow");
  assert.equal(r.responsible, "feature");
});

test("conditional informed targets parse (ticketing -> backlog:when=ticketed)", () => {
  const r = parseRaci(seed()).find((x) => x.route === "ticketing");
  assert.ok(r);
  assert.deepEqual(r.informed, [
    { name: "user_summary" },
    { name: "backlog", when: "ticketed" },
  ]);
});

test("no route carries a command (the seed has no cli routes yet)", () => {
  for (const r of parseRaci(seed())) {
    assert.equal(r.command, undefined, `${r.route} unexpectedly has a command`);
  }
});
