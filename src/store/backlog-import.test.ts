// FG-606 (FG-496 Slice A): the Markdown -> DB import orchestrator. Tests run REAL
// store + parser code against a real in-memory SQLite DB (makeInMemoryDb) and
// real temp backlog directories, never ~/.forge/forge.db.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { rmSync } from "node:fs";
import { importBacklog, BacklogImportError } from "./backlog-import.js";
import {
  getTicket,
  ticketsForProject,
  blockerEvidenceForTicket,
  relationsForTicket,
  getStorageMode,
  getIdSequence,
} from "./tickets.js";
import {
  registryByEvidence,
  computeRepositoryEvidence,
  deriveProjectKey,
  ProjectIdentityConflictError,
} from "./project-registry.js";
import { readBacklogConfig } from "../backlog/config.js";
import type { GitRunner } from "../util/github-url.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

const NOW = "2026-07-24T00:00:00Z";

function fixedRemoteGit(remoteUrl: string): GitRunner {
  return (args: string[]) => {
    if (args.includes("remote")) return `origin\t${remoteUrl} (fetch)\norigin\t${remoteUrl} (push)\n`;
    if (args.includes("symbolic-ref")) return "main\n";
    return "";
  };
}

type FileFm = Record<string, unknown> & { id: string; type: string; status: string; title: string };

function writeTicketFile(projectDir: string, subdir: string, fm: FileFm, body: string): void {
  const dir = join(projectDir, "backlog", subdir);
  mkdirSync(dir, { recursive: true });
  const yaml = stringifyYaml(fm, { lineWidth: 0 });
  const content = `---\n${yaml}---\n\n${body}\n`;
  writeFileSync(join(dir, `${fm.id}-slug.md`), content);
}

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg606-proj-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  return dir;
}

function seedCommittedKey(projectDir: string, projectKey: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `project_key: ${projectKey}\n`);
}

// AC: after import, DB rows equal the Markdown set for
// id/type/status/title/body/created/closed/relations/frontmatter.
test("import preserves id/type/status/title/body/created/closed/relations", () => {
  const dir = newProject();
  writeTicketFile(
    dir,
    "stories",
    {
      id: "FG-10",
      type: "story",
      status: "active",
      title: "a story",
      created: "2026-01-01",
      related: ["FG-2", "FG-3"],
      epic: "FG-100",
    },
    "the body",
  );
  writeTicketFile(
    dir,
    "done",
    { id: "FG-11", type: "story", status: "done", title: "done one", created: "2026-01-01", closed: "2026-02-02" },
    "closed body",
  );

  const result = importBacklog(dir, { git: fixedRemoteGit("git@github.com:acme/one.git"), now: NOW });
  const key = result.projectKey;

  const t10 = getTicket(key, "FG-10")!;
  assert.equal(t10.type, "story");
  assert.equal(t10.status, "active");
  assert.equal(t10.title, "a story");
  assert.equal(t10.body.trim(), "the body");
  assert.equal(t10.created, "2026-01-01");
  assert.equal(t10.epic, "FG-100");
  const rels = relationsForTicket(key, "FG-10").map((r) => r.relatedId).sort();
  assert.deepEqual(rels, ["FG-2", "FG-3"]);

  const t11 = getTicket(key, "FG-11")!;
  assert.equal(t11.status, "done");
  assert.equal(t11.closed, "2026-02-02");

  // storage mode default recorded; id sequence seeded at highest id + 1 (next to allocate).
  assert.equal(getStorageMode(key), "markdown");
  assert.equal(getIdSequence(key, "FG"), 12);
});

// AC (7): a legacy status:blocked ticket imports as active + a blocker_evidence
// row (never plain active).
test("legacy blocked imports as active + a blocker_evidence row", () => {
  const dir = newProject();
  writeTicketFile(dir, "stories", { id: "FG-20", type: "story", status: "blocked", title: "blocked one" }, "b");

  const { projectKey } = importBacklog(dir, { git: fixedRemoteGit("git@github.com:acme/two.git"), now: NOW });

  const t = getTicket(projectKey, "FG-20")!;
  assert.equal(t.status, "active", "blocked collapses to active");
  const evidence = blockerEvidenceForTicket(projectKey, "FG-20");
  assert.equal(evidence.length, 1, "blocker fact survives as evidence");
  assert.equal(evidence[0]!.source, "import-legacy-blocked");
});

