// idle-watchdog tests: timer behavior under node:test mock timers + env parsing.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  startIdleWatchdog,
  resolveIdleTimeoutMs,
  DEFAULT_IDLE_TIMEOUT_MS,
} from "./idle-watchdog.js";

function withFakeTimers(fn: () => void) {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    fn();
  } finally {
    mock.timers.reset();
  }
}

test("fires onIdle after idleMs of silence", () => {
  withFakeTimers(() => {
    let fired = 0;
    const wd = startIdleWatchdog(1000, () => fired++);
    mock.timers.tick(999);
    assert.equal(fired, 0);
    mock.timers.tick(1);
    assert.equal(fired, 1);
    wd.stop();
  });
});

test("bump resets the countdown", () => {
  withFakeTimers(() => {
    let fired = 0;
    const wd = startIdleWatchdog(1000, () => fired++);
    mock.timers.tick(900);
    wd.bump(); // would have fired at 1000 without this
    mock.timers.tick(900);
    assert.equal(fired, 0);
    mock.timers.tick(100);
    assert.equal(fired, 1);
    wd.stop();
  });
});

test("stop cancels a pending fire", () => {
  withFakeTimers(() => {
    let fired = 0;
    const wd = startIdleWatchdog(1000, () => fired++);
    wd.stop();
    mock.timers.tick(5000);
    assert.equal(fired, 0);
  });
});

test("bump after stop does not re-arm", () => {
  withFakeTimers(() => {
    let fired = 0;
    const wd = startIdleWatchdog(1000, () => fired++);
    wd.stop();
    wd.bump();
    mock.timers.tick(5000);
    assert.equal(fired, 0);
  });
});

test("idleMs <= 0 disables the watchdog", () => {
  withFakeTimers(() => {
    let fired = 0;
    const wd = startIdleWatchdog(0, () => fired++);
    wd.bump();
    mock.timers.tick(10_000_000);
    assert.equal(fired, 0);
    wd.stop();
  });
});

test("resolveIdleTimeoutMs: env default / override / disable / invalid", () => {
  assert.equal(resolveIdleTimeoutMs(undefined, {}), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(resolveIdleTimeoutMs(undefined, { FORGE_AGENT_IDLE_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveIdleTimeoutMs(undefined, { FORGE_AGENT_IDLE_TIMEOUT_MS: "0" }), 0);
  assert.equal(resolveIdleTimeoutMs(undefined, { FORGE_AGENT_IDLE_TIMEOUT_MS: "abc" }), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(resolveIdleTimeoutMs(undefined, { FORGE_AGENT_IDLE_TIMEOUT_MS: "-1" }), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(resolveIdleTimeoutMs(undefined, { FORGE_AGENT_IDLE_TIMEOUT_MS: "" }), DEFAULT_IDLE_TIMEOUT_MS);
});

test("resolveIdleTimeoutMs: precedence env > runtime YAML > default", () => {
  // Runtime YAML (seconds) is used when no env override is set.
  assert.equal(resolveIdleTimeoutMs(300, {}), 300_000);
  // Env override wins over the runtime value.
  assert.equal(resolveIdleTimeoutMs(300, { FORGE_AGENT_IDLE_TIMEOUT_MS: "5000" }), 5000);
  // Env can disable even when a runtime value is present.
  assert.equal(resolveIdleTimeoutMs(300, { FORGE_AGENT_IDLE_TIMEOUT_MS: "0" }), 0);
  // Invalid runtime value falls through to the hardcoded default.
  assert.equal(resolveIdleTimeoutMs(-5, {}), DEFAULT_IDLE_TIMEOUT_MS);
});
