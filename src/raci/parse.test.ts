// RACI record-block parser — grammar tests.
//
// Covers the brutal parsing rules from docs/prds/raci-routing-policy.md:
// block markers, required fields, command-iff-cli, accountable=human, path
// enum, unique keys, none sentinel, conditionals, prose-outside-ignored.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRaci, RaciParseError } from "./parse.js";

const BUG_FIX = `### route: bug_fix

classification_hints: bug, defect, failing test
responsible: engineer
accountable: human
path: invoke_chain
consulted: affected_code, existing_tests
required_followups: test-engineer
informed: user_summary, backlog:when=ticketed, docs_impact:when=operator_behavior_changed
force_rules: requires_tests`;

const OPS_CLI = `### route: ops_retry_orphan_repair

classification_hints: retry_orphan, orphaned retry
responsible: forge-ops-repair
accountable: human
path: cli
command: forge ops repair
consulted: ops_incident
required_followups: none
informed: user_summary, event_log, ops_check
force_rules: ops_repair_ask`;

test("parses a complete invoke_chain route", () => {
  const [r] = parseRaci(BUG_FIX);
  assert.ok(r);
  assert.equal(r.route, "bug_fix");
  assert.deepEqual(r.classificationHints, ["bug", "defect", "failing test"]);
  assert.equal(r.responsible, "engineer");
  assert.equal(r.accountable, "human");
  assert.equal(r.path, "invoke_chain");
  assert.equal(r.command, undefined);
  assert.deepEqual(r.consulted, ["affected_code", "existing_tests"]);
  assert.deepEqual(r.requiredFollowups, ["test-engineer"]);
  assert.deepEqual(r.informed, [
    { name: "user_summary" },
    { name: "backlog", when: "ticketed" },
    { name: "docs_impact", when: "operator_behavior_changed" },
  ]);
  assert.deepEqual(r.forceRules, ["requires_tests"]);
});

test("parses a cli route with command", () => {
  const [r] = parseRaci(OPS_CLI);
  assert.ok(r);
  assert.equal(r.path, "cli");
  assert.equal(r.command, "forge ops repair");
  assert.equal(r.responsible, "forge-ops-repair");
  assert.deepEqual(r.requiredFollowups, []); // `none` sentinel
});

test("parses multiple route blocks", () => {
  const routes = parseRaci(`${BUG_FIX}\n\n${OPS_CLI}`);
  assert.equal(routes.length, 2);
  assert.deepEqual(
    routes.map((r) => r.route),
    ["bug_fix", "ops_retry_orphan_repair"],
  );
});

test("`none` is the only empty-list sentinel", () => {
  const [r] = parseRaci(OPS_CLI);
  assert.deepEqual(r!.requiredFollowups, []);
  // a real symbol named anything-but-none stays a one-element list
  const block = BUG_FIX.replace("force_rules: requires_tests", "force_rules: none");
  assert.deepEqual(parseRaci(block)[0]!.forceRules, []);
});

test("ignores free prose outside route blocks", () => {
  const doc = `# forge RACI

This intro paragraph is human context and must be ignored.

## Routes

${BUG_FIX}

Some explanatory prose between blocks — also ignored.

${OPS_CLI}
`;
  const routes = parseRaci(doc);
  assert.equal(routes.length, 2);
});

test("cli route without command throws", () => {
  const block = OPS_CLI.replace("command: forge ops repair\n", "");
  assert.throws(() => parseRaci(block), RaciParseError);
});

test("non-cli route with command throws", () => {
  const block = `${BUG_FIX}\ncommand: forge do thing`;
  assert.throws(() => parseRaci(block), /command is only allowed for path "cli"/);
});

test("accountable other than human throws", () => {
  const block = BUG_FIX.replace("accountable: human", "accountable: orchestrator");
  assert.throws(() => parseRaci(block), /accountable must be "human"/);
});

test("invalid path throws", () => {
  const block = BUG_FIX.replace("path: invoke_chain", "path: teleport");
  assert.throws(() => parseRaci(block), /invalid path "teleport"/);
});

test("duplicate route key throws", () => {
  assert.throws(() => parseRaci(`${BUG_FIX}\n\n${BUG_FIX}`), /duplicate route key: bug_fix/);
});

test("missing required field throws", () => {
  const block = BUG_FIX.replace("force_rules: requires_tests", "");
  assert.throws(() => parseRaci(block), /missing required field "force_rules"/);
});

test("unknown field throws", () => {
  const block = `${BUG_FIX}\nbogus_field: whatever`;
  assert.throws(() => parseRaci(block), /unknown field "bogus_field"/);
});

test("duplicate field throws", () => {
  const block = `${BUG_FIX}\nresponsible: someone-else`;
  assert.throws(() => parseRaci(block), /duplicate field "responsible"/);
});

test("empty document yields no routes", () => {
  assert.deepEqual(parseRaci(""), []);
  assert.deepEqual(parseRaci("# just prose\n\nnothing here\n"), []);
});

// --- strict list / symbol grammar ---

test("empty list item (double comma) throws", () => {
  const block = BUG_FIX.replace(
    "consulted: affected_code, existing_tests",
    "consulted: affected_code,, existing_tests",
  );
  assert.throws(() => parseRaci(block), /empty list item/);
});

test("leading comma throws", () => {
  const block = BUG_FIX.replace(
    "consulted: affected_code, existing_tests",
    "consulted: , affected_code",
  );
  assert.throws(() => parseRaci(block), /empty list item/);
});

test("trailing comma throws (classification_hints too)", () => {
  const block = BUG_FIX.replace(
    "classification_hints: bug, defect, failing test",
    "classification_hints: bug,",
  );
  assert.throws(() => parseRaci(block), /empty list item/);
});

test("`none` mixed with other values throws", () => {
  const block = BUG_FIX.replace("force_rules: requires_tests", "force_rules: none, requires_tests");
  assert.throws(() => parseRaci(block), /"none" must stand alone/);
});

test("malformed symbol in a symbol-only field throws", () => {
  const block = BUG_FIX.replace(
    "consulted: affected_code, existing_tests",
    "consulted: affected code",
  );
  assert.throws(() => parseRaci(block), /malformed symbol "affected code"/);
});

test("classification_hints still allow spaces (free phrases)", () => {
  const [r] = parseRaci(BUG_FIX);
  assert.deepEqual(r!.classificationHints, ["bug", "defect", "failing test"]);
});

test("malformed informed target throws", () => {
  const block = BUG_FIX.replace(/^informed: .+$/m, "informed: User_Summary");
  assert.throws(() => parseRaci(block), /informed target "User_Summary" is malformed/);
});

test("empty when= condition throws", () => {
  const block = BUG_FIX.replace(/^informed: .+$/m, "informed: backlog:when=");
  assert.throws(() => parseRaci(block), /informed condition "" on "backlog" is malformed/);
});

test("malformed route key throws", () => {
  const block = BUG_FIX.replace("### route: bug_fix", "### route: Bug Fix");
  assert.throws(() => parseRaci(block), /malformed route key "Bug Fix"/);
});

test("malformed responsible throws", () => {
  const block = BUG_FIX.replace("responsible: engineer", "responsible: red wide");
  assert.throws(() => parseRaci(block), /responsible "red wide" is malformed/);
});
