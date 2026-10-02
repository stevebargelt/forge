// FG-847 Rule 2 / AC 2 — POST /api/backlog/<id>/edit: a closed-registry row shelling exactly
// `forge backlog edit <id> --body -`, the body on the child's STDIN and never in argv,
// size-bounded, behind the shared guards and the mutation slot, every refusal before a spawn,
// the actor carried as FORGE_ACTOR=dashboard; the response carries the new revision and the
// re-run verdict. The CLI half — the write and its `backlog.ticket_edited` event — runs
// in-process at the end.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "fg847-edit-home-"));
process.env["FORGE_HOME"] = HOME;
delete process.env["HOST"];
delete process.env["FORGE_ACTOR"];
// The CLI half runs against this test's own store, never an agent container's mounted snapshot.
delete process.env["FORGE_BACKLOG_SNAPSHOT_DIR"];

const { ACTION_FORGE_VERBS, ACTION_ROUTES, isActionMutationPath, handleActionMutation } = await import("./action-mutation.js");
const { BACKLOG_EDIT_PATH, MAX_TICKET_BODY_BYTES, backlogEditArgv, parseBacklogEditRequest } = await import("./backlog-edit-mutation.js");
const { isRefusal } = await import("./mutation-guards.js");
const { getDb } = await import("../../src/store/db.js");
const { setStorageMode, getTicket } = await import("../../src/store/tickets.js");
const { clearBacklogStoreCache } = await import("../../src/backlog/storage-mode.js");
const { writeTicket } = await import("../../src/backlog/structured.js");
const { Command } = await import("commander");
const { registerBacklog } = await import("../../src/cli/commands/backlog.js");
const { provenPhysical } = await import("../../src/util/path-identity.js");
const { setAuthorityMountForTest } = await import("../../src/backlog/container-authority.js");
setAuthorityMountForTest(mkdtempSync(join(tmpdir(), "fg847-edit-no-authority-")));

const PK = "pk-fg847-edit";
const CHECKOUT = mkdtempSync(join(tmpdir(), "fg847-edit-checkout-"));
mkdirSync(join(CHECKOUT, ".forge"), { recursive: true });
writeFileSync(join(CHECKOUT, ".forge", "config.yml"), `project_key: ${PK}\nbacklog:\n  prefix: FG\n`);
const MARKDOWN_CHECKOUT = mkdtempSync(join(tmpdir(), "fg847-edit-md-"));

getDb();
setStorageMode(PK, "db", "2026-09-30T00:00:00Z");
clearBacklogStoreCache();
const NOT_READY = "Only a description.\n";
writeTicket(CHECKOUT, { id: "FG-7", type: "story", status: "active", title: "seven", body: NOT_READY, created: "2026-09-30" });

after(() => {
  for (const d of [HOME, CHECKOUT, MARKDOWN_CHECKOUT, BIN_DIR]) rmSync(d, { recursive: true, force: true });
});

const project = (key: string, dir: string) =>
  ({
    key,
    label: key,
    primaryCheckout: dir,
    projectDir: dir,
    checkouts: [{ projectDir: dir, projectDirs: [dir], exists: true, runCount: 0, inFlightCount: 0, liveSessions: 0 }],
  }) as never;
const PROJECTS: Record<string, unknown> = { "repo-1": project("repo-1", CHECKOUT), "repo-md": project("repo-md", MARKDOWN_CHECKOUT), "repo-none": project("repo-none", MARKDOWN_CHECKOUT) };
const IDENTITY: Record<string, unknown> = { "repo-1": { projectKey: PK, storageMode: "db" }, "repo-md": { projectKey: "pk-md", storageMode: "markdown" }, "repo-none": null };

// ─── the fake forge: records PWD, FORGE_ACTOR, argv and stdin, then applies the body to the
// store the way `backlog edit` does (body replaced, revision + 1) so the route's re-read is real.

