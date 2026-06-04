// Routing-policy schema tests (#275). SHAPE validation of the derived
// routing-policy.yml — no compiler, no CLI, no semantic resolution.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RoutingPolicySchema } from "./policy-schema.js";

/** A minimal valid policy. Helpers clone + mutate it per case. */
function validPolicy(): unknown {
  return {
    version: 1,
    governance: { accountable: "human" },
    routes: {
      bug_fix: {
        responsible: "engineer",
        path: "invoke_chain",
        consulted: ["affected_code", "existing_tests"],
        required_followups: ["test-engineer"],
        informed: [{ name: "user_summary" }, { name: "backlog", when: "ticketed" }],
        force_rules: [],
      },
    },
  };
}

// deep clone via structuredClone (Node 18+)
const clone = () => structuredClone(validPolicy()) as Record<string, any>;
const ok = (p: unknown) => RoutingPolicySchema.safeParse(p).success;

test("valid minimal policy parses", () => {
  assert.equal(ok(validPolicy()), true);
});

test("governance.accountable: human is required at the header", () => {
  const p = clone();
  delete p.governance;
  assert.equal(ok(p), false);
});

test("missing accountable is rejected", () => {
  const p = clone();
  p.governance = {};
  assert.equal(ok(p), false);
});

test("non-human accountable is rejected", () => {
  const p = clone();
  p.governance = { accountable: "user" };
  assert.equal(ok(p), false);
});

test("per-route accountable is rejected (strict)", () => {
  const p = clone();
  p.routes.bug_fix.accountable = "human";
  assert.equal(ok(p), false);
});

test("valid CLI route with command parses", () => {
  const p = clone();
  p.routes.ops_repair = {
    responsible: "forge-ops-repair",
    path: "cli",
    command: "forge ops repair",
    consulted: ["ops_incident"],
    required_followups: [],
    informed: [{ name: "user_summary" }, { name: "event_log" }],
    force_rules: [],
  };
  assert.equal(ok(p), true);
});

test("CLI route missing command is rejected", () => {
  const p = clone();
  p.routes.bug_fix.path = "cli"; // no command
  assert.equal(ok(p), false);
});

test("non-CLI route with a command is rejected", () => {
  const p = clone();
  p.routes.bug_fix.command = "forge do thing"; // path is invoke_chain
  assert.equal(ok(p), false);
});

test("empty arrays are valid", () => {
  const p = clone();
  p.routes.bug_fix.consulted = [];
  p.routes.bug_fix.required_followups = [];
  p.routes.bug_fix.informed = [];
  p.routes.bug_fix.force_rules = [];
  assert.equal(ok(p), true);
});

test("`none` is rejected inside arrays", () => {
  for (const field of ["consulted", "required_followups", "force_rules"]) {
    const p = clone();
    p.routes.bug_fix[field] = ["none"];
    assert.equal(ok(p), false, `${field}: ["none"] should be rejected`);
  }
  const p = clone();
  p.routes.bug_fix.informed = [{ name: "none" }];
  assert.equal(ok(p), false, 'informed name "none" should be rejected');
});

test("classification_hints: array of non-empty strings, spaces allowed", () => {
  const good = clone();
  good.routes.bug_fix.classification_hints = ["bug", "failing test"];
  assert.equal(ok(good), true);

  const empty = clone();
  empty.routes.bug_fix.classification_hints = ["bug", ""];
  assert.equal(ok(empty), false);
});

test("informed requires normalized object form", () => {
  const bare = clone();
  bare.routes.bug_fix.informed = ["user_summary"]; // bare string — not allowed
  assert.equal(ok(bare), false);

  const objForm = clone();
  objForm.routes.bug_fix.informed = [{ name: "backlog", when: "ticketed" }];
  assert.equal(ok(objForm), true);

  const emptyWhen = clone();
  emptyWhen.routes.bug_fix.informed = [{ name: "backlog", when: "" }];
  assert.equal(ok(emptyWhen), false); // when must be a symbol
});

test("malformed symbols are rejected", () => {
  const badResponsible = clone();
  badResponsible.routes.bug_fix.responsible = "red wide";
  assert.equal(ok(badResponsible), false);

  const badConsulted = clone();
  badConsulted.routes.bug_fix.consulted = ["affected code"];
  assert.equal(ok(badConsulted), false);

  const badKey = clone();
  badKey.routes["Bug Fix"] = badKey.routes.bug_fix;
  delete badKey.routes.bug_fix;
  assert.equal(ok(badKey), false);
});

test("unknown path is rejected", () => {
  const p = clone();
  p.routes.bug_fix.path = "teleport";
  assert.equal(ok(p), false);
});

test("version must be 1", () => {
  const p = clone();
  p.version = 2;
  assert.equal(ok(p), false);
});
