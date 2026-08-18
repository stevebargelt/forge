// FG-608 (FG-496 Slice C): the campaign directory guards.
//
// The ticket body asked for these guards to be CONVERTED from filesystem probes
// to store questions. That conversion already landed with FG-607 — `hasBacklog`
// in executor.ts is a one-line delegate to projectHasBacklog(), and report.ts /
// campaign.ts call projectHasBacklog() directly. What FG-608 owes is therefore
// VERIFICATION plus a lock, and the lock has two halves:
//
//   1. the STORE half — a db-mode project with no backlog/ directory on disk is
//      admitted by every guard (campaignBlocker at both the start and the resume
//      site, computeCurrentPlanHash, and the `forge campaign approve` CLI guard).
//      This is the AC "campaign planning, review-loop, and shipping-reviewer read
//      DB tickets (inherited from Slice B; verified here)".
//
//   2. the LIVENESS half — every one of those guards is written
//      `if (!existsSync(dir) || !projectHasBacklog(dir))`, and the existsSync()
//      operand is NOT a leftover from the pre-FG-607 shape. It answers a
//      different question: does the campaign's RECORDED projectDir still exist on
//      this host (cf. src/v2/retry.ts:242, a campaign whose directory was
//      deleted). Collapsing it into the store check would let a campaign proceed
//      against a vanished directory, because in db mode projectHasBacklog()
//      answers `true` for a directory that is no longer there at all — which the
//      first test below asserts directly.
//
// The final test is a source-level assertion that pins all four guard sites, so a
// future "cleanup" that drops the existsSync() operand fails here rather than
// silently re-opening the vanished-directory hole.
//
// Which cases actually CATCH that cleanup — measured by deleting the existsSync()
// operand from all four sites and re-running this file:
//   - "vanished projectDir ... in DB mode" FAILS (behavioural proof), and
//   - the source-level guard FAILS (all four sites).
//   - the MARKDOWN vanished case and the CLI vanished case still PASS. They are
//     controls, not detectors: in markdown mode projectHasBacklog() itself falls
//     back to existsSync(<dir>/backlog), and a deleted git checkout loses its
//     git-common-dir evidence so the registry stops resolving it to db. Don't
//     mistake either for the lock — the two above are the lock.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { setStorageMode } from "../store/tickets.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "../backlog/container-authority.testkit-spawn.js";
import {
  computeRepositoryEvidence,
  resolveAndClaimProjectKey,
} from "../store/project-registry.js";
import { clearBacklogStoreCache, projectHasBacklog, resolveBacklogStore } from "../backlog/storage-mode.js";
import { writeTicket } from "../backlog/structured.js";
import {
  approveCampaign,
  listCampaignItems,
  tryTransitionCampaignToRunning,
  updateCampaignStatus,
} from "../store/campaigns.js";
import { planCampaign } from "./planner.js";
import { campaignBlocker } from "./executor.js";
import { assembleCampaignShow } from "./report.js";
import type { Campaign } from "../types/index.js";
import { getCampaign } from "../store/campaigns.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";

const NOW = "2026-07-29T00:00:00Z";
const BODY =
  "## Problem\nSomething is broken.\n\n## Goal\nFix it.\n\n## Acceptance Criteria\n- The fix is covered by a test.\n";

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
  clearBacklogStoreCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A plain (non-git) directory: repositoryCheckoutIdentity resolves it on the
// `path` rung, whose evidence key is derived from the canonical path alone. That
// matters for the vanished-directory case below — the key is unchanged after the
// directory is deleted, so the registry keeps answering `db` and the store check
// alone would still admit the campaign.
function newProject(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `fg608-${label}-`)));
  dirs.push(dir);
  return dir;
}

function seedCommittedKey(projectDir: string, projectKey: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `project_key: ${projectKey}\nbacklog:\n  prefix: FG\n`);
}

// Register this dir's REAL repository evidence to a key, exactly as an import
// would — without the resolver being involved.
function registerEvidence(projectDir: string, projectKey: string): void {
  const evidence = computeRepositoryEvidence(projectDir);
  writeTransaction(() =>
    resolveAndClaimProjectKey({
      evidenceKey: evidence.key,
      evidenceSource: evidence.source,
      configKey: projectKey,
      createdAt: NOW,
    }),
  );
}

/** A db-mode project with NO backlog/ directory: the post-cutover shape. */
function dbModeProject(label: string, projectKey: string): string {
  const dir = newProject(label);
  seedCommittedKey(dir, projectKey);
  registerEvidence(dir, projectKey);
  setStorageMode(projectKey, "db", NOW);
  clearBacklogStoreCache();

  writeTicket(dir, {
    id: "FG-1",
    type: "story",
    status: "active",
    title: "a db-mode story",
    created: "2026-01-01",
    body: BODY,
  });
  assert.equal(existsSync(join(dir, "backlog")), false, "the fixture must have no backlog/ directory");
  return dir;
}

