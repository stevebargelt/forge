import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateProjectSignals, findProject, listProjects, type RepositoryIdentityResolver } from "./projects.js";
import { liveOrchestratorSessions } from "./orchestrator-heartbeats.js";
import { captureProcessIdentity } from "./process-identity.js";

const forgeKey = "repo-forge";

function identity(entries: Record<string, { key: string; root?: string; branch?: string; remoteName?: string; exists?: boolean }>): RepositoryIdentityResolver {
  return (projectDir) => {
    const entry = entries[projectDir];
    assert.ok(entry, `missing identity fixture for ${projectDir}`);
    return {
      key: entry.key,
      source: "remote",
      checkoutRoot: entry.root ?? projectDir,
      exists: entry.exists ?? true,
      ...(entry.branch ? { branch: entry.branch } : {}),
      ...(entry.remoteName ? { remoteName: entry.remoteName } : {}),
    };
  };
}

test("aggregateProjectSignals collapses standalone clones and aggregates all repository activity", () => {
  const dirs = ["/tmp/forge", "/tmp/renamed-dashboard-clone", "/tmp/forge-fg571"];
  const projects = aggregateProjectSignals([
    { projectDir: dirs[0]!, runCount: 2, liveSessions: 1, lastRunAt: "2026-07-15T01:00:00Z" },
    { projectDir: dirs[1]!, runCount: 3, inFlightCount: 2, lastRunAt: "2026-07-17T01:00:00Z" },
    { projectDir: dirs[2]!, runCount: 5, liveSessions: 2, inFlightCount: 1, lastRunAt: "2026-07-16T01:00:00Z" },
  ], identity({
    [dirs[0]!]: { key: forgeKey, branch: "main", remoteName: "forge" },
    [dirs[1]!]: { key: forgeKey, branch: "dashboard-home", remoteName: "forge" },
    [dirs[2]!]: { key: forgeKey, branch: "fg578-raci-clobber", remoteName: "forge" },
  }));

  assert.equal(projects.length, 1);
  assert.equal(projects[0]!.label, "Forge");
  assert.equal(projects[0]!.runCount, 10);
  assert.equal(projects[0]!.inFlightCount, 3);
  assert.equal(projects[0]!.liveSessions, 3);
  assert.equal(projects[0]!.lastRunAt, "2026-07-17T01:00:00Z");
  assert.deepEqual(projects[0]!.projectDirs, [...dirs].sort());
  assert.deepEqual(projects[0]!.checkouts.map((checkout) => checkout.branch), [
    "main",
    "fg578-raci-clobber",
    "dashboard-home",
  ]);
  assert.equal(findProject("renamed-dashboard-clone", projects)?.key, forgeKey);
});

test("aggregateProjectSignals keeps exact observed paths while combining subdirectory signals by checkout", () => {
  const root = "/tmp/forge";
  const subdir = `${root}/dashboard`;
  const projects = aggregateProjectSignals([
    { projectDir: root, runCount: 1 },
    { projectDir: subdir, runCount: 4, inFlightCount: 2 },
  ], identity({
    [root]: { key: forgeKey, root, branch: "main", remoteName: "forge" },
    [subdir]: { key: forgeKey, root, branch: "main", remoteName: "forge" },
  }));

  assert.equal(projects[0]!.checkouts.length, 1);
  assert.equal(projects[0]!.checkouts[0]!.runCount, 5);
  assert.equal(projects[0]!.checkouts[0]!.inFlightCount, 2);
  assert.deepEqual(projects[0]!.projectDirs, [root, subdir]);
});

test("aggregateProjectSignals keeps repositories with the same basename separate", () => {
  const a = "/tmp/one/same";
  const b = "/tmp/two/same";
  const projects = aggregateProjectSignals([
    { projectDir: a, runCount: 1 },
    { projectDir: b, runCount: 1 },
  ], identity({
    [a]: { key: "repo-one", remoteName: "same" },
    [b]: { key: "repo-two", remoteName: "same" },
  }));
  assert.equal(projects.length, 2);
  assert.notEqual(projects[0]!.key, projects[1]!.key);
});

test("aggregateProjectSignals does not claim a repository or branch for a deleted checkout", () => {
  const missing = "/tmp/deleted-forge-checkout";
  const projects = aggregateProjectSignals([{ projectDir: missing, runCount: 1 }], identity({
    [missing]: { key: "repo-missing", exists: false },
  }));
  assert.equal(projects[0]!.label, "Unknown repository");
  assert.equal(projects[0]!.checkouts[0]!.branch, undefined);
  assert.equal(projects[0]!.checkouts[0]!.exists, false);
});

