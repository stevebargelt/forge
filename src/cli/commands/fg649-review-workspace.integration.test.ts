// FG-649 (change 2): the REVIEW ROW is the authority for which checkout its stages act on.
//
// Before this, `forge review start|continue` did `resolve(opts.project ?? process.cwd())` on
// every invocation, so a `continue` run from the wrong directory drove a review against a
// different tree. That was a wrong READ, surfaced as the candidate_not_checked_out stop.
// Since the coordinator COMMITS the fix cycle (FG-649 change 1) it is a write into a
// possibly-wrong repository — which is why the binding is durable and the fallback is gone.
//
// This tier spawns the REAL CLI at the process boundary (the review-coordinator.integration
// pattern: spawnSync the actual program, FORGE_HOME on a temp store, the FG-645 authority
// testkit seam) and — this is the point — runs every child with `cwd` set to a DIFFERENT git
// repository than the review's workspace. A test that resolved the workspace the old way
// would act on that cwd repo, and each arm below names which repository it observed.
//
// It dispatches NO containers. Two stages are enough to observe the workspace deterministically:
//   - Stage 1's candidate/HEAD comparison, which names the workspace it looked at and the head
//     it found there (arm 2);
//   - Stage 2's fail-closed unevaluated-diff refusal, which lists the paths of
//     `git diff --name-only <base>..<candidate>` — shas that exist ONLY in the workspace repo
//     (arm 1).
//
// RED baselines, each falsifiable and each naming the exact pre-fix line:
//   - restore `projectDir: resolve(opts.project ?? process.cwd())` in depsFor
//     (src/cli/commands/review.ts) and arms 1, 2, 3 and 6 fail: the transcripts name cwdRepo's
//     paths and head instead of the recorded workspace's.
//   - drop the workspace_dir write from `start`'s insertReview and arm 4 fails.
//   - re-add a cwd fallback to resolveReviewWorkspace and arms 5, 7 and 8 fail: a deleted or
//     unbound workspace silently acts on cwd instead of refusing by name.
//   - drop `workspace_dir` from ADDITIVE_COLUMNS in src/store/schema.ts and arm 9 fails.
//   - delete the identityRefusal call from checkWorkspace and arm 10 fails; widen it to refuse
//     whenever the paths differ and arm 11 fails.
// Each was RUN against the pre-fix line, not asserted from reading: 7 of these arms go red
// with `projectDir: resolve(opts.project ?? process.cwd())` restored in depsFor.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";
import { computeRepositoryEvidence } from "../../store/project-registry.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const localTsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

const CONTRACT = {
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["the review row names the checkout its stages act on"],
  acceptance_refs: ["FG-649 change 2"],
  risk_lenses: ["wide"],
  non_goals: ["protect the host from malicious candidate code"],
  lens_scopes: { wide: ["src/"] },
};

let homeDir: string;
let contractPath: string;

/** The review's workspace: two commits, and a file name that exists in NO other fixture repo. */
let workspaceRepo: string;
let workspaceBase: string;
let workspaceHead: string;

/** Where the operator is standing. A real repository, deliberately not the review's. */
let cwdRepo: string;

/** An operator-supplied override (--project), and a run's project_dir for the legacy arm. */
let otherRepo: string;
let runRepo: string;

