// FG-757: a Darwin kern.boottime usec adjustment must not false-orphan a live
// launcher. These cover the process-identity boundary and its heartbeat consumer
// with an injected process table, so they are host-independent (including Linux CI).

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProcessIdentity, type ProcessIdentity, type ProcessProbe } from "./process-identity.js";
import { loadHeartbeats, writeLauncherHeartbeat } from "./orchestrator-heartbeats.js";

const HOST = "fg757-test-host";
const PID = 757;
const START_TOKEN = "ps-lstart:Wed Aug 24 10:00:00 2026";
const LEGACY_A = "boottime:{ sec = 1785613094, usec = 406504 } Wed Aug 24 10:00:00 2026";
const LEGACY_B = "boottime:{ sec = 1785613094, usec = 460361 } Wed Aug 24 10:00:00 2026";
const NEW = "boottime-sec:1785613094";

function identity(boot: string | undefined): ProcessIdentity {
  return { pid: PID, host: HOST, startToken: START_TOKEN, ...(boot ? { boot } : {}) };
}

function probe(boot: string | undefined, startToken: string | undefined = START_TOKEN): ProcessProbe {
  return {
    host: () => HOST,
    boot: () => boot,
    identify: (pid) => pid === PID ? { pid, host: HOST, ...(startToken ? { startToken } : {}) } : null,
  };
}

let heartbeatsDir: string;

beforeEach(() => { heartbeatsDir = mkdtempSync(join(tmpdir(), "forge-fg757-")); });
afterEach(() => { rmSync(heartbeatsDir, { recursive: true, force: true }); });

test("FG-757: legacy recorded boot and new current token with the same sec remains alive", () => {
  assert.equal(classifyProcessIdentity(identity(LEGACY_A), probe(NEW)), "alive");
});

test("FG-757: a different Darwin boot second still fences the process as dead", () => {
  assert.equal(classifyProcessIdentity(identity(LEGACY_A), probe("boottime-sec:1785699494")), "dead");
});

test("FG-757: legacy and new same-format tokens compare by stable boot second", () => {
  assert.equal(classifyProcessIdentity(identity(LEGACY_A), probe(LEGACY_B)), "alive", "legacy usec drift falls through");
  assert.equal(classifyProcessIdentity(identity(NEW), probe(NEW)), "alive", "new sec-only tokens remain live");
});

test("FG-757: absent or malformed Darwin boot values fall through to the start-token fence", () => {
  assert.equal(classifyProcessIdentity(identity(LEGACY_A), probe(undefined)), "alive", "missing current boot is not a false death");
  assert.equal(classifyProcessIdentity(identity("boottime:unparseable"), probe(NEW)), "alive", "malformed recorded boot is not a false death");
  assert.equal(classifyProcessIdentity(identity("boottime:unparseable"), probe(NEW, "different-start")), "dead", "start-token mismatch still fences");
});

test("FG-757: a legacy launcher heartbeat is live rather than orphaned after Darwin usec drift", () => {
  writeLauncherHeartbeat({
    sessionId: "fg757-launcher",
    projectDir: "/project-under-test",
    provider: "anthropic",
    runtime: "claude-code",
    adapter: "claude",
    identity: identity(LEGACY_A),
  }, { heartbeatsDir });

  const [session] = loadHeartbeats({ heartbeatsDir, processProbe: probe(NEW) });
  assert.equal(session?.processLiveness, "alive");
  assert.equal(session?.state, "live");
  assert.equal(session?.isLive, true);
  assert.notEqual(session?.state, "orphaned");
});
