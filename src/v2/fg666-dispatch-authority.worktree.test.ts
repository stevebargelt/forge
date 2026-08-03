// FG-666: the SUBSTRATE and the GUARD.
//
// The defect: a pipeline dispatches a task into a per-task PRIVATE CLONE
// (`git clone --quiet --shared --no-checkout`, worktree-lifecycle.ts:378), and the
// clone's derived repository evidence does not match the evidence the registered
// project_key was minted against. FG-608's cross-repository guard then correctly
// refuses every backlog read and the task's authority marker says `unknown` — so
// the architect, tech-lead and every engineer work from the brief alone while the
// shipping reviewer (a red, which mounts the project directory read-only and so
// resolves correctly) judges them against acceptance criteria they never saw.
//
// These cases pin the MECHANISM and the two halves that must hold TOGETHER. The
// seam-level pins — which prove the production caller passes the right input —
// live in fg666-dispatch-seam.worktree.test.ts; a test that constructs the
// resolver's input itself cannot detect a caller passing the wrong one, which is
// exactly why FG-621's substrate change went unnoticed.
//
// Real git fixtures throughout. repositoryCheckoutIdentity is NEVER mocked: the
// whole bug lives in what real git reports for a real clone.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { upsertTicket, setStorageMode, ensureStorageMode, dispatchEvidenceForTask } from "../store/tickets.js";
import { clearBacklogStoreCache } from "../backlog/storage-mode.js";
import { computeRepositoryEvidence } from "../store/project-registry.js";
import { repositoryCheckoutIdentity } from "../util/repository-identity.js";
import { normalizeGitRemoteUrl } from "../util/github-url.js";
import { SNAPSHOT_DB_BASENAME, liveSnapshotTargets } from "../backlog/snapshot.js";
import { CLONES_DIR } from "../util/paths.js";
import { resolveDispatchBacklogAuthority, publishBacklogSnapshot, backlogSnapshotHostDir } from "./spawn.js";

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

const NOW = "2026-08-03T00:00:00Z";

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

/** A real repository with one commit. `remote` adds a GitHub origin, which is what
 *  lifts identity onto the `remote` rung. */
function initRepo(prefix: string, opts: { remote?: string } = {}): string {
  const dir = newDir(prefix);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  if (opts.remote) git(dir, ["remote", "add", "origin", opts.remote]);
  return dir;
}

/** PRODUCTION'S OWN INCANTATION — worktree-lifecycle.ts:378. Not an approximation
 *  of how a per-task workspace is made; the same command. */
function privateClone(parent: string, prefix: string): string {
  const parentDir = newDir(prefix);
  const clonePath = join(parentDir, "clone");
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", parent, clonePath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  git(clonePath, ["config", "user.email", "agent@forge.local"]);
  git(clonePath, ["config", "user.name", "forge-agent"]);
  git(clonePath, ["checkout", "--quiet", "-b", "forge/task", "HEAD"]);
  return clonePath;
}

function linkedWorktree(parent: string, prefix: string): string {
  const holder = newDir(prefix);
  const wtPath = join(holder, "wt");
  git(parent, ["worktree", "add", "--quiet", "-b", "forge/wt", wtPath]);
  return wtPath;
}

/** Cut a checkout over to db mode and register its identity, the way
 *  `forge backlog migrate` does at import time. */
