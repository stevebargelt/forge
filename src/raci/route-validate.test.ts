// Operational-policy lint tests (#278) — pure core with injected host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRoutePolicy, checkForceRuleWeakening, type HostEnv } from "./route-validate.js";
import { compileRaciDocument } from "./compile.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "seeds", "forge-raci.md");

const all: HostEnv = { agentInstalled: () => true, workflowKnown: () => true };
const none: HostEnv = { agentInstalled: () => false, workflowKnown: () => false };

const raci = () => readFileSync(SEED_PATH, "utf8");
const seedPolicy = () => compileRaciDocument(raci());

function compile(block: string): unknown {
  return compileRaciDocument(block);
}

const CLI_BLOCK = `### route: ops
classification_hints: retry
responsible: forge-ops-repair
accountable: human
path: cli
command: forge ops repair
consulted: none
required_followups: none
informed: user_summary
force_rules: none`;

test("seed policy resolves clean when everything is installed", () => {
  const v = validateRoutePolicy(seedPolicy(), all);
  assert.equal(v.ok, true, JSON.stringify(v.findings));
  assert.equal(v.mode, "standalone");
});

test("agents and workflows are flagged when nothing is installed", () => {
  const v = validateRoutePolicy(seedPolicy(), none);
  assert.equal(v.ok, false);
  // engineer (invoke_chain) and feature (workflow) are unresolved...
  assert.ok(v.findings.some((f) => f.code === "responsible_unresolved" && f.route === "implementation_quick"));
  assert.ok(v.findings.some((f) => f.code === "responsible_unresolved" && f.route === "implementation_full"));
  // ...but orchestrator/in_session routes are built-in and resolve.
  assert.ok(!v.findings.some((f) => f.route === "orientation"));
});

test("evidence-source consults resolve even when not installed agents", () => {
  const v = validateRoutePolicy(seedPolicy(), none);
  // implementation_quick consults affected_code + existing_tests (evidence sources)
  assert.ok(!v.findings.some((f) => f.code === "consulted_unresolved" && f.route === "implementation_quick"));
});

test("an unknown consulted symbol is flagged", () => {
  const policy = compile(
    `### route: x\nclassification_hints: y\nresponsible: orchestrator\naccountable: human\npath: in_session\nconsulted: not_a_real_thing\nrequired_followups: none\ninformed: user_summary\nforce_rules: none`,
  );
  const v = validateRoutePolicy(policy, none);
  assert.ok(v.findings.some((f) => f.code === "consulted_unresolved" && f.route === "x"));
});

test("cli responsible resolves against the action registry", () => {
  const good = validateRoutePolicy(compile(CLI_BLOCK), none);
  assert.equal(good.ok, true, JSON.stringify(good.findings));

  const badPolicy = structuredClone(compile(CLI_BLOCK)) as any;
  badPolicy.routes.ops.responsible = "made-up-action";
  const bad = validateRoutePolicy(badPolicy, none);
  assert.ok(bad.findings.some((f) => f.code === "responsible_unresolved" && f.route === "ops"));
});

test("a cli command that doesn't match the registered action is flagged", () => {
  const bad = structuredClone(compile(CLI_BLOCK)) as any;
  bad.routes.ops.command = "forge made up";
  const v = validateRoutePolicy(bad, none);
  assert.ok(v.findings.some((f) => f.code === "command_mismatch" && f.route === "ops"));
});

test("a built-in does not bypass path resolution (cli + orchestrator is flagged)", () => {
  // path: cli with a non-CLI-action responsible must NOT validate just because
  // it's a built-in symbol.
  const policy = compile(
    `### route: bad_cli\nclassification_hints: x\nresponsible: orchestrator\naccountable: human\npath: cli\ncommand: forge made up\nconsulted: none\nrequired_followups: none\ninformed: user_summary\nforce_rules: none`,
  );
  const v = validateRoutePolicy(policy, all);
  assert.ok(v.findings.some((f) => f.code === "responsible_unresolved" && f.route === "bad_cli"));
});

