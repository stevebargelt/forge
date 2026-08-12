// FG-663 — the DURABLE project identity captured on a run at CREATION, proved at
// the store's single INSERT choke point.
//
// The defect FG-663 closes: a run had no durable project field. Identity was
// re-derived at READ time by inspecting the filesystem, so when a disposable
// clone was deleted, resolution fell through to a hash of the vanished path and
// the run rendered as "Unknown repository" — 131 runs / 364 tasks of measured
// blast radius. The forward fix records the PROJECT a run belongs to as data,
// while the checkout is still readable, and never re-derives it from a
// project_dir that may be gone.
//
// This file pins the STORE half (AC1/AC3/AC6/AC8): insertRun captures the right
// identity for each precedence rung; the captured value SURVIVES deletion of the
// checkout directory; a genuinely non-git, config-less directory degrades to its
// stable path-source repo- key rather than throwing or attributing elsewhere;
// and capture is a PURE READER — it writes nothing to .forge/config.yml, mints no
// project_identity registry row, and leaves git clean.
//
// Resolution precedence (src/backlog/storage-mode.ts resolveProjectIdentity),
// every rung anchored to THIS checkout's own repository evidence (RF-3):
//   (a) the pk- this checkout's evidence maps to in the registry — the arbiter
//       wins outright when it knows this evidence
//   (b) else a declared config project_key (pk-), but ONLY when it is not
//       registered to a DIFFERENT repository's evidence (else degrade to (c))
//   (c) else the resolved repo- evidence key (remote > git-common-dir > path)
//   NULL only when there is no projectDir at all.
//
// Every case works against REAL git checkouts and the REAL identity readers, so a
// change to the evidence key material (which FG-663 must NOT touch) would surface
// here rather than in production.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import { insertRun, getRun, setRunProjectDir, resolveRunProjectIdentity } from "./runs.js";
import { computeRepositoryEvidence } from "./project-registry.js";
import { nowIso } from "../util/ids.js";
import { startRun } from "../v2/startRun.js";
import { WorkflowSchema, type Workflow } from "../v2/schema.js";
import type { Run } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let root: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  // realpath so a macOS /var -> /private/var alias in the mkdtemp prefix cannot
  // make the checkout dir the test creates differ from the one the evidence
  // readers resolve.
  root = realpathSync(mkdtempSync(join(tmpdir(), "fg663-")));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

/** A real committed checkout. With a remote, identity resolves via the preferred
 *  normalized remote; without one, via the git common dir. Either way the key is
 *  a `repo-` evidence key. */
function initRepo(dir: string, opts?: { remote?: string }): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  if (opts?.remote) git(dir, ["remote", "add", "origin", opts.remote]);
}

/** Write a committed project_key into .forge/config.yml, exactly as an operator's
 *  git-tracked config carries it. Committed so `git status` stays clean and the
 *  file is fixture, not capture side effect. */
function writeConfigKey(dir: string, projectKey: string): void {
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), `project_key: ${projectKey}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "add project_key"]);
}

function porcelain(dir: string): string {
  return git(dir, ["status", "--porcelain"]).trim();
}

/** The raw stored column — deliberately read via SQL, not rowToRun, because
 *  project_identity is not on the Run type (the dashboard reads the raw column
 *  too). This IS the durable record the whole ticket is about. */
function storedIdentity(id: string): string | null {
  const row = getDb().prepare(`SELECT project_identity AS pi FROM runs WHERE id = ?`).get(id) as
    | { pi: string | null }
    | undefined;
  return row?.pi ?? null;
}

function registryRowCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM project_identity`).get() as { n: number }).n;
}

/** A minimal Run with only what insertRun binds. id is the discriminator. */
function makeRun(id: string, projectDir: string | undefined): Run {
  return {
    id,
    workflow: "feature",
    title: `fg663 ${id}`,
    status: "active",
    createdAt: nowIso(),
    projectDir,
    reviewMode: "legacy_verdict",
  };
}