// AC (8): re-running import is idempotent (no duplicate rows / no drift).
test("re-import is idempotent", () => {
  const dir = newProject();
  writeTicketFile(dir, "stories", { id: "FG-30", type: "story", status: "blocked", title: "t" }, "body");

  const opts = { git: fixedRemoteGit("git@github.com:acme/three.git"), now: NOW };
  const first = importBacklog(dir, opts);
  const second = importBacklog(dir, opts);

  assert.equal(first.projectKey, second.projectKey);
  assert.equal(ticketsForProject(first.projectKey).length, 1, "no duplicate tickets");
  assert.equal(blockerEvidenceForTicket(first.projectKey, "FG-30").length, 1, "no duplicate evidence");
  // The second import adopts the now-committed key (rung 1) — config was healed.
  assert.equal(readBacklogConfig(dir).projectKey, first.projectKey);
  assert.equal(second.rung, 1);
});

// AC (1): (project_key, ticket_id) coexistence through the import path.
test("FG-123 imported under two different projects coexists", () => {
  const dirA = newProject();
  const dirB = newProject();
  writeTicketFile(dirA, "stories", { id: "FG-123", type: "story", status: "active", title: "A" }, "a");
  writeTicketFile(dirB, "stories", { id: "FG-123", type: "story", status: "active", title: "B" }, "b");

  const a = importBacklog(dirA, { git: fixedRemoteGit("git@github.com:acme/a.git"), now: NOW });
  const b = importBacklog(dirB, { git: fixedRemoteGit("git@github.com:acme/b.git"), now: NOW });

  assert.notEqual(a.projectKey, b.projectKey);
  assert.equal(getTicket(a.projectKey, "FG-123")!.title, "A");
  assert.equal(getTicket(b.projectKey, "FG-123")!.title, "B");
});

// AC (3): two linked worktrees (same evidence), both config-absent. The first
// mints; the second ADOPTS -> exactly ONE backlog, never two.
test("two linked worktrees converge to ONE backlog (adopt, never split)", () => {
  const wtA = newProject();
  const wtB = newProject();
  writeTicketFile(wtA, "stories", { id: "FG-40", type: "story", status: "active", title: "from A" }, "a");
  writeTicketFile(wtB, "stories", { id: "FG-41", type: "story", status: "active", title: "from B" }, "b");

  const git = fixedRemoteGit("git@github.com:acme/shared.git");
  const a = importBacklog(wtA, { git, now: NOW });
  const b = importBacklog(wtB, { git, now: NOW });

  assert.equal(a.projectKey, b.projectKey, "second worktree adopts the first's key");
  assert.equal(a.rung, 4, "first mints");
  assert.equal(b.rung, 2, "second adopts");

  const key = a.projectKey;
  assert.ok(getTicket(key, "FG-40"));
  assert.ok(getTicket(key, "FG-41"));
  assert.equal(ticketsForProject(key).length, 2, "one shared backlog, both worktrees' tickets");
  // Exactly one registry row for the shared evidence.
  const ev = computeRepositoryEvidence(wtA, git);
  assert.equal(registryByEvidence(ev.key)!.projectKey, key);
  // Both configs healed to the same key.
  assert.equal(readBacklogConfig(wtA).projectKey, key);
  assert.equal(readBacklogConfig(wtB).projectKey, key);
});

// AC (4): divergent committed keys -> REFUSE (no silent second backlog).
test("divergent committed keys on two branches -> REFUSE", () => {
  const wtA = newProject();
  const wtB = newProject();
  seedCommittedKey(wtA, "pk-k1");
  seedCommittedKey(wtB, "pk-k2");
  writeTicketFile(wtA, "stories", { id: "FG-50", type: "story", status: "active", title: "A" }, "a");
  writeTicketFile(wtB, "stories", { id: "FG-51", type: "story", status: "active", title: "B" }, "b");

  const git = fixedRemoteGit("git@github.com:acme/divergent.git");
  importBacklog(wtA, { git, now: NOW }); // claims pk-k1

  assert.throws(
    () => importBacklog(wtB, { git, now: NOW }),
    (e: unknown) => e instanceof ProjectIdentityConflictError,
  );
  // wtB wrote NO tickets under its own key — no second backlog.
  assert.equal(ticketsForProject("pk-k2").length, 0);
});