test("a built-in required followup is rejected (followups must be agents)", () => {
  const policy = compile(
    `### route: x\nclassification_hints: y\nresponsible: orchestrator\naccountable: human\npath: in_session\nconsulted: none\nrequired_followups: orchestrator\ninformed: user_summary\nforce_rules: none`,
  );
  const v = validateRoutePolicy(policy, none);
  assert.ok(v.findings.some((f) => f.code === "followup_unresolved" && f.route === "x"));
});

test("schema-invalid input yields schema_error and stops", () => {
  const v = validateRoutePolicy({ version: 1, governance: { accountable: "user" }, routes: {} }, all);
  assert.equal(v.ok, false);
  assert.ok(v.findings.every((f) => f.code === "schema_error"));
});

test("standalone mode does not produce drift findings", () => {
  const v = validateRoutePolicy(seedPolicy(), all);
  assert.equal(v.mode, "standalone");
  assert.ok(!v.findings.some((f) => f.code === "policy_drift"));
});

test("with-raci mode: matching policy has no drift", () => {
  const v = validateRoutePolicy(seedPolicy(), all, raci());
  assert.equal(v.mode, "with-raci");
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("with-raci mode: a differing route is reported as drift", () => {
  const mutated = structuredClone(seedPolicy()) as any;
  mutated.routes.implementation_quick.responsible = "frontend-specialist";
  const v = validateRoutePolicy(mutated, all, raci());
  assert.ok(v.findings.some((f) => f.code === "policy_drift" && f.route === "implementation_quick"));
});

test("with-raci mode: a route missing from the policy is drift", () => {
  const mutated = structuredClone(seedPolicy()) as any;
  delete mutated.routes.research;
  const v = validateRoutePolicy(mutated, all, raci());
  assert.ok(
    v.findings.some((f) => f.code === "policy_drift" && f.route === "research" && /missing from the policy/.test(f.message)),
  );
});

// ── project override: force-rule non-weakening (#280) ────────────────────────

// A route carrying a synthetic force rule. force_rules resolution is dormant
// (empty baseline), so these compile and validate without complaint — letting us
// prove the structural weakening check works ahead of any real baseline.
const forced = (rules: string) =>
  compileRaciDocument(
    `### route: shared\nclassification_hints: y\nresponsible: orchestrator\naccountable: human\npath: in_session\nconsulted: none\nrequired_followups: none\ninformed: user_summary\nforce_rules: ${rules}`,
  );

test("checkForceRuleWeakening: dormant — the seed carries no force rules, no findings", () => {
  assert.deepEqual(checkForceRuleWeakening(seedPolicy(), seedPolicy()), []);
});

test("checkForceRuleWeakening: a project dropping a host force rule is flagged", () => {
  const f = checkForceRuleWeakening(forced("protect_attribution"), forced("none"));
  assert.equal(f.length, 1);
  assert.equal(f[0]!.code, "force_rule_weakened");
  assert.equal(f[0]!.route, "shared");
  assert.match(f[0]!.message, /protect_attribution/);
});

test("checkForceRuleWeakening: keeping or strengthening the force rule is fine", () => {
  assert.deepEqual(checkForceRuleWeakening(forced("protect_attribution"), forced("protect_attribution")), []);
  assert.deepEqual(
    checkForceRuleWeakening(forced("protect_attribution"), forced("protect_attribution, extra_rule")),
    [],
  );
});

test("checkForceRuleWeakening: omitting the route entirely is not weakening a shared rule", () => {
  const project = compileRaciDocument(
    `### route: other\nclassification_hints: y\nresponsible: orchestrator\naccountable: human\npath: in_session\nconsulted: none\nrequired_followups: none\ninformed: user_summary\nforce_rules: none`,
  );
  assert.deepEqual(checkForceRuleWeakening(forced("protect_attribution"), project), []);
});