describe("FG-663 — insertRun captures the durable project identity at creation (AC1)", () => {
  test("(a) a checkout that DECLARES a project_key stores that pk-", () => {
    const dir = join(root, "declared");
    initRepo(dir, { remote: "https://github.com/acme/declared.git" });
    writeConfigKey(dir, "pk-declared-0001");

    insertRun(makeRun("run-a", dir));

    assert.equal(
      storedIdentity("run-a"),
      "pk-declared-0001",
      "a declared project_key is the highest-precedence identity — durable, git-tracked, clone-inherited",
    );
  });

  test("(b) with NO config but a registry row for this evidence, stores the MAPPED pk-", () => {
    const dir = join(root, "registered");
    initRepo(dir, { remote: "https://github.com/acme/registered.git" });
    const evidence = computeRepositoryEvidence(dir);
    // Register this repository's evidence to a project_key — the registry is the
    // arbiter the resolver consults when config declares nothing.
    getDb()
      .prepare(
        `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("pk-registered-0002", evidence.key, evidence.source, nowIso());

    insertRun(makeRun("run-b", dir));

    assert.equal(
      storedIdentity("run-b"),
      "pk-registered-0002",
      "with no declared key, the pk- the checkout's evidence maps to in the registry wins over the raw repo- key",
    );
  });

  test("(c) with a remote and NEITHER config nor registry, stores the remote-sourced repo-", () => {
    const dir = join(root, "bare");
    initRepo(dir, { remote: "https://github.com/acme/bare.git" });
    const evidence = computeRepositoryEvidence(dir);

    insertRun(makeRun("run-c", dir));

    const stored = storedIdentity("run-c");
    assert.equal(stored, evidence.key, "the resolved repo- evidence key is captured when nothing else declares identity");
    assert.equal(evidence.source, "remote", "fixture sanity: a repo with a remote resolves via the remote source");
    assert.match(stored ?? "", /^repo-/, "an evidence key is a repo- key, never a pk-");
  });

  test("no projectDir at all stores NULL — a real run that just cannot claim a project", () => {
    insertRun(makeRun("run-null", undefined));
    assert.equal(storedIdentity("run-null"), null, "NULL is the only honest reading when there is no project_dir");
  });
});

describe("FG-663 — attribution survives deletion of the checkout directory (AC3/AC8)", () => {
  test("(d) the stored identity is unchanged after the checkout is deleted, and still attributes", () => {
    const dir = join(root, "doomed");
    initRepo(dir, { remote: "https://github.com/acme/doomed.git" });
    writeConfigKey(dir, "pk-doomed-0003");

    insertRun(makeRun("run-d", dir));
    const captured = storedIdentity("run-d");
    assert.equal(captured, "pk-doomed-0003", "precondition: identity was captured while the checkout existed");

    // The disposable clone is deleted — the exact event that used to orphan a run
    // into "Unknown repository" because identity was re-derived from a now-gone path.
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false, "the checkout is genuinely gone");

    assert.equal(
      storedIdentity("run-d"),
      captured,
      "identity is DATA on the row, so deleting the directory cannot change it — it is read back, never re-derived",
    );
    // And the run is still fully readable — deletion touched nothing about the row.
    assert.equal(getRun("run-d")?.projectDir, dir, "project_dir is retained verbatim beside the durable identity");
  });
});

describe("FG-663 — a non-git, config-less directory degrades cleanly (AC6)", () => {
  test("(e) stores its stable path-source repo- and does NOT throw", () => {
    const dir = join(root, "not-a-repo");
    mkdirSync(dir, { recursive: true });
    const evidence = computeRepositoryEvidence(dir);

    assert.doesNotThrow(() => insertRun(makeRun("run-e", dir)), "capture must never block run creation on a plain dir");

    const stored = storedIdentity("run-e");
    assert.equal(evidence.source, "path", "fixture sanity: a non-git directory resolves via the path source");
    assert.equal(stored, evidence.key, "the stable path-source key is captured — the run is attributed to itself, not elsewhere");
    assert.match(stored ?? "", /^repo-/, "a path-source evidence key is still a repo- key");
  });
});

describe("FG-663 — capture is a PURE READER (protected invariant)", () => {
  test("(f) inserting writes NO config, mints NO registry row, and leaves git clean", () => {
    const dir = join(root, "pure");
    initRepo(dir, { remote: "https://github.com/acme/pure.git" });
    assert.equal(porcelain(dir), "", "precondition: the fixture checkout is clean");
    assert.equal(existsSync(join(dir, ".forge", "config.yml")), false, "precondition: no config declared");
    const registryBefore = registryRowCount();

    insertRun(makeRun("run-f", dir));

    // Identity was still captured — the evidence repo- key — even though nothing
    // was minted for it. Reading resolved an identity; it did not create one.
    assert.equal(storedIdentity("run-f"), computeRepositoryEvidence(dir).key, "capture still resolved an identity");
    assert.equal(
      existsSync(join(dir, ".forge", "config.yml")),
      false,
      "capture must NOT heal config — a forge pointed at a throwaway clone cannot dirty its tree",
    );
    assert.equal(registryRowCount(), registryBefore, "capture must mint NO project_identity registry row");
    assert.equal(porcelain(dir), "", "capture leaves git status clean — it composes only readers");
  });
});

describe("FG-663 — every creation path reaches the choke point (AC4 spot-check)", () => {
  // A minimal but SCHEMA-VALID workflow so the REAL startRun path runs, not a
  // fabricated Run — startRun is one of the creation paths AC4 requires, and it
  // records identity only because it funnels through insertRun.
  const TEST_WORKFLOW: Workflow = WorkflowSchema.parse({
    name: "feature",
    description: "fg663 project-identity spot-check workflow",
    steps: [{ id: "build", agent: "engineer" }],
  });

  test("startRun populates project_identity by construction (funnels through insertRun)", () => {
    const dir = join(root, "via-startrun");
    initRepo(dir, { remote: "https://github.com/acme/via-startrun.git" });

    const { runId } = startRun({ workflow: TEST_WORKFLOW, title: "spot-check", inputs: {}, projectDir: dir });

    assert.equal(
      storedIdentity(runId),
      computeRepositoryEvidence(dir).key,
      "central capture at insertRun means a creation path needs no per-caller edit to record identity (AC4)",
    );
  });

  test("a direct insertRun site populates it too — the same single choke point", () => {
    const dir = join(root, "via-insert");
    initRepo(dir, { remote: "https://github.com/acme/via-insert.git" });

    insertRun(makeRun("run-direct", dir));

    assert.equal(storedIdentity("run-direct"), computeRepositoryEvidence(dir).key);
  });
});

describe("FG-663 (RF-3) — a checkout cannot forge another project's declared identity", () => {
  test("a copied .forge/config.yml project_key registered to a DIFFERENT repository is NOT trusted — capture stores this checkout's own evidence", () => {
    // The victim: a registered project. Its pk- maps to ITS evidence.
    const victim = join(root, "victim");
    initRepo(victim, { remote: "https://github.com/acme/victim.git" });
    const victimEvidence = computeRepositoryEvidence(victim);
    getDb()
      .prepare(
        `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("pk-victim-9001", victimEvidence.key, victimEvidence.source, nowIso());

    // The attacker: a DIFFERENT repository that ships the victim's project_key in a
    // copied config, trying to slip its runs into the victim's scoped views.
    const attacker = join(root, "attacker");
    initRepo(attacker, { remote: "https://github.com/evil/attacker.git" });
    writeConfigKey(attacker, "pk-victim-9001");
    const attackerEvidence = computeRepositoryEvidence(attacker);
    assert.notEqual(attackerEvidence.key, victimEvidence.key, "fixture: genuinely distinct repositories");

    insertRun(makeRun("run-attacker", attacker));

    assert.equal(
      storedIdentity("run-attacker"),
      attackerEvidence.key,
      "a declared key registered to another repository's evidence is refused — the run is attributed to its OWN evidence, never the victim's pk-",
    );
    assert.notEqual(storedIdentity("run-attacker"), "pk-victim-9001", "the forged identity is never stored (cross-project isolation)");
  });

  test("a declared key that AGREES with the registry (a legitimate clone) is still captured", () => {
    const dir = join(root, "legit-clone");
    initRepo(dir, { remote: "https://github.com/acme/legit.git" });
    const evidence = computeRepositoryEvidence(dir);
    // Registry maps THIS evidence to the declared key — they agree.
    getDb()
      .prepare(
        `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("pk-legit-9002", evidence.key, evidence.source, nowIso());
    writeConfigKey(dir, "pk-legit-9002");

    insertRun(makeRun("run-legit", dir));
    assert.equal(storedIdentity("run-legit"), "pk-legit-9002", "a declared key corroborated by the registry is trusted");
  });
});

describe("FG-663 (RF-3) — identity resolution is never held across the write lock", () => {
  test("insertRun inside a write transaction WITHOUT a pre-resolved identity fails loudly", () => {
    const dir = join(root, "in-tx-bare");
    initRepo(dir, { remote: "https://github.com/acme/in-tx-bare.git" });
    assert.throws(
      () => writeTransaction(() => insertRun(makeRun("run-in-tx", dir))),
      /write transaction/i,
      "a git subprocess must never be resolved while the SQLite write lock is held — resolve it ABOVE the transaction",
    );
    assert.equal(getRun("run-in-tx"), undefined, "the run was never inserted — the guard fired before the INSERT");
  });

  test("insertRun inside a write transaction WITH a pre-resolved identity succeeds and stores it", () => {
    const dir = join(root, "in-tx-hoisted");
    initRepo(dir, { remote: "https://github.com/acme/in-tx-hoisted.git" });
    // Resolve ABOVE the transaction, exactly as the dispatch/campaign paths do.
    const identity = resolveRunProjectIdentity(dir);
    writeTransaction(() => insertRun(makeRun("run-hoisted", dir), identity));
    assert.equal(
      storedIdentity("run-hoisted"),
      computeRepositoryEvidence(dir).key,
      "the pre-resolved identity is what lands on the row",
    );
  });

  test("a run with NO projectDir needs no resolution, so it is fine inside a transaction", () => {
    writeTransaction(() => insertRun(makeRun("run-no-pd", undefined)));
    assert.equal(storedIdentity("run-no-pd"), null, "no projectDir → no subprocess → no guard to trip");
  });
});

describe("FG-663 — setRunProjectDir moves identity with the path", () => {
  test("re-pointing a run's project_dir recomputes and moves project_identity with it", () => {
    const from = join(root, "from");
    const to = join(root, "to");
    initRepo(from, { remote: "https://github.com/acme/from.git" });
    initRepo(to);
    writeConfigKey(to, "pk-to-0004");

    insertRun(makeRun("run-move", from));
    assert.equal(storedIdentity("run-move"), computeRepositoryEvidence(from).key, "starts under the 'from' evidence key");

    setRunProjectDir("run-move", to);

    assert.equal(
      storedIdentity("run-move"),
      "pk-to-0004",
      "identity moves with the path exactly as project_dir_canonical does — a stale identity would be worse than none",
    );
    assert.equal(getRun("run-move")?.projectDir, to, "project_dir moved too");
  });
});
