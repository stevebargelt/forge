// FG-576 D14 / AC7: the process fence, and the four states it must keep apart.
//
// Every assertion here runs against an INJECTED heartbeats dir and an INJECTED
// process probe (AC13): nothing reads the operator's ~/.forge and nothing
// consults the real process table, so the same evidence holds on every host.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHeartbeats,
  writeLauncherHeartbeat,
  type ProcessIdentity,
  type ProcessProbe,
} from "./orchestrator-heartbeats.js";
import {
  captureProcessIdentity,
  classifyProcessIdentity,
  coerceProcessIdentity,
  systemProcessProbe,
} from "./process-identity.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "forge-fence-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const HOST = "test-host";

/** Models the process table: pid -> start token (undefined = pid held, no token readable). */
function probeFor(
  live: Record<number, string | undefined>,
  opts: { host?: string; boot?: string } = {},
): ProcessProbe {
  const host = opts.host ?? HOST;
  const boot = opts.boot ?? "boot-1";
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

const LAUNCHER_PID = 4711;

function writeLauncher(sessionId: string, identity: ProcessIdentity, now: number): void {
  writeLauncherHeartbeat(
    {
      sessionId,
      projectDir: "/proj/a",
      provider: "anthropic",
      runtime: "claude-code",
      adapter: "claude",
      identity,
    },
    { heartbeatsDir: dir, now },
  );
}

function writeHook(sessionId: string, lastSeen: string): void {
  writeFileSync(
    join(dir, `${sessionId}.json`),
    JSON.stringify({ sessionId, projectDir: "/proj/a", startedAt: "2026-05-26T10:00:00Z", lastSeen }),
  );
}

// --- classifyProcessIdentity ------------------------------------------------

test("classifyProcessIdentity: same pid AND same start token is alive", () => {
  const recorded: ProcessIdentity = { pid: LAUNCHER_PID, host: HOST, boot: "boot-1", startToken: "tok-a" };
  assert.equal(classifyProcessIdentity(recorded, probeFor({ [LAUNCHER_PID]: "tok-a" })), "alive");
});

test("classifyProcessIdentity: nothing holds the pid is dead", () => {
  const recorded: ProcessIdentity = { pid: LAUNCHER_PID, host: HOST, boot: "boot-1", startToken: "tok-a" };
  assert.equal(classifyProcessIdentity(recorded, probeFor({})), "dead");
});

test("classifyProcessIdentity: a REUSED pid is dead, not unknown and never alive (D14 phantom)", () => {
  const recorded: ProcessIdentity = { pid: LAUNCHER_PID, host: HOST, boot: "boot-1", startToken: "tok-a" };
  assert.equal(classifyProcessIdentity(recorded, probeFor({ [LAUNCHER_PID]: "tok-b" })), "dead");
});

test("classifyProcessIdentity: a pid from a previous boot is dead even if the token matches", () => {
  const recorded: ProcessIdentity = { pid: LAUNCHER_PID, host: HOST, boot: "boot-1", startToken: "tok-a" };
  const rebooted = probeFor({ [LAUNCHER_PID]: "tok-a" }, { boot: "boot-2" });
  assert.equal(classifyProcessIdentity(recorded, rebooted), "dead");
});

test("classifyProcessIdentity: a record from another host is unknown, never alive", () => {
  const recorded: ProcessIdentity = { pid: LAUNCHER_PID, host: "other-host", boot: "boot-1", startToken: "tok-a" };
  assert.equal(classifyProcessIdentity(recorded, probeFor({ [LAUNCHER_PID]: "tok-a" })), "unknown");
});

test("classifyProcessIdentity: an unfenceable running pid is unknown, never alive", () => {
  const recorded: ProcessIdentity = { pid: LAUNCHER_PID, host: HOST, boot: "boot-1" };
  assert.equal(classifyProcessIdentity(recorded, probeFor({ [LAUNCHER_PID]: "tok-a" })), "unknown");
  const noToken: ProcessIdentity = { pid: LAUNCHER_PID, host: HOST, boot: "boot-1", startToken: "tok-a" };
  assert.equal(classifyProcessIdentity(noToken, probeFor({ [LAUNCHER_PID]: undefined })), "unknown");
});

test("classifyProcessIdentity: a missing or malformed fence is unknown", () => {
  assert.equal(classifyProcessIdentity(undefined, probeFor({})), "unknown");
  assert.equal(classifyProcessIdentity({ pid: 0, host: HOST }, probeFor({})), "unknown");
});

test("captureProcessIdentity: fences THIS process against the real probe", () => {
  const identity = captureProcessIdentity(process.pid, systemProcessProbe);
  assert.equal(identity.pid, process.pid);
  assert.ok(identity.host.length > 0);
  assert.equal(classifyProcessIdentity(identity, systemProcessProbe), "alive");
});

test("coerceProcessIdentity: rejects shapes that cannot fence anything", () => {
  assert.equal(coerceProcessIdentity(undefined), undefined);
  assert.equal(coerceProcessIdentity({ pid: "4711", host: HOST }), undefined);
  assert.equal(coerceProcessIdentity({ pid: 4711 }), undefined);
  assert.deepEqual(coerceProcessIdentity({ pid: 4711, host: HOST, startToken: "t", boot: "b" }), {
    pid: 4711, host: HOST, startToken: "t", boot: "b",
  });
});

// --- the four states, read through the heartbeat surface --------------------

test("(b) alive process + 40-minute-old interaction reads ALIVE and is never finalized (D14 suspend)", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeLauncher("sess-suspend", { pid: LAUNCHER_PID, host: HOST, boot: "boot-1", startToken: "tok-a" }, now);
  writeHook("sess-suspend", "2026-05-26T11:20:00Z"); // 40 minutes ago

  const [session] = loadHeartbeats({ heartbeatsDir: dir, now, processProbe: probeFor({ [LAUNCHER_PID]: "tok-a" }) });
  assert.equal(session?.state, "live");
  assert.equal(session?.isLive, true);
  assert.equal(session?.processLiveness, "alive");
  assert.equal(session?.interaction, "stale");
  assert.equal(session?.finalizable, false, "a suspended laptop is not a dead session");
});

