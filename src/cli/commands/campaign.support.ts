// FG-728 step 3: shared support module for the campaign.integration split. NOT a
// `*.integration.test.ts` file, so node:test does not collect it — it holds the
// helpers and the per-test lifecycle that campaign-a..d each import. runForge spawns
// the BUILT CLI (`node <builtEntry>`) through the shared FG-728 spawn authority
// instead of re-deriving tsx/entry. forgeHome/projectDir are exported `let`s
// reassigned by setup(): ESM live bindings let each split file reference them as
// bare identifiers exactly as the original single file did.

import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { setDbForTest } from "../../store/db.js";
import { insertHostVerification } from "../../store/host-verifications.js";
import { writeTicket } from "../../backlog/structured.js";
import { NODE_EXEC, BUILT_CLI_ENTRY } from "../../integration-cli-spawn.js";

export let forgeHome: string;
export let projectDir: string;

export function setup(): void {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-campaign-cli-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "forge-campaign-cli-proj-"));

  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    body: "",
    created: "2024-01-01",
  });
  writeTicket(projectDir, {
    id: "FG-102",
    type: "story",
    status: "active",
    title: "Story Two",
    body: "",
    created: "2024-01-02",
  });
  writeTicket(projectDir, {
    id: "FG-103",
    type: "story",
    status: "active",
    title: "Story Three",
    epic: "FG-100",
    body: "",
    created: "2024-01-03",
  });
  writeTicket(projectDir, {
    id: "FG-100",
    type: "epic",
    status: "active",
    title: "Test Epic",
    related: ["FG-103"],
    body: "",
  });
}

export function teardown(): void {
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}



// FG-442 finding 3: `campaign plan` refuses when no lane judgment is supplied
// (no --routes, no --default-lane). The overwhelming majority of tests in this
// file plan a campaign only as setup for testing unrelated behavior (approve,
// start, escalate-lane, reconcile, ...), so runForge auto-supplies a
// --default-lane for a bare `campaign plan` call unless the caller already
// passed --routes or --default-lane. Tests that exercise the lane-judgment
// requirement itself pass { rawPlan: true } to get the real, un-augmented CLI
// invocation.
export function runForge(args: string[], opts: { rawPlan?: boolean } = {}) {
  const isPlan = args[0] === "campaign" && args[1] === "plan";
  const hasLaneJudgment = args.includes("--routes") || args.includes("--default-lane");
  const finalArgs =
    isPlan && !opts.rawPlan && !hasLaneJudgment
      ? [...args, "--default-lane", "full_feature", "--default-lane-rationale", "test-harness default (FG-442 compat, unrelated to the behavior under test)"]
      : args;
  return spawnSync(NODE_EXEC, [BUILT_CLI_ENTRY, ...finalArgs], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}


/** Campaign fixtures must use the production writer, which derives the proven
 * project_dir_canonical identity instead of accidentally creating legacy rows. */
export function insertFixtureHostVerification(
  db: Database.Database,
  ticketId: string,
  commitSha: string,
  recordedAt = "2026-01-01T00:00:00Z",
): void {
  setDbForTest(db);
  insertHostVerification({
    ticketId,
    projectDir,
    commitSha,
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt,
  });
}


// ── FG-428: campaign reconcile ──────────────────────────────────────────────────

export function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}


export function makeCommitIn(dir: string, label: string): string {
  writeFileSync(join(dir, `${label}.txt`), label);
  gitExec(["add", "."], dir);
  gitExec(["commit", "-m", label], dir);
  return gitExec(["rev-parse", "HEAD"], dir).trim();
}


