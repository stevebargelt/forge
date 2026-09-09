// FG-783 regression: one authenticated operator flow through the real loopback listener.
// This deliberately exercises the HTTP handler, CSRF pin, identity scope, SQLite authority,
// request ledger, and project-scoped audit together; no handler or store boundary is mocked.

import "../../../src/test-setup.js";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { createRemoteBoardServer, REMOTE_PLAN_AUDIT_ENDPOINT, REMOTE_PLAN_ENDPOINT } from "./server.js";
import type { BoundRemoteIdentityResolver, RemoteIdentityResolution, VerifiedIdentity } from "./identity.js";
import type { ProjectRecord } from "../queries.js";
import type { ServeStateRecord } from "./tailscale/serve-state.js";
import { applyMigrations, setDbForTest, writeTransaction } from "../../../src/store/db.js";
import { SCHEMA_SQL } from "../../../src/store/schema.js";
import { queueVersion, queueView } from "../../../src/store/queue.js";
import { applyRemotePlanningCommand, remotePlanningAudit } from "../../../src/store/remote-planning.js";
import { upsertTicket, type TicketRow } from "../../../src/store/tickets.js";
import { resetPublishBarrierForTest } from "../../../src/backlog/snapshot.js";

const PROJECT_KEY = "fg783-flow-project";
const PROJECT_DIR = "/tmp/fg783-flow-project";
const OTHER_PROJECT_KEY = "fg783-flow-other";
const ACTOR = "operator@tailnet.test";
const SERVE_HOST = "board.tailnet.test";
const READY_BODY = ["## Problem", "Need a plan.", "", "## Goal", "Deliver it.", "", "## Acceptance Criteria", "- works"].join("\n");

let directory: string;
let db: DatabaseInstance;
let priorDb: DatabaseInstance | null;
let server: Server;
let port: number;
let resolution: RemoteIdentityResolution;

function ticket(ticketId: string, projectKey = PROJECT_KEY): TicketRow {
  return {
    projectKey,
    ticketId,
    type: "story",
    status: "active",
    title: ticketId,
    body: READY_BODY,
    created: "2026-09-09",
    closed: null,
    closedCommit: null,
    epic: null,
    frontmatter: null,
    importedAt: "2026-09-09T00:00:00Z",
    importedFrom: null,
  };
}

function project(): ProjectRecord {
  return {
    key: PROJECT_KEY,
    label: "Planning flow",
    color: "#123456",
    description: null,
    projectDir: PROJECT_DIR,
    primaryCheckout: PROJECT_DIR,
    projectDirs: [PROJECT_DIR],
    checkouts: [],
    lastRunAt: null,
    runCount: 0,
    inFlightCount: 0,
    liveSessions: 0,
  } as unknown as ProjectRecord;
}

function grant(over: Partial<VerifiedIdentity> = {}): RemoteIdentityResolution {
  return {
    ok: true,
    identity: {
      subject: ACTOR,
      capabilities: ["read", "plan"],
      projectScope: { projectKey: PROJECT_KEY, memberDirs: [PROJECT_DIR] },
      provenance: { adapter: "test-adapter" },
      ...over,
    },
    ignoredIdentityHeaders: [],
    confirmedIdentityHeaders: [],
  };
}

