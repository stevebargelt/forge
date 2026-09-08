// FG-785: end-to-end operator flow for the outbound-only kanban command.
//
// This uses the real core CLI, which shells into the dashboard workspace entry, assembles the
// FG-781 RemoteBoard from a registered checkout, and persists its resulting card identities in
// the machine store.  It deliberately uses the shipped fake provider: one CLI process is one
// reference-provider session, while the durable map is the operator-visible outcome to verify.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These must be established before imports that evaluate src/util/paths.ts.
const root = mkdtempSync(join(tmpdir(), "fg785-kanban-sync-cli-"));
const forgeHome = join(root, "forge-home");
const scanRoots = join(root, "scan-roots");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(scanRoots, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = scanRoots;

const { getDb } = await import("../store/db.js");
const { repositoryCheckoutIdentity } = await import("../util/repository-identity.js");
const { SRC_DIR, NODE_EXEC } = await import("../integration-cli-spawn.js");

const CLI_ENTRY = join(SRC_DIR, "cli", "index.ts");
const AT = "2026-09-08T00:00:00Z";
const projectDir = join(scanRoots, "alpha");

function runKanban(args: string[]) {
  return spawnSync(NODE_EXEC, ["--import", "tsx", CLI_ENTRY, "kanban", ...args], {
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...process.env,
      FORGE_HOME: forgeHome,
      FORGE_PROJECT_SCAN_ROOTS: scanRoots,
      // A sentinel also proves the real CLI accepts a host-only credential without putting it in
      // its normal JSON response (the exhaustive leak scan is covered by the dedicated AC6 test).
      FORGE_KANBAN_FAKE_TOKEN: "fg785-cli-host-only-token",
      NO_NOTIFY: "true",
    },
  });
}

let projectKey: string;

before(() => {
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:example/fg785-cli-e2e.git"], {
    cwd: projectDir,
    stdio: "ignore",
  });

  const db = getDb();
  projectKey = repositoryCheckoutIdentity(realpathSync(projectDir)).key;
  const storeKey = "pk-fg785-cli-e2e";
  db.prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,'remote',?)`,
  ).run(storeKey, projectKey, AT);
  db.prepare(`INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?,?,?)`).run(storeKey, "db", AT);
  db.prepare(
    `INSERT INTO tickets (project_key,ticket_id,type,status,title,body,created,closed,closed_commit,epic,frontmatter,imported_at,imported_from)
     VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,?,NULL)`,
  ).run(storeKey, "FG-785-A", "story", "active", "Project this card", "not projected directly", null, AT);

  // Dashboard discovery is intentionally driven by a real Forge run associated with the checkout.
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, completed_at, metadata, project_dir)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("run-fg785-cli-e2e", "feature", "FG-785 CLI flow", "complete", AT, AT, null, realpathSync(projectDir));
});

test("AC7: forge kanban sync projects a real registered board and status exposes its durable identity map", () => {
  const sync = runKanban(["sync", "--project", projectKey, "--provider", "fake"]);
  assert.equal(sync.status, 0, `sync stderr: ${sync.stderr}`);
  const summary = JSON.parse(String(sync.stdout)) as {
    projectIdentity: string;
    provider: string;
    created: number;
    errors: number;
    outcomes: Array<{ ticketId: string; action: string; externalId?: string }>;
  };
  assert.equal(summary.projectIdentity, projectKey);
  assert.equal(summary.provider, "fake");
  assert.equal(summary.created, 1, "the assembled board's ticket becomes one outbound card");
  assert.equal(summary.errors, 0);
  assert.deepEqual(summary.outcomes.map((outcome) => outcome.action), ["created"]);
  assert.ok(summary.outcomes[0]?.externalId, "the provider assigned an external identity");
  assert.doesNotMatch(String(sync.stdout) + String(sync.stderr), /fg785-cli-host-only-token/);

  const status = runKanban(["status", "--project", projectKey, "--provider", "fake", "--json"]);
  assert.equal(status.status, 0, `status stderr: ${status.stderr}`);
  const projection = JSON.parse(String(status.stdout)) as {
    count: number;
    cards: Array<{ ticketIdentity: string; externalCardId: string; projectionState: string; lastProjectedHash: string }>;
  };
  assert.equal(projection.count, 1, "the core read command sees the map written by the child entry");
  assert.deepEqual(projection.cards[0] && {
    ticketIdentity: projection.cards[0].ticketIdentity,
    externalCardId: projection.cards[0].externalCardId,
    projectionState: projection.cards[0].projectionState,
  }, { ticketIdentity: "FG-785-A", externalCardId: summary.outcomes[0]?.externalId, projectionState: "active" });
  assert.match(projection.cards[0]!.lastProjectedHash, /^[a-f0-9]{64}$/, "incremental revision is persisted");
});
