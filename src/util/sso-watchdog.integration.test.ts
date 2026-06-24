import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startSsoWatchdog,
  stopSsoWatchdog,
  isWatchdogRunning,
  _ssoWatchdogPidFile,
} from "./sso-watchdog.js";

let tmpHome: string;
let prevForgeHome: string | undefined;
let prevWatchdogScript: string | undefined;

beforeEach(() => {
  // Each test gets its own FORGE_HOME so PID files don't collide across tests
  // and don't touch the user's real ~/.forge.
  tmpHome = join(
    tmpdir(),
    `forge-sso-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tmpHome, { recursive: true });
  prevForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = tmpHome;
  prevWatchdogScript = process.env.FORGE_SSO_WATCHDOG;
});

afterEach(() => {
  // Always try to stop a running watchdog so tests don't leak background sleep procs.
  try {
    stopSsoWatchdog();
  } catch {
    // ignore
  }
  if (prevForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = prevForgeHome;
  if (prevWatchdogScript === undefined) delete process.env.FORGE_SSO_WATCHDOG;
  else process.env.FORGE_SSO_WATCHDOG = prevWatchdogScript;
  rmSync(tmpHome, { recursive: true, force: true });
});

test("isWatchdogRunning: returns false when no PID file exists", () => {
  assert.equal(isWatchdogRunning(), false);
});

test("isWatchdogRunning: returns false and cleans up a stale PID file", () => {
  // PID 999999999 is virtually certain not to be in use.
  writeFileSync(_ssoWatchdogPidFile(), "999999999");
  assert.equal(isWatchdogRunning(), false);
  assert.equal(existsSync(_ssoWatchdogPidFile()), false, "stale PID file should be cleaned up");
});

test("isWatchdogRunning: returns true for a live process", () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
  child.unref();
  try {
    writeFileSync(_ssoWatchdogPidFile(), String(child.pid));
    assert.equal(isWatchdogRunning(), true);
  } finally {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
  }
});

test("start + stop roundtrip with a real script", async () => {
  const dummyScript = join(tmpHome, "dummy-watchdog.sh");
  writeFileSync(dummyScript, "#!/usr/bin/env bash\nsleep 30\n", { mode: 0o755 });
  process.env.FORGE_SSO_WATCHDOG = dummyScript;

  assert.equal(isWatchdogRunning(), false);
  startSsoWatchdog("run-test");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(isWatchdogRunning(), true, "watchdog should be running after start");
  assert.equal(existsSync(_ssoWatchdogPidFile()), true);

  stopSsoWatchdog();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(isWatchdogRunning(), false, "watchdog should be stopped");
  assert.equal(existsSync(_ssoWatchdogPidFile()), false);
});

test("start: noop when no FORGE_SSO_WATCHDOG is set", () => {
  delete process.env.FORGE_SSO_WATCHDOG;
  startSsoWatchdog("run-test");
  assert.equal(isWatchdogRunning(), false);
});

test("start: noop when script does not exist", () => {
  process.env.FORGE_SSO_WATCHDOG = "/path/that/does/not/exist.sh";
  startSsoWatchdog("run-test");
  assert.equal(isWatchdogRunning(), false);
});

test("start: idempotent — second call while running keeps the same PID", async () => {
  const dummyScript = join(tmpHome, "dummy-watchdog.sh");
  writeFileSync(dummyScript, "#!/usr/bin/env bash\nsleep 30\n", { mode: 0o755 });
  process.env.FORGE_SSO_WATCHDOG = dummyScript;

  startSsoWatchdog("run-test");
  await new Promise((r) => setTimeout(r, 80));
  const firstPid = readFileSync(_ssoWatchdogPidFile(), "utf8").trim();

  startSsoWatchdog("run-test"); // should noop
  const secondPid = readFileSync(_ssoWatchdogPidFile(), "utf8").trim();

  assert.equal(firstPid, secondPid, "PID should not change when start is called twice");
});

test("stop: tolerant of missing PID file", () => {
  // Should not throw.
  stopSsoWatchdog();
});
