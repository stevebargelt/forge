import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HeartbeatWriteError,
  closeLauncherHeartbeat,
  findOrchestratorSession,
  liveOrchestratorSessions,
  liveProjectDirs,
  loadHeartbeats,
  refreshLauncherHeartbeat,
  writeLauncherHeartbeat,
} from "./orchestrator-heartbeats.js";
import type { ProcessIdentity, ProcessProbe } from "./process-identity.js";

// A fully injected probe: these tests never consult the real process table, so
// they are deterministic on every host and can model pid reuse directly.
function fakeProbe(live: Record<number, string | undefined>, host = "test-host", boot = "boot-1"): ProcessProbe {
  return {
    host: () => host,
    boot: () => boot,
    identify: (pid) => {
      if (!(pid in live)) return null;
      const startToken = live[pid];
      return { pid, host, boot, ...(startToken ? { startToken } : {}) } satisfies ProcessIdentity;
    },
  };
}

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "forge-hb-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeHb(name: string, body: object): void {
  writeFileSync(join(dir, name), JSON.stringify(body));
}

test("loadHeartbeats: empty dir returns []", () => {
  assert.deepEqual(loadHeartbeats({ heartbeatsDir: dir }), []);
});

test("loadHeartbeats: returns nothing when dir does not exist", () => {
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(loadHeartbeats({ heartbeatsDir: dir }), []);
});

test("loadHeartbeats: live session within stale window is isLive=true", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeHb("sess-a.json", {
    sessionId: "sess-a",
    projectDir: "/proj/a",
    startedAt: "2026-05-26T11:55:00Z",
    lastSeen: "2026-05-26T11:59:30Z", // 30s ago
  });
  const out = loadHeartbeats({ heartbeatsDir: dir, now });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.isLive, true);
  assert.equal(out[0]?.projectDir, "/proj/a");
});

test("loadHeartbeats: stale session is isLive=false and is kept by default", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeHb("sess-stale.json", {
    sessionId: "sess-stale",
    projectDir: "/proj/old",
    startedAt: "2026-05-26T10:00:00Z",
    lastSeen: "2026-05-26T11:00:00Z", // 1h ago, > 15min
  });
  const out = loadHeartbeats({ heartbeatsDir: dir, now });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.isLive, false);
});

test("loadHeartbeats: gcStale removes stale files and excludes them from result", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeHb("sess-live.json",  { sessionId: "live",  projectDir: "/p1", startedAt: "x", lastSeen: "2026-05-26T11:59:00Z" });
  writeHb("sess-stale.json", { sessionId: "stale", projectDir: "/p2", startedAt: "x", lastSeen: "2026-05-26T08:00:00Z" });
  const out = loadHeartbeats({ heartbeatsDir: dir, now, gcStale: true });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.sessionId, "live");
  assert.ok(existsSync(join(dir, "sess-live.json")));
  assert.ok(!existsSync(join(dir, "sess-stale.json")));
});

test("loadHeartbeats: corrupt JSON file is skipped (and GC'd if gcStale)", () => {
  writeFileSync(join(dir, "broken.json"), "{ not valid");
  let out = loadHeartbeats({ heartbeatsDir: dir });
  assert.equal(out.length, 0);
  assert.ok(existsSync(join(dir, "broken.json")));
  out = loadHeartbeats({ heartbeatsDir: dir, gcStale: true });
  assert.equal(out.length, 0);
  assert.ok(!existsSync(join(dir, "broken.json")));
});

test("loadHeartbeats: ignores non-.json files in the dir", () => {
  writeFileSync(join(dir, "README"), "not a heartbeat");
  writeHb("sess.json", { sessionId: "s", projectDir: "/p", startedAt: "x", lastSeen: new Date().toISOString() });
  const out = loadHeartbeats({ heartbeatsDir: dir });
  assert.equal(out.length, 1);
});

test("loadHeartbeats: JSON missing required keys is skipped", () => {
  writeHb("bad-shape.json", { hello: "world" });
  const out = loadHeartbeats({ heartbeatsDir: dir });
  assert.equal(out.length, 0);
});