const BIN_DIR = mkdtempSync(join(tmpdir(), "fg847-edit-bin-"));
const LOG = join(BIN_DIR, "argv.log");
const STDIN_LOG = join(BIN_DIR, "stdin.log");
const SQLITE = createRequire(import.meta.url).resolve("better-sqlite3");
const FAKE_FORGE = join(BIN_DIR, "forge");
writeFileSync(
  FAKE_FORGE,
  `#!/usr/bin/env node
const fs = require("node:fs");
const body = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(LOG)}, [process.cwd(), process.env.FORGE_ACTOR ?? "", ...process.argv.slice(2)].join("\\n"));
fs.writeFileSync(${JSON.stringify(STDIN_LOG)}, body);
const Database = require(${JSON.stringify(SQLITE)});
const db = new Database(${JSON.stringify(join(HOME, "forge.db"))});
db.prepare("UPDATE tickets SET body = ?, revision = revision + 1, body_hash = NULL WHERE project_key = ? AND ticket_id = ?").run(body, ${JSON.stringify(PK)}, process.argv[4]);
console.log("Updated body of " + process.argv[4]);
`,
);
chmodSync(FAKE_FORGE, 0o755);
process.env["FORGE_BIN"] = FAKE_FORGE;

function spawned(): { cwd: string; actor: string; argv: string[]; stdin: string } | null {
  if (!existsSync(LOG)) return null;
  const [cwd, actor, ...argv] = readFileSync(LOG, "utf8").split("\n");
  const stdin = readFileSync(STDIN_LOG, "utf8");
  rmSync(LOG);
  rmSync(STDIN_LOG);
  return { cwd: cwd!, actor: actor!, argv, stdin };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]) as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1:8024", "content-type": "application/json", origin: "http://127.0.0.1:8024", ...headers };
  req.method = "POST";
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      writeHead(s: number) {
        status = s;
        return res;
      },
      end(text: string) {
        resolve({ status, body: JSON.parse(text) as Record<string, unknown> });
      },
    } as unknown as ServerResponse;
    void handleActionMutation(req, res, path, {
      lookupTask: () => null,
      resolveProject: (key) => PROJECTS[key] as never,
      ticketIdentity: (p) => IDENTITY[(p as unknown as { key: string }).key] as never,
    });
  });
}

const READY = "## Problem\n\nThe click did nothing visible.\n\n## Goal\n\nThe refusal shows where the operator acted.\n\n## Acceptance Criteria\n- it shows\n";

// ─── the registry row ────────────────────────────────────────────────────────

test("the registry: one row shelling the `backlog` verb; nothing else under /api/backlog mutates", () => {
  assert.deepEqual(ACTION_ROUTES["backlog-edit"], { path: "/api/backlog/:id/edit", verb: "backlog" });
  assert.ok((ACTION_FORGE_VERBS as readonly string[]).includes("backlog"));
  assert.ok(isActionMutationPath("/api/backlog/FG-7/edit"));
  for (const path of ["/api/backlog/FG-7/readiness", "/api/backlog/FG-7/runs", "/api/backlog/FG-7/edit/force", "/api/backlog/edit", "/api/backlog/FG-7/close", "/api/backlog/FG-7/file"]) {
    assert.equal(BACKLOG_EDIT_PATH.test(path), false, path);
    assert.equal(isActionMutationPath(path), false, path);
  }
});

test("the argv: exactly `backlog edit <id> --body -` — the body is never an argv element", () => {
  assert.deepEqual(backlogEditArgv("FG-7"), ["backlog", "edit", "FG-7", "--body", "-"]);
});

