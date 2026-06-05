// Orchestrator-mediated authoring core (#279) — pure gate + diff + summary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { proposeRaciChange, unifiedDiff } from "./propose.js";
import type { HostEnv } from "./route-validate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "seeds", "forge-raci.md");
const seed = () => readFileSync(SEED_PATH, "utf8");

const all: HostEnv = { agentInstalled: () => true, workflowKnown: () => true };
const none: HostEnv = { agentInstalled: () => false, workflowKnown: () => false };

// A unique anchor inside the implementation_quick block of the seed.
const IQ_ANCHOR = "responsible: engineer\naccountable: human\npath: invoke_chain";

// Small self-contained docs for the change-summary tests (independent of seed internals).
const route = (key: string, responsible: string) =>
  `### route: ${key}
classification_hints: x
responsible: ${responsible}
accountable: human
path: invoke_chain
consulted: none
required_followups: none
informed: user_summary
force_rules: none`;

test("accepted edit: a valid responsible change passes the gate and is summarized", () => {
  const current = seed();
  const candidate = current.replace(IQ_ANCHOR, "responsible: frontend-specialist\naccountable: human\npath: invoke_chain");
  const p = proposeRaciChange(current, candidate, all);

  assert.equal(p.ok, true, JSON.stringify(p.validation));
  assert.equal(p.validation.raci.ok, true);
  assert.equal(p.validation.route.ok, true);
  const mod = p.routeChanges.modified.find((m) => m.route === "implementation_quick");
  assert.ok(mod, "implementation_quick should be modified");
  assert.ok(mod!.fields.some((f) => f.field === "responsible" && f.after === "frontend-specialist"));
  assert.notEqual(p.raciDiff, "");
});

test("rejected edit: an unknown informed target fails raci validate (host-independent)", () => {
  const current = seed();
  const candidate = current.replace(
    "informed: user_summary, backlog:when=ticketed, docs_impact:when=operator_behavior_changed",
    "informed: not_a_real_target",
  );
  const p = proposeRaciChange(current, candidate, all);

  assert.equal(p.ok, false);
  assert.ok(p.validation.raci.findings.some((f) => f.code === "informed_unknown"));
});

test("rejected edit: an uninstalled agent fails route validate (host resolution)", () => {
  const current = seed();
  const candidate = current.replace(IQ_ANCHOR, "responsible: ghost-agent\naccountable: human\npath: invoke_chain");
  // raci validate is host-independent and passes; route validate must catch it.
  const p = proposeRaciChange(current, candidate, none);

  assert.equal(p.ok, false);
  assert.ok(
    p.validation.route.findings.some(
      (f) => f.code === "responsible_unresolved" && f.route === "implementation_quick",
    ),
  );
});

test("rejected edit: weakening accountable away from human is structurally blocked", () => {
  const current = seed();
  const candidate = current.replace(IQ_ANCHOR, "responsible: engineer\naccountable: user\npath: invoke_chain");
  const p = proposeRaciChange(current, candidate, all);

  assert.equal(p.ok, false);
  // The parser rejects non-human accountable, so the candidate never compiles.
  assert.ok(
    p.validation.raci.findings.some((f) => f.code === "parse_error") ||
      p.validation.route.findings.some((f) => f.code === "candidate_compile_error"),
  );
});

test("no-op candidate: gate passes, empty change summary, empty diff", () => {
  const current = seed();
  const p = proposeRaciChange(current, current, all);
  assert.equal(p.ok, true);
  assert.deepEqual(p.routeChanges, { added: [], removed: [], modified: [] });
  assert.equal(p.raciDiff, "");
});

test("change summary: added route", () => {
  const current = `${route("a", "engineer")}\n\n${route("b", "engineer")}`;
  const candidate = `${current}\n\n${route("c", "engineer")}`;
  const p = proposeRaciChange(current, candidate, all);
  assert.deepEqual(p.routeChanges.added, ["c"]);
  assert.deepEqual(p.routeChanges.removed, []);
});

test("change summary: removed route", () => {
  const current = `${route("a", "engineer")}\n\n${route("b", "engineer")}`;
  const candidate = route("a", "engineer");
  const p = proposeRaciChange(current, candidate, all);
  assert.deepEqual(p.routeChanges.removed, ["b"]);
  assert.deepEqual(p.routeChanges.added, []);
});

test("change summary: modified route reports only changed executable fields", () => {
  const current = `${route("a", "engineer")}\n\n${route("b", "engineer")}`;
  const candidate = `${route("a", "frontend-specialist")}\n\n${route("b", "engineer")}`;
  const p = proposeRaciChange(current, candidate, all);
  assert.equal(p.routeChanges.modified.length, 1);
  const mod = p.routeChanges.modified[0]!;
  assert.equal(mod.route, "a");
  assert.deepEqual(
    mod.fields.map((f) => f.field),
    ["responsible"],
  );
});

test("absent current: every candidate route reads as added", () => {
  const candidate = route("a", "engineer");
  const p = proposeRaciChange("", candidate, all);
  assert.deepEqual(p.routeChanges.added, ["a"]);
});

test("unifiedDiff: marks added, removed, and context lines", () => {
  const d = unifiedDiff("one\ntwo\nthree", "one\ntwo-changed\nthree");
  assert.match(d, /^ {2}one$/m);
  assert.match(d, /^- two$/m);
  assert.match(d, /^\+ two-changed$/m);
  assert.match(d, /^ {2}three$/m);
});

test("unifiedDiff: identical input yields all-context, no +/- lines", () => {
  const d = unifiedDiff("a\nb", "a\nb");
  assert.ok(!/^[+-] /m.test(d));
});

test("unifiedDiff: one change in a large file is hunked, not a full dump", () => {
  const lines = Array.from({ length: 40 }, (_, k) => `line${k}`);
  const a = lines.join("\n");
  const changed = [...lines];
  changed[20] = "line20-changed";
  const d = unifiedDiff(a, changed.join("\n"), 3);

  assert.match(d, /^- line20$/m);
  assert.match(d, /^\+ line20-changed$/m);
  assert.match(d, /⋮/, "far-away unchanged regions should be elided");
  assert.ok(!d.includes("line0"), "lines far from the change must be dropped");
  assert.ok(d.includes("line18") && d.includes("line22"), "context within 3 lines is kept");
});
