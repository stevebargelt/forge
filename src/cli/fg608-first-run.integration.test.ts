// FG-608 red F9: FIRST RUN ON A FRESH HOST.
//
// getDb({readOnly: true}) refuses when the store does not exist — reading must
// never create a database and run every migration as a side effect (db.ts). That
// refusal reached no handler, so roughly ten read-only commands died on a host that
// had simply never run a workflow.
//
// Both halves are asserted here and NEITHER alone is the property: the survey
// commands must exit 0 with an empty answer, AND no command may leave forge.db
// behind. A guard that exits 0 by falling through to the WRITABLE handle would pass
// the first half while recreating the exact bug the read-only path exists to kill.
//
// Driven through a real child `forge` process — the property is CLI-level.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fg608-freshhost-"));
  cwd = mkdtempSync(join(tmpdir(), "fg608-freshproj-"));
});

afterEach(() => {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
});

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    cwd,
    input: "",
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: join(home, "forge.db") },
  });
}

function storeCreated(): boolean {
  return existsSync(join(home, "forge.db"));
}

// The survey commands: "what is on this host?" — a host with no store answers
// "nothing", which is a fact, not an error.
const SURVEYS: string[][] = [
  ["status", "--json"],
  ["status"],
  ["runs", "query", "--json"],
  ["metrics", "--json"],
  ["usage", "--json"],
  ["ops", "check", "--json"],
  ["sweep", "--json"],
];

for (const args of SURVEYS) {
  test(`FG-608 F9: \`forge ${args.join(" ")}\` exits 0 on a host with no store, and creates none`, () => {
    const res = runForge(args);
    assert.equal(
      res.status,
      0,
      `must not crash on a fresh host:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
    assert.equal(
      storeCreated(),
      false,
      "a READ created ~/.forge/forge.db — the FORGE-DEC-012 bug the read-only open exists to prevent",
    );
    if (args.includes("--json")) {
      assert.doesNotThrow(
        () => JSON.parse(res.stdout),
        `--json must still emit parseable JSON on an empty host, got: ${res.stdout}`,
      );
    }
  });
}

// The lookup commands are addressed to a SPECIFIC run. "There is no store" cannot
// be answered with an empty result, so they still fail — but with the reason, and
// still without minting a store.
const LOOKUPS: string[][] = [
  ["show", "run-nope"],
  ["report", "run-nope"],
  ["export", "--run", "run-nope"],
  ["bundle", "run-nope"],
];

for (const args of LOOKUPS) {
  test(`FG-608 F9: \`forge ${args.join(" ")}\` fails with a REASON on a fresh host, creating no store`, () => {
    const res = runForge(args);
    assert.notEqual(res.status, 0, "a specific run cannot exist on a host with no store");
    assert.match(
      res.stderr,
      /no forge store exists on this host yet/,
      `the operator gets the precondition, not a store-layer surprise: ${res.stderr}`,
    );
    assert.equal(storeCreated(), false);
  });
}

test("FG-608 F9: after the surveys, FORGE_HOME holds no database at all", () => {
  for (const args of SURVEYS) runForge(args);
  const dbFiles = readdirSync(home).filter((f) => f.startsWith("forge.db"));
  assert.deepEqual(dbFiles, [], `read-only commands left ${dbFiles.join(", ")} behind`);
});
