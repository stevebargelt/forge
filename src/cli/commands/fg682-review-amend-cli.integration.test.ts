// FG-682 (step 5): `forge review amend-docs <review-id>` — the coordinator verb that amends a
// documentation-only correction discovered AFTER the docs stage into the review's candidate.
//
// This tier spawns the REAL CLI at the process boundary (the FG-649 review-workspace pattern:
// spawnSync the actual program, FORGE_HOME on a temp store, the FG-645 authority testkit seam)
// against a REAL git repository whose worktree holds the correction. It dispatches NO containers:
// the amendment's commit + advance are the coordinator's own git and ledger writes, so they run
// to completion here without a reviewer.
//
// The acceptance it proves (step 5):
//   - `amend-docs <id> --path <doc> --rationale <text>` amends the correction into the candidate
//     and ADVANCES it (the COORDINATOR commits — AC3), writing the amendment ledger record (AC6);
//   - `--path <source-or-config-file>` is REFUSED BY NAME with a non-zero exit and NOTHING written
//     (the candidate is unmoved, no amendment record) — AC2;
//   - an absent `--rationale` is the named refusal too, since the CLI keeps no second copy of the
//     amendment authority — runDocsAmendment owns it.
//
// RED baseline: delete the `amend-docs` subcommand from registerReview (src/cli/commands/review.ts)
// and every arm reddens — commander exits non-zero with "unknown command" and no candidate moves.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../store/schema.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

const CONTRACT = {
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["the amendment moves only declared documentation"],
  acceptance_refs: ["FG-682"],
  risk_lenses: ["wide"],
  non_goals: ["a general re-anchor of the candidate to HEAD"],
  lens_scopes: { wide: ["src/"] },
};

const DOC_PATH = "docs/SCHEMA-CONTRACT.md";
const SOURCE_PATH = "src/resolver.ts";
const CONFIG_PATH = "package.json";

let homeDir: string;
let repo: string;
/** The candidate the review is pinned to — the head of the repo when a review opens. */
let candidate: string;

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function openStore(): Database.Database {
  return new Database(join(homeDir, "forge.db"));
}

function runForge(args: string[]) {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: homeDir, ...authorityTestkitEnv() },
  });
}

/** Seed a review PAST DISCOVERY and past the docs stage, pinned to `candidate` — the exact
 *  precondition the amendment is bounded to. contract_confirmed_sha == candidate here, so
 *  discovery is complete at the confirmed sha and the review is eligible. */
