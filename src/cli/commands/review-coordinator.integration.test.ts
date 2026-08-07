// FG-639: `forge review start|continue` at the real process boundary.
//
// The unit tiers drive the stage machine in-process. This tier spawns the actual CLI,
// because the claims that matter here are process-level: the verbs EXIST on the real
// program, a missing or invalid review contract EXITS NON-ZERO and writes no review row,
// and `continue` reads the persisted stage from the on-disk store rather than from anything
// the process that opened the review was holding.
//
// It deliberately does NOT dispatch containers. `continue` is driven to the point where the
// next transition is read and reported; the stages that spawn reviewers, fixers and the
// rechecker are covered by src/v2/review-run.test.ts over injected runners, and by the live
// pilot. What this tier proves is that the operator surface and the durable store agree.
//
// The child goes through the FG-645 authority testkit seam (docs/how-to-testing.md):
// without it, a spawned forge inherits this process's backlog-authority signals and answers
// from a mounted snapshot instead of the fixture the test just built.
//
// FG-649: the parked review now carries a workspace_dir, and `continue` is driven with NO
// --project from a cwd (homeDir) that is not a git worktree at all — so every arm below is
// also evidence that the dispatch workspace comes from the review row rather than from the
// directory the process happens to run in. The unbound legacy shape (no workspace_dir, no
// adoptable run project_dir) gets its own arm, asserting the refusal BY NAME.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../../store/schema.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const localTsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

const CONTRACT = {
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["no partial write"],
  acceptance_refs: ["FG-639 AC 1"],
  risk_lenses: ["wide"],
  non_goals: ["protect the host from malicious candidate code"],
  lens_scopes: { wide: ["src/"] },
};

const PARKED_DIGEST = "shard-plan-1-parked";

let homeDir: string;
let repoDir: string;
let contractPath: string;
let badContractPath: string;

function runForge(args: string[]) {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: homeDir,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: homeDir, ...authorityTestkitEnv() },
  });
}

function openStore(): Database.Database {
  return new Database(join(homeDir, "forge.db"));
}

function reviewCount(): number {
  const db = openStore();
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM reviews`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** A review parked mid-lifecycle: verification and contract confirmation complete, discovery
 *  complete at the confirmed sha, one untriaged finding. This is the exact state an
 *  orchestrator crash leaves behind, written directly so the test asserts what `continue`
 *  READS rather than re-deriving it. */
function seedParkedReview(): void {
  const db = openStore();
  try {
    db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, review_mode) VALUES (?, ?, ?, ?, ?, ?)`).run(
      "run-parked",
      "feature",
      "parked",
      "active",
      "2026-07-30T00:00:00Z",
      "evidence_led",
    );
    db.prepare(
      `INSERT INTO reviews (id, run_id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha,
                            workspace_dir, contract_json, stage_evidence_json, lens_outcomes_json,
                            shard_plan_json, review_mode, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "review-parked",
      "run-parked",
      "FG-639",
      "base000",
      "conf222",
      "conf222",
      // FG-649: the review's OWN workspace binding. The run deliberately records no
      // project_dir, so this is the only thing that can answer "which checkout".
      repoDir,
      JSON.stringify(CONTRACT),
      JSON.stringify({
        verified_entry: { sha: "conf222", at: "2026-07-30T00:00:01Z" },
        contract_confirmed: { sha: "conf222", at: "2026-07-30T00:00:02Z" },
        discovery: { sha: "conf222", at: "2026-07-30T00:00:03Z" },
      }),
      // The per-lens outcome provenance a completed panel leaves behind. Recorded here for
      // the same reason the coordinator records it: the stage record says discovery ran, and
      // THIS says every selected lens authored an outcome. Either one alone would let an
      // incomplete panel read as complete.
      JSON.stringify([
        {
          lens: "wide",
          role: "red-wide",
          complete: true,
          outcome: "fail",
          authored: true,
          findings: [],
          taskId: "task-wide",
          // FG-689: WHICH shard of the lens's scope this outcome reviewed, and the partition
          // it was cut under. Without both, the outcome satisfies no shard of the plan below
          // and `continue` would correctly re-enter discovery instead of reading the parked
          // stage this test is about.
          shard: { index: 1, of: 1 },
          derivationDigest: PARKED_DIGEST,
        },
      ]),
      // FG-689: what discovery RECORDED AS OWED, written before its first container started.
      // A parked review with outcomes but no plan is a review whose expectation nobody wrote
      // down, and both the coordinator and the gate refuse it by name — so the crash-recovery
      // shape this fixture stands for has to carry one.
      JSON.stringify({
        derivation: {
          baseSha: "base000",
          candidateSha: "conf222",
          renderingId: "review-diff-1-parked",
          budget: 600_000,
          unit: "utf8_bytes",
          budgetValidatedRuntime: "unvalidated",
          scopesDigest: "scopes-parked",
        },
        digest: PARKED_DIGEST,
        fanoutWidth: 4,
        lenses: [{ lens: "wide", shards: [{ index: 1, of: 1, paths: ["src/a.ts"], chars: 120 }] }],
        skipped: [],
        recordedAt: "2026-07-30T00:00:03Z",
      }),
      "evidence_led",
      "discovering",
      "2026-07-30T00:00:00Z",
      "2026-07-30T00:00:03Z",
    );
    db.prepare(
      `INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, severity, risk_lens,
                                    reachability, evidence, sources_json, disposition, discovered_sha,
                                    created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untriaged', ?, ?, ?)`,
    ).run(
      "review-parked/RF-1",
      "review-parked",
      1,
      "RF-1",
      "the reconcile path can write partially",
      "high",
      "wide",
      "demonstrated",
      "src/a.ts:12 returns before the guard",
      JSON.stringify([{ redRole: "red-wide" }]),
      "conf222",
      "2026-07-30T00:00:03Z",
      "2026-07-30T00:00:03Z",
    );
  } finally {
    db.close();
  }
}