/** Bound to a review and then deleted out from under it. */
let doomedRepo: string;

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function makeRepo(prefix: string, files: string[]): { dir: string; shas: string[] } {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg649-${prefix}-`));
  git(dir, ["init", "-q"]);
  const shas: string[] = [];
  for (const file of files) {
    writeFileSync(join(dir, file), `${file} in ${prefix}\n`);
    git(dir, ["add", file]);
    git(dir, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", `chore: add ${file}`]);
    shas.push(git(dir, ["rev-parse", "HEAD"]).trim());
  }
  return { dir, shas };
}

/** Every child runs from cwdRepo — a real git repository that is NOT the review's workspace.
 *  If the workspace were still resolved from cwd, this is the tree every arm would observe. */
function runForge(args: string[], opts: { cwd?: string } = {}) {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: opts.cwd ?? cwdRepo,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: homeDir, ...authorityTestkitEnv() },
  });
}

function openStore(): Database.Database {
  return new Database(join(homeDir, "forge.db"));
}

function reviewRow(id: string): { state: string; workspace_dir: string | null; candidate_sha: string | null } {
  const db = openStore();
  try {
    return db.prepare(`SELECT state, workspace_dir, candidate_sha FROM reviews WHERE id = ?`).get(id) as {
      state: string;
      workspace_dir: string | null;
      candidate_sha: string | null;
    };
  } finally {
    db.close();
  }
}

type SeedOpts = {
  id: string;
  workspaceDir?: string | undefined;
  runId?: string | undefined;
  runProjectDir?: string | undefined;
  candidateSha: string;
  baseSha?: string | undefined;
  /** Stage 1 recorded, so the next transition is the contract confirmation. */
  verifiedEntryAt?: string | undefined;
};

function seedReview(o: SeedOpts): void {
  const db = openStore();
  try {
    if (o.runId !== undefined) {
      db.prepare(
        `INSERT INTO runs (id, workflow, title, status, created_at, project_dir, review_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(o.runId, "feature", o.runId, "active", "2026-07-30T00:00:00Z", o.runProjectDir ?? null, "evidence_led");
    }
    db.prepare(
      `INSERT INTO reviews (id, run_id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha,
                            workspace_dir, contract_json, stage_evidence_json, review_mode, state,
                            created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      o.id,
      o.runId ?? null,
      "FG-649",
      o.baseSha ?? null,
      null,
      o.candidateSha,
      o.workspaceDir ?? null,
      JSON.stringify(CONTRACT),
      o.verifiedEntryAt !== undefined
        ? JSON.stringify({ verified_entry: { sha: o.verifiedEntryAt, at: "2026-07-30T00:00:01Z" } })
        : null,
      "evidence_led",
      "confirming_contract",
      "2026-07-30T00:00:00Z",
      "2026-07-30T00:00:01Z",
    );
  } finally {
    db.close();
  }
}

/** Enough of a repository's observable state to prove a refusal never touched it. */
function repoSignature(dir: string): string {
  return [
    git(dir, ["rev-parse", "HEAD"]).trim(),
    git(dir, ["status", "--porcelain", "--untracked-files=all"]),
    git(dir, ["rev-list", "--count", "HEAD"]).trim(),
  ].join("|");
}

before(() => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg649-home-"));
  const db = openStore();
  db.exec(SCHEMA_SQL);
  db.close();

  contractPath = join(homeDir, "contract.json");
  writeFileSync(contractPath, JSON.stringify(CONTRACT, null, 2));

  const ws = makeRepo("workspace", ["workspace-base.md", "workspace-only.md"]);
  workspaceRepo = ws.dir;
  workspaceBase = ws.shas[0] as string;
  workspaceHead = ws.shas[1] as string;

  cwdRepo = makeRepo("cwd", ["cwd-only.md"]).dir;
  otherRepo = makeRepo("other", ["other-only.md"]).dir;
  runRepo = makeRepo("run", ["run-only.md"]).dir;
  doomedRepo = makeRepo("doomed", ["doomed-only.md"]).dir;

  assert.notEqual(
    git(cwdRepo, ["rev-parse", "HEAD"]).trim(),
    workspaceHead,
    "precondition: the cwd repo and the review's workspace must be different trees, or nothing here discriminates",
  );
});

after(() => {
  for (const dir of [homeDir, workspaceRepo, cwdRepo, otherRepo, runRepo, doomedRepo]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── arm 1 ───────────────────────────────────────────────────────────────────
// The strongest available proof that git ran in the RECORDED repository: the Stage 2
// unevaluated-diff refusal lists `git diff --name-only <base>..<candidate>`, and those two
// shas exist only in workspaceRepo. From cwdRepo the same command could not even resolve them.
test("FG-649: `forge review continue` computes its diff in the PERSISTED workspace, from a cwd that is another repo", () => {
  seedReview({
    id: "review-bound",
    workspaceDir: workspaceRepo,
    baseSha: workspaceBase,
    candidateSha: workspaceHead,
    verifiedEntryAt: workspaceHead,
  });

  const r = runForge(["review", "continue", "review-bound"]);
  const out = `${r.stdout}${r.stderr}`;

  assert.match(out, /workspace-only\.md/, "the changed paths come from the review's own workspace");
  assert.doesNotMatch(out, /cwd-only\.md/, "and never from the directory the process happened to run in");
  assert.doesNotMatch(
    out,
    /candidate_not_checked_out/,
    "the candidate/HEAD comparison resolved against the recorded repo, where the candidate IS the head",
  );
  assert.equal(reviewRow("review-bound").workspace_dir, workspaceRepo, "the binding is unchanged by a read of it");
});

// ── arm 2 ───────────────────────────────────────────────────────────────────
// The candidate matches NEITHER repository's head, so the comparison stops — and the stop
// names the workspace it looked at and the head it found there. Pre-fix this named cwdRepo.
test("FG-649: the candidate/HEAD comparison names the RECORDED workspace and its head, never cwd's", () => {
  const cwdHead = git(cwdRepo, ["rev-parse", "HEAD"]).trim();
  seedReview({
    id: "review-elsewhere",
    workspaceDir: workspaceRepo,
    baseSha: workspaceBase,
    candidateSha: "0".repeat(40),
  });

  const r = runForge(["review", "continue", "review-elsewhere"]);
  const out = `${r.stdout}${r.stderr}`;

  assert.match(out, /candidate_not_checked_out/, "an absent candidate is still the honest environment stop");
  assert.match(out, new RegExp(`the workspace at ${workspaceRepo} is on ${workspaceHead}`));
  assert.doesNotMatch(out, new RegExp(cwdHead), "the cwd repository's head is irrelevant and must not appear");
});

// ── arm 3 ───────────────────────────────────────────────────────────────────
test("FG-649: --project on continue is RECORDED, so the NEXT invocation with no flag uses it", () => {
  // No verified_entry: the next transition is Stage 1, whose candidate/HEAD comparison names
  // the workspace it looked at. That is the cheapest deterministic observation of WHICH repo
  // was resolved — the candidate is workspaceRepo's head, so any other repo stops here.
  seedReview({
    id: "review-override",
    workspaceDir: workspaceRepo,
    baseSha: workspaceBase,
    candidateSha: workspaceHead,
  });

  const overridden = runForge(["review", "continue", "review-override", "--project", otherRepo]);
  assert.match(
    `${overridden.stdout}${overridden.stderr}`,
    /candidate_not_checked_out/,
    "the override took effect: otherRepo is not on the candidate",
  );
  assert.equal(
    reviewRow("review-override").workspace_dir,
    otherRepo,
    "an operator override is RECORDED on the review, never merely used for one invocation",
  );

  const after = runForge(["review", "continue", "review-override"]);
  const out = `${after.stdout}${after.stderr}`;
  assert.match(out, new RegExp(`the workspace at ${otherRepo} is on`), "a later bare continue uses what was recorded");
  assert.doesNotMatch(out, new RegExp(workspaceRepo), "and does not fall back to the binding the override replaced");
});

// ── arm 4 ───────────────────────────────────────────────────────────────────
test("FG-649: `forge review start --project <dir>` persists workspace_dir, readable from the SQLite row", () => {
  // A commit whose subject references the ticket, so the comparison base resolves at open.
  writeFileSync(join(workspaceRepo, "fg650-note.md"), "started\n");
  git(workspaceRepo, ["add", "fg650-note.md"]);
  git(workspaceRepo, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "FG-650: note"]);

  const r = runForge(["review", "start", "FG-650", "--contract", contractPath, "--project", workspaceRepo]);
  assert.match(r.stdout, /workspace: /, "start reports the workspace it bound");

  const db = openStore();
  try {
    const row = db
      .prepare(`SELECT id, workspace_dir FROM reviews WHERE ticket_id = ?`)
      .get("FG-650") as { id: string; workspace_dir: string | null } | undefined;
    assert.ok(row, "the review was opened");
    assert.equal(row.workspace_dir, workspaceRepo, "the workspace is bound on the review row");

    // Bound by the INSERT, not by a later patch: the review.created event is written inside
    // the same transaction as the row, so it can only carry a workspace the insert knew.
    // (Falsifiable: drop `workspaceDir: workspace.dir` from start's insertReview call and
    // this half reddens while the row above still passes, because depsFor would re-record it.)
    const created = db
      .prepare(`SELECT payload FROM events WHERE event_type = 'review.created' ORDER BY id DESC LIMIT 1`)
      .get() as { payload: string };
    assert.equal(
      (JSON.parse(created.payload) as { workspaceDir?: string }).workspaceDir,
      workspaceRepo,
      "the creation record names the checkout the review was opened against",
    );
  } finally {
    db.close();
  }
});

// ── arm 5 ───────────────────────────────────────────────────────────────────
test("FG-649: a review whose persisted workspace was DELETED refuses by name and never touches cwd", () => {
  seedReview({
    id: "review-doomed",
    workspaceDir: doomedRepo,
    baseSha: workspaceBase,
    candidateSha: workspaceHead,
    verifiedEntryAt: workspaceHead,
  });
  rmSync(doomedRepo, { recursive: true, force: true });

  const cwdBefore = repoSignature(cwdRepo);
  const r = runForge(["review", "continue", "review-doomed"]);

  assert.notEqual(r.status, 0, "a missing workspace is a refusal, not a silent relocation");
  assert.match(r.stderr, /review_workspace_unusable/, "the refusal is NAMED");
  assert.match(r.stderr, /--project <dir>/, "and names the repair");
  assert.match(r.stderr, /Nothing was written/);
  assert.equal(repoSignature(cwdRepo), cwdBefore, "the repository the operator was standing in is untouched");
  assert.equal(reviewRow("review-doomed").workspace_dir, doomedRepo, "and the stale binding is not overwritten by a guess");
});

// ── arm 6 ───────────────────────────────────────────────────────────────────
test("FG-649: a directory INSIDE a worktree is not its root, and is refused rather than half-used", () => {
  seedReview({
    id: "review-subdir",
    workspaceDir: workspaceRepo,
    baseSha: workspaceBase,
    candidateSha: workspaceHead,
    verifiedEntryAt: workspaceHead,
  });
  const subdir = join(workspaceRepo, ".git");

  const r = runForge(["review", "continue", "review-subdir", "--project", subdir]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /review_workspace_unusable/);
  assert.equal(
    reviewRow("review-subdir").workspace_dir,
    workspaceRepo,
    "a refused override never becomes the recorded binding",
  );
});

// ── arm 6b (FG-649 / RF-3) ──────────────────────────────────────────────────
test("FG-649/RF-3: `continue --dry-run --project <dir>` previews without REBINDING the workspace", () => {
  // `--dry-run` is documented as "report the one valid next transition and exit without
  // running it". It built its deps first (deliberately, so the preview applies the same
  // checks the act does), and depsFor's workspace resolution RECORDED the flag — so a
  // documented preview permanently changed which repository every later stage, including the
  // coordinator's own git commit, writes into. The checks stay; only the write is dropped.
  seedReview({
    id: "review-dryrun",
    workspaceDir: workspaceRepo,
    baseSha: workspaceBase,
    candidateSha: workspaceHead,
    verifiedEntryAt: workspaceHead,
  });

  const preview = runForge(["review", "continue", "review-dryrun", "--dry-run", "--project", otherRepo]);
  assert.equal(preview.status, 0, `${preview.stdout}${preview.stderr}`);
  assert.match(preview.stdout, /next: /, "the preview still answers");
  assert.equal(
    reviewRow("review-dryrun").workspace_dir,
    workspaceRepo,
    "a preview does not rebind which repository later stages COMMIT into",
  );

  // The preview is still ABOUT the invocation it previews: the same --project checks apply,
  // so a dry run against an unusable dir refuses by name rather than quietly previewing
  // against the old binding.
  const bad = runForge(["review", "continue", "review-dryrun", "--dry-run", "--project", join(workspaceRepo, ".git")]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /review_workspace_unusable/);
  assert.equal(reviewRow("review-dryrun").workspace_dir, workspaceRepo);

  // And the act still binds — the write moved onto the acting path, it did not disappear.
  runForge(["review", "continue", "review-dryrun", "--project", otherRepo]);
  assert.equal(reviewRow("review-dryrun").workspace_dir, otherRepo, "the real invocation still RECORDS its override");
});

// ── arm 7 ───────────────────────────────────────────────────────────────────
test("FG-649: a legacy row with no workspace_dir and no adoptable run project_dir refuses unbound, writing nothing", () => {
  seedReview({
    id: "review-legacy-unbound",
    runId: "run-legacy-unbound",
    baseSha: workspaceBase,
    candidateSha: workspaceHead,
    verifiedEntryAt: workspaceHead,
  });

  const r = runForge(["review", "continue", "review-legacy-unbound"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /review_workspace_unbound/);
  assert.match(r.stderr, /--project <dir>/);
  assert.match(r.stderr, /Nothing was written/);

  const row = reviewRow("review-legacy-unbound");
  assert.equal(row.workspace_dir, null, "nothing was bound");
  assert.equal(row.state, "confirming_contract", "and the row was not parked mid-stage");
});

// ── arm 8 ───────────────────────────────────────────────────────────────────
test("FG-649: a legacy row whose run carries project_dir ADOPTS it and RECORDS what it adopted", () => {
  seedReview({
    id: "review-legacy-adopt",
    runId: "run-legacy-adopt",
    runProjectDir: runRepo,
    baseSha: workspaceBase,
    candidateSha: workspaceHead,
  });

  const r = runForge(["review", "continue", "review-legacy-adopt"]);
  assert.match(
    `${r.stdout}${r.stderr}`,
    new RegExp(`the workspace at ${runRepo} is on`),
    "the run's project dir is the legacy adoption source",
  );
  assert.equal(
    reviewRow("review-legacy-adopt").workspace_dir,
    runRepo,
    "an adoption is RECORDED, so the next invocation is bound rather than re-deriving",
  );
});

// ── arm 9 ───────────────────────────────────────────────────────────────────
// The additive migration, against a real pre-FG-649 `reviews` shape on disk.
test("FG-649: workspace_dir migrates onto a pre-FG-649 store additively, with no data loss", () => {
  const legacyPath = join(homeDir, "legacy.db");
  const legacy = new Database(legacyPath);
  legacy.exec(`
    CREATE TABLE reviews (
      id                     TEXT PRIMARY KEY,
      run_id                 TEXT,
      subject_task_id        TEXT,
      ticket_id              TEXT,
      base_sha               TEXT,
      contract_confirmed_sha TEXT,
      candidate_sha          TEXT,
      trusted_remote_sha     TEXT,
      contract_json          TEXT,
      lens_outcomes_json     TEXT,
      stage_evidence_json    TEXT,
      review_mode            TEXT NOT NULL DEFAULT 'evidence_led',
      state                  TEXT NOT NULL DEFAULT 'confirming_contract',
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      settled_at             TEXT
    );
  `);
  legacy
    .prepare(
      `INSERT INTO reviews (id, ticket_id, candidate_sha, review_mode, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("review-pre-fg649", "FG-600", "abc1234", "evidence_led", "settled", "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z");
  const columnsBefore = (legacy.pragma("table_info(reviews)") as { name: string }[]).map((c) => c.name);
  assert.equal(columnsBefore.includes("workspace_dir"), false, "precondition: the legacy shape has no workspace_dir");
  legacy.close();

  const migrated = new Database(legacyPath);
  try {
    migrated.exec(SCHEMA_SQL);
    applyMigrations(migrated);

    const columns = (migrated.pragma("table_info(reviews)") as { name: string }[]).map((c) => c.name);
    assert.ok(columns.includes("workspace_dir"), "the additive migration adds the column to an existing table");

    const row = migrated.prepare(`SELECT * FROM reviews WHERE id = ?`).get("review-pre-fg649") as Record<string, unknown>;
    assert.equal(row.ticket_id, "FG-600", "the pre-existing row survives");
    assert.equal(row.candidate_sha, "abc1234");
    assert.equal(row.state, "settled");
    assert.equal(row.workspace_dir, null, "and reads back NULL — the legacy shape continue adopts or refuses for");
    assert.equal(migrated.pragma("user_version", { simple: true }), 0, "no destructive boundary was crossed");
  } finally {
    migrated.close();
  }
});

// ── arms 10 and 11 ──────────────────────────────────────────────────────────
// IDENTITY, not string equality. A path that still exists can be a DIFFERENT repository than
// the one this review's run belongs to — re-cloned, or a scratch tree that happens to sit
// where the old checkout was. Since a stage now COMMITS in that directory, the ledger refuses
// where it can arbitrate: the run's project dir has a registered project_identity, and the
// proposed workspace's converging repository-evidence key is not that project's.
//
// The second arm is the non-vacuity half: with the same registry row present, the run's OWN
// repository resolves normally. A guard that refused both would be indistinguishable from a
// guard that refuses everything.
function registerProjectIdentity(dir: string, projectKey: string): void {
  const db = openStore();
  try {
    db.prepare(
      `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(projectKey, computeRepositoryEvidence(dir).key, "git-common-dir", "2026-07-30T00:00:00Z");
  } finally {
    db.close();
  }
}

test("FG-649: a --project that is a DIFFERENT registered repository than the run's refuses by name", () => {
  registerProjectIdentity(runRepo, "pk-fg649-run");
  seedReview({
    id: "review-identity",
    runId: "run-identity",
    runProjectDir: runRepo,
    workspaceDir: runRepo,
    baseSha: workspaceBase,
    candidateSha: workspaceHead,
  });

  const r = runForge(["review", "continue", "review-identity", "--project", otherRepo]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /review_workspace_identity_mismatch/, "the refusal is NAMED");
  assert.match(r.stderr, /pk-fg649-run/, "and names the project the run belongs to");
  assert.match(r.stderr, /Nothing was written/);
  assert.equal(
    reviewRow("review-identity").workspace_dir,
    runRepo,
    "a refused override never becomes the recorded binding",
  );
});

test("FG-649: the identity guard does NOT fire for the run's own repository", () => {
  const r = runForge(["review", "continue", "review-identity"]);
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /review_workspace_identity_mismatch/, "the registered repository is not refused");
  assert.match(out, new RegExp(`the workspace at ${runRepo} is on`), "it resolves and the stage proceeds normally");
});