/** A never-imported markdown project — the default path, as a control. */
function markdownProject(label: string): string {
  const dir = newProject(label);
  const stories = join(dir, "backlog", "stories");
  mkdirSync(stories, { recursive: true });
  writeFileSync(
    join(stories, "FG-1-a-story.md"),
    `---\nid: FG-1\ntype: story\nstatus: active\ntitle: a markdown story\n---\n\n${BODY}`,
  );
  return dir;
}

function plannedApprovedCampaign(projectDir: string): Campaign {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-1"] },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "FG-608 dir-guard fixture" });
  return getCampaign(campaign.id)!;
}

function pause(campaignId: string): Campaign {
  tryTransitionCampaignToRunning(campaignId);
  updateCampaignStatus(campaignId, "paused");
  return getCampaign(campaignId)!;
}

// ── The store half: db mode with no backlog/ directory is admitted ────────────

test("integ FG-608: campaignBlocker(start) admits a db-mode project with no backlog/ directory", () => {
  const dir = dbModeProject("start", "pk-fg608-start");
  const campaign = plannedApprovedCampaign(dir);

  const blocker = campaignBlocker(campaign, listCampaignItems(campaign.id), "start");
  assert.notEqual(
    blocker,
    "invalid_project_dir",
    "a db-mode project legitimately has no backlog/ directory — the guard must ask the store",
  );
  assert.equal(blocker, null, "nothing else should block this campaign either");
});

test("integ FG-608: campaignBlocker(resume) admits a db-mode project with no backlog/ directory", () => {
  const dir = dbModeProject("resume", "pk-fg608-resume");
  const planned = plannedApprovedCampaign(dir);
  const campaign = pause(planned.id);

  const blocker = campaignBlocker(campaign, listCampaignItems(campaign.id), "resume");
  assert.notEqual(blocker, "invalid_project_dir", "the resume site must ask the store too");
  assert.equal(blocker, null);
});

// computeCurrentPlanHash() is module-private in report.ts; `currentPlanHash` on
// the show/report results is its only surface. Before FG-607 it probed the
// filesystem and silently returned null for a db-mode project — an empty report
// with no error, which is exactly the failure this pins.
test("integ FG-608: computeCurrentPlanHash returns a real hash for a db-mode project with no backlog/ directory", () => {
  const dir = dbModeProject("hash", "pk-fg608-hash");
  const campaign = plannedApprovedCampaign(dir);

  const show = assembleCampaignShow(campaign.id)!;
  assert.ok(show, "show must assemble");
  assert.ok(
    show.currentPlanHash,
    "currentPlanHash must be a real hash, not the silent null a filesystem probe produced",
  );
  assert.equal(show.currentPlanHash, campaign.approvedPlanHash);
  assert.equal(show.planStale, false);
});

// ── The liveness half: a vanished projectDir still rejects, in BOTH modes ─────

// The discriminating case. The registry keeps answering `db` for a directory that
// no longer exists, so projectHasBacklog() answers TRUE for it: only the
// existsSync() operand can reject a vanished projectDir.
test("integ FG-608: a vanished projectDir yields invalid_project_dir in DB mode — store check alone would admit it", () => {
  const dir = dbModeProject("gone-db", "pk-fg608-gone-db");
  // Two snapshots of ONE campaign: `planned` is the start site's precondition,
  // `paused` the resume site's. campaignBlocker rejects on status before it ever
  // reaches the directory guard, so a single snapshot can only prove one of them.
  const planned = plannedApprovedCampaign(dir);
  const paused = pause(planned.id);

  rmSync(dir, { recursive: true, force: true });
  clearBacklogStoreCache();
  assert.equal(existsSync(dir), false);

  // The premise: the store still calls this project db-mode, and the store
  // question alone says it has a backlog.
  assert.equal(resolveBacklogStore(dir).mode, "db", "the registry must still resolve the deleted checkout to db");
  assert.equal(
    projectHasBacklog(dir),
    true,
    "in db mode the store answers `has a backlog` for a directory that is GONE — " +
      "collapsing the guards into this check would let a campaign run against a vanished projectDir",
  );

  assert.equal(
    campaignBlocker(planned, listCampaignItems(planned.id), "start"),
    "invalid_project_dir",
    "the host-path liveness check must reject regardless of what the store says",
  );
  assert.equal(
    campaignBlocker(paused, listCampaignItems(paused.id), "resume"),
    "invalid_project_dir",
  );
  assert.equal(
    assembleCampaignShow(planned.id)!.currentPlanHash,
    null,
    "no plan hash can be computed against a directory that does not exist",
  );
});

test("integ FG-608: a vanished projectDir yields invalid_project_dir in MARKDOWN mode too", () => {
  const dir = markdownProject("gone-md");
  const planned = plannedApprovedCampaign(dir);
  const paused = pause(planned.id);

  rmSync(dir, { recursive: true, force: true });
  clearBacklogStoreCache();

  assert.equal(resolveBacklogStore(dir).mode, "markdown");
  assert.equal(campaignBlocker(planned, listCampaignItems(planned.id), "start"), "invalid_project_dir");
  assert.equal(campaignBlocker(paused, listCampaignItems(paused.id), "resume"), "invalid_project_dir");
  assert.equal(assembleCampaignShow(planned.id)!.currentPlanHash, null);
});

