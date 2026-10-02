// FG-847 Rule 1 / AC 1 — readiness is a read. GET /api/backlog/<id>/readiness answers with
// the SAME derivation `forge readiness <id> --json` prints (core readinessReportForRow), for
// a ready, a needs_refinement and a stale-assessment ticket at the same revision — read from
// the store, with no subprocess on the serving path.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../src/store/db.js";
import { setStorageMode } from "../../src/store/tickets.js";
import { enqueueTicket } from "../../src/store/queue.js";
import { clearBacklogStoreCache } from "../../src/backlog/storage-mode.js";
import { writeTicket, type StructuredTicket } from "../../src/backlog/structured.js";
import { registerReadiness } from "../../src/cli/commands/readiness.js";
import { readTicketReadiness, readinessPayload, readinessRefusal } from "./backlog-edit-mutation.js";

const PK = "pk-fg847-dto";
const READY = "## Problem\nIt breaks.\n\n## Goal\nIt works.\n\n## Acceptance Criteria\n- it works\n";
const NOT_READY = "Only a description, no sections.\n";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let dir: string;

function ticket(id: string, body: string): StructuredTicket {
  return { id, type: "story", status: "active", title: `ticket ${id}`, body, created: "2026-09-30" };
}

before(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
  dir = mkdtempSync(join(tmpdir(), "fg847-dto-"));
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), `project_key: ${PK}\nbacklog:\n  prefix: FG\n`);
  setStorageMode(PK, "db", "2026-09-30T00:00:00Z");
  writeTicket(dir, ticket("FG-1", READY));
  writeTicket(dir, ticket("FG-2", NOT_READY));
  // FG-3: an assessment recorded by an enqueue attempt, then the body edited — stale.
  writeTicket(dir, ticket("FG-3", NOT_READY));
  enqueueTicket(PK, "FG-3", {}, "2026-09-30T01:00:00Z");
  writeTicket(dir, ticket("FG-3", READY));
  // FG-4: recorded and still current.
  writeTicket(dir, ticket("FG-4", NOT_READY));
  enqueueTicket(PK, "FG-4", {}, "2026-09-30T02:00:00Z");
});

after(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  clearBacklogStoreCache();
  rmSync(dir, { recursive: true, force: true });
});

async function cliReadiness(id: string): Promise<Record<string, unknown>> {
  const program = new Command();
  program.exitOverride();
  registerReadiness(program);
  const lines: string[] = [];
  const orig = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    await program.parseAsync(["readiness", id, "--json", "--project", dir], { from: "user" });
  } finally {
    console.log = orig;
  }
  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

function dashboardReadiness(id: string): Record<string, unknown> {
  const lookup = readTicketReadiness({ projectKey: PK, storageMode: "db" }, id);
  assert.equal(lookup.kind, "ok", `${id} reads`);
  return readinessPayload(lookup as Extract<typeof lookup, { kind: "ok" }>) as unknown as Record<string, unknown>;
}

const DTO_FIELDS = ["ticketId", "outcome", "gaps", "refinementProposal", "revision", "evaluatedAt", "stale"];

for (const [id, expected] of [
  ["FG-1", { outcome: "ready", stale: false, recorded: false }],
  ["FG-2", { outcome: "needs_refinement", stale: false, recorded: false }],
  ["FG-3", { outcome: "ready", stale: true, recorded: true }],
  ["FG-4", { outcome: "needs_refinement", stale: false, recorded: true }],
] as const) {
  test(`${id}: the dashboard DTO is the CLI's \`forge readiness --json\`, field for field (${expected.outcome}${expected.stale ? ", stale" : ""})`, async () => {
    const cli = await cliReadiness(id);
    const dto = dashboardReadiness(id);
    assert.deepEqual(Object.keys(cli).sort(), [...DTO_FIELDS].sort(), "the CLI's JSON carries exactly the DTO");
    for (const field of DTO_FIELDS) assert.deepEqual(dto[field], cli[field], `${id}.${field}`);
    assert.equal(dto["outcome"], expected.outcome);
    assert.equal(dto["stale"], expected.stale);
    assert.equal(dto["evaluatedAt"] !== null, expected.recorded, "evaluatedAt is the recorded assessment's, null when none");
    assert.equal(typeof dto["revision"], "number", "a DB-mode ticket reports its revision");
    // The route adds the text the verdict describes — the Refine editor's seed.
    assert.equal(dto["projectKey"], PK);
    assert.equal(typeof dto["body"], "string");
    assert.equal(dto["title"], `ticket ${id}`);
    if (expected.outcome === "needs_refinement") {
      assert.ok((dto["gaps"] as string[]).includes("Missing Problem section"));
      assert.match(String(dto["refinementProposal"]), /## Problem/);
    } else {
      assert.deepEqual(dto["gaps"], []);
      assert.equal(dto["refinementProposal"], null);
    }
  });
}

test("refusals: no ticket store, a markdown-mode project and an unknown ticket are named, never an empty verdict", () => {
  assert.deepEqual(readTicketReadiness(null, "FG-1"), { kind: "no-truth" });
  const markdown = readTicketReadiness({ projectKey: PK, storageMode: "markdown" }, "FG-1");
  assert.equal(markdown.kind, "markdown");
  const missing = readTicketReadiness({ projectKey: PK, storageMode: "db" }, "FG-404");
  assert.equal(missing.kind, "missing");
  assert.equal(readinessRefusal({ kind: "no-truth" }, "FG-1", "proj").status, 404);
  assert.equal(readinessRefusal({ kind: "markdown", projectKey: PK }, "FG-1", "proj").status, 409);
  assert.match(readinessRefusal({ kind: "markdown", projectKey: PK }, "FG-1", "proj").error, /store of record/);
  assert.equal(readinessRefusal({ kind: "missing", projectKey: PK }, "FG-404", "proj").status, 404);
});

test("the serving path: GET /api/backlog/:id/readiness reads the store and spawns nothing", () => {
  const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const start = server.indexOf("const readinessMatch = path.match(BACKLOG_READINESS_PATH);");
  assert.ok(start > 0, "server.ts routes the readiness read");
  assert.ok(start > server.indexOf(`if (req.method !== "GET")`), "it is a GET, behind the non-GET fallthrough");
  const branch = server.slice(start, server.indexOf("return;\n  }\n", server.indexOf("sendJson(res, 503", start)));
  assert.match(branch, /readTicketReadiness\(ticketIdentityForProject\(owner\), ticketId\)/);
  assert.doesNotMatch(branch, /runForgeVerb|execFile|spawn|withMutationSlot/);
  const module = readFileSync(new URL("./backlog-edit-mutation.ts", import.meta.url), "utf8");
  const read = module.slice(module.indexOf("export function readTicketReadiness"), module.indexOf("/** A lookup that is not"));
  assert.match(read, /runInReadOnlyDbScope/);
  assert.doesNotMatch(read, /runForgeVerb|execFile|spawn/);
});
