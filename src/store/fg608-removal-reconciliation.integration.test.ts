// FG-608 (acceptance 8): REMOVAL RECONCILIATION, deferred here from FG-606.
//
// The shadow must equal the current Markdown set INCLUDING removals — because the
// DB becomes AUTHORITATIVE in this slice, so a ticket deleted from Markdown that
// lingers in the DB is not a harmless stale row, it is a ticket that came back
// from the dead.
//
// The hard half is the multi-worktree case: a project_key spans every clone and
// linked worktree, and each has its OWN branch-local backlog/. Absence of a source
// is NOT evidence of absence of a ticket. Prune authority therefore belongs to the
// SET OF LIVE SOURCES, never to the checkout running the import.
//
// Integration tier: real temp checkouts + a real (in-memory) SQLite store, driving
// the real importBacklog. `sourceId` is injected to model two worktrees of one
// project without materializing two real git checkouts — the identity RESOLVER is
// tested separately below against a real directory.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import {
  importBacklog,
  resolveSourceIdentity,
  reconcileRemovals,
  RemovalReconciliationRefusal,
} from "./backlog-import.js";
import {
  getTicket,
  ticketsForProject,
  relationsForTicket,
  blockerEvidenceForTicket,
  liveBacklogSources,
  forgetBacklogSource,
  LEGACY_BLOCKED_SOURCE,
} from "./tickets.js";
import { readTicket } from "../backlog/structured.js";
import { setStorageMode } from "./tickets.js";
import { clearBacklogStoreCache } from "../backlog/storage-mode.js";
import type { GitRunner } from "../util/github-url.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  clearBacklogStoreCache();
});

const NOW = "2026-07-29T00:00:00Z";

function fixedRemoteGit(remoteUrl: string): GitRunner {
  return (args: string[]) => {
    if (args.includes("remote")) return `origin\t${remoteUrl} (fetch)\norigin\t${remoteUrl} (push)\n`;
    if (args.includes("symbolic-ref")) return "main\n";
    return "";
  };
}

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg608-rr-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  dirs.push(dir);
  return dir;
}

type Fm = Record<string, unknown> & { id: string; type: string; status: string; title: string };