// AC (6): a failure between the claim and the ticket writes rolls the WHOLE
// transaction back — zero partial tickets, zero partial evidence — and a clean
// re-run converges to the committed mapping.
test("atomic rollback: a mid-transaction failure writes ZERO tickets and ZERO registry rows", () => {
  const dir = newProject();
  writeTicketFile(dir, "stories", { id: "FG-60", type: "story", status: "blocked", title: "t" }, "b");

  const git = fixedRemoteGit("git@github.com:acme/rollback.git");
  const ev = computeRepositoryEvidence(dir, git);
  const wouldBeKey = deriveProjectKey(ev.key);

  assert.throws(() =>
    importBacklog(dir, {
      git,
      now: NOW,
      __afterClaimBeforeTickets: () => {
        throw new Error("boom mid-transaction");
      },
    }),
  );

  // Registry claim rolled back with the rest — nothing persisted.
  assert.equal(registryByEvidence(ev.key), undefined, "claim rolled back");
  assert.equal(ticketsForProject(wouldBeKey).length, 0, "zero partial tickets");
  assert.equal(blockerEvidenceForTicket(wouldBeKey, "FG-60").length, 0, "zero partial evidence");
  assert.equal(readBacklogConfig(dir).projectKey, null, "config not healed on failure");

  // A clean re-run converges.
  const ok = importBacklog(dir, { git, now: NOW });
  assert.equal(ok.projectKey, wouldBeKey);
  assert.equal(ticketsForProject(ok.projectKey).length, 1);
  assert.equal(blockerEvidenceForTicket(ok.projectKey, "FG-60").length, 1);
});

function removeTicketFile(projectDir: string, subdir: string, id: string): void {
  rmSync(join(projectDir, "backlog", subdir, `${id}-slug.md`));
}

// Must-fix #2: re-import after a Markdown REMOVAL/RENAME reconciles stale rows so
// the shadow EQUALS the current source set — removed tickets, orphaned relations,
// evidence and events are pruned; a dropped `related:` entry on a SURVIVING ticket
// is pruned; unrelated rows are untouched.
test("re-import reconciles removed tickets and relations so the shadow equals Markdown", () => {
  const dir = newProject();
  writeTicketFile(
    dir,
    "stories",
    { id: "FG-70", type: "story", status: "active", title: "keeper", related: ["FG-71", "FG-72"] },
    "keep",
  );
  writeTicketFile(dir, "stories", { id: "FG-71", type: "story", status: "blocked", title: "to remove" }, "gone");
  writeTicketFile(dir, "stories", { id: "FG-72", type: "story", status: "active", title: "unrelated" }, "u");

  const git = fixedRemoteGit("git@github.com:acme/reconcile.git");
  const first = importBacklog(dir, { git, now: NOW });
  const key = first.projectKey;
  assert.equal(ticketsForProject(key).length, 3);
  assert.equal(blockerEvidenceForTicket(key, "FG-71").length, 1);
  assert.deepEqual(relationsForTicket(key, "FG-70").map((r) => r.relatedId).sort(), ["FG-71", "FG-72"]);

  // Remove FG-71 entirely; drop the FG-71 relation from FG-70 (keep only FG-72).
  removeTicketFile(dir, "stories", "FG-71");
  writeTicketFile(
    dir,
    "stories",
    { id: "FG-70", type: "story", status: "active", title: "keeper", related: ["FG-72"] },
    "keep",
  );

  const second = importBacklog(dir, { git, now: NOW });
  assert.equal(second.projectKey, key);

  // The removed ticket and all its dependent rows are gone.
  assert.equal(getTicket(key, "FG-71"), undefined, "removed ticket pruned");
  assert.equal(blockerEvidenceForTicket(key, "FG-71").length, 0, "orphaned evidence pruned");
  // The dropped relation is gone; the surviving one remains.
  assert.deepEqual(relationsForTicket(key, "FG-70").map((r) => r.relatedId), ["FG-72"], "stale relation pruned");
  // Unrelated rows untouched; the shadow equals the current Markdown set.
  assert.ok(getTicket(key, "FG-70"));
  assert.ok(getTicket(key, "FG-72"));
  assert.deepEqual(
    ticketsForProject(key).map((t) => t.ticketId).sort(),
    ["FG-70", "FG-72"],
    "DB rows equal the current Markdown ticket set",
  );
});

// Must-fix #2 + protocol invariant: removal reconciliation is PROVENANCE-scoped —
// removing a ticket from ONE linked worktree must NOT prune a sibling worktree's
// tickets (they share a project_key but have different Markdown sets).
test("removal in one worktree preserves a sibling worktree's tickets", () => {
  const wtA = newProject();
  const wtB = newProject();
  writeTicketFile(wtA, "stories", { id: "FG-40", type: "story", status: "active", title: "from A" }, "a");
  writeTicketFile(wtB, "stories", { id: "FG-41", type: "story", status: "active", title: "from B" }, "b");

  const git = fixedRemoteGit("git@github.com:acme/siblings.git");
  const a = importBacklog(wtA, { git, now: NOW });
  importBacklog(wtB, { git, now: NOW });
  const key = a.projectKey;
  assert.equal(ticketsForProject(key).length, 2, "union of both worktrees");

  // wtA removes FG-40 and re-imports. FG-41 (owned by wtB) must survive.
  removeTicketFile(wtA, "stories", "FG-40");
  importBacklog(wtA, { git, now: NOW });

  assert.equal(getTicket(key, "FG-40"), undefined, "wtA's removed ticket pruned");
  assert.ok(getTicket(key, "FG-41"), "sibling worktree's ticket survives");
});

