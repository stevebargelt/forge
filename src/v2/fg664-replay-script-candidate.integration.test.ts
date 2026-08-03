// FG-664 AC 4 — the guard on `--candidate` in the operator evidence harness
// `scripts/fg664-recheck-replay.sh`.
//
// WHY THE FLAG EXISTS. The AC 4 amendment requires an end-to-end recheck on a
// review whose findings are genuinely `fix_now`. The harness pinned FG-662's
// candidate with no override, so it refused every such review — correctly, since
// a recheck at another candidate is not evidence about this one, but with no way
// to tell it which candidate it is proving.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. Nothing here dispatches an agent
// container (no daemon in any tier — the FG-621 smoke-script precedent). What is
// provable, and what the amendment depends on, is that the flag SELECTS the
// asserted candidate without RELAXING the assertion: a malformed or non-commit
// value is refused, a value that disagrees with the review's recorded candidate
// is still refused, and omitting the flag still runs against FG-662's pinned sha.
//
// Tier: integration. It drives the real script as a subprocess and builds a real
// git repo, both banned from the unit tier by src/test-tiers.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "fg664-recheck-replay.sh");

/** The sha the script has always run against. Written out here so a change to the
 *  default has to change this file too — the amendment is explicit that every
 *  existing invocation must behave exactly as it does now. */
const PINNED_DEFAULT = "593f88bad31813383c53c42a27fd9ef095759db8";

const REVIEW_ID = "review-fg664-replay-guard";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** A throwaway checkout with two commits, so a test can hand the script both a
 *  candidate the review is bound to and one it is not — each a real commit
 *  object, which is what keeps the refusal about the BINDING rather than about a
 *  sha git could not resolve. */
function makeRepo(): { dir: string; first: string; second: string } {
  const dir = makeTmpDir("fg664-replay-repo-");
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fg664",
        GIT_AUTHOR_EMAIL: "fg664@example.invalid",
        GIT_COMMITTER_NAME: "fg664",
        GIT_COMMITTER_EMAIL: "fg664@example.invalid",
      },
    }).trim();

  git("init", "--quiet", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "--quiet", "-m", "one");
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "a.txt"), "two\n");
  git("add", "a.txt");
  git("commit", "--quiet", "-m", "two");
  const second = git("rev-parse", "HEAD");
  return { dir, first, second };
}

/** A ledger holding exactly the columns the harness reads, with one review bound
 *  to `candidateSha` and one `fix_now` finding per AC 4 ref. Deliberately not the
 *  full schema: the harness opens the store read-only with its own driver, so the
 *  columns it names are the whole contract this file needs to honour. */