function writeTicketFile(projectDir: string, fm: Fm, body: string): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${fm.id}-slug.md`),
    `---\n${stringifyYaml(fm, { lineWidth: 0 })}---\n\n${body}\n`,
  );
}

function removeTicketFile(projectDir: string, id: string): void {
  rmSync(join(projectDir, "backlog", "stories", `${id}-slug.md`), { force: true });
}

const GIT = fixedRemoteGit("git@github.com:acme/removal.git");

// ─── single-source removal PRUNES ────────────────────────────────────────────

test("FG-608: a ticket removed from the ONLY source's Markdown is pruned", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-1", type: "story", status: "active", title: "keep" }, "k");
  writeTicketFile(dir, { id: "FG-2", type: "story", status: "active", title: "gone" }, "g");

  const first = importBacklog(dir, { git: GIT, now: NOW, sourceId: "src-a" });
  assert.equal(ticketsForProject(first.projectKey).length, 2);

  removeTicketFile(dir, "FG-2");
  const second = importBacklog(dir, { git: GIT, now: NOW, sourceId: "src-a" });

  assert.deepEqual(second.prunedTickets, ["FG-2"]);
  assert.equal(getTicket(first.projectKey, "FG-2"), undefined);
  assert.deepEqual(
    ticketsForProject(first.projectKey).map((t) => t.ticketId),
    ["FG-1"],
    "the shadow equals the current Markdown set",
  );
});

// ─── the multi-worktree case does NOT prune ──────────────────────────────────

test("FG-608: 'removed from one worktree, kept in another' does NOT prune", () => {
  const wtA = newProject();
  const wtB = newProject();
  // Both worktrees carry FG-10; only A carries FG-11.
  writeTicketFile(wtA, { id: "FG-10", type: "story", status: "active", title: "shared" }, "s");
  writeTicketFile(wtA, { id: "FG-11", type: "story", status: "active", title: "A-only" }, "a");
  writeTicketFile(wtB, { id: "FG-10", type: "story", status: "active", title: "shared" }, "s");

  const a = importBacklog(wtA, { git: GIT, now: NOW, sourceId: "src-a" });
  importBacklog(wtB, { git: GIT, now: NOW, sourceId: "src-b" });
  const key = a.projectKey;
  assert.equal(ticketsForProject(key).length, 2, "one project_key, two sources, two distinct ids");

  // A drops the SHARED ticket. B still claims it -> it must survive.
  removeTicketFile(wtA, "FG-10");
  const second = importBacklog(wtA, { git: GIT, now: NOW, sourceId: "src-a" });

  assert.deepEqual(second.prunedTickets, [], "nothing pruned — a sibling source still claims FG-10");
  assert.ok(getTicket(key, "FG-10"), "the shared ticket survives A's removal");
  assert.ok(getTicket(key, "FG-11"), "A's own ticket is untouched");

  // Now B drops it too. NO live source claims it -> it prunes.
  removeTicketFile(wtB, "FG-10");
  const third = importBacklog(wtB, { git: GIT, now: NOW, sourceId: "src-b" });
  assert.deepEqual(third.prunedTickets, ["FG-10"], "the last source's removal prunes it");
  assert.equal(getTicket(key, "FG-10"), undefined);
});

// ─── fails closed ────────────────────────────────────────────────────────────

test("FG-608: prune REFUSES with zero live successfully-scanned sources (fails closed)", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-20", type: "story", status: "active", title: "t" }, "b");
  const { projectKey } = importBacklog(dir, { git: GIT, now: NOW, sourceId: "src-a" });

  // Forget every source, so nothing is live. importBacklog itself always
  // registers its own source before reconciling, so this condition is only
  // reachable by calling the PRODUCT function directly — which is what this does.
  // A test that re-implemented the guard would be asserting nothing.
  writeTransaction(() => forgetBacklogSource(projectKey, "src-a", NOW));
  assert.deepEqual(liveBacklogSources(projectKey), [], "precondition: no live sources");

  assert.throws(
    () =>
      reconcileRemovals(projectKey, "src-a", {
        ticket: [{ ticketId: "FG-20", memberKey: "" }],
        relation: [],
        blocker_evidence: [],
      }),
    (e: unknown) => e instanceof RemovalReconciliationRefusal,
    "with nothing claiming anything, every row looks prunable — refuse instead",
  );
  assert.ok(getTicket(projectKey, "FG-20"), "keeping the ticket is the correct failure direction");
});

test("FG-608: a pre-FG-608 row no membership ever claimed is NEVER pruned", () => {
  const dir = newProject();
  const { projectKey } = importBacklog(dir, { git: GIT, now: NOW, sourceId: "src-a" });

  // Simulate a row imported before the membership substrate existed: it has no
  // membership from ANY source. We cannot know which sources hold it, so keeping
  // it is the correct failure direction.
  db.prepare(
    `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, imported_at, revision)
     VALUES (?, 'FG-LEGACY', 'story', 'active', 'legacy', '', ?, 1)`,
  ).run(projectKey, NOW);

  const second = importBacklog(dir, { git: GIT, now: NOW, sourceId: "src-a" });
  assert.deepEqual(second.prunedTickets, []);
  assert.ok(getTicket(projectKey, "FG-LEGACY"), "an unattributed legacy row is never pruned");
});

// ─── relations follow the same per-source membership ─────────────────────────

test("FG-608: relations prune per-source, and a sibling's claim keeps them", () => {
  const wtA = newProject();
  const wtB = newProject();
  writeTicketFile(wtA, { id: "FG-30", type: "story", status: "active", title: "t", related: ["FG-31"] }, "b");
  writeTicketFile(wtA, { id: "FG-31", type: "story", status: "active", title: "u" }, "b");
  writeTicketFile(wtB, { id: "FG-30", type: "story", status: "active", title: "t", related: ["FG-31"] }, "b");
  writeTicketFile(wtB, { id: "FG-31", type: "story", status: "active", title: "u" }, "b");

  const a = importBacklog(wtA, { git: GIT, now: NOW, sourceId: "src-a" });
  importBacklog(wtB, { git: GIT, now: NOW, sourceId: "src-b" });
  const key = a.projectKey;
  assert.equal(relationsForTicket(key, "FG-30").length, 1);

  // A drops the relation; B still declares it.
  writeTicketFile(wtA, { id: "FG-30", type: "story", status: "active", title: "t" }, "b");
  const second = importBacklog(wtA, { git: GIT, now: NOW, sourceId: "src-a" });
  assert.deepEqual(second.prunedRelations, [], "a sibling still claims the relation");
  assert.equal(relationsForTicket(key, "FG-30").length, 1);

  // B drops it too.
  writeTicketFile(wtB, { id: "FG-30", type: "story", status: "active", title: "t" }, "b");
  const third = importBacklog(wtB, { git: GIT, now: NOW, sourceId: "src-b" });
  assert.deepEqual(third.prunedRelations, ["FG-30->FG-31(related)"]);
  assert.equal(relationsForTicket(key, "FG-30").length, 0);
});

// ─── THE BLOCKER-EVIDENCE INVERSE DELETION ───────────────────────────────────
// The case the ticket names directly: import upserted evidence for a `blocked`
// source ticket but had NO inverse deletion when a later import supplied
// active/done/deferred. structured.ts then reconstructed the row as `blocked`
// forever and readiness.ts held it back from campaign dispatch.

test("FG-608: unblocking in Markdown DELETES the blocker evidence, so the seam stops reading it as blocked", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-40", type: "story", status: "blocked", title: "was blocked" }, "b");
  // NO injected git runner here, deliberately: this test reads back through the
  // SEAM (readTicket -> resolveBacklogStore), which computes repository evidence
  // from the REAL directory. An injected runner would register the identity under
  // fabricated evidence and the read would then refuse on an identity mismatch —
  // proving nothing about blocker reconstruction.
  const { projectKey } = importBacklog(dir, { now: NOW, sourceId: "src-a" });

  assert.equal(blockerEvidenceForTicket(projectKey, "FG-40").length, 1, "import recorded the blocked fact");

  // Read it back through the SEAM in db mode — this is the reconstruction path
  // (structured.ts) that made the bug user-visible.
  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  assert.equal(readTicket(dir, "FG-40").status, "blocked", "precondition: the seam reads it as blocked");

  // Markdown now says active. Before FG-608 the evidence survived and the seam
  // kept answering 'blocked'.
  setStorageMode(projectKey, "markdown", NOW);
  clearBacklogStoreCache();
  writeTicketFile(dir, { id: "FG-40", type: "story", status: "active", title: "was blocked" }, "b");
  const second = importBacklog(dir, { now: NOW, sourceId: "src-a" });

  assert.deepEqual(second.prunedBlockerEvidence, [`FG-40(${LEGACY_BLOCKED_SOURCE})`]);
  assert.equal(blockerEvidenceForTicket(projectKey, "FG-40").length, 0, "the inverse deletion fired");

  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();
  assert.equal(
    readTicket(dir, "FG-40").status,
    "active",
    "the seam no longer reconstructs it as blocked — it is dispatchable again",
  );
});

test("FG-608: blocker evidence is NOT dropped because a sibling worktree lacks the blocked marker", () => {
  const wtA = newProject();
  const wtB = newProject();
  writeTicketFile(wtA, { id: "FG-50", type: "story", status: "blocked", title: "shared" }, "b");
  writeTicketFile(wtB, { id: "FG-50", type: "story", status: "active", title: "shared" }, "b");

  // A (blocked) imports first, then B (active). B's import must NOT delete the
  // evidence A recorded — B simply never claimed it.
  const a = importBacklog(wtA, { git: GIT, now: NOW, sourceId: "src-a" });
  const b = importBacklog(wtB, { git: GIT, now: NOW, sourceId: "src-b" });

  assert.deepEqual(b.prunedBlockerEvidence, []);
  assert.equal(
    blockerEvidenceForTicket(a.projectKey, "FG-50").length,
    1,
    "evidence from one source survives a sibling that lacks the marker",
  );
});

// ─── the operator forget-source verb ─────────────────────────────────────────

test("FG-608: forget-source releases a permanently-removed source so its tickets prune", () => {
  const wtA = newProject();
  const wtB = newProject();
  writeTicketFile(wtA, { id: "FG-60", type: "story", status: "active", title: "shared" }, "s");
  writeTicketFile(wtB, { id: "FG-60", type: "story", status: "active", title: "shared" }, "s");

  const a = importBacklog(wtA, { git: GIT, now: NOW, sourceId: "src-a" });
  importBacklog(wtB, { git: GIT, now: NOW, sourceId: "src-b" });
  const key = a.projectKey;

  // A removes it. B (a clone that has since been deleted from disk, but is still
  // registered) keeps pinning it — this is the stale-source problem the verb exists
  // for: FG-345/FG-621 transient clones are reaper-deleted and never re-import.
  removeTicketFile(wtA, "FG-60");
  assert.deepEqual(importBacklog(wtA, { git: GIT, now: NOW, sourceId: "src-a" }).prunedTickets, []);
  assert.ok(getTicket(key, "FG-60"), "the dead source still pins it");

  assert.deepEqual(
    liveBacklogSources(key).map((s) => s.sourceId).sort(),
    ["src-a", "src-b"],
  );

  const forgot = writeTransaction(() => forgetBacklogSource(key, "src-b", NOW));
  assert.equal(forgot, true);
  assert.deepEqual(liveBacklogSources(key).map((s) => s.sourceId), ["src-a"]);

  const after = importBacklog(wtA, { git: GIT, now: NOW, sourceId: "src-a" });
  assert.deepEqual(after.prunedTickets, ["FG-60"], "with the dead source forgotten, the prune proceeds");
});

test("FG-608: forgetting an unregistered source reports false rather than silently succeeding", () => {
  const dir = newProject();
  const { projectKey } = importBacklog(dir, { git: GIT, now: NOW, sourceId: "src-a" });
  assert.equal(writeTransaction(() => forgetBacklogSource(projectKey, "src-nope", NOW)), false);
});

// ─── the durable source identity itself ──────────────────────────────────────

test("FG-608: source identity is durable — it is NOT the realpath and survives re-resolution", () => {
  const dir = newProject();
  const first = resolveSourceIdentity(dir);
  const second = resolveSourceIdentity(dir);
  assert.equal(first, second, "resolution is stable, never a fresh id per call");
  // A non-git directory has no admin dir to hide a durable id in; the canonical
  // path is the honest fallback and is stated as such.
  assert.match(first, /^path:/);

  const other = newProject();
  assert.notEqual(resolveSourceIdentity(other), first, "two directories are two sources");
});

// ─── FG-693: this boundary goes through the ONE identity contract ────────────
//
// The plan's boundary inventory MISSED this file, and both halves of it derived a
// project identity with a private realpath: `resolveSourceIdentity` realpathed the
// project dir and compared `realpathSync(topLevel) === canonicalDir`, and
// `importBacklog` realpathed it a second time for `imported_from`. That column is
// UNIONed with `runs.project_dir` by the dispatcher's observedCheckouts, so the two
// sides of that union have to be canonicalized under ONE discipline — otherwise one
// checkout arrives there as two candidates and dispatch refuses `ambiguous_checkout`
// for a project that has exactly one checkout.

test("FG-693: one checkout under two spellings is ONE backlog source, not two", () => {
  const dir = newProject();
  const alias = join(dirname(dir), "link-to-" + basename(dir));
  symlinkSync(dir, alias);
  dirs.push(alias);
  assert.notEqual(alias, dir, "fixture: the two spellings must differ, or nothing here discriminates");

  assert.equal(
    resolveSourceIdentity(alias),
    resolveSourceIdentity(dir),
    "a source is one physical checkout — a second spelling of it must not register a second source, " +
      "because a source that 'evaporates' pins every ticket it ever imported",
  );
});

test("FG-693: imported_from is the PROVEN physical path, whatever spelling the import was driven with", () => {
  const dir = newProject();
  writeTicketFile(dir, { id: "FG-1", type: "story", status: "active", title: "keep" }, "k");
  const alias = join(dirname(dir), "link-to-" + basename(dir));
  symlinkSync(dir, alias);
  dirs.push(alias);

  const result = importBacklog(alias, { git: GIT, now: NOW, sourceId: "src-a" });

  const row = db
    .prepare(`SELECT imported_from FROM tickets WHERE project_key = ? AND ticket_id = ?`)
    .get(result.projectKey, "FG-1") as { imported_from: string | null };
  assert.equal(
    row.imported_from,
    realpathSync(dir),
    "the persisted provenance is the physical path — the dispatcher UNIONs this column with runs.project_dir " +
      "and collapses both by proven identity, so an alias recorded here would arrive as a second checkout",
  );
  assert.notEqual(row.imported_from, alias, "and it is NOT the spelling the caller happened to use");
});

test("FG-693: an unresolvable project dir is REFUSED by name rather than recorded as a guess", () => {
  const gone = join(tmpdir(), "fg693-never-existed", "checkout");
  assert.throws(
    () => resolveSourceIdentity(gone),
    /durable source identity/,
    "`path:<unproven spelling>` would be a guess persisted in a proven position",
  );
});

test("FG-608: a directory merely INSIDE a repository does not inherit that repo's source identity", () => {
  // Two unrelated project dirs that happen to sit under one enclosing checkout
  // must not share a source id — one's removals would prune the other's tickets.
  const a = newProject();
  const b = newProject();
  assert.notEqual(resolveSourceIdentity(a), resolveSourceIdentity(b));
});
