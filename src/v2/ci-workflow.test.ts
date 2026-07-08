// FG-474 regression guard: `.github/workflows/ci.yml` is the required merge-gate
// check. It must actually run the deterministic suite the orchestrator now
// defers to (CLAUDE.md's "Merge authorization") instead of a host re-run — if a
// future edit drops a step, mistargets the trigger, or unpins Node, the gate
// stops proving what the docs claim it proves, silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { REQUIRED_CI_CHECK_CONTEXT, REQUIRED_CI_GATE_COMMAND } from "../store/host-verifications.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_PATH = join(root, ".github", "workflows", "ci.yml");

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = {
  on?: { push?: unknown; pull_request?: { branches?: string[] } };
  jobs?: Record<string, { "runs-on"?: string; steps?: Step[] }>;
};

function loadWorkflow(): Workflow {
  return parseYaml(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

test("FG-474: ci.yml parses as valid YAML", () => {
  assert.doesNotThrow(() => loadWorkflow());
});

test("FG-474: ci.yml triggers on push and on pull_request into main", () => {
  const wf = loadWorkflow();
  assert.ok(wf.on?.push !== undefined, "must trigger on push (feature-branch visibility)");
  assert.ok(
    wf.on?.pull_request?.branches?.includes("main"),
    "must trigger on pull_request into main (the PR check the merge gate reads)"
  );
});

test("FG-474: ci.yml has a job whose steps run the full deterministic gate", () => {
  const wf = loadWorkflow();
  const jobs = wf.jobs ?? {};
  const job = Object.values(jobs)[0];
  assert.ok(job, "workflow must define at least one job");
  const steps = job!.steps ?? [];
  const runCommands = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
  const usesRefs = steps.map((s) => s.uses).filter((u): u is string => typeof u === "string");

  assert.ok(usesRefs.some((u) => u.startsWith("actions/checkout")), "must check out the repo");
  assert.ok(
    usesRefs.some((u) => u.startsWith("actions/setup-node")),
    "must set up Node via actions/setup-node"
  );
  assert.ok(
    runCommands.some((r) => r.includes("npm ci")),
    "must install dependencies with npm ci"
  );
  assert.ok(
    runCommands.some((r) => r.includes("better-sqlite3")),
    "must rebuild/verify the better-sqlite3 native module so its ABI matches the pinned Node version"
  );
  assert.ok(
    runCommands.some((r) => r.includes("npm run typecheck")),
    "must run typecheck — CLAUDE.md's merge gate names typecheck explicitly"
  );
  assert.ok(
    runCommands.some((r) => r.includes("npm run test:all")),
    "must run the shipped-claim aggregate (root + dashboard workspace), not just the root suite"
  );
});

test("FG-474 red-review fix: ci.yml's test job actually runs REQUIRED_CI_GATE_COMMAND — the command CI-sourced host_verifications evidence is pinned to", () => {
  const wf = loadWorkflow();
  const steps = Object.values(wf.jobs ?? {})[0]?.steps ?? [];
  const runCommands = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
  assert.ok(
    runCommands.some((r) => r.includes(REQUIRED_CI_GATE_COMMAND)),
    `ci.yml must run REQUIRED_CI_GATE_COMMAND ("${REQUIRED_CI_GATE_COMMAND}") — a green "${REQUIRED_CI_CHECK_CONTEXT}" check only ever proves this command ran; if the workflow's actual command drifts from this constant, a CI-sourced host_verifications row would mislabel a command CI never ran (the FG-419 gate_name spoofing vector)`
  );
});

test("FG-474: ci.yml pins Node via the repo's .nvmrc rather than a hardcoded/latest version", () => {
  const wf = loadWorkflow();
  const steps = Object.values(wf.jobs ?? {})[0]?.steps ?? [];
  const setupNode = steps.find((s) => s.uses?.startsWith("actions/setup-node"));
  assert.ok(setupNode, "must have an actions/setup-node step");
  assert.equal(
    setupNode!.with?.["node-version-file"],
    ".nvmrc",
    "must read node-version-file from .nvmrc so CI can't drift from the ABI the native module was built for"
  );
});

test("FG-474: .nvmrc pins the Node major version the better-sqlite3 ABI note references", () => {
  const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
  assert.equal(nvmrc, "24", ".nvmrc must stay pinned to 24 — the ABI mismatch this workflow guards against was observed against this exact version");
});
