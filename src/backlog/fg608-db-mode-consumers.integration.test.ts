// FG-608 acceptance: "Campaign planning, review-loop, and shipping-reviewer read
// DB tickets (inherited from Slice B; verified here)."
//
// That bullet was the thinnest-covered one in the slice. What existed:
//   - fg607-seam-consumers covers `forge readiness` and `forge campaign plan
//     --epic` only.
//   - fg608-dir-guard-regression claims this AC in its header but tests the
//     campaign DIR-GUARD, which is a different question (may the campaign start)
//     from this one (does the consumer read the right ticket).
//   - review-loop.integration.test.ts contains no db-mode setup at all, and
//     nothing anywhere constructs a reviewer context packet in db mode.
//
// So after the cutover, the two consumers that decide what a REVIEWER is shown —
// review-loop (src/cli/commands/review-loop.ts:1032) and the shipping-reviewer's
// context packet (src/v2/reviewer-context-packet.ts:65) — were unverified against
// the authoritative store. Both call readTicket(); if either resolved Markdown,
// a reviewer would be handed a frozen pre-cutover ticket body while the engineer
// built against the live one.
//
// THE DISCRIMINATOR used throughout: every db-mode fixture here also has a STALE
// backlog/*.md on disk whose title and body DIFFER from the DB row. That is the
// realistic post-cutover shape — `backlog/*.md` freezes in place, it is not
// deleted — and it means a consumer that fell back to the seam-bypassing file
// read produces a specifically WRONG string rather than merely failing. A
// fixture with no Markdown at all could not tell "read the DB" apart from
// "found nothing and defaulted"; the no-Markdown case is covered separately as
// the fresh-clone shape.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { setStorageMode } from "../store/tickets.js";
import { computeRepositoryEvidence, resolveAndClaimProjectKey } from "../store/project-registry.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { clearBacklogStoreCache } from "./storage-mode.js";
import { writeTicket } from "./structured.js";
import { registerReviewLoop } from "../cli/commands/review-loop.js";
import { assembleReviewerContextPacket } from "../v2/reviewer-context-packet.js";
import { resolvePlan, planCampaign } from "../campaign/planner.js";
import type { Run, Task, TaskPackage } from "../types/index.js";

const NOW = "2026-07-29T00:00:00Z";

// The DB bodies/titles the consumers MUST return, and the stale Markdown ones
// they must not. Distinct strings so an assertion failure names which store won.
const DB_TITLE = "the live db-mode story";
const DB_BODY = "## Goal\nThe body that lives in the authoritative store.\n";
const STALE_TITLE = "the FROZEN pre-cutover markdown title";
const STALE_BODY = "## Goal\nThe body frozen in backlog/*.md at cutover.\n";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
});

afterEach(() => {
  mock.restoreAll();
  setDbForTest(prev as DatabaseInstance);
  db.close();
  clearBacklogStoreCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    // test-setup.ts neutralizes the global git config on purpose, so identity
    // must be supplied rather than borrowed from the host.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

// realpathSync: the evidence key is path-derived on the `path` rung and /tmp is a
// symlink on macOS, so an unresolved path registers evidence the consumer's own
// resolution would then miss.
function newProject(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `fg608-consumers-${label}-`)));
  dirs.push(dir);
  return dir;
}

/** A project cut over to the DB store, exactly as `forge backlog migrate` leaves
 *  it: a committed project_key, registry evidence, and mode = db. */
function dbModeProject(label: string, projectKey: string, opts: { git?: boolean } = {}): string {
  const dir = newProject(label);
  if (opts.git) {
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "src.ts"), "// initial\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "initial commit"]);
  }
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), `project_key: ${projectKey}\nbacklog:\n  prefix: FG\n`);
  const evidence = computeRepositoryEvidence(dir);
  writeTransaction(() =>
    resolveAndClaimProjectKey({
      evidenceKey: evidence.key,
      evidenceSource: evidence.source,
      configKey: projectKey,
      createdAt: NOW,
    }),
  );
  setStorageMode(projectKey, "db", NOW);
  // resolveBacklogStore memoizes for 3s keyed on path + db generation.
  clearBacklogStoreCache();
  return dir;
}

/** Seed a ticket through the seam. In db mode this writes a DB row and NO file. */
function seedDbTicket(
  projectDir: string,
  ticket: { id: string; type?: "idea" | "epic" | "story"; status?: "active" | "done"; title: string; body: string; epic?: string; related?: string[] },
): void {
  writeTicket(projectDir, {
    id: ticket.id,
    type: ticket.type ?? "story",
    status: ticket.status ?? "active",
    title: ticket.title,
    created: "2026-01-01",
    body: ticket.body,
    ...(ticket.epic ? { epic: ticket.epic } : {}),
    ...(ticket.related ? { related: ticket.related } : {}),
  });
  // Asserted by SCANNING rather than by reconstructing the slug: guessing the
  // filename would make this pass for the wrong reason (a name that never
  // existed) and quietly stop noticing a seam that wrote Markdown in db mode.
  const storiesDir = join(projectDir, "backlog", "stories");
  const written = existsSync(storiesDir) ? readdirSync(storiesDir) : [];
  assert.deepEqual(
    written.filter((f) => f.startsWith(`${ticket.id}-`)),
    [],
    "a db-mode seam write must not create a Markdown file",
  );
}