test("parseBacklogEditRequest: the one shape, the size bound (MAX_TICKET_BODY_BYTES, in UTF-8 bytes), no control characters", () => {
  assert.equal(MAX_TICKET_BODY_BYTES, 64 * 1024);
  assert.deepEqual(parseBacklogEditRequest({ projectKey: "repo-1", body: READY, baseRevision: 3 }), { projectKey: "repo-1", projectDir: undefined, body: READY, baseRevision: 3 });
  const atBound = "é".repeat(MAX_TICKET_BODY_BYTES / 2);
  assert.ok(!isRefusal(parseBacklogEditRequest({ projectKey: "k", body: atBound })), "exactly the bound is accepted");
  const refused: Array<[unknown, number, RegExp]> = [
    [{ projectKey: "k", body: `${atBound}x` }, 413, /at most 65536 bytes/],
    [{ projectKey: "k" }, 400, /body is required/],
    [{ projectKey: "k", body: "   \n" }, 400, /must not be empty/],
    [{ projectKey: "k", body: "a\u0000b" }, 400, /control characters/],
    [{ projectKey: "k", body: "x", argv: ["--force"] }, 400, /refusing argv/],
    [{ projectKey: "k", body: "x", force: true }, 400, /refusing force/],
    [{ body: "x" }, 400, /projectKey is required/],
    [{ projectKey: "k", body: "x", baseRevision: -1 }, 400, /baseRevision/],
    [{ projectKey: "k", body: "x", baseRevision: "3" }, 400, /baseRevision/],
    [{ projectKey: "k", body: 7 }, 400, /body is required/],
    [["x"], 400, /JSON object/],
  ];
  for (const [input, status, why] of refused) {
    const out = parseBacklogEditRequest(input);
    assert.ok(isRefusal(out), JSON.stringify(input).slice(0, 80));
    if (isRefusal(out)) {
      assert.equal(out.status, status);
      assert.match(out.error, why);
    }
  }
});

// ─── the handler ─────────────────────────────────────────────────────────────

test("handler: a body that still lacks sections is written and stays needs_refinement — the response carries the new revision and the re-run verdict", async () => {
  spawned();
  const before = getTicket(PK, "FG-7")!.revision!;
  const body = "Still only a description — now with `$(rm -rf /)` and a --flag in it.\n";
  const out = await post("/api/backlog/FG-7/edit", { projectKey: "repo-1", body, baseRevision: before });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const child = spawned()!;
  assert.deepEqual(child.argv, ["backlog", "edit", "FG-7", "--body", "-"], "exactly this argv");
  assert.equal(child.stdin, body, "the body arrives on stdin");
  assert.ok(!child.argv.some((a) => a.includes("description")), "and never in argv");
  assert.equal(child.actor, "dashboard", "the actor is the dashboard, set server-side");
  assert.equal(provenPhysical(child.cwd), provenPhysical(CHECKOUT), "runs in the registry's checkout");
  assert.equal(out.body["verb"], "forge backlog edit FG-7 --body -");
  assert.equal(out.body["previousRevision"], before);
  assert.equal(out.body["revision"], before + 1);
  const readiness = out.body["readiness"] as Record<string, unknown>;
  assert.equal(readiness["outcome"], "needs_refinement");
  assert.equal(readiness["revision"], before + 1);
  assert.equal(readiness["body"], body);
});

test("handler: a body with the sections flips the verdict to ready at the new revision", async () => {
  const before = getTicket(PK, "FG-7")!.revision!;
  const out = await post("/api/backlog/FG-7/edit", { projectKey: "repo-1", body: READY, baseRevision: before });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(spawned()!.stdin, READY);
  assert.equal(out.body["revision"], before + 1);
  assert.equal((out.body["readiness"] as Record<string, unknown>)["outcome"], "ready");
});

test("handler: the CLI's refusal passes through verbatim as a 409", async () => {
  const refuseBin = join(BIN_DIR, "forge-refuses");
  writeFileSync(refuseBin, `#!/bin/sh\ncat > /dev/null\necho "forge: Ticket FG-7 is locked by a migration" >&2\nexit 1\n`);
  chmodSync(refuseBin, 0o755);
  process.env["FORGE_BIN"] = refuseBin;
  try {
    const out = await post("/api/backlog/FG-7/edit", { projectKey: "repo-1", body: READY });
    assert.equal(out.status, 409);
    assert.equal(out.body["ok"], false);
    assert.equal(out.body["error"], "forge: Ticket FG-7 is locked by a migration");
  } finally {
    process.env["FORGE_BIN"] = FAKE_FORGE;
  }
});

