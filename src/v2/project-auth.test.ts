import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadProjectAuthProfile, missingRequiredEnv, profileAllowsRole,
  produceStorageState, resolveProjectAuthForContainer, ProjectAuthError,
  type ProjectAuthProfile, type AuthCommandRunner,
} from "./project-auth.js";

let proj: string;
let taskDir: string;

const QA_YML = `
auth_profiles:
  qa:
    kind: project-command
    command: npm run e2e:auth
    storage_state: .playwright/.auth/qa.json
    required_env:
      - E2E_EMAIL
      - E2E_PASSWORD
    roles:
      - test-engineer
      - manual-qa
`;

function writeConfig(yml: string) {
  mkdirSync(join(proj, ".forge"), { recursive: true });
  writeFileSync(join(proj, ".forge", "auth-profiles.yml"), yml);
}

// A runner that "logs in" by writing a Playwright-shaped storage_state file.
function runnerWriting(stateRel: string): AuthCommandRunner {
  return (_cmd, cwd) => {
    const p = join(cwd, stateRel);
    mkdirSync(join(cwd, ".playwright", ".auth"), { recursive: true });
    writeFileSync(p, JSON.stringify({ cookies: [], origins: [{ origin: "http://localhost:3000", localStorage: [] }] }));
    return { ok: true, code: 0 };
  };
}

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), "forge-projauth-"));
  taskDir = mkdtempSync(join(tmpdir(), "forge-projauth-task-"));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(taskDir, { recursive: true, force: true });
});

// ── load ──

test("loadProjectAuthProfile: parses a valid project-command profile", () => {
  writeConfig(QA_YML);
  const p = loadProjectAuthProfile(proj, "qa")!;
  assert.equal(p.kind, "project-command");
  assert.equal(p.command, "npm run e2e:auth");
  assert.equal(p.storage_state, ".playwright/.auth/qa.json");
  assert.deepEqual(p.required_env, ["E2E_EMAIL", "E2E_PASSWORD"]);
});

test("loadProjectAuthProfile: undefined when file or named profile is absent", () => {
  assert.equal(loadProjectAuthProfile(proj, "qa"), undefined); // no file
  writeConfig(QA_YML);
  assert.equal(loadProjectAuthProfile(proj, "nope"), undefined); // wrong name
});

test("loadProjectAuthProfile: throws loudly on malformed config (typo'd key)", () => {
  writeConfig(`auth_profiles:\n  qa:\n    kind: project-command\n    command: x\n    storage_state: s.json\n    rolez: [a]\n`);
  assert.throws(() => loadProjectAuthProfile(proj, "qa"), ProjectAuthError);
});

// ── env (names only) + role gating ──

test("missingRequiredEnv: reports missing var NAMES only", () => {
  const p: ProjectAuthProfile = { kind: "project-command", command: "x", storage_state: "s.json", required_env: ["A", "B"] };
  assert.deepEqual(missingRequiredEnv(p, { A: "set" }), ["B"]);
  assert.deepEqual(missingRequiredEnv(p, { A: "set", B: "set" }), []);
  assert.deepEqual(missingRequiredEnv(p, { A: "set", B: "" }), ["B"], "empty counts as missing");
});

test("profileAllowsRole: reds NEVER get auth; scoped roles enforced; unscoped allows non-red", () => {
  const scoped: ProjectAuthProfile = { kind: "project-command", command: "x", storage_state: "s.json", roles: ["test-engineer"] };
  assert.equal(profileAllowsRole(scoped, "test-engineer"), true);
  assert.equal(profileAllowsRole(scoped, "manual-qa"), false, "not in scoped roles");
  assert.equal(profileAllowsRole(scoped, "red-security"), false, "reds excluded");

  const unscoped: ProjectAuthProfile = { kind: "project-command", command: "x", storage_state: "s.json" };
  assert.equal(profileAllowsRole(unscoped, "engineer"), true);
  assert.equal(profileAllowsRole(unscoped, "red-wide"), false, "reds excluded even when unscoped");
});