// ── The CLI guard (campaign.ts, `forge campaign approve`) ────────────────────

function forge(cwd: string, args: string[]) {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
}

function initRepo(dir: string): void {
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ]) {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  }
  writeFileSync(join(dir, "README.md"), "seed\n");
  for (const args of [["add", "-A"], ["commit", "-qm", "init"]]) {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

function planViaCli(projectDir: string): string {
  const res = forge(projectDir, [
    "campaign", "plan",
    "--tickets", "FG-1",
    "--project", projectDir,
    "--mode", "sequential",
    "--default-lane", "ticketing_only",
    "--default-lane-rationale", "FG-608 dir-guard coverage; the lane is not what is under test",
    "--json",
  ]);
  assert.equal(res.status, 0, `campaign plan failed: ${res.stderr}`);
  return (JSON.parse(res.stdout) as { campaignId: string }).campaignId;
}

// The CLI guard runs in its OWN process against the real on-disk store, so this
// exercises the whole resolution — import, mode flip, and the approve-time guard.
test("integ FG-608: `forge campaign approve` admits a db-mode project with no backlog/ directory", () => {
  const dir = newProject("cli-db");
  initRepo(dir);
  const stories = join(dir, "backlog", "stories");
  mkdirSync(stories, { recursive: true });
  writeFileSync(
    join(stories, "FG-1-a-story.md"),
    `---\nid: FG-1\ntype: story\nstatus: active\ntitle: a story\n---\n\n${BODY}`,
  );

  const imported = forge(dir, ["backlog", "import", "--json", "--project", dir]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const flipped = forge(dir, ["backlog", "mode", "--set", "db", "--json", "--project", dir]);
  assert.equal(flipped.status, 0, `mode --set db failed: ${flipped.stderr}`);

  // Post-cutover shape: the Markdown is gone; the DB is the only store.
  rmSync(join(dir, "backlog"), { recursive: true, force: true });

  const campaignId = planViaCli(dir);
  const approved = forge(dir, ["campaign", "approve", campaignId, "--rationale", "FG-608", "--json"]);
  assert.equal(
    approved.status,
    0,
    `approve rejected a db-mode project with no backlog/ directory: ${approved.stderr}`,
  );
  assert.doesNotMatch(approved.stderr, /invalid or missing backlog/);
});

test("integ FG-608: `forge campaign approve` refuses a campaign whose projectDir has vanished", () => {
  const dir = newProject("cli-gone");
  initRepo(dir);
  const stories = join(dir, "backlog", "stories");
  mkdirSync(stories, { recursive: true });
  writeFileSync(
    join(stories, "FG-1-a-story.md"),
    `---\nid: FG-1\ntype: story\nstatus: active\ntitle: a story\n---\n\n${BODY}`,
  );

  const campaignId = planViaCli(dir);
  rmSync(dir, { recursive: true, force: true });

  const approved = forge(repoRoot, ["campaign", "approve", campaignId, "--rationale", "FG-608", "--json"]);
  assert.notEqual(approved.status, 0, `approve accepted a vanished projectDir; stdout: ${approved.stdout}`);
  assert.match(approved.stderr, /invalid or missing backlog/);
});

// ── The source-level lock on all four guard sites ────────────────────────────

// Pins the shape `!existsSync(<expr>) || !<store check>(<the same expr>)` at every
// site. A future change that drops the existsSync() operand — reading it as a
// leftover from before FG-607 converted these to store questions — fails here.
test("integ FG-608: every campaign backlog guard keeps its existsSync() host-path liveness operand", () => {
  const sites: { file: string; expected: number }[] = [
    { file: "src/campaign/executor.ts", expected: 2 },
    { file: "src/campaign/report.ts", expected: 1 },
    { file: "src/cli/commands/campaign.ts", expected: 1 },
  ];

  // Same identifier on BOTH sides: a guard that liveness-checked one path and
  // store-checked another would be a different bug, and must not pass here.
  const paired = /!existsSync\(([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\)\s*\|\|\s*!(?:hasBacklog|projectHasBacklog)\(\1\)/g;
  const anyStoreCheck = /!\s*(?:hasBacklog|projectHasBacklog)\s*\(/g;

  let totalPaired = 0;
  for (const { file, expected } of sites) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    const pairedHits = source.match(paired) ?? [];
    const storeHits = source.match(anyStoreCheck) ?? [];

    assert.equal(
      pairedHits.length,
      expected,
      `${file}: expected ${expected} guard(s) of the form ` +
        `\`!existsSync(dir) || !projectHasBacklog(dir)\`, found ${pairedHits.length}. ` +
        `The existsSync() operand is a HOST-PATH LIVENESS check on the campaign's recorded ` +
        `projectDir (a campaign whose directory was deleted) — NOT a leftover from the FG-607 ` +
        `store conversion. Dropping it lets a campaign proceed against a vanished directory.`,
    );
    assert.equal(
      storeHits.length,
      pairedHits.length,
      `${file}: found a backlog store check that is NOT paired with an existsSync() liveness check`,
    );
    totalPaired += pairedHits.length;
  }

  assert.equal(totalPaired, 4, "all four campaign guard sites must be accounted for");
});