test("handler: every refusal happens before a spawn — guards, bad JSON, size, unknown project, markdown store, missing ticket, a moved revision", async () => {
  spawned();
  const current = getTicket(PK, "FG-7")!.revision!;
  const refusals: Array<[string, unknown, Record<string, string>, number, RegExp]> = [
    ["/api/backlog/FG-7/edit", { projectKey: "repo-1", body: READY }, { "content-type": "text/plain" }, 415, /application\/json/],
    ["/api/backlog/FG-7/edit", { projectKey: "repo-1", body: READY }, { origin: "http://evil.example" }, 403, /cross-origin/],
    ["/api/backlog/FG-7/edit", { projectKey: "repo-1", body: READY }, { "sec-fetch-site": "cross-site" }, 403, /cross-origin/],
    ["/api/backlog/FG-7/edit", { projectKey: "repo-1", body: READY }, { host: "attacker.example:8024" }, 403, /Host/],
    ["/api/backlog/FG-7/edit", "{not json", {}, 400, /not valid JSON/],
    ["/api/backlog/FG-7/edit", { projectKey: "repo-1", body: "x".repeat(MAX_TICKET_BODY_BYTES + 1) }, {}, 413, /at most/],
    ["/api/backlog/FG-7/edit", { projectKey: "repo-1", body: "y".repeat(3 * MAX_TICKET_BODY_BYTES) }, {}, 413, /exceeds/],
    ["/api/backlog/-rf/edit", { projectKey: "repo-1", body: READY }, {}, 400, /must not begin with "-"/],
    ["/api/backlog/FG%207/edit", { projectKey: "repo-1", body: READY }, {}, 400, /not a ticket id/],
    ["/api/backlog/FG-7/edit", { projectKey: "nope", body: READY }, {}, 404, /no registered project/],
    ["/api/backlog/FG-7/edit", { projectKey: "repo-md", body: READY }, {}, 409, /store of record/],
    ["/api/backlog/FG-7/edit", { projectKey: "repo-none", body: READY }, {}, 404, /no ticket store/],
    ["/api/backlog/FG-404/edit", { projectKey: "repo-1", body: READY }, {}, 404, /no ticket FG-404/],
    ["/api/backlog/FG-7/edit", { projectKey: "repo-1", body: READY, baseRevision: current - 1 }, {}, 409, /someone edited it meanwhile/],
  ];
  for (const [path, body, headers, status, why] of refusals) {
    const out = await post(path, body, headers);
    assert.equal(out.status, status, `${path} ${JSON.stringify(headers)}: ${JSON.stringify(out.body).slice(0, 300)}`);
    assert.equal(out.body["ok"], false);
    assert.match(String(out.body["error"]), why);
    assert.equal(spawned(), null, "nothing spawned");
  }
  process.env["HOST"] = "0.0.0.0";
  try {
    const out = await post("/api/backlog/FG-7/edit", { projectKey: "repo-1", body: READY });
    assert.equal(out.status, 403);
    assert.match(String(out.body["error"]), /not loopback/);
    assert.equal(spawned(), null);
  } finally {
    delete process.env["HOST"];
  }
  assert.equal(getTicket(PK, "FG-7")!.revision, current, "no refusal wrote anything");
});

// ─── the verb the route shells, run in-process: the write and its event ──────

test("`forge backlog edit` records backlog.ticket_edited with the revisions and the actor from FORGE_ACTOR", async () => {
  const program = new Command();
  program.exitOverride();
  registerBacklog(program);
  const before = getTicket(PK, "FG-7")!.revision!;
  const lines: string[] = [];
  const orig = console.log;
  console.log = (line: string) => lines.push(line);
  process.env["FORGE_ACTOR"] = "dashboard";
  try {
    await program.parseAsync(["backlog", "edit", "FG-7", "--body", READY.replace("it shows", "it shows inline"), "--project", CHECKOUT], { from: "user" });
  } finally {
    console.log = orig;
    delete process.env["FORGE_ACTOR"];
  }
  assert.ok(lines.includes(`Updated body of FG-7 (revision ${before + 1})`), lines.join("\n"));
  const rows = getDb().prepare("SELECT payload FROM events WHERE event_type = 'backlog.ticket_edited' ORDER BY id").all() as Array<{ payload: string }>;
  const last = JSON.parse(rows.at(-1)!.payload) as Record<string, unknown>;
  assert.deepEqual(
    { projectKey: last["projectKey"], ticketId: last["ticketId"], previousRevision: last["previousRevision"], revision: last["revision"], actor: last["actor"] },
    { projectKey: PK, ticketId: "FG-7", previousRevision: before, revision: before + 1, actor: "dashboard" },
  );
});
