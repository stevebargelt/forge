// RACI compiler tests (#276): parsed record blocks -> derived RoutingPolicy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileRaciDocument, compileRaciToPolicy } from "./compile.js";
import { parseRaci } from "./parse.js";
import { RoutingPolicySchema } from "./policy-schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "seeds", "forge-raci.md");

const BUG_FIX = `### route: bug_fix

classification_hints: bug, defect, failing test
responsible: engineer
accountable: human
path: invoke_chain
consulted: affected_code, existing_tests
required_followups: test-engineer
informed: user_summary, backlog:when=ticketed
force_rules: none`;

const OPS_CLI = `### route: ops_retry_orphan_repair

classification_hints: retry_orphan
responsible: forge-ops-repair
accountable: human
path: cli
command: forge ops repair
consulted: none
required_followups: none
informed: user_summary, event_log
force_rules: none`;

test("compiles a representative non-cli route", () => {
  const policy = compileRaciDocument(BUG_FIX);
  const r = policy.routes.bug_fix;
  assert.ok(r);
  assert.deepEqual(r.classification_hints, ["bug", "defect", "failing test"]);
  assert.equal(r.responsible, "engineer");
  assert.equal(r.path, "invoke_chain");
  assert.equal(r.command, undefined);
  assert.deepEqual(r.consulted, ["affected_code", "existing_tests"]);
  assert.deepEqual(r.required_followups, ["test-engineer"]);
});

test("compiles a cli route and keeps command", () => {
  const policy = compileRaciDocument(OPS_CLI);
  const r = policy.routes.ops_retry_orphan_repair;
  assert.ok(r);
  assert.equal(r.path, "cli");
  assert.equal(r.command, "forge ops repair");
});

test("hoists accountable to the header and never emits it per-route", () => {
  const policy = compileRaciDocument(BUG_FIX);
  assert.equal(policy.governance.accountable, "human");
  // no route carries accountable
  for (const r of Object.values(policy.routes)) {
    assert.equal((r as Record<string, unknown>)["accountable"], undefined);
  }
});

test("converts source `none` lists to empty arrays", () => {
  const policy = compileRaciDocument(OPS_CLI);
  const r = policy.routes.ops_retry_orphan_repair;
  assert.ok(r);
  assert.deepEqual(r.consulted, []);
  assert.deepEqual(r.required_followups, []);
  assert.deepEqual(r.force_rules, []);
});

test("normalizes conditional informed values to { name, when? } objects", () => {
  const policy = compileRaciDocument(BUG_FIX);
  assert.deepEqual(policy.routes.bug_fix!.informed, [
    { name: "user_summary" },
    { name: "backlog", when: "ticketed" },
  ]);
});

test("output validates against RoutingPolicySchema", () => {
  const policy = compileRaciDocument(`${BUG_FIX}\n\n${OPS_CLI}`);
  assert.equal(RoutingPolicySchema.safeParse(policy).success, true);
});

test("route count and key order match the source", () => {
  const doc = `${BUG_FIX}\n\n${OPS_CLI}`;
  const records = parseRaci(doc);
  const policy = compileRaciToPolicy(records);
  assert.deepEqual(Object.keys(policy.routes), records.map((r) => r.route));
});

test("the real seeds/forge-raci.md compiles and validates", () => {
  const policy = compileRaciDocument(readFileSync(SEED_PATH, "utf8"));
  assert.equal(RoutingPolicySchema.safeParse(policy).success, true);
  // every source route is present and accountable lives only in the header
  assert.equal(policy.governance.accountable, "human");
  assert.ok(Object.keys(policy.routes).length >= 19);
});

test("representative seed routes compile to the expected shape", () => {
  const policy = compileRaciDocument(readFileSync(SEED_PATH, "utf8"));

  const implFull = policy.routes.implementation_full;
  assert.ok(implFull);
  assert.equal(implFull.responsible, "feature");
  assert.equal(implFull.path, "workflow");
  assert.equal(implFull.command, undefined);
  assert.deepEqual(implFull.informed, [
    { name: "user_summary" },
    { name: "backlog", when: "ticketed" },
    { name: "docs_impact", when: "operator_behavior_changed" },
  ]);

  const implQuick = policy.routes.implementation_quick;
  assert.ok(implQuick);
  assert.equal(implQuick.responsible, "engineer");
  assert.equal(implQuick.path, "invoke_chain");
  assert.deepEqual(implQuick.consulted, ["affected_code", "existing_tests"]);
  assert.deepEqual(implQuick.required_followups, ["test-engineer"]);

  const uiDesign = policy.routes.ui_design;
  assert.ok(uiDesign);
  assert.equal(uiDesign.responsible, "prompt-author");
  assert.equal(uiDesign.path, "invoke");
  assert.deepEqual(uiDesign.consulted, ["design_artifacts"]);
  assert.deepEqual(uiDesign.informed, [
    { name: "user_summary" },
    { name: "handoff_notes", when: "session_boundary" },
  ]);

  const orientation = policy.routes.orientation;
  assert.ok(orientation);
  assert.equal(orientation.responsible, "orchestrator");
  assert.equal(orientation.path, "in_session");

  const research = policy.routes.research;
  assert.ok(research);
  assert.equal(research.responsible, "research-specialist");
  assert.equal(research.path, "invoke");
});