// Must-fix #2: reconciliation is project-scoped — another project's rows are never
// touched when this project drops tickets.
test("reconciliation never deletes another project's rows", () => {
  const dirA = newProject();
  const dirB = newProject();
  writeTicketFile(dirA, "stories", { id: "FG-80", type: "story", status: "active", title: "A-only" }, "a");
  writeTicketFile(dirB, "stories", { id: "FG-80", type: "story", status: "active", title: "B-keep" }, "b");

  const a = importBacklog(dirA, { git: fixedRemoteGit("git@github.com:acme/ra.git"), now: NOW });
  const b = importBacklog(dirB, { git: fixedRemoteGit("git@github.com:acme/rb.git"), now: NOW });

  // Empty A's Markdown and re-import: A's rows vanish, B's are untouched.
  removeTicketFile(dirA, "stories", "FG-80");
  importBacklog(dirA, { git: fixedRemoteGit("git@github.com:acme/ra.git"), now: NOW });

  assert.equal(ticketsForProject(a.projectKey).length, 0, "A fully reconciled to empty");
  assert.equal(ticketsForProject(b.projectKey).length, 1, "B untouched");
  assert.equal(getTicket(b.projectKey, "FG-80")!.title, "B-keep");
});

// Must-fix #3: an unrecognized frontmatter key round-trips into the DB preserved.
test("import preserves unrecognized frontmatter keys (full fidelity)", () => {
  const dir = newProject();
  writeTicketFile(
    dir,
    "stories",
    { id: "FG-90", type: "story", status: "active", title: "extra", customField: "keep-me", priority: 3 },
    "body",
  );

  const { projectKey } = importBacklog(dir, { git: fixedRemoteGit("git@github.com:acme/fm.git"), now: NOW });
  const t = getTicket(projectKey, "FG-90")!;
  assert.equal(t.frontmatter!["customField"], "keep-me", "unrecognized key preserved");
  assert.equal(t.frontmatter!["priority"], 3, "unrecognized scalar preserved");
});

// Must-fix #4: next_seq is seeded at the highest existing id PLUS ONE.
test("id sequence is seeded at max id + 1", () => {
  const dir = newProject();
  writeTicketFile(dir, "stories", { id: "FG-3", type: "story", status: "active", title: "three" }, "a");
  writeTicketFile(dir, "stories", { id: "FG-7", type: "story", status: "active", title: "seven" }, "b");

  const { projectKey } = importBacklog(dir, { git: fixedRemoteGit("git@github.com:acme/seq.git"), now: NOW });
  assert.equal(getIdSequence(projectKey, "FG"), 8, "highest id 7 -> next_seq 8");
});

// Must-fix #6: a malformed file (missing a required frontmatter field) fails with a
// precise, file-identified error and writes ZERO rows (all-or-nothing atomic).
test("malformed file aborts import with a precise file+field error and writes zero rows", () => {
  const dir = newProject();
  writeTicketFile(dir, "stories", { id: "FG-95", type: "story", status: "active", title: "good" }, "ok");
  // Missing `type` in frontmatter.
  writeTicketFile(dir, "stories", { id: "FG-96", type: undefined as unknown as string, status: "active", title: "bad" }, "x");

  const git = fixedRemoteGit("git@github.com:acme/malformed.git");
  const ev = computeRepositoryEvidence(dir, git);
  const wouldBeKey = deriveProjectKey(ev.key);

  assert.throws(
    () => importBacklog(dir, { git, now: NOW }),
    (e: unknown) =>
      e instanceof BacklogImportError &&
      e.field === "type" &&
      e.file.includes("FG-96") &&
      /missing required frontmatter field 'type'/.test(e.message),
  );

  // Atomic: nothing written for the good ticket either.
  assert.equal(ticketsForProject(wouldBeKey).length, 0, "zero rows written on a malformed import");
  assert.equal(getTicket(wouldBeKey, "FG-95"), undefined);
});