function cutOverToDb(projectDir: string, projectKey: string, ticketId: string, body: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `project_key: ${projectKey}\n`);
  writeTransaction(() => {
    ensureStorageMode(projectKey, NOW);
    upsertTicket({
      projectKey,
      ticketId,
      type: "story",
      status: "active",
      title: `title ${ticketId}`,
      body,
      importedAt: NOW,
    });
  });
  setStorageMode(projectKey, "db", NOW);
  const evidence = computeRepositoryEvidence(projectDir);
  db.prepare(
    `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(projectKey, evidence.key, evidence.source, NOW);
  clearBacklogStoreCache();
}

/** The clone inherits `.forge/config.yml` (it is git-TRACKED) but not the commit
 *  that created it, so a `--no-checkout` clone needs the file materialized on the
 *  branch it checks out. Committing it in the parent first is what production has:
 *  FG-608 committed the key, so every clone carries it. */
function commitForgeConfig(projectDir: string, projectKey: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `project_key: ${projectKey}\n`);
  git(projectDir, ["add", "-A"]);
  git(projectDir, ["commit", "-m", "commit project_key"]);
}

// ─── (1) THE SUBSTRATE MATRIX ────────────────────────────────────────────────

test("FG-666 (1): a linked worktree CONVERGES with its parent's evidence; a private clone DIVERGES", () => {
  const remoteParent = initRepo("fg666-remote-parent-", { remote: "git@github.com:acme/widget.git" });
  const remoteClone = privateClone(remoteParent, "fg666-remote-clone-");
  const barebackParent = initRepo("fg666-bare-parent-");
  const barebackClone = privateClone(barebackParent, "fg666-bare-clone-");
  const worktree = linkedWorktree(barebackParent, "fg666-bare-wt-");

  const id = (d: string) => repositoryCheckoutIdentity(d);

  // The remote-bearing parent rides the `remote` rung.
  assert.equal(id(remoteParent).source, "remote");

  // THE CORRECTION THIS TICKET TURNS ON: a per-task clone's origin is a FILESYSTEM
  // PATH, and normalizeGitRemoteUrl returns undefined for one — no `://` so the
  // scp-form branch is skipped, no scp-form colon so `new URL()` throws. The remote
  // rung does not merely produce a DIFFERENT key for a clone; it does not
  // participate at all, and identity falls through to the clone's OWN git common
  // dir. This is why "preserve/rename the origin remote" could never have worked.
  assert.equal(
    normalizeGitRemoteUrl(remoteParent),
    undefined,
    "a bare filesystem path does not normalize as a remote — the remote rung cannot participate for a clone",
  );
  assert.equal(id(remoteClone).source, "git-common-dir", "the clone falls through to its own common dir");
  assert.notEqual(
    id(remoteClone).key,
    id(remoteParent).key,
    "a private clone of a remote-bearing parent DIVERGES from it",
  );

  // The remoteless pair: BOTH sides resolve via git-common-dir and they still
  // diverge, because `--shared` gives the clone its own common dir. There is no
  // origin URL to copy here, which is the case Option 1 could never have fixed.
  assert.equal(id(barebackParent).source, "git-common-dir");
  assert.equal(id(barebackClone).source, "git-common-dir");
  assert.notEqual(
    id(barebackClone).key,
    id(barebackParent).key,
    "a private clone of a REMOTELESS parent diverges too — neither rung converges",
  );

  // THE ROW THAT EXPLAINS WHY NOTHING CAUGHT FG-621: a linked worktree shares its
  // parent's git common dir, so it resolves to the SAME evidence. Backlog authority
  // silently depended on that convergence; moving the dispatch substrate from linked
  // worktrees to private clones removed it, and no test noticed.
  assert.equal(
    id(worktree).key,
    id(barebackParent).key,
    "a LINKED WORKTREE converges with its parent — the property FG-621's substrate change removed",
  );
});

// ─── (2)+(3) THE AC3/AC5 PAIR — same code, two substrates ────────────────────
//
// (a) and (b) differ ONLY in substrate. Any change that makes (a) pass by weakening
// the guard breaks (b). The pairing is the proof; neither case alone is.

