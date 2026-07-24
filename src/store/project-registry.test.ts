// FG-606 (FG-496 Slice A): the project-identity registry + 5-rung authority ladder.
// Tests run REAL store code against a real in-memory SQLite DB (makeInMemoryDb),
// never ~/.forge/forge.db.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import type { GitRunner } from "../util/github-url.js";
import {
  deriveProjectKey,
  computeRepositoryEvidence,
  resolveAndClaimProjectKey,
  registryByEvidence,
  registryByKey,
  ProjectIdentityConflictError,
  type ResolveResult,
} from "./project-registry.js";

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

function resolve(input: {
  evidenceKey: string;
  evidenceSource?: string;
  configKey: string | null;
}): ResolveResult {
  return writeTransaction(() =>
    resolveAndClaimProjectKey({
      evidenceKey: input.evidenceKey,
      evidenceSource: input.evidenceSource ?? "remote",
      configKey: input.configKey,
      createdAt: NOW,
    }),
  );
}

// A git runner that reports the same origin remote for any directory — models two
// linked worktrees / clones that share one upstream.
function fixedRemoteGit(remoteUrl: string): GitRunner {
  return (args: string[]) => {
    if (args.includes("remote")) return `origin\t${remoteUrl} (fetch)\norigin\t${remoteUrl} (push)\n`;
    // symbolic-ref / rev-parse: report a branch, no common-dir needed (remote wins).
    if (args.includes("symbolic-ref")) return "main\n";
    return "";
  };
}

test("deriveProjectKey is deterministic and pk-prefixed", () => {
  const a = deriveProjectKey("repo-abc");
  const b = deriveProjectKey("repo-abc");
  assert.equal(a, b);
  assert.match(a, /^pk-[0-9a-f]{20}$/);
  assert.notEqual(deriveProjectKey("repo-abc"), deriveProjectKey("repo-xyz"));
});

// AC (2): project_key stable across two linked worktrees at DIFFERENT real paths —
// both derive the SAME key via repositoryCheckoutIdentity.
test("two worktrees at different real paths derive the SAME project_key", () => {
  const wtA = mkdtempSync(join(tmpdir(), "fg606-wtA-"));
  const wtB = mkdtempSync(join(tmpdir(), "fg606-wtB-"));
  const git = fixedRemoteGit("git@github.com:acme/forge.git");

  const evA = computeRepositoryEvidence(wtA, git);
  const evB = computeRepositoryEvidence(wtB, git);
  assert.equal(evA.source, "remote");
  assert.equal(evA.key, evB.key, "converging evidence key across worktrees");
  assert.equal(deriveProjectKey(evA.key), deriveProjectKey(evB.key));
});

test("rung 4: both absent -> derive, claim, persist to config", () => {
  const r = resolve({ evidenceKey: "repo-e1", configKey: null });
  assert.equal(r.rung, 4);
  assert.equal(r.projectKey, deriveProjectKey("repo-e1"));
  assert.equal(r.persistToConfig, true);
  assert.equal(registryByEvidence("repo-e1")!.projectKey, r.projectKey);
});

test("rung 3: config present, registry absent -> claim the committed key, no persist", () => {
  const r = resolve({ evidenceKey: "repo-e2", configKey: "pk-committed" });
  assert.equal(r.rung, 3);
  assert.equal(r.projectKey, "pk-committed");
  assert.equal(r.persistToConfig, false);
  assert.equal(registryByKey("pk-committed")!.repoEvidenceKey, "repo-e2");
});

test("rung 1: config and registry agree -> proceed", () => {
  resolve({ evidenceKey: "repo-e3", configKey: "pk-x" }); // claim
  const r = resolve({ evidenceKey: "repo-e3", configKey: "pk-x" });
  assert.equal(r.rung, 1);
  assert.equal(r.projectKey, "pk-x");
  assert.equal(r.persistToConfig, false);
});

// AC (3, sequential form): first worktree claims (rung 4); the second, still
// config-absent, ADOPTS the registered key (rung 2) -> exactly one backlog.
test("rung 2: config absent, registry exists -> adopt & heal (one backlog, not two)", () => {
  const first = resolve({ evidenceKey: "repo-shared", configKey: null }); // rung 4
  const second = resolve({ evidenceKey: "repo-shared", configKey: null }); // rung 2 adopt
  assert.equal(second.rung, 2);
  assert.equal(second.projectKey, first.projectKey, "the second worktree adopts, never mints a second key");
  assert.equal(second.persistToConfig, true, "heal config with the adopted key");
  // Exactly one registry row for the shared evidence.
  assert.equal(registryByEvidence("repo-shared")!.projectKey, first.projectKey);
});

// AC (4): divergent committed keys on two branches -> REFUSE, surfacing BOTH.
test("rung 5: divergent committed keys for one repository -> REFUSE", () => {
  resolve({ evidenceKey: "repo-div", configKey: "pk-branch1" }); // registered to pk-branch1
  let err: unknown;
  try {
    resolve({ evidenceKey: "repo-div", configKey: "pk-branch2" });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ProjectIdentityConflictError, "must refuse, not silently split");
  const detail = (err as ProjectIdentityConflictError).detail;
  assert.equal(detail.registeredKey, "pk-branch1");
  assert.equal(detail.configKey, "pk-branch2");
  assert.match((err as Error).message, /pk-branch1/);
  assert.match((err as Error).message, /pk-branch2/);
  // No second backlog: still exactly one row, still owned by pk-branch1.
  assert.equal(registryByEvidence("repo-div")!.projectKey, "pk-branch1");
});

// AC (5): the same project_key copied into an UNRELATED repo -> REFUSE via the
// reverse-direction uniqueness (no backlog merge).
test("rung 5: a project_key copied into an unrelated repository -> REFUSE (reverse direction)", () => {
  resolve({ evidenceKey: "repo-orig", configKey: "pk-shared" }); // pk-shared owns repo-orig
  let err: unknown;
  try {
    // A DIFFERENT repository whose config carries the SAME (copied) key.
    resolve({ evidenceKey: "repo-other", configKey: "pk-shared" });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ProjectIdentityConflictError, "must refuse a cross-repo key collision");
  const detail = (err as ProjectIdentityConflictError).detail;
  assert.equal(detail.registeredEvidenceKey, "repo-orig");
  assert.equal(detail.evidenceKey, "repo-other");
  // pk-shared still maps ONLY to repo-orig — no merge.
  assert.equal(registryByKey("pk-shared")!.repoEvidenceKey, "repo-orig");
});
