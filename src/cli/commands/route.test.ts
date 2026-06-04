// `forge route validate` command tests (#278) — the fs/yaml-aware wrapper.
// The pure resolution/drift logic is covered in src/raci/route-validate.test.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { validateRoutePolicyFile, renderHuman } from "./route.js";
import { compileRaciDocument } from "../../raci/compile.js";
import type { HostEnv } from "../../raci/route-validate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "..", "seeds", "forge-raci.md");
const all: HostEnv = { agentInstalled: () => true, workflowKnown: () => true };

let dir: string;
let policyPath: string;
let raciPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-route-test-"));
  const seed = readFileSync(SEED_PATH, "utf8");
  raciPath = join(dir, "forge-raci.md");
  writeFileSync(raciPath, seed);
  policyPath = join(dir, "routing-policy.yml");
  writeFileSync(policyPath, yamlStringify(compileRaciDocument(seed)));
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("missing policy is policy_not_found (never compiles from RACI)", () => {
  const v = validateRoutePolicyFile(join(dir, "nope.yml"), { host: all });
  assert.equal(v.ok, false);
  assert.equal(v.findings[0]!.code, "policy_not_found");
});

test("a valid compiled policy validates clean (standalone)", () => {
  const v = validateRoutePolicyFile(policyPath, { host: all });
  assert.equal(v.ok, true, JSON.stringify(v.findings));
  assert.equal(v.mode, "standalone");
});

test("with a matching --raci there is no drift", () => {
  const v = validateRoutePolicyFile(policyPath, { raciPath, host: all });
  assert.equal(v.mode, "with-raci");
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("a drifted policy is reported against --raci", () => {
  const drifted = join(dir, "drifted.yml");
  const policy = compileRaciDocument(readFileSync(raciPath, "utf8")) as Record<string, any>;
  policy.routes.research.responsible = "someone-else";
  writeFileSync(drifted, yamlStringify(policy));
  const v = validateRoutePolicyFile(drifted, { raciPath, host: all });
  assert.ok(v.findings.some((f) => f.code === "policy_drift" && f.route === "research"));
});

test("an explicit but missing --raci is raci_not_found", () => {
  const v = validateRoutePolicyFile(policyPath, { raciPath: join(dir, "no-raci.md"), host: all });
  assert.equal(v.ok, false);
  assert.equal(v.findings[0]!.code, "raci_not_found");
});

test("renderHuman shows mode + findings", () => {
  assert.match(renderHuman("/x/p.yml", { ok: true, mode: "standalone", findings: [] }), /OK/);
  const bad = renderHuman("/x/p.yml", {
    ok: false,
    mode: "with-raci",
    findings: [{ code: "policy_drift", route: "r", message: "differs" }],
  });
  assert.match(bad, /policy_drift/);
});