// ── produceStorageState ──

test("produceStorageState: missing env → throws BY NAME (no values)", () => {
  const p: ProjectAuthProfile = { kind: "project-command", command: "login", storage_state: "s.json", required_env: ["MISSING_VAR"] };
  assert.throws(
    () => produceStorageState(p, proj, { runner: () => ({ ok: true, code: 0 }) }),
    (e: Error) => /MISSING_VAR/.test(e.message),
  );
});

test("produceStorageState: command failure → secret-free error (no stderr surfaced)", () => {
  const p: ProjectAuthProfile = { kind: "project-command", command: "login", storage_state: "s.json" };
  const failing: AuthCommandRunner = () => ({ ok: false, code: 7 });
  assert.throws(
    () => produceStorageState(p, proj, { runner: failing }),
    (e: Error) => /exit 7/.test(e.message) && !/password|token|secret/i.test(e.message),
  );
});

test("produceStorageState: command 'succeeds' but no file → throws", () => {
  const p: ProjectAuthProfile = { kind: "project-command", command: "login", storage_state: ".playwright/.auth/qa.json" };
  const noop: AuthCommandRunner = () => ({ ok: true, code: 0 });
  assert.throws(() => produceStorageState(p, proj, { runner: noop }), /produced no storage_state/);
});

test("produceStorageState: success returns the produced file path", () => {
  const p: ProjectAuthProfile = { kind: "project-command", command: "login", storage_state: ".playwright/.auth/qa.json" };
  const path = produceStorageState(p, proj, { runner: runnerWriting(".playwright/.auth/qa.json") });
  assert.ok(path.endsWith(".playwright/.auth/qa.json"));
});

// ── resolveProjectAuthForContainer ──

test("resolveProjectAuthForContainer: refuses a red role", () => {
  const p: ProjectAuthProfile = { kind: "project-command", command: "login", storage_state: "s.json", roles: ["test-engineer"] };
  assert.throws(() => resolveProjectAuthForContainer(p, proj, taskDir, "red-security", { runner: runnerWriting("s.json") }), /not permitted|reds/i);
});

test("resolveProjectAuthForContainer: stages a mode-600 copy in the task dir", () => {
  const p: ProjectAuthProfile = { kind: "project-command", command: "login", storage_state: ".playwright/.auth/qa.json", roles: ["test-engineer"] };
  const staged = resolveProjectAuthForContainer(p, proj, taskDir, "test-engineer", { runner: runnerWriting(".playwright/.auth/qa.json") });
  assert.equal(staged.hostPath, join(taskDir, "auth-state.json"));
  assert.equal(statSync(staged.hostPath).mode & 0o777, 0o600, "staged auth must be mode 600");
  // origins reconciled for container access
  assert.ok(staged.origins.length > 0);
  // the staged copy is valid JSON (the reconciled state)
  JSON.parse(readFileSync(staged.hostPath, "utf8"));
});

test("produceStorageState: a timed-out login command → ProjectAuthError, NO command echoed (Findings 3+5)", () => {
  const p: ProjectAuthProfile = { kind: "project-command", command: "secret-login --password=hunter2", storage_state: "s.json" };
  const timingOut: AuthCommandRunner = () => ({ ok: false, code: -1, timedOut: true });
  assert.throws(
    () => produceStorageState(p, proj, { runner: timingOut }),
    (e: Error) => /timed out/.test(e.message) && !e.message.includes("hunter2") && !e.message.includes("secret-login"),
  );
});

test("produceStorageState: a failed command error never echoes the configured command (Finding 5)", () => {
  const p: ProjectAuthProfile = { kind: "project-command", command: "login --token=SECRET123", storage_state: "s.json" };
  assert.throws(
    () => produceStorageState(p, proj, { runner: () => ({ ok: false, code: 3 }) }),
    (e: Error) => /exit 3/.test(e.message) && !e.message.includes("SECRET123") && !e.message.includes("--token"),
  );
});
