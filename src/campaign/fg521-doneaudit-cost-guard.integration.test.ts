// FG-521 (c) — the COST guard and the no-gap direction of show/report agreement.
//
// Making `campaign show`'s next-action project report's done-audit machine
// bought agreement, but the done-audit map is expensive: collectDoneAuditInput
// shells out to git per item (`git status`, `git cat-file`, `git remote`,
// `git branch -r --contains`). `campaign show` is the command an operator runs
// constantly, on running/paused campaigns, where that answer is never consulted
// — paying for it there is exactly the FG-444-shaped regression this guards.
//
// The seam: `git cat-file`, bare `git remote`, and `git branch -r --contains`
// are UNIQUE to the done-audit collector (src/done-audit/collect.ts). No other
// collector on the show path issues them — the out-of-band/reconcile collectors
// use rev-list/diff/merge-base/rev-parse/status. So a `git` shim on PATH that
// logs argv gives a real, unmocked observation of whether collection ran, with
// no production seam and no override injected (an injected map would
// short-circuit the very collection under test).

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { approveCampaign, tryTransitionCampaignToRunning, updateCampaignStatus } from "../store/campaigns.js";
import { closeTicket, writeTicket } from "../backlog/structured.js";
import { planCampaign } from "./planner.js";
import { setDoneAuditMapForTest } from "./report.js";
import { registerCampaign } from "../cli/commands/campaign.js";
import type { DoneAuditResult } from "../done-audit/done-audit.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
let shimDir: string;
let gitLog: string;
let realGit: string;
let savedPath: string | undefined;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: projectDir, encoding: "utf8" });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg521-cost-"));
  shimDir = mkdtempSync(join(tmpdir(), "fg521-shim-"));
  gitLog = join(shimDir, "git-invocations.log");
  savedPath = process.env["PATH"];
  realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

  writeTicket(projectDir, {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Story One",
    created: "2024-01-01",
    body: "## Problem\nOne.\n\n## Goal\nDo it.\n\n## Acceptance Criteria\n- done\n",
  });
  writeTicket(projectDir, {
    id: "FG-102",
    type: "story",
    status: "active",
    title: "Story Two",
    created: "2024-01-02",
    body: "## Problem\nTwo.\n\n## Goal\nDo it.\n\n## Acceptance Criteria\n- done\n",
  });

  // A real repo with a real commit, and tickets closed against it — this is the
  // fixture shape that makes the done-audit collector issue its git probes
  // (cat-file / remote / branch --contains all hang off ticket.closedCommit).
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(projectDir, "BASE.md"), "base");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  const commit = git(["rev-parse", "HEAD"]).trim();
  closeTicket(projectDir, "FG-101", commit);
  closeTicket(projectDir, "FG-102", commit);

  // The shim: log argv, then exec the real git so behavior is unchanged.
  const shim = join(shimDir, "git");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(shim, 0o755);
  writeFileSync(gitLog, "");
});

afterEach(() => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
});

/** Run `fn` with the logging git shim first on PATH; return every git argv seen. */
function recordGitInvocations(fn: () => Promise<unknown> | unknown): Promise<string[]> {
  writeFileSync(gitLog, "");
  process.env["PATH"] = `${shimDir}:${savedPath ?? ""}`;
  const done = (): string[] => {
    process.env["PATH"] = savedPath ?? "";
    return readFileSync(gitLog, "utf8").split("\n").filter((l) => l.trim().length > 0);
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(done, (e) => { done(); throw e; });
    return Promise.resolve(done());
  } catch (e) {
    done();
    throw e;
  }
}

/** Argv shapes ONLY src/done-audit/collect.ts issues. `git status --porcelain`
 *  is deliberately NOT in here — report.ts and the reconcile collectors issue it
 *  too, so it can't distinguish done-audit collection from ordinary show work. */
function doneAuditGitProbes(invocations: string[]): string[] {
  return invocations.filter(
    (a) => a.startsWith("cat-file -e ") || a === "remote" || a.startsWith("branch -r --contains "),
  );
}