for (const remote of [undefined, "git@github.com:acme/widget.git"] as const) {
  const label = remote ? "remote-bearing" : "REMOTELESS";
  test(`FG-666 (2a/3): a per-task clone of a ${label} registered checkout resolves db + the correct project_key`, () => {
    const KEY = `pk-fg666-${remote ? "remote" : "bare"}`;
    const parent = initRepo("fg666-pair-parent-", remote ? { remote } : {});
    cutOverToDb(parent, KEY, "FG-1", "body");
    commitForgeConfig(parent, KEY);
    const clone = privateClone(parent, "fg666-pair-clone-");

    // The clone genuinely carries the right key and genuinely diverges in evidence.
    assert.match(readFileSync(join(clone, ".forge", "config.yml"), "utf8"), new RegExp(KEY));
    assert.notEqual(computeRepositoryEvidence(clone).key, computeRepositoryEvidence(parent).key);

    // Asking the CLONE is the category error — and FG-608 correctly refuses it.
    const fromClone = resolveDispatchBacklogAuthority(clone, "task-from-clone", "FG-1");
    assert.equal(fromClone.mode, "unknown", "the clone has no independent claim to a project");
    assert.equal(fromClone.reason, "identity-conflict");

    // Asking the PROJECT — which is what the dispatch layer now does — resolves.
    const fromProject = resolveDispatchBacklogAuthority(parent, "task-from-project", "FG-1");
    assert.equal(fromProject.mode, "db");
    assert.equal(fromProject.projectKey, KEY);
    assert.equal(fromProject.dispatchedTicket, `FG-1:1:${fromProject.ticketEvidence!.bodyHash}`);
  });
}

test("FG-666 (2b): a GENUINELY DIFFERENT repository carrying a COPIED project_key is still refused", () => {
  const KEY = "pk-fg666-guard";
  const owner = initRepo("fg666-guard-owner-");
  cutOverToDb(owner, KEY, "FG-1", "body");

  // A completely unrelated repository whose .forge/config.yml commits the same key —
  // .forge/config.yml is git-tracked and freely copyable, which is the whole reason
  // the registry cross-check exists.
  const impostor = initRepo("fg666-guard-impostor-");
  mkdirSync(join(impostor, ".forge"), { recursive: true });
  writeFileSync(join(impostor, ".forge", "config.yml"), `project_key: ${KEY}\n`);
  clearBacklogStoreCache();

  const authority = resolveDispatchBacklogAuthority(impostor, "task-impostor", "FG-1");
  assert.equal(authority.mode, "unknown", "the cross-repository guard still refuses — it was NOT weakened");
  assert.equal(authority.reason, "identity-conflict");
  assert.equal(authority.projectKey, null, "and it never hands back the copied key");
  assert.match(authority.detail!, new RegExp(KEY), "the detail names the declared key");
  assert.match(
    authority.detail!,
    new RegExp(computeRepositoryEvidence(impostor).key),
    "and this checkout's evidence, so the operator can tell which side moved",
  );

  // The owner still resolves — the guard refuses the impostor, not the project.
  assert.equal(resolveDispatchBacklogAuthority(owner, "task-owner", "FG-1").mode, "db");
});

test("FG-666 (2b): NO path-prefix exemption — a foreign repo sitting under the clones dir is still refused", () => {
  // The rejected shortcut: treat any workspace under ~/.forge/worktrees/clones/ as
  // trusted because of where it lives. That would make identity forgeable by anyone
  // who can create a directory — and the agent has passwordless root in a container
  // whose workspace is exactly there. Pinned behaviourally rather than by reading
  // the diff: a repository that is NOT this project, placed at the very path the
  // exemption would have covered, must still be refused.
  const KEY = "pk-fg666-prefix";
  const owner = initRepo("fg666-prefix-owner-");
  cutOverToDb(owner, KEY, "FG-1", "body");

  const underClones = join(CLONES_DIR, "run-fg666-prefix", "task-fg666-prefix");
  mkdirSync(underClones, { recursive: true });
  dirs.push(join(CLONES_DIR, "run-fg666-prefix"));
  git(underClones, ["init", "-b", "main"]);
  git(underClones, ["config", "user.email", "test@forge.test"]);
  git(underClones, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(underClones, "README.md"), "# not this project\n");
  git(underClones, ["add", "."]);
  git(underClones, ["commit", "-m", "initial"]);
  mkdirSync(join(underClones, ".forge"), { recursive: true });
  writeFileSync(join(underClones, ".forge", "config.yml"), `project_key: ${KEY}\n`);
  clearBacklogStoreCache();

  const authority = resolveDispatchBacklogAuthority(underClones, "task-under-clones", "FG-1");
  assert.equal(
    authority.mode,
    "unknown",
    "a workspace under the clones directory earns no trust from its path — the guard still refuses",
  );
  assert.equal(authority.reason, "identity-conflict");
});

