// FG-754 regression: all live operator surfaces share one persisted fixture with
// abandoned, terminal-history, and paused campaigns. The three states must remain
// distinct: only abandoned is vetoed; terminal history is already closed; paused
// work remains actionable.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const forgeHome = mkdtempSync(join(tmpdir(), "forge-fg754-distinct-"));
const projectDir = mkdtempSync(join(tmpdir(), "forge-fg754-distinct-project-"));
process.env.FORGE_HOME = forgeHome;

// The real activity derivation resolves this project workflow and thereby classifies
// the fixture's architect step as a human gate.
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
copyFileSync(join(here, "../../seeds/workflows/feature.yml"), join(projectDir, ".forge", "workflows", "feature.yml"));

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { currentActivity, inFlight, attentionInbox } = await import("./queries.js");

const AGED = "2026-06-30T00:00:00.000Z";
const RECENT = "2026-08-24T11:00:00.000Z";

function insertFixture(id: string, campaignStatus: "abandoned" | "complete" | "paused", at: string): void {
  writeTransaction(() => {
    const db = getDb();
    db.prepare(
      "INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir) VALUES (?, ?, 'list', '{}', 'serial', ?, ?, ?)",
    ).run(`campaign-${id}`, campaignStatus, at, at, projectDir);
    db.prepare(
      "INSERT INTO runs (id, workflow, title, status, created_at, project_dir, metadata) VALUES (?, 'feature', ?, 'active', ?, ?, ?)",
    ).run(`run-${id}`, `${id} campaign run`, at, projectDir, JSON.stringify({ ticketId: `FG-${id}` }));
    db.prepare(
      "INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES (?, ?, 'architect', 'architecture-advisor', 'awaiting_gate', '{}', ?, ?)",
    ).run(`task-${id}`, `run-${id}`, at, at);
    db.prepare(
      "INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, run_id, lifecycle_status, created_at, updated_at) VALUES (?, ?, 0, ?, ?, 'awaiting_gate', ?, ?)",
    ).run(`item-${id}`, `campaign-${id}`, `FG-${id}`, `run-${id}`, at, at);
  });
}

insertFixture("abandoned-aged", "abandoned", AGED);
insertFixture("terminal-history", "complete", RECENT);
insertFixture("paused-live", "paused", RECENT);

after(() => {
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

test("FG-754: abandoned, terminal, and paused campaigns are distinct across activity, in-flight, and Home inbox", () => {
  const activity = currentActivity();
  const operatorRuns = activity.operatorWaits.map((wait) => wait.runId).sort();
  assert.deepEqual(operatorRuns, ["run-paused-live"], "only the genuinely active paused campaign gate is an operator wait");
  assert.equal(activity.operatorWaits.some((wait) => wait.runId === "run-abandoned-aged"), false, "the aged abandoned row never resurfaces");
  assert.equal(activity.operatorWaits.some((wait) => wait.runId === "run-terminal-history"), false, "terminal campaign history remains excluded");

  const inFlightIds = inFlight(undefined, () => "alive").map((row) => row.taskId).sort();
  assert.deepEqual(inFlightIds, ["task-paused-live"]);

  const inbox = attentionInbox();
  const inboxRuns = inbox.items.filter((item) => item.kind === "waiting_gate").map((item) => item.links.runId).sort();
  assert.deepEqual(inboxRuns, ["run-paused-live"], "Home receives the same derived operator wait, not its own stale read");
  assert.deepEqual(inbox.degraded, []);
});