before(() => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg639-cli-"));
  const db = openStore();
  db.exec(SCHEMA_SQL);
  db.close();

  contractPath = join(homeDir, "contract.json");
  writeFileSync(contractPath, JSON.stringify(CONTRACT, null, 2));
  badContractPath = join(homeDir, "bad-contract.json");
  writeFileSync(badContractPath, JSON.stringify({ threat_model: "x", risk_lenses: ["wide"] }, null, 2));

  // A real repository with NO commit referencing the ticket under test: `start` now resolves
  // the comparison base before it writes anything, and this is the shape that cannot resolve.
  repoDir = mkdtempSync(join(tmpdir(), "forge-fg639-repo-"));
  const git = (args: string[]): void => void execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  git(["init", "-q"]);
  writeFileSync(join(repoDir, "README.md"), "fixture\n");
  git(["add", "README.md"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "chore: fixture base"]);

  seedParkedReview();
});

after(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

test("FG-639: `forge review` advertises start and continue alongside the FG-638 read/write verbs", () => {
  const r = runForge(["review", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  for (const verb of ["start", "continue", "show", "disposition"]) {
    assert.match(r.stdout, new RegExp(`\\b${verb}\\b`), `forge review must advertise ${verb}`);
  }
});

test("FG-639: `forge review start` without --contract exits non-zero and opens NO review", () => {
  const before = reviewCount();
  const r = runForge(["review", "start", "FG-639"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--contract <file> is required/);
  assert.match(r.stderr, /never reconstructed from prompts after the fact/);
  assert.match(r.stderr, /Nothing was written/);
  assert.equal(reviewCount(), before, "a refused start leaves the store exactly as it found it");
});

test("FG-639: `forge review start` with an INVALID contract exits non-zero and opens NO review", () => {
  const before = reviewCount();
  const r = runForge(["review", "start", "FG-639", "--contract", badContractPath]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /review contract invalid/);
  assert.match(r.stderr, /protected_invariants/);
  assert.equal(reviewCount(), before);
});

test("FG-639: `forge review start` refuses a --add-lens spec that carries no diff evidence", () => {
  const before = reviewCount();
  const r = runForge([
    "review",
    "start",
    "FG-639",
    "--contract",
    contractPath,
    "--add-lens",
    "security",
    "--project",
    homeDir,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--add-lens expects <lens>:<reason>:<diff-evidence>/);
  assert.match(r.stderr, /only with the evidence and reason that made it necessary/);
  assert.match(r.stderr, /Nothing was written/);
  assert.equal(r.stdout.includes("candidate"), false, "no candidate was resolved and no stage ran");
  assert.equal(reviewCount(), before, "every precondition is checked BEFORE the row exists");
});

test("FG-639: `forge review start` refuses AT OPEN when the comparison base cannot be inferred", () => {
  const before = reviewCount();
  const r = runForge(["review", "start", "FG-702", "--contract", contractPath, "--project", repoDir]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no commit subject in .* references FG-702/);
  assert.match(r.stderr, /--since <sha>/);
  assert.match(r.stderr, /Nothing was written/);
  assert.equal(reviewCount(), before, "a review that could never confirm its contract is never opened");
});

test("FG-674: planning-only ticket history refuses at the real CLI boundary and writes no review", () => {
  const repo = mkdtempSync(join(tmpdir(), "forge-fg674-planning-"));
  try {
    const g = (args: string[]): void => void execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo });
    g(["init", "-q"]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    g(["add", "README.md"]);
    g(["commit", "-q", "-m", "chore: fixture base"]);
    mkdirSync(join(repo, "backlog"));
    writeFileSync(join(repo, "backlog", "FG-674.md"), "planning only\n");
    g(["add", "backlog/FG-674.md"]);
    g(["commit", "-q", "-m", "FG-674: planning only"]);

    const before = reviewCount();
    const r = runForge(["review", "start", "FG-674", "--contract", contractPath, "--project", repo]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /every commit whose subject references FG-674.*changes only backlog\//);
    assert.match(r.stderr, /--since <sha>/);
    assert.match(r.stderr, /Nothing was written/);
    assert.equal(reviewCount(), before, "the resolver refuses before insertReview at the real process boundary");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// FG-674: the basis is operator-facing. A base an operator cannot explain is a base nobody
// checks — the incident's `note:` line about a widened range was easy to miss in a launch log.
test("FG-674: on a feature branch `forge review start` takes the BRANCH POINT and names the rule", () => {
  const repo = mkdtempSync(join(tmpdir(), "forge-fg674-branch-"));
  try {
    const g = (args: string[]): string =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        cwd: repo,
        encoding: "utf8",
      });
    g(["init", "-q"]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    g(["add", "README.md"]);
    g(["commit", "-q", "-m", "chore: fixture base"]);
    const defaultBranch = g(["symbolic-ref", "--short", "HEAD"]).trim();
    const branchPoint = g(["rev-parse", "HEAD"]).trim();

    g(["checkout", "-q", "-b", "feature/fg-674"]);
    writeFileSync(join(repo, "impl.ts"), "export const x = 1;\n");
    g(["add", "impl.ts"]);
    g(["commit", "-q", "-m", "FG-674: implement it"]);

    const r = runForge(["review", "start", "FG-674", "--contract", contractPath, "--project", repo]);
    assert.match(
      r.stdout,
      new RegExp(`base sha: ${branchPoint} \\(basis: merge-base with ${defaultBranch} `),
      `start must state WHICH rule produced the base:\n${r.stdout}\n${r.stderr}`,
    );
    assert.doesNotMatch(r.stdout, /inferred from the oldest commit/, "the branch point is not a text heuristic");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("FG-639 / PRD #15: `forge review continue` reads the PERSISTED next stage from the store", () => {
  const r = runForge(["review", "continue", "review-parked"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /await_disposition/,
    "discovery is complete at the confirmed sha, so the persisted next stage is the disposition stop",
  );
  assert.match(r.stdout, /RF-1/, "and it names the finding holding the review");
  assert.doesNotMatch(r.stdout, /discover:/, "continue never repeats a completed discovery");

  const db = openStore();
  try {
    const row = db.prepare(`SELECT state FROM reviews WHERE id = ?`).get("review-parked") as { state: string };
    assert.equal(row.state, "awaiting_disposition", "the durable state moved to the stop it reported");
  } finally {
    db.close();
  }
});

test("FG-639: `forge review continue` on an unknown review exits non-zero", () => {
  const r = runForge(["review", "continue", "review-nope"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no review review-nope/);
});

test("FG-639: the disposition stop is idempotent — continue at a stop reports it without advancing", () => {
  const first = runForge(["review", "continue", "review-parked"]);
  assert.equal(first.status, 0, first.stderr);
  const second = runForge(["review", "continue", "review-parked"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /await_disposition/);
});

test("FG-639: `forge review continue --json` emits the stage outcome as a machine-readable object", () => {
  const r = runForge(["review", "continue", "review-parked", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { transition: { kind: string; blockingFindings?: string[] }; status: string };
  assert.equal(parsed.transition.kind, "await_disposition");
  assert.equal(parsed.status, "stopped");
  assert.deepEqual(parsed.transition.blockingFindings, ["RF-1"]);
});

test("FG-639: --dry-run on an unknown review emits the SAME named refusal the real path does", () => {
  const dry = runForge(["review", "continue", "review-nope", "--dry-run"]);
  const real = runForge(["review", "continue", "review-nope"]);
  assert.notEqual(dry.status, 0, "the printed answer may not drift from the act");
  assert.match(dry.stderr, /no review review-nope/);
  assert.doesNotMatch(dry.stderr, /Not found:/, "never a raw Error out of the command action");
  assert.doesNotMatch(dry.stdout, /next:/, "there is no transition to preview");
  assert.equal(dry.stderr.trim(), real.stderr.trim(), "one refusal, one wording");
});

test("FG-639: --dry-run applies the SAME --add-lens validation the real path does", () => {
  const r = runForge(["review", "continue", "review-parked", "--dry-run", "--add-lens", "security"]);
  assert.notEqual(r.status, 0, "a preview that skipped the checks previews a different invocation");
  assert.match(r.stderr, /--add-lens expects <lens>:<reason>:<diff-evidence>/);
  assert.doesNotMatch(r.stdout, /next:/);
});

test("FG-639: --dry-run reports the one valid next transition without running it", () => {
  const r = runForge(["review", "continue", "review-parked", "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { transition: { kind: string }; status: string };
  assert.equal(parsed.status, "dry_run");
  assert.equal(parsed.transition.kind, "await_disposition");
});

test("FG-639: dispositioning the finding moves the persisted next stage to the batch fix", () => {
  const d = runForge([
    "review",
    "disposition",
    "review-parked/RF-1",
    "fix_now",
    "--rationale",
    "trust-gate write path — fix before advancing",
  ]);
  assert.equal(d.status, 0, d.stderr);

  // --dry-run, deliberately: the batch fix DISPATCHES a container, which this tier does not
  // do. What it asserts is the transition the coordinator would take, read from the store.
  const r = runForge(["review", "continue", "review-parked", "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { transition: { kind: string } };
  assert.equal(
    parsed.transition.kind,
    "batch_fix",
    "the ONE valid next transition after disposition is the single batch fix",
  );
});

// FG-649: the LEGACY shape — a row written before workspace_dir existed, whose run records
// no project_dir either. Nothing in the ledger can say which checkout its stages act on, and
// the directory the operator happens to be standing in is not an answer: since the
// coordinator COMMITS the fix cycle, guessing would be a write into an arbitrary repository.
// So `continue` refuses BY NAME and leaves the row exactly as it found it.
//
// RED baseline: with src/cli/commands/review.ts back at `resolve(opts.project ?? process.cwd())`
// this exits 0 and drives a stage against homeDir, which is not even a git worktree.
function seedUnboundReview(): void {
  const db = openStore();
  try {
    db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, review_mode) VALUES (?, ?, ?, ?, ?, ?)`).run(
      "run-unbound",
      "feature",
      "unbound",
      "active",
      "2026-07-30T00:00:00Z",
      "evidence_led",
    );
    db.prepare(
      `INSERT INTO reviews (id, run_id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha,
                            contract_json, stage_evidence_json, review_mode, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "review-unbound",
      "run-unbound",
      "FG-649",
      "base000",
      "conf222",
      "conf222",
      JSON.stringify(CONTRACT),
      JSON.stringify({ verified_entry: { sha: "conf222", at: "2026-07-30T00:00:01Z" } }),
      "evidence_led",
      "confirming_contract",
      "2026-07-30T00:00:00Z",
      "2026-07-30T00:00:01Z",
    );
  } finally {
    db.close();
  }
}

test("FG-649: `forge review continue` on a review with NO bound workspace refuses by name and writes nothing", () => {
  seedUnboundReview();

  const r = runForge(["review", "continue", "review-unbound"]);
  assert.notEqual(r.status, 0, "an unbound workspace is a refusal, not a cwd guess");
  assert.match(r.stderr, /review_workspace_unbound/, "the refusal is NAMED");
  assert.match(r.stderr, /--project <dir>/, "and it names the repair");
  assert.match(r.stderr, /Nothing was written/);
  assert.doesNotMatch(r.stdout, /verify_entry|confirm_contract/, "no stage ran");

  const db = openStore();
  try {
    const row = db
      .prepare(`SELECT state, workspace_dir FROM reviews WHERE id = ?`)
      .get("review-unbound") as { state: string; workspace_dir: string | null };
    assert.equal(row.state, "confirming_contract", "the refused invocation left the row where it was");
    assert.equal(row.workspace_dir, null, "and bound nothing behind the operator's back");
  } finally {
    db.close();
  }
});

test("FG-649: --dry-run refuses the SAME unbound workspace the real path does", () => {
  const dry = runForge(["review", "continue", "review-unbound", "--dry-run"]);
  const real = runForge(["review", "continue", "review-unbound"]);
  assert.notEqual(dry.status, 0, "a preview that skipped the workspace check previews a different invocation");
  assert.match(dry.stderr, /review_workspace_unbound/);
  assert.equal(dry.stderr.trim(), real.stderr.trim(), "one refusal, one wording");
});