// ─── (4) RESOLUTION IS SIDE-EFFECT-FREE ──────────────────────────────────────

test("FG-666 (4): resolveDispatchBacklogAuthority writes NOTHING — no marker, no target, no publication, no evidence", () => {
  const KEY = "pk-fg666-pure";
  const parent = initRepo("fg666-pure-");
  cutOverToDb(parent, KEY, "FG-1", "body");

  const authority = resolveDispatchBacklogAuthority(parent, "task-pure", "FG-1");
  assert.equal(authority.mode, "db");
  assert.equal(authority.hostDir, backlogSnapshotHostDir("task-pure"));

  assert.equal(existsSync(join(authority.hostDir, "authority.json")), false, "no marker written");
  assert.equal(existsSync(join(authority.hostDir, SNAPSHOT_DB_BASENAME)), false, "no snapshot published");
  assert.deepEqual(liveSnapshotTargets(KEY), [], "no fan-out target registered");
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM backlog_snapshot_publications`).get() as { n: number }).n,
    0,
    "no publication row",
  );
  assert.equal(dispatchEvidenceForTask("task-pure"), undefined, "no dispatch evidence recorded");

  // And publication — the OTHER half — is what commits every one of them.
  dirs.push(authority.hostDir);
  const mount = publishBacklogSnapshot(authority, "task-pure");
  assert.equal(mount.mode, "db");
  assert.equal(existsSync(join(mount.hostDir, "authority.json")), true);
  assert.equal(existsSync(join(mount.hostDir, SNAPSHOT_DB_BASENAME)), true);
  assert.equal(liveSnapshotTargets(KEY).length, 1);
  assert.equal(dispatchEvidenceForTask("task-pure")!.revision, 1);
});

// ─── (5) CLASSIFICATION: declared-but-unresolvable vs no key at all ──────────

test("FG-666 (5): a project with NO project_key resolves markdown with NO reason — the normal outcome stays silent", () => {
  const plain = initRepo("fg666-nokey-");
  mkdirSync(join(plain, "backlog"), { recursive: true });

  const authority = resolveDispatchBacklogAuthority(plain, "task-md", "FG-1");
  assert.equal(authority.mode, "markdown");
  assert.equal(authority.projectKey, null);
  assert.equal(
    authority.reason,
    undefined,
    "a diagnostic that fires on every normal project reproduces the silence FG-666 exists to end",
  );
  assert.equal(authority.detail, undefined);
});

test("FG-666 (5): a DECLARED but unresolvable project_key resolves unknown + identity-conflict + the keys", () => {
  const KEY = "pk-fg666-declared";
  const owner = initRepo("fg666-declared-owner-");
  cutOverToDb(owner, KEY, "FG-1", "body");

  // Same key, different repository — the registry maps it elsewhere.
  const other = initRepo("fg666-declared-other-");
  mkdirSync(join(other, ".forge"), { recursive: true });
  writeFileSync(join(other, ".forge", "config.yml"), `project_key: ${KEY}\n`);
  clearBacklogStoreCache();

  const authority = resolveDispatchBacklogAuthority(other, "task-conflict", "FG-1");
  assert.equal(authority.mode, "unknown");
  assert.equal(authority.reason, "identity-conflict");
  const detail = authority.detail!;
  assert.match(detail, new RegExp(KEY), "the config key");
  assert.match(detail, new RegExp(computeRepositoryEvidence(owner).key), "the REGISTERED evidence");
  assert.match(detail, new RegExp(computeRepositoryEvidence(other).key), "and THIS checkout's evidence");
});
