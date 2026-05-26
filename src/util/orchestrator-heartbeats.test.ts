import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHeartbeats, liveProjectDirs } from "./orchestrator-heartbeats.js";

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