function seedReview(id: string): void {
  const db = openStore();
  try {
    const stageEvidence = JSON.stringify({
      verified_entry: { sha: candidate, at: "2026-08-05T00:00:00Z" },
      contract_confirmed: { sha: candidate, at: "2026-08-05T00:00:01Z" },
      discovery: { sha: candidate, at: "2026-08-05T00:00:02Z" },
      docs: { sha: candidate, at: "2026-08-05T00:00:03Z", meta: { operator_behavior_changed: false } },
    });
    db.prepare(
      `INSERT INTO reviews (id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha,
                            workspace_dir, contract_json, stage_evidence_json, review_mode, state,
                            created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "FG-682",
      candidate,
      candidate,
      candidate,
      repo,
      JSON.stringify(CONTRACT),
      stageEvidence,
      "evidence_led",
      "confirming_contract",
      "2026-08-05T00:00:00Z",
      "2026-08-05T00:00:03Z",
    );
  } finally {
    db.close();
  }
}

function reviewRow(id: string): { candidate_sha: string | null; lens_outcomes_json: string | null } {
  const db = openStore();
  try {
    return db.prepare(`SELECT candidate_sha, lens_outcomes_json FROM reviews WHERE id = ?`).get(id) as {
      candidate_sha: string | null;
      lens_outcomes_json: string | null;
    };
  } finally {
    db.close();
  }
}

function amendmentRecords(id: string): unknown[] {
  const raw = reviewRow(id).lens_outcomes_json;
  if (raw === null) return [];
  const all = JSON.parse(raw) as { kind?: string }[];
  return all.filter((r) => r.kind === "docs_amendment");
}

before(() => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg682-home-"));
  const db = openStore();
  db.exec(SCHEMA_SQL);
  db.close();

  repo = mkdtempSync(join(tmpdir(), "forge-fg682-repo-"));
  git(repo, ["init", "-q"]);
  // Local identity, so the COORDINATOR's own `git commit` (which runs without -c overrides)
  // has an author in this scratch repo.
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);

  mkdirSync(join(repo, "docs"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, DOC_PATH),
    "# Schema contract\n\nThe dependencyEnvironment receipt exists because a writable invoke and a\n" +
      "read-write non-worktree dispatch cross the same resolver as a reviewer.\n",
  );
  writeFileSync(join(repo, SOURCE_PATH), "export const resolve = () => 1;\n");
  writeFileSync(join(repo, CONFIG_PATH), '{"name":"x","version":"1.0.0"}\n');
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "FG-682: candidate implementation"]);
  candidate = git(repo, ["rev-parse", "HEAD"]).trim();
});

after(() => {
  for (const dir of [homeDir, repo]) rmSync(dir, { recursive: true, force: true });
});

// ── arm 1 ─────────────────────────────────────────────────────────────────────
// The happy path: a three-line prose correction sits in the worktree; the verb commits ONLY the
// declared documentation and advances the candidate, and the amendment ledger record preserves
// the superseded->amended lineage and the rationale.
test("FG-682: amend-docs commits the declared doc and advances the candidate, recording the lineage", () => {
  seedReview("review-amend-ok");

  // The FG-678 shape: a prose statement the batch falsified, corrected in place.
  writeFileSync(
    join(repo, DOC_PATH),
    "# Schema contract\n\nThe dependencyEnvironment receipt was removed: all three dispatch lanes now\n" +
      "cross one shared resolver, so the receipt no longer distinguishes them.\n",
  );

  const r = runForge([
    "review",
    "amend-docs",
    "review-amend-ok",
    "--path",
    DOC_PATH,
    "--rationale",
    "the batch collapsed all three lanes into one resolver, falsifying the receipt prose",
    "--discovered-by",
    "orchestrator",
  ]);
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /amended/, "the outcome names the amendment");
  assert.match(out, new RegExp(DOC_PATH.replace(".", "\\.")), "and reports the committed documentation path");

  const row = reviewRow("review-amend-ok");
  assert.ok(row.candidate_sha && row.candidate_sha !== candidate, "the candidate ADVANCED off the superseded sha");
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), row.candidate_sha, "the coordinator's commit IS the new head");

  // Exactly the declared doc landed in the amendment commit — nothing swept in.
  const committed = git(repo, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").filter(Boolean);
  assert.deepEqual(committed, [DOC_PATH], "the commit carries only the declared documentation");
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "", "the worktree is clean after the coordinator committed");

  const records = amendmentRecords("review-amend-ok") as {
    supersededSha: string;
    amendedSha: string;
    paths: string[];
    rationale: string;
    discoveredBy: string;
  }[];
  assert.equal(records.length, 1, "one amendment record, the durable home of the lineage (AC6)");
  const rec = records[0]!;
  assert.equal(rec.supersededSha, candidate, "lineage: the superseded candidate");
  assert.equal(rec.amendedSha, row.candidate_sha, "lineage: the amended candidate");
  assert.deepEqual(rec.paths, [DOC_PATH], "the record names exactly what moved");
  assert.match(rec.rationale, /falsifying the receipt/, "the rationale is preserved verbatim");
  assert.equal(rec.discoveredBy, "orchestrator", "and who discovered it");
});

// ── arm 2 ─────────────────────────────────────────────────────────────────────
// A declared SOURCE path is refused BY NAME before any git write — nothing recorded, candidate
// unmoved (AC2). Even with the source file dirty, the classifier refuses it as non-documentation.
test("FG-682: amend-docs refuses a declared SOURCE path by name, writing nothing", () => {
  seedReview("review-amend-src");
  writeFileSync(join(repo, SOURCE_PATH), "export const resolve = () => 2; // edited\n");

  const before = reviewRow("review-amend-src").candidate_sha;
  const r = runForge([
    "review",
    "amend-docs",
    "review-amend-src",
    "--path",
    SOURCE_PATH,
    "--rationale",
    "trying to sneak a code change through a docs-only verb",
  ]);
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, "a non-documentation declaration is a refusal, not a silent commit");
  assert.match(out, /docs_amendment_path_not_documentation/, "the refusal is NAMED");
  assert.match(out, new RegExp(SOURCE_PATH.replace(".", "\\.")), "and names the offending path");

  assert.equal(reviewRow("review-amend-src").candidate_sha, before, "the candidate is UNMOVED");
  assert.equal(amendmentRecords("review-amend-src").length, 0, "and nothing was recorded");
  // Reset the worktree so later arms start clean.
  git(repo, ["checkout", "--", SOURCE_PATH]);
});

// ── arm 3 ─────────────────────────────────────────────────────────────────────
// A declared CONFIG path is refused the same way — code, tests AND config all refuse by name.
test("FG-682: amend-docs refuses a declared CONFIG path by name, writing nothing", () => {
  seedReview("review-amend-cfg");
  writeFileSync(join(repo, CONFIG_PATH), '{"name":"x","version":"1.0.1"}\n');

  const before = reviewRow("review-amend-cfg").candidate_sha;
  const r = runForge([
    "review",
    "amend-docs",
    "review-amend-cfg",
    "--path",
    CONFIG_PATH,
    "--rationale",
    "config is not documentation",
  ]);
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0);
  assert.match(out, /docs_amendment_path_not_documentation/, "config refuses by name");
  assert.equal(reviewRow("review-amend-cfg").candidate_sha, before, "the candidate is UNMOVED");
  assert.equal(amendmentRecords("review-amend-cfg").length, 0, "and nothing was recorded");
  git(repo, ["checkout", "--", CONFIG_PATH]);
});

// ── arm 4 ─────────────────────────────────────────────────────────────────────
// An absent --rationale is the named refusal too: the CLI keeps no second copy of the amendment
// authority, so runDocsAmendment's docs_amendment_no_rationale surfaces verbatim.
test("FG-682: amend-docs refuses when --rationale is absent, writing nothing", () => {
  seedReview("review-amend-norationale");
  writeFileSync(join(repo, DOC_PATH), "# Schema contract\n\nA correction with no stated reason.\n");

  const before = reviewRow("review-amend-norationale").candidate_sha;
  const r = runForge(["review", "amend-docs", "review-amend-norationale", "--path", DOC_PATH]);
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, "a rationale-less amendment is refused");
  assert.match(out, /docs_amendment_no_rationale/, "the refusal is NAMED");
  assert.equal(reviewRow("review-amend-norationale").candidate_sha, before, "the candidate is UNMOVED");
  assert.equal(amendmentRecords("review-amend-norationale").length, 0, "and nothing was recorded");
  git(repo, ["checkout", "--", DOC_PATH]);
});
