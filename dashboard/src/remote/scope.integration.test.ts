// FG-781 AC3 / RF-4 — the remote projection scope is SERVER-AUTHORITATIVE. The member dirs
// that scope the projection are the granted PROJECT's own dirs, resolved from the registry —
// never the dirs an adapter hands in. A candidate identity that names project A's key but
// carries project B's dir is a scope-confusion attempt and must refuse with NO data, rather
// than projecting B once an adapter is wired.
//
// Two independent proofs:
//   1. the pure gate predicate (claimedDirsWithinProject) — deterministic, DB-free;
//   2. the real handler end to end (createRemoteBoardServer + a stub adapter identity),
//      asserting the cross-project claim yields a 401 `unauthorized` envelope with board:null
//      and zero B data, while an in-scope claim is NOT refused at the gate.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), "fg781-scope-"));

import { createRemoteBoardServer, claimedDirsWithinProject } from "./server.js";
import type { BoundRemoteIdentityResolver, VerifiedIdentity } from "./identity.js";
import type { ProjectRecord } from "../queries.js";

const A_DIR = "/home/steve/checkouts/alpha";
const B_DIR = "/home/steve/checkouts/bravo";

test("RF-4: claimedDirsWithinProject refuses an empty or out-of-scope claim, accepts an in-scope one", () => {
  assert.equal(claimedDirsWithinProject([], [A_DIR]), false, "an empty claim is refused");
  assert.equal(claimedDirsWithinProject([B_DIR], [A_DIR]), false, "a cross-project dir is refused");
  assert.equal(claimedDirsWithinProject([A_DIR, B_DIR], [A_DIR]), false, "any out-of-scope dir taints the whole claim");
  assert.equal(claimedDirsWithinProject([A_DIR], [A_DIR, B_DIR]), true, "a subset of the project's own dirs is accepted");
});

function projectA(): ProjectRecord {
  return {
    key: "repo-alpha",
    label: "Alpha",
    color: "#123456",
    description: null,
    projectDir: A_DIR,
    primaryCheckout: A_DIR,
    projectDirs: [A_DIR],
    checkouts: [],
    lastRunAt: null,
    runCount: 0,
    inFlightCount: 0,
    liveSessions: 0,
  } as unknown as ProjectRecord;
}

function identityClaiming(dir: string): VerifiedIdentity {
  return {
    subject: "tester",
    capabilities: ["read"],
    projectScope: { projectKey: "repo-alpha", memberDirs: [dir] },
    provenance: { adapter: "test-adapter" },
  };
}

function serverWith(claimedDir: string): { srv: Server; url: () => string } {
  // BoundRemoteIdentityResolver is uniformly async (FG-782 step 1); a synchronous stub value
  // flows through the same awaited path in the handler.
  const resolveIdentity: BoundRemoteIdentityResolver = async () => ({
    ok: true,
    identity: identityClaiming(claimedDir),
    ignoredIdentityHeaders: [],
    confirmedIdentityHeaders: [],
  });
  const srv = createRemoteBoardServer({
    resolveIdentity,
    lookupProject: (key) => (key === "repo-alpha" ? projectA() : undefined),
  });
  return { srv, url: () => `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/board` };
}

const listen = (srv: Server): Promise<void> => new Promise((r) => srv.listen(0, "127.0.0.1", () => r()));
const opened: Server[] = [];
after(() => {
  for (const srv of opened) srv.close();
});

test("RF-4: a grant for project A carrying project B's dir refuses with no B data (401 unauthorized)", async () => {
  const { srv, url } = serverWith(B_DIR);
  opened.push(srv);
  await listen(srv);

  const res = await fetch(url());
  assert.equal(res.status, 401, "a cross-project scope claim is refused at the HTTP layer");
  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.equal(body.state, "unauthorized", "the five-state envelope reports the refusal honestly");
  assert.equal(body.board, null, "the refusal carries NO project data");
  assert.ok(!raw.includes(B_DIR), "project B's dir is never reflected into the response");
});

test("RF-4 non-vacuous: an in-scope claim is NOT refused at the scope gate", async () => {
  const { srv, url } = serverWith(A_DIR);
  opened.push(srv);
  await listen(srv);

  const res = await fetch(url());
  // With an in-scope claim the gate passes; the read then either serves the board (200) or
  // degrades on the store (503) — the load-bearing point is that it is NOT the 401 refusal.
  assert.notEqual(res.status, 401, "an in-scope claim passes the scope gate rather than being refused");
});
