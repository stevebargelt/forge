// RACI authoring-view lint tests (#277).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRaci } from "./validate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "seeds", "forge-raci.md");

const BASE = `### route: bug_fix

classification_hints: bug, defect
responsible: engineer
accountable: human
path: invoke_chain
consulted: affected_code, existing_tests
required_followups: test-engineer
informed: user_summary, backlog:when=ticketed
force_rules: none`;

test("a well-formed document validates clean", () => {
  const v = validateRaci(BASE);
  assert.equal(v.ok, true);
  assert.deepEqual(v.findings, []);
});

test("the real seeds/forge-raci.md validates clean", () => {
  const v = validateRaci(readFileSync(SEED_PATH, "utf8"));
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("a grammar error is reported as a single parse_error finding", () => {
  const broken = BASE.replace("path: invoke_chain", "path: teleport");
  const v = validateRaci(broken);
  assert.equal(v.ok, false);
  assert.equal(v.findings.length, 1);
  assert.equal(v.findings[0]!.code, "parse_error");
});

test("informed targets outside the controlled vocabulary are flagged", () => {
  const block = BASE.replace("informed: user_summary, backlog:when=ticketed", "informed: user_summary, made_up_target");
  const v = validateRaci(block);
  assert.equal(v.ok, false);
  const f = v.findings.find((x) => x.code === "informed_unknown");
  assert.ok(f);
  assert.equal(f.route, "bug_fix");
  assert.match(f.message, /made_up_target/);
});

test("force_rules are NOT resolved while the baseline is empty (dormant)", () => {
  // `requires_tests` is a well-formed symbol but not in any baseline yet; with an
  // empty static baseline the resolution check is dormant, so this is clean.
  const block = BASE.replace("force_rules: none", "force_rules: requires_tests");
  const v = validateRaci(block);
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("findings collect across routes", () => {
  const bad1 = BASE.replace("informed: user_summary, backlog:when=ticketed", "informed: nope_one");
  const bad2 = `### route: other

classification_hints: x
responsible: engineer
accountable: human
path: invoke
consulted: none
required_followups: none
informed: nope_two
force_rules: none`;
  const v = validateRaci(`${bad1}\n\n${bad2}`);
  assert.equal(v.ok, false);
  const routes = v.findings.filter((f) => f.code === "informed_unknown").map((f) => f.route);
  assert.deepEqual(routes.sort(), ["bug_fix", "other"]);
});

test("the result is JSON-serializable", () => {
  const v = validateRaci(BASE);
  assert.doesNotThrow(() => JSON.stringify(v));
});