async function renderCampaignCli(args: string[]): Promise<string> {
  const lines: string[] = [];
  mock.method(console, "log", (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    const program = new Command();
    registerCampaign(program);
    await program.parseAsync(args, { from: "user" });
    return lines.join("\n");
  } finally {
    mock.restoreAll();
  }
}

/** Two shipped items; caller picks the campaign's terminal status. */
function campaignWithShippedItems(status: "complete" | "paused" | "running"): string {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101", "FG-102"] },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "LGTM" });
  const items = db
    .prepare("SELECT id FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC")
    .all(campaign.id) as { id: string }[];
  for (const item of items) {
    db.prepare("UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE id = ?").run(item.id);
  }
  tryTransitionCampaignToRunning(campaign.id);
  if (status !== "running") updateCampaignStatus(campaign.id, status);
  return campaign.id;
}

// ── (c) cost guard ───────────────────────────────────────────────────────────

test("FG-521 cost guard: `campaign show` on a NON-complete campaign never runs the done-audit collector's git probes", async () => {
  for (const status of ["running", "paused"] as const) {
    const id = campaignWithShippedItems(status);
    const invocations = await recordGitInvocations(() => renderCampaignCli(["campaign", "show", id]));
    const probes = doneAuditGitProbes(invocations);
    assert.deepEqual(
      probes,
      [],
      `a ${status} campaign's next-action never consults the done-audit map, so show must not pay for it — but it shelled out: ${JSON.stringify(probes)}`,
    );
  }
});

test("FG-521 cost guard: the probe is real — a COMPLETE campaign's `campaign show` DOES run the done-audit collector (positive control)", async () => {
  const id = campaignWithShippedItems("complete");
  const invocations = await recordGitInvocations(() => renderCampaignCli(["campaign", "show", id]));
  const probes = doneAuditGitProbes(invocations);

  // Without this control, the negative test above would pass even if the shim
  // never intercepted anything at all.
  assert.ok(
    probes.some((a) => a.startsWith("cat-file -e ")),
    `expected the done-audit collector's git probes on a complete campaign, saw: ${JSON.stringify(invocations)}`,
  );
  // One map per assemble, one collect per item — not per item per surface.
  assert.equal(probes.filter((a) => a.startsWith("cat-file -e ")).length, 2, "exactly one cat-file probe per campaign item");
});

test("FG-521 cost guard: `campaign report` still runs the collector on a non-complete campaign — report is the audit surface, show is the hot path", async () => {
  const id = campaignWithShippedItems("paused");
  const invocations = await recordGitInvocations(() => renderCampaignCli(["campaign", "report", id]));

  // report builds the map unconditionally (it renders per-item doneAuditState),
  // so the guard is scoped to show. Pinning this stops a future "optimization"
  // from silently removing report's audit data along with show's cost.
  assert.ok(
    doneAuditGitProbes(invocations).length > 0,
    `campaign report must still collect done-audit evidence, saw: ${JSON.stringify(invocations)}`,
  );
});

// ── (c) agreement in the NO-GAP direction, on the rendered surfaces ──────────

const PASS_AUDIT: DoneAuditResult = { outcome: "pass", checks: [], gaps: [], requestedAction: null };

test("FG-521: all audits pass — rendered `campaign show` reads 'complete — none' AND rendered `campaign report` reads the all-clear; neither claims a gap", async () => {
  const id = campaignWithShippedItems("complete");
  const prevMap = setDoneAuditMapForTest(new Map([["FG-101", PASS_AUDIT], ["FG-102", PASS_AUDIT]]));
  try {
    const showOut = await renderCampaignCli(["campaign", "show", id]);
    const reportOut = await renderCampaignCli(["campaign", "report", id]);

    assert.match(showOut, /Next action: complete — none/);
    assert.match(reportOut, /Next operator action: none — campaign complete \(all items shipped\)/);

    // Agreement runs both ways: sharing the gap machine must not make the
    // no-gap case start reporting phantom gaps on either surface.
    assert.doesNotMatch(showOut, /done-audit gaps/);
    assert.doesNotMatch(reportOut, /unresolved done-audit gaps/);
  } finally {
    setDoneAuditMapForTest(prevMap);
  }
});
