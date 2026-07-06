// FG-357: direct integration-tier tests for the post-merge integration gate
// module itself.
//
// The dispatch-level worktree tests (fg357-dispatch.worktree.test.ts) exercise
// runIntegrationGate() only indirectly, through the full dispatchSingleStep /
// dispatchFanoutStep orchestration — slow, and each case only touches the
// pass/fail happy paths reachable through a real merge. This file spawns real
// npm processes against real temp directories to cover the module's own
// branches directly: the hasTestUnitScript skip logic (no package.json,
// malformed package.json, no test:unit script), captured stdout/stderr on
// failure, and the FORGE_INTEGRATION_GATE_TIMEOUT_MS override — none of which
// are reachable, or fast to reach, through the dispatch seam.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegrationGate } from "./integration-gate.js";

let dir: string;
const savedTimeoutEnv = process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-integration-gate-"));
  delete process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedTimeoutEnv === undefined) delete process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS;
  else process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS = savedTimeoutEnv;
});

function writePackageJson(scripts: Record<string, string> | undefined): void {
  const pkg: Record<string, unknown> = { name: "gate-fixture", private: true };
  if (scripts) pkg.scripts = scripts;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
}

// ─── Skip (no-op pass-through) branches ───────────────────────────────────────

test("runIntegrationGate: no package.json at all → skipped, ok:true", () => {
  const result = runIntegrationGate(dir);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.output, /skipped/i);
});

test("runIntegrationGate: package.json with no scripts field → skipped, ok:true", () => {
  writePackageJson(undefined);
  const result = runIntegrationGate(dir);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.output, /skipped/i);
});

test("runIntegrationGate: package.json with scripts but no test:unit → skipped, ok:true", () => {
  writePackageJson({ build: "true" });
  const result = runIntegrationGate(dir);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.output, /skipped/i);
});

test("runIntegrationGate: malformed package.json (invalid JSON) → skipped, ok:true, no throw", () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{ not valid json");
  const result = runIntegrationGate(dir);
  assert.equal(result.ok, true, "a malformed package.json must not crash the gate or block the merge");
  if (result.ok) assert.match(result.output, /skipped/i);
});

// ─── Real npm run test:unit — pass/fail branches ──────────────────────────────

test("runIntegrationGate: test:unit script exits 0 → ok:true with captured output", () => {
  writePackageJson({ "test:unit": "echo integration-gate-pass-marker" });
  const result = runIntegrationGate(dir);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.output, /integration-gate-pass-marker/);
});

test("runIntegrationGate: test:unit script exits non-zero → ok:false with captured stdout/stderr and error", () => {
  writePackageJson({
    "test:unit": "echo integration-gate-fail-stdout && echo integration-gate-fail-stderr 1>&2 && exit 1",
  });
  const result = runIntegrationGate(dir);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.output, /integration-gate-fail-stdout/, "stdout must be captured");
    assert.match(result.output, /integration-gate-fail-stderr/, "stderr must be captured");
    assert.ok(result.error.length > 0, "a non-empty error message must be recorded");
    assert.ok(typeof result.status === "number" && result.status > 0, "an ordinary non-zero exit must report a positive status");
    assert.ok(!result.signal, "an ordinary non-zero exit must not report a signal");
    assert.equal(result.timedOut, false, "an ordinary non-zero exit must not be reported as a timeout");
  }
});

test("runIntegrationGate: test:unit script killed by signal (not timeout, not a normal exit) → ok:false with signal populated", () => {
  writePackageJson({ "test:unit": "kill -9 $$" });
  const result = runIntegrationGate(dir);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.signal, "a signal-killed script must report the signal");
    assert.equal(result.timedOut, false, "a signal-kill outside the timeout path must not be reported as a timeout");
  }
});

// ─── FORGE_INTEGRATION_GATE_TIMEOUT_MS override ───────────────────────────────

test("runIntegrationGate: FORGE_INTEGRATION_GATE_TIMEOUT_MS cuts off a hanging test:unit script → ok:false", () => {
  writePackageJson({ "test:unit": "sleep 5" });
  process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS = "300";

  const start = Date.now();
  const result = runIntegrationGate(dir);
  const elapsed = Date.now() - start;

  assert.equal(result.ok, false, "a script that outlives the configured timeout must fail the gate");
  assert.ok(elapsed < 5000, `gate must respect the short timeout override, not the 5s script (took ${elapsed}ms)`);
  if (!result.ok) assert.equal(result.timedOut, true, "a timeout-cutoff run must report timedOut: true");
});

test("runIntegrationGate: non-numeric FORGE_INTEGRATION_GATE_TIMEOUT_MS falls back to default without crashing", () => {
  writePackageJson({ "test:unit": "true" });
  process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS = "not-a-number";

  const result = runIntegrationGate(dir);
  assert.equal(result.ok, true, "an invalid timeout override must not break the gate — falls back to the default");
});