test("aggregateProjectSignals recovers a deleted Claude scratchpad's canonical repository from exact source provenance", () => {
  const source = "/Users/person/code/forge";
  const scratchpad = "/private/tmp/claude-501/-Users-person-code-forge/session-id/scratchpad/fg561-backlog-clone";
  const projects = aggregateProjectSignals([
    { projectDir: source, runCount: 2 },
    { projectDir: scratchpad, runCount: 1 },
  ], identity({
    [source]: { key: forgeKey, branch: "main", remoteName: "forge" },
    [scratchpad]: { key: "repo-missing", exists: false },
  }));

  assert.equal(projects.length, 1);
  assert.equal(projects[0]!.label, "Forge");
  assert.equal(projects[0]!.runCount, 3);
  const deleted = projects[0]!.checkouts.find((checkout) => checkout.projectDir === scratchpad);
  assert.equal(deleted?.exists, false);
  assert.equal(deleted?.branch, undefined);
});

// FG-576 D12 / FG-689 D11: the launcher is a SECOND writer into
// ~/.forge/orchestrators. Two files now describe ONE session, so anything that
// counted files counted that session twice.
test("FG-576: a launcher record and a hook record for one session count as ONE live session", () => {
  const heartbeatsDir = mkdtempSync(join(tmpdir(), "forge-projects-hb-"));
  const projectDir = mkdtempSync(join(tmpdir(), "forge-projects-proj-"));
  try {
    const now = Date.parse("2026-05-26T12:00:00Z");
    writeFileSync(join(heartbeatsDir, "sess-1.launcher.json"), JSON.stringify({
      kind: "forge-launcher-orchestrator",
      version: 1,
      sessionId: "sess-1",
      projectDir,
      startedAt: "2026-05-26T11:50:00Z",
      refreshedAt: "2026-05-26T11:59:00Z",
      provider: "anthropic",
      runtime: "claude-code",
      adapter: "claude",
      process: captureProcessIdentity(),
    }));
    writeFileSync(join(heartbeatsDir, "sess-1.json"), JSON.stringify({
      sessionId: "sess-1",
      projectDir,
      startedAt: "2026-05-26T11:50:00Z",
      lastSeen: new Date(now).toISOString(),
    }));

    const sessions = liveOrchestratorSessions({ heartbeatsDir, now });
    assert.equal(sessions.length, 1, "two files, one canonical session identity");

    const projects = listProjects({ scanRoots: [], heartbeatsDir });
    const record = projects.find((project) => project.projectDirs.includes(projectDir));
    assert.ok(record, "the live session's project must be listed");
    assert.equal(record.liveSessions, 1, "one session must not be counted once per heartbeat file");

    // And the aggregation seam agrees when fed the deduped signal.
    const aggregated = aggregateProjectSignals(
      sessions.map((session) => ({ projectDir: session.projectDir, liveSessions: 1 })),
    );
    assert.equal(aggregated[0]?.liveSessions, 1);
  } finally {
    rmSync(heartbeatsDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-576: a dead launcher's record contributes no live session", () => {
  const heartbeatsDir = mkdtempSync(join(tmpdir(), "forge-projects-hb-"));
  const projectDir = mkdtempSync(join(tmpdir(), "forge-projects-proj-"));
  try {
    writeFileSync(join(heartbeatsDir, "sess-dead.launcher.json"), JSON.stringify({
      kind: "forge-launcher-orchestrator",
      version: 1,
      sessionId: "sess-dead",
      projectDir,
      startedAt: "2026-05-26T11:50:00Z",
      refreshedAt: "2026-05-26T11:59:00Z",
      provider: "openai",
      runtime: "codex-cli",
      adapter: "codex",
      // A pid that is real but whose start fence can never match.
      process: { ...captureProcessIdentity(), startToken: "recycled-pid-token" },
    }));

    const projects = listProjects({ scanRoots: [], heartbeatsDir });
    const record = projects.find((project) => project.projectDirs.includes(projectDir));
    assert.equal(record, undefined, "an orphaned launcher record is not a live project signal");
  } finally {
    rmSync(heartbeatsDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