test("liveProjectDirs: dedupes multiple sessions per project", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeHb("s1.json", { sessionId: "s1", projectDir: "/proj/shared", startedAt: "x", lastSeen: "2026-05-26T11:59:00Z" });
  writeHb("s2.json", { sessionId: "s2", projectDir: "/proj/shared", startedAt: "x", lastSeen: "2026-05-26T11:58:00Z" });
  writeHb("s3.json", { sessionId: "s3", projectDir: "/proj/other",  startedAt: "x", lastSeen: "2026-05-26T11:55:00Z" });
  const set = liveProjectDirs({ heartbeatsDir: dir, now });
  assert.equal(set.size, 2);
  assert.ok(set.has("/proj/shared"));
  assert.ok(set.has("/proj/other"));
});

test("liveProjectDirs: stale sessions don't count", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeHb("s1.json", { sessionId: "s1", projectDir: "/old", startedAt: "x", lastSeen: "2026-05-25T10:00:00Z" });
  const set = liveProjectDirs({ heartbeatsDir: dir, now });
  assert.equal(set.size, 0);
});

test("loadHeartbeats: garbage non-JSON file doesn't crash readdir loop", () => {
  // Create a subdirectory in the heartbeats dir; ensure it's filtered.
  mkdirSync(join(dir, "subdir"));
  writeHb("sess.json", { sessionId: "s", projectDir: "/p", startedAt: "x", lastSeen: new Date().toISOString() });
  const out = loadHeartbeats({ heartbeatsDir: dir });
  assert.equal(out.length, 1);
  // Sanity: subdir still present.
  assert.ok(readdirSync(dir).includes("subdir"));
});

// --- FG-576: the launcher-owned record ------------------------------------

test("writeLauncherHeartbeat: lands in the EXISTING namespace beside the hook file (D12)", () => {
  const probe = fakeProbe({ [process.pid]: "tok-a" });
  const path = writeLauncherHeartbeat({
    sessionId: "sess-1",
    projectDir: "/proj/a",
    provider: "openai",
    runtime: "codex-cli",
    adapter: "codex",
    receiptId: "rcpt-1",
  }, { heartbeatsDir: dir, processProbe: probe });

  assert.equal(path, join(dir, "sess-1.launcher.json"));
  // No second directory: everything is a flat file in the one namespace.
  assert.deepEqual(readdirSync(dir), ["sess-1.launcher.json"]);

  const [session] = loadHeartbeats({ heartbeatsDir: dir, processProbe: probe });
  assert.equal(session?.sessionId, "sess-1");
  assert.equal(session?.provider, "openai");
  assert.equal(session?.runtime, "codex-cli");
  assert.equal(session?.adapter, "codex");
  assert.equal(session?.receiptId, "rcpt-1");
  assert.deepEqual(session?.sources, ["launcher"]);
});

test("writeLauncherHeartbeat: a record for a provider with NO hook is live but never healthy (AC7)", () => {
  const probe = fakeProbe({ [process.pid]: "tok-a" });
  writeLauncherHeartbeat(
    { sessionId: "codex-1", projectDir: "/proj/a", provider: "openai", runtime: "codex-cli", adapter: "codex" },
    { heartbeatsDir: dir, processProbe: probe },
  );
  const [session] = loadHeartbeats({ heartbeatsDir: dir, processProbe: probe });
  assert.equal(session?.state, "live");
  assert.equal(session?.isLive, true);
  assert.equal(session?.processLiveness, "alive");
  assert.equal(session?.interaction, "unknown");
  assert.equal(session?.health, "unknown", "no hook evidence must never read as healthy");
  assert.equal(session?.finalizable, false);
});