/** The frozen pre-cutover file. Written directly, because the seam would (rightly)
 *  send it to the DB in db mode. */
function writeFrozenMarkdown(
  projectDir: string,
  id: string,
  fields: { title: string; body: string; type?: string; status?: string; epic?: string },
): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  const fm = [
    `id: ${id}`,
    `type: ${fields.type ?? "story"}`,
    `status: ${fields.status ?? "active"}`,
    `title: "${fields.title}"`,
    ...(fields.epic ? [`epic: ${fields.epic}`] : []),
  ].join("\n");
  writeFileSync(join(dir, `${id}-frozen.md`), `---\n${fm}\n---\n\n${fields.body}\n`);
}

function captureLog(): { lines: () => string } {
  const out: string[] = [];
  mock.method(console, "log", (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  return { lines: () => out.join("\n") };
}

// ─── consumer 1: review-loop ─────────────────────────────────────────────────

async function runReviewLoopDryRun(projectDir: string, ticketId: string, since: string): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerReviewLoop(program, async () => {
    throw new Error("--dry-run must not dispatch");
  });
  const log = captureLog();
  await program.parseAsync(
    ["review-loop", ticketId, "--since", since, "--project", projectDir, "--unrouted", "--dry-run"],
    { from: "user" },
  );
  return log.lines();
}

test("FG-608: review-loop resolves the DB ticket, not the frozen backlog/*.md beside it", async () => {
  const dir = dbModeProject("rl", "pk-review-loop", { git: true });
  const since = git(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "src.ts"), "// changed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "FG-1 work"]);

  seedDbTicket(dir, { id: "FG-1", title: DB_TITLE, body: DB_BODY });
  writeFrozenMarkdown(dir, "FG-1", { title: STALE_TITLE, body: STALE_BODY });

  const printed = await runReviewLoopDryRun(dir, "FG-1", since);

  // review-loop.ts:1046 prints `review-loop: ${ticket.id} — ${ticket.title}`, and
  // that title can only have come from readTicket().
  assert.match(printed, new RegExp(`review-loop: FG-1 — ${DB_TITLE}`), "review-loop read the DB ticket");
  assert.doesNotMatch(printed, /FROZEN pre-cutover/, "the frozen Markdown title never reaches the loop");
});

test("FG-608: review-loop resolves a db-mode ticket in a checkout with NO backlog/ directory", async () => {
  const dir = dbModeProject("rl-nodir", "pk-review-loop-nodir", { git: true });
  const since = git(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "src.ts"), "// changed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "FG-2 work"]);

  seedDbTicket(dir, { id: "FG-2", title: DB_TITLE, body: DB_BODY });
  assert.equal(existsSync(join(dir, "backlog")), false, "the post-cutover fresh-clone shape");

  const printed = await runReviewLoopDryRun(dir, "FG-2", since);
  assert.match(printed, new RegExp(`review-loop: FG-2 — ${DB_TITLE}`));
});

// ─── consumer 2: the shipping reviewer's context packet ──────────────────────

function seedRunAndTask(runId: string, taskId: string, ticketId: string): void {
  const run: Run = {
    id: runId,
    workflow: "feature",
    title: "db-mode run",
    status: "active",
    createdAt: NOW,
    metadata: { ticketId },
  };
  insertRun(run);
  const pkg: TaskPackage = {
    taskId,
    runId,
    phase: "build",
    role: "engineer",
    inputs: {},
    composedSystemPrompt: "",
  };
  const task: Task = {
    id: taskId,
    runId,
    phase: "build",
    agentRole: "engineer",
    status: "complete",
    taskPackage: pkg,
    createdAt: NOW,
  };
  insertTask(task);
}

test("FG-608: the shipping reviewer's context packet carries the DB ticket, not the frozen Markdown", () => {
  const dir = dbModeProject("packet", "pk-packet");
  seedDbTicket(dir, { id: "FG-1", title: DB_TITLE, body: DB_BODY });
  writeFrozenMarkdown(dir, "FG-1", { title: STALE_TITLE, body: STALE_BODY });
  seedRunAndTask("run-packet", "task-packet", "FG-1");

  const packet = assembleReviewerContextPacket("run-packet", "task-packet", dir);

  assert.ok(packet.backlog, "the reviewer was given a ticket");
  assert.equal(packet.backlog.title, DB_TITLE);
  assert.match(packet.backlog.body, /authoritative store/, "the DB body reached the reviewer");
  assert.doesNotMatch(packet.backlog.body, /frozen in backlog/, "the frozen Markdown body did not");
  assert.deepEqual(
    packet.missingContext.filter((m) => m.field === "backlogTicket"),
    [],
    "a db-mode ticket is not reported as missing context",
  );
});

test("FG-608: the context packet resolves a db-mode ticket with NO backlog/ directory", () => {
  const dir = dbModeProject("packet-nodir", "pk-packet-nodir");
  seedDbTicket(dir, { id: "FG-9", title: DB_TITLE, body: DB_BODY });
  assert.equal(existsSync(join(dir, "backlog")), false);
  seedRunAndTask("run-nodir", "task-nodir", "FG-9");

  const packet = assembleReviewerContextPacket("run-nodir", "task-nodir", dir);
  assert.ok(packet.backlog, "no backlog/ directory is not a missing ticket after cutover");
  assert.equal(packet.backlog.title, DB_TITLE);
  assert.deepEqual(packet.missingContext.filter((m) => m.field === "backlogTicket"), []);
});

// ─── consumer 3: campaign planning ───────────────────────────────────────────

test("FG-608: the campaign planner's explicit-list resolution reads DB tickets", () => {
  const dir = dbModeProject("plan-list", "pk-plan-list");
  seedDbTicket(dir, { id: "FG-1", title: DB_TITLE, body: DB_BODY });
  seedDbTicket(dir, { id: "FG-2", title: "second db story", body: "b" });
  // A ticket that exists ONLY as frozen Markdown. planner.ts:245 builds its
  // membership set from listTickets(), so this id resolving would prove a
  // Markdown read — and it is the exact stale-work-item bug the cutover exists
  // to prevent.
  writeFrozenMarkdown(dir, "FG-GHOST", { title: STALE_TITLE, body: STALE_BODY });

  const plan = resolvePlan({ kind: "list", ticketIds: ["FG-1", "FG-2"] }, { projectDir: dir });
  assert.deepEqual(plan.resolvedIds, ["FG-1", "FG-2"], "the DB tickets resolve");

  assert.throws(
    () => resolvePlan({ kind: "list", ticketIds: ["FG-GHOST"] }, { projectDir: dir }),
    /Tickets not found in backlog: FG-GHOST/,
    "a Markdown-only ticket is NOT a campaign-plannable ticket after cutover",
  );
});

test("FG-608: the campaign planner's mixed epic+additions resolution reads DB tickets", () => {
  const dir = dbModeProject("plan-mixed", "pk-plan-mixed");
  seedDbTicket(dir, { id: "FG-E", type: "epic", title: "the epic", body: "e" });
  seedDbTicket(dir, { id: "FG-1", title: "child one", body: "c1", epic: "FG-E" });
  seedDbTicket(dir, { id: "FG-2", title: "child two", body: "c2", epic: "FG-E" });
  // Not under the epic — reachable only through the additions branch
  // (planner.ts:273), which is a listTickets() call the epic path never makes.
  seedDbTicket(dir, { id: "FG-3", title: "the addition", body: "a" });
  writeFrozenMarkdown(dir, "FG-GHOST", { title: STALE_TITLE, body: STALE_BODY, epic: "FG-E" });

  const plan = resolvePlan(
    { kind: "mixed", epicId: "FG-E", additions: ["FG-3"], exclusions: ["FG-2"] },
    { projectDir: dir },
  );
  assert.deepEqual(plan.resolvedIds, ["FG-1", "FG-3"], "epic expansion, exclusion and addition all came from the DB");
  assert.ok(!plan.resolvedIds.includes("FG-GHOST"), "a Markdown-only child never joins the campaign");

  assert.throws(
    () => resolvePlan({ kind: "mixed", epicId: "FG-E", additions: ["FG-GHOST"] }, { projectDir: dir }),
    /Added tickets not found in backlog: FG-GHOST/,
  );
});

test("FG-608: planCampaign persists a campaign whose items are the DB tickets", () => {
  const dir = dbModeProject("plan-campaign", "pk-plan-campaign");
  seedDbTicket(dir, { id: "FG-1", title: DB_TITLE, body: DB_BODY });
  seedDbTicket(dir, { id: "FG-2", title: "second db story", body: "b" });
  writeFrozenMarkdown(dir, "FG-GHOST", { title: STALE_TITLE, body: STALE_BODY });

  const result = planCampaign({ kind: "list", ticketIds: ["FG-1", "FG-2"] }, { projectDir: dir });
  assert.deepEqual(result.items.map((i) => i.ticketId), ["FG-1", "FG-2"]);
  assert.equal(result.campaign.status, "planned");
  assert.ok(!result.items.some((i) => i.ticketId === "FG-GHOST"));
});