// ── FG-443: campaign reconcile — out-of-band (awaiting_gate/non-pipeline) completion path ──
//
// Real CLI-subprocess coverage for the branch reconcile.ts added alongside the existing
// scope-blocked path above: an item parked at lifecycle_status='awaiting_gate' with no
// blocker_kind (the ONLY shape executor.ts's gate:human path produces — e.g. an item
// re-routed to a non-pipeline lane whose ticket shipped outside the feature run). The
// unit/direct-import tests for this path already live in reconcile.integration.test.ts
// and report.integration.test.ts; these tests prove the same behavior holds through the actual
// `forge campaign reconcile|show|report` commands, spawned as real child processes
// against the on-disk forge.db — the operator's actual interface.

export function commitFileIn(dir: string, relPath: string, content: string, message: string): string {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  gitExec(["add", "."], dir);
  gitExec(["commit", "-m", message], dir);
  return gitExec(["rev-parse", "HEAD"], dir).trim();
}


// Plans + approves a single-item paused campaign whose item is forced into the ONLY
// shape executor.ts's gate:human path produces: lifecycle_status='awaiting_gate' with
// no blocker_kind. Distinct from setupReconcileCliCampaign/setupSingleItemReconcileCliCampaign
// above, which always set blocker_kind='scope' — that field's absence is exactly what
// routes an item to FG-443's out-of-band branch instead of the FG-428 scope-blocked one.
export function setupOutOfBandCliCampaign(ticketId: string): { campaignId: string; itemId: string } {
  writeTicket(projectDir, { id: ticketId, type: "story", status: "active", title: "Out of band", body: "" });

  const planResult = runForge([
    "campaign", "plan",
    "--tickets", ticketId,
    "--project", projectDir,
    "--json",
  ]);
  assert.equal(planResult.status, 0, `plan failed\nstderr: ${planResult.stderr}`);
  const planOutput = JSON.parse(planResult.stdout) as { campaignId: string };

  const approveResult = runForge(["campaign", "approve", planOutput.campaignId, "--rationale", "approved"]);
  assert.equal(approveResult.status, 0, `approve failed\nstdout: ${approveResult.stdout}\nstderr: ${approveResult.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath);
  const item = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .get(planOutput.campaignId) as { id: string };

  db.prepare(
    "UPDATE campaign_items SET lifecycle_status = 'awaiting_gate', outcome = NULL, blocker_kind = NULL, requested_human_action = 'Human gate required at step review' WHERE id = ?"
  ).run(item.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(planOutput.campaignId);
  db.close();

  return { campaignId: planOutput.campaignId, itemId: item.id };
}


// ── FG-440: automatic host-verification capture — real CLI-subprocess coverage ──
//
// Everything above exercises reconcileCampaign()/collectReconcileEvidence() as
// directly-imported functions (reconcile.integration.test.ts) or the CLI with a
// PRE-SEEDED host_verifications row (setupReconcileCliCampaign above). Neither
// proves the actual operator entrypoint — `forge campaign reconcile`, spawned as
// a real child process — performs the REAL gate run itself: writes package.json
// into the real (temp) projectDir, spawns `forge campaign reconcile` as a
// separate process, and lets it invoke `npm run test:all` for real. This is the
// FG-440 anti-spoofing proof end-to-end, not just at the function seam. It also
// proves the two-way reason-code split (host_verification_not_recorded vs
// host_verification_recorded_but_failed) renders correctly on both the raw JSON
// path (campaign.ts's `--json` branch, which must NOT run codes through
// describeMissingReason) and the human path (which must).

export function commitGateScriptIn(dir: string, label: string, scriptBody: string): string {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "synthetic", version: "0.0.0", scripts: { "test:all": scriptBody } }, null, 2)
  );
  writeFileSync(join(dir, `${label}.txt`), label);
  gitExec(["add", "."], dir);
  gitExec(["commit", "-m", label], dir);
  return gitExec(["rev-parse", "HEAD"], dir).trim();
}


export function commitPendingChangesIn(dir: string, message: string): string {
  gitExec(["add", "."], dir);
  gitExec(["commit", "-m", message], dir);
  return gitExec(["rev-parse", "HEAD"], dir).trim();
}