test("writeLauncherHeartbeat: unwritable directory surfaces a typed error rather than being swallowed", () => {
  // A regular file where the directory should be, so mkdir -p fails.
  writeFileSync(join(dir, "file-in-the-way"), "x");
  let caught: unknown;
  try {
    writeLauncherHeartbeat(
      { sessionId: "sess-1", projectDir: "/p", provider: "anthropic", runtime: "claude-code", adapter: "claude" },
      { heartbeatsDir: join(dir, "file-in-the-way", "nested") },
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof HeartbeatWriteError, "the launcher must be able to refuse on a write failure");
  assert.match(caught.message, /retry/i, "the refusal must be actionable");
});

test("writeLauncherHeartbeat: refuses a session id that would escape the namespace", () => {
  assert.throws(
    () => writeLauncherHeartbeat(
      { sessionId: "../../etc/passwd", projectDir: "/p", provider: "anthropic", runtime: "claude-code", adapter: "claude" },
      { heartbeatsDir: dir },
    ),
    HeartbeatWriteError,
  );
  assert.deepEqual(readdirSync(dir), []);
});

test("refreshLauncherHeartbeat: touches bookkeeping without changing the liveness answer", () => {
  const probe = fakeProbe({ [process.pid]: "tok-a" });
  writeLauncherHeartbeat(
    { sessionId: "sess-1", projectDir: "/p", provider: "anthropic", runtime: "claude-code", adapter: "claude" },
    { heartbeatsDir: dir, processProbe: probe, now: Date.parse("2026-05-26T10:00:00Z") },
  );
  assert.equal(refreshLauncherHeartbeat("sess-1", { heartbeatsDir: dir, now: Date.parse("2026-05-26T10:05:00Z") }), true);
  assert.equal(refreshLauncherHeartbeat("no-such-session", { heartbeatsDir: dir }), false);

  const session = findOrchestratorSession("sess-1", { heartbeatsDir: dir, processProbe: probe });
  assert.equal(session?.startedAt, "2026-05-26T10:00:00.000Z");
  assert.equal(session?.lastSeen, "2026-05-26T10:05:00.000Z");
  assert.equal(session?.state, "live");
});

test("closeLauncherHeartbeat: removes only the launcher's own file", () => {
  const probe = fakeProbe({ [process.pid]: "tok-a" });
  writeLauncherHeartbeat(
    { sessionId: "sess-1", projectDir: "/p", provider: "anthropic", runtime: "claude-code", adapter: "claude" },
    { heartbeatsDir: dir, processProbe: probe },
  );
  writeHb("sess-1.json", { sessionId: "sess-1", projectDir: "/p", startedAt: "x", lastSeen: new Date().toISOString() });

  closeLauncherHeartbeat("sess-1", { heartbeatsDir: dir });
  assert.deepEqual(readdirSync(dir).sort(), ["sess-1.json"]);
});

test("loadHeartbeats: merges the launcher record and the hook record for ONE session (D12)", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  const probe = fakeProbe({ [process.pid]: "tok-a" });
  writeLauncherHeartbeat(
    { sessionId: "sess-1", projectDir: "/proj/a", provider: "anthropic", runtime: "claude-code", adapter: "claude" },
    { heartbeatsDir: dir, processProbe: probe, now },
  );
  writeHb("sess-1.json", {
    sessionId: "sess-1",
    projectDir: "/proj/a",
    startedAt: "2026-05-26T11:50:00Z",
    lastSeen: "2026-05-26T11:59:00Z",
  });

  const sessions = loadHeartbeats({ heartbeatsDir: dir, now, processProbe: probe });
  assert.equal(sessions.length, 1, "two files, one canonical session");
  assert.deepEqual(sessions[0]?.sources, ["launcher", "provider-hook"]);
  assert.equal(sessions[0]?.state, "live");
  assert.equal(sessions[0]?.health, "healthy");
  assert.equal(liveOrchestratorSessions({ heartbeatsDir: dir, now, processProbe: probe }).length, 1);
  assert.equal(liveProjectDirs({ heartbeatsDir: dir, now, processProbe: probe }).size, 1);
});

test("loadHeartbeats: a launcher record for a dead launcher is orphaned, not live, and is NOT gc'd", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeLauncherHeartbeat(
    { sessionId: "sess-1", projectDir: "/proj/a", provider: "openai", runtime: "codex-cli", adapter: "codex" },
    { heartbeatsDir: dir, processProbe: fakeProbe({ [process.pid]: "tok-a" }), now },
  );
  // The launcher's pid is gone by the time we read.
  const sessions = loadHeartbeats({ heartbeatsDir: dir, now, gcStale: true, processProbe: fakeProbe({}) });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.state, "orphaned");
  assert.equal(sessions[0]?.isLive, false);
  assert.ok(existsSync(join(dir, "sess-1.launcher.json")), "orphan evidence must survive gc");
});

test("loadHeartbeats: a malformed launcher record is skipped, never read as a hook record", () => {
  writeHb("sess-1.launcher.json", { sessionId: "sess-1", projectDir: "/p", startedAt: "x", lastSeen: "y" });
  assert.deepEqual(loadHeartbeats({ heartbeatsDir: dir }), []);
});
