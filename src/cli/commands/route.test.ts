// `forge route validate` command tests (#278) — the fs/yaml-aware wrapper.
// The pure resolution/drift logic is covered in src/raci/route-validate.test.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { validateRoutePolicyFile, renderHuman, explainRoute, explainRouteFile } from "./route.js";
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

test("explainRoute returns the full route for an exact key", () => {
  const policy = compileRaciDocument(readFileSync(SEED_PATH, "utf8"));
  const res = explainRoute(policy, "implementation_quick");
  assert.ok(res.ok);
  assert.equal(res.route.responsible, "engineer");
  assert.equal(res.route.path, "invoke_chain");
  assert.deepEqual(res.route.required_followups, ["test-engineer"]);
});

test("explainRoute flags an unknown key (and lists known routes)", () => {
  const policy = compileRaciDocument(readFileSync(SEED_PATH, "utf8"));
  const res = explainRoute(policy, "not_a_route");
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.findings[0]!.code === "unknown_route");
  assert.ok(!res.ok && /research/.test(res.findings[0]!.message));
});

test("explainRoute flags a schema-invalid policy", () => {
  const res = explainRoute({ version: 1, governance: { accountable: "user" }, routes: {} }, "x");
  assert.equal(res.ok, false);
});

test("proof of life: editing the RACI changes the explained route", () => {
  const raci = readFileSync(SEED_PATH, "utf8");

  const before = explainRoute(compileRaciDocument(raci), "research");
  assert.ok(before.ok);
  assert.equal(before.route.responsible, "research-specialist");

  // Edit the RACI source, recompile, explain again — the route must change.
  const edited = raci.replace("responsible: research-specialist", "responsible: deep-researcher");
  const after = explainRoute(compileRaciDocument(edited), "research");
  assert.ok(after.ok);
  assert.equal(after.route.responsible, "deep-researcher");
  assert.notEqual(before.route.responsible, after.route.responsible);
});

test("explainRouteFile: missing policy is a structured policy_not_found", () => {
  const res = explainRouteFile(join(dir, "nope.yml"), "research");
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.findings[0]!.code === "policy_not_found");
});

test("explainRouteFile: corrupt YAML is a structured policy_parse_error (not a crash)", () => {
  const bad = join(dir, "bad.yml");
  writeFileSync(bad, "routes: [1, 2"); // unterminated flow — yaml.parse throws
  const res = explainRouteFile(bad, "research");
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.findings[0]!.code === "policy_parse_error");
});

test("explainRouteFile: explains a valid policy file by key", () => {
  const res = explainRouteFile(policyPath, "research");
  assert.ok(res.ok);
  assert.equal(res.route.responsible, "research-specialist");
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