test("(c) a REUSED pid classifies as orphaned/dead, not unknown (D14 phantom)", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeLauncher("sess-phantom", { pid: LAUNCHER_PID, host: HOST, boot: "boot-1", startToken: "tok-a" }, now);
  writeHook("sess-phantom", "2026-05-26T11:59:00Z"); // recent interaction evidence

  const [session] = loadHeartbeats({ heartbeatsDir: dir, now, processProbe: probeFor({ [LAUNCHER_PID]: "tok-b" }) });
  assert.equal(session?.processLiveness, "dead");
  assert.equal(session?.state, "orphaned");
  assert.equal(session?.isLive, false, "a recycled pid must not keep an orchestrator active forever");
  assert.equal(session?.health, "stale", "a dead launcher is never healthy, however fresh the hook file is");
  assert.equal(session?.finalizable, true);
});

test("(d) a record with NO interaction evidence never classifies as healthy (AC7)", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeLauncher("sess-codex", { pid: LAUNCHER_PID, host: HOST, boot: "boot-1", startToken: "tok-a" }, now);

  const [session] = loadHeartbeats({ heartbeatsDir: dir, now, processProbe: probeFor({ [LAUNCHER_PID]: "tok-a" }) });
  assert.equal(session?.interaction, "unknown");
  assert.equal(session?.health, "unknown");
  assert.notEqual(session?.health, "healthy");
  // Process liveness still answers live/not-live — that is the whole point of
  // the launcher-owned claim for a provider that supplies no hook.
  assert.equal(session?.isLive, true);
  assert.equal(session?.processLiveness, "alive");
});

test("(d) an UNFENCEABLE launcher record with no interaction evidence is unknown, never live", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeLauncher("sess-foreign", { pid: LAUNCHER_PID, host: "other-host", boot: "boot-1", startToken: "tok-a" }, now);

  const [session] = loadHeartbeats({ heartbeatsDir: dir, now, processProbe: probeFor({ [LAUNCHER_PID]: "tok-a" }) });
  assert.equal(session?.processLiveness, "unknown");
  assert.equal(session?.state, "unknown");
  assert.equal(session?.isLive, false);
  assert.equal(session?.health, "unknown");
  assert.equal(session?.finalizable, false, "what we cannot judge, we do not finalize");
});

test("(e) a legacy hook-shape file still parses and counts, but is NOT process-alive evidence", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeHook("sess-legacy", "2026-05-26T11:59:00Z");

  const [session] = loadHeartbeats({ heartbeatsDir: dir, now, processProbe: probeFor({}) });
  assert.equal(session?.sessionId, "sess-legacy");
  assert.deepEqual(session?.sources, ["provider-hook"]);
  assert.equal(session?.isLive, true, "an in-flight pre-upgrade session must survive the upgrade (D12)");
  assert.equal(session?.state, "live-unfenced");
  assert.equal(session?.processLiveness, "unknown", "a hook file asserts a turn, never a running process");
  assert.equal(session?.health, "healthy");
  assert.equal(session?.finalizable, false);
});

test("(e) a legacy hook file that has gone stale finalizes exactly as it did before", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  writeHook("sess-old", "2026-05-26T10:00:00Z");

  const [session] = loadHeartbeats({ heartbeatsDir: dir, now, processProbe: probeFor({}) });
  assert.equal(session?.state, "stale");
  assert.equal(session?.isLive, false);
  assert.equal(session?.finalizable, true);
});

test("the 15-minute window governs the INTERACTION claim only, never the process fence", () => {
  const now = Date.parse("2026-05-26T12:00:00Z");
  // A launcher record written two hours ago whose process is still alive.
  writeLauncher("sess-long", { pid: LAUNCHER_PID, host: HOST, boot: "boot-1", startToken: "tok-a" }, Date.parse("2026-05-26T10:00:00Z"));

  const [session] = loadHeartbeats({ heartbeatsDir: dir, now, processProbe: probeFor({ [LAUNCHER_PID]: "tok-a" }) });
  assert.equal(session?.isLive, true, "elapsed time alone never kills a fenced launcher");
  assert.equal(session?.state, "live");
});