function request(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const data = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "POST", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function mutationHeaders(): Record<string, string> {
  return {
    host: SERVE_HOST,
    "content-type": "application/json",
    origin: `https://${SERVE_HOST}`,
    "sec-fetch-site": "same-origin",
  };
}

function queueFingerprint(): string {
  return JSON.stringify({ version: queueVersion(PROJECT_KEY), rows: queueView(PROJECT_KEY).map((row) => [row.ticketId, row.queued, row.rank]) });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "fg783-planning-flow-"));
  db = new Database(join(directory, "forge.db"));
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  priorDb = setDbForTest(db);
  resetPublishBarrierForTest();
  writeTransaction(() => {
    upsertTicket(ticket("FG-1"));
    upsertTicket(ticket("OTHER-1", OTHER_PROJECT_KEY));
  });
  resolution = grant();
  const serveState: ServeStateRecord = { version: 1, serveHost: SERVE_HOST, servePort: 443, loopbackPort: 1, target: "http://127.0.0.1:1", url: `https://${SERVE_HOST}`, createArgs: [], disableArgs: [] };
  server = createRemoteBoardServer({
    resolveIdentity: (async () => resolution) as BoundRemoteIdentityResolver,
    lookupProject: (key) => key === PROJECT_KEY ? project() : undefined,
    readServeState: () => serveState,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((done) => server.close(() => done()));
  setDbForTest(priorDb as DatabaseInstance);
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("FG-783: authenticated planning flow is replay-safe, CAS-safe, scoped, and auditable", async () => {
  const enqueue = { action: "enqueue", requestId: "flow-enqueue-1", ticketId: "FG-1" };
  const first = await request(REMOTE_PLAN_ENDPOINT, { headers: mutationHeaders(), body: enqueue });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.outcome, "applied");
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.requestId, enqueue.requestId);
  assert.deepEqual(queueView(PROJECT_KEY).filter((row) => row.queued).map((row) => row.ticketId), ["FG-1"]);
  assert.equal(remotePlanningAudit(PROJECT_KEY).length, 1, "the first command creates one durable ledger/audit row");

  const afterEnqueue = queueFingerprint();
  const replay = await request(REMOTE_PLAN_ENDPOINT, { headers: mutationHeaders(), body: enqueue });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true, "the repeated request id returns its recorded outcome");
  assert.equal(queueFingerprint(), afterEnqueue, "a replay does not apply enqueue a second time");
  assert.equal(remotePlanningAudit(PROJECT_KEY).length, 1, "a replay adds no ledger row");

  const staleVersion = queueVersion(PROJECT_KEY) - 1;
  const beforeStale = queueFingerprint();
  const stale = await request(REMOTE_PLAN_ENDPOINT, {
    headers: mutationHeaders(),
    body: { action: "reorder-queue", requestId: "flow-stale-1", order: ["FG-1"], expectVersion: staleVersion },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.outcome, "refused");
  assert.equal(stale.body.summary.queueVersion, queueVersion(PROJECT_KEY), "the refusal returns the current safe version");
  assert.equal(queueFingerprint(), beforeStale, "a stale CAS request has zero queue mutation");

  resolution = grant({ capabilities: ["read"] });
  const readOnly = await request(REMOTE_PLAN_ENDPOINT, { headers: mutationHeaders(), body: { ...enqueue, requestId: "flow-read-only" } });
  assert.equal(readOnly.status, 403, "read capability never confers plan");
  assert.equal(queueFingerprint(), beforeStale, "read-only denial has zero mutation");

  resolution = grant({ projectScope: { projectKey: PROJECT_KEY, memberDirs: ["/tmp/foreign-project"] } });
  const crossProject = await request(REMOTE_PLAN_ENDPOINT, { headers: mutationHeaders(), body: { ...enqueue, requestId: "flow-cross-project" } });
  assert.equal(crossProject.status, 401, "a resolver claim outside the server project scope is refused");
  assert.equal(queueFingerprint(), beforeStale, "cross-project denial has zero mutation");

  applyRemotePlanningCommand({ requestId: "foreign-audit-row", actor: "other@tailnet.test", transport: "test-adapter", projectKey: OTHER_PROJECT_KEY, action: "enqueue", targetId: "OTHER-1", at: "2026-09-09T00:00:00Z" });
  resolution = grant();
  const audit = await request(REMOTE_PLAN_AUDIT_ENDPOINT, { method: "GET", headers: { host: SERVE_HOST } });
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.body.rows.map((row: { requestId: string }) => row.requestId).sort(), ["flow-enqueue-1", "flow-stale-1"], "the audit response returns only this identity's project rows");
  assert.ok(audit.body.rows.every((row: { targetId: string }) => row.targetId !== "OTHER-1"));
});