function makeLedger(candidateSha: string, opts: { confirmedSha?: string } = {}): string {
  const dir = makeTmpDir("fg664-replay-db-");
  const path = join(dir, "forge.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE reviews (
      id TEXT PRIMARY KEY,
      state TEXT,
      candidate_sha TEXT,
      contract_confirmed_sha TEXT,
      workspace_dir TEXT,
      ticket_id TEXT,
      run_id TEXT,
      settled_at TEXT,
      stage_evidence_json TEXT,
      lens_outcomes_json TEXT
    );
    CREATE TABLE review_findings (
      review_id TEXT,
      finding_ref TEXT,
      ordinal INTEGER,
      summary TEXT,
      disposition TEXT,
      resolution TEXT,
      resolution_evidence_kind TEXT,
      resolution_evidence TEXT,
      resolved_sha TEXT
    );
  `);
  db.prepare(
    `INSERT INTO reviews (id, state, candidate_sha, contract_confirmed_sha, workspace_dir, ticket_id, run_id, stage_evidence_json, lens_outcomes_json)
     VALUES (?, 'settled', ?, ?, '', 'FG-664', 'run-fg664', '{}', '[]')`,
  ).run(REVIEW_ID, candidateSha, opts.confirmedSha ?? "");
  const insert = db.prepare(
    `INSERT INTO review_findings (review_id, finding_ref, ordinal, summary, disposition) VALUES (?, ?, ?, ?, 'fix_now')`,
  );
  ["RF-1", "RF-3", "RF-4"].forEach((ref, i) => insert.run(REVIEW_ID, ref, i, `${ref} summary`));
  db.close();
  return path;
}

type Run = { status: number | null; out: string };

function runScript(args: string[]): Run {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ── the default is unchanged ─────────────────────────────────────────────────

test("fg664 replay harness: omitting --candidate still runs against the pinned FG-662 candidate", () => {
  const repo = makeRepo();
  // The temp checkout cannot contain FG-662's candidate, so the pinned default is
  // what the candidate assertion names — which is the observable proof that the
  // default did not move.
  const r = runScript(["--project-dir", repo.dir]);
  assert.notEqual(r.status, 0, "a missing candidate is never a pass");
  assert.match(r.out, new RegExp(`candidate ${PINNED_DEFAULT} is NOT present`), r.out);
});

// ── a supplied candidate is VALIDATED ────────────────────────────────────────

test("fg664 replay harness: --candidate needs a value", () => {
  const r = runScript(["--candidate"]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /--candidate needs a value/, r.out);
});

test("fg664 replay harness: a malformed --candidate is refused as malformed, before anything is asked of git", () => {
  for (const bad of ["HEAD", "not-a-sha", "593F88BAD31813383C53C42A27FD9EF095759DB8", "../etc/passwd"]) {
    const r = runScript(["--candidate", bad]);
    assert.notEqual(r.status, 0, `${bad} must be refused`);
    assert.match(r.out, /is not a sha: expected 40 \(or 64\) lowercase hex/, `${bad}: ${r.out}`);
  }
});

test("fg664 replay harness: an ABBREVIATED sha is refused — the binding check compares strings, so it could never match", () => {
  const r = runScript(["--candidate", "593f88b"]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /is 7 characters; a FULL 40- or 64-character sha is required/, r.out);
});

test("fg664 replay harness: a well-formed --candidate that is not a commit in the checkout is refused", () => {
  const repo = makeRepo();
  const unknown = "0".repeat(39) + "1";
  const r = runScript(["--project-dir", repo.dir, "--candidate", unknown]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, new RegExp(`candidate ${unknown} is NOT present`), r.out);
  assert.doesNotMatch(r.out, new RegExp(PINNED_DEFAULT), "the supplied value is what gets asserted, not the default");
});

// ── the flag SELECTS the assertion; it does not disable it ───────────────────

test("fg664 replay harness: a --candidate that disagrees with the review's recorded candidate STILL refuses", () => {
  const repo = makeRepo();
  const db = makeLedger(repo.first);
  const r = runScript(["--project-dir", repo.dir, "--db", db, "--review", REVIEW_ID, "--candidate", repo.second]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, new RegExp(`bound to candidate ${repo.first}, not ${repo.second}`), r.out);
  assert.match(r.out, /REFUSING to replay/, r.out);
});

test("fg664 replay harness: a valid --candidate the review IS bound to is accepted, and the run proceeds to the next assertion", () => {
  const repo = makeRepo();
  const db = makeLedger(repo.second);
  const r = runScript(["--project-dir", repo.dir, "--db", db, "--review", REVIEW_ID, "--candidate", repo.second]);
  // Accepted means it got PAST the candidate identity and the review binding —
  // the next unmet prerequisite (this fixture records no contract-confirmed sha)
  // is what it stops on, and it is not about the candidate.
  assert.doesNotMatch(r.out, /is NOT present/, r.out);
  assert.doesNotMatch(r.out, /REFUSING to replay/, r.out);
  assert.match(r.out, /records no contract-confirmed sha/, r.out);
});

// ── documented ───────────────────────────────────────────────────────────────

test("fg664 replay harness: --help documents --candidate beside the other flags", () => {
  const r = runScript(["--help"]);
  assert.match(r.out, /\[--candidate SHA\]/, r.out);
  assert.match(r.out, /^#\s+--candidate\s+the candidate sha this replay is proving/m, r.out);
  for (const flag of ["--project-dir", "--review", "--db", "--route", "--image"]) {
    assert.match(r.out, new RegExp(`^#\\s+${flag}\\s`, "m"), `${flag} must still be documented`);
  }
  assert.match(r.out, new RegExp(PINNED_DEFAULT), "the help states the unchanged default");
});
