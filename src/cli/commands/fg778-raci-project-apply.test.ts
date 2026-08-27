// FG-778 — `forge raci apply`/`propose` retarget to the PROJECT raci.
//
// Since FG-777 the host ~/.forge/forge-raci.md is forge-owned/always-upgraded, so
// apply must write the PROJECT override (<project>/.forge/forge-raci.md) instead —
// leaving the host raci pure — and a compiled project policy is read directly by
// dispatch, so a project apply is IMMEDIATELY effective (no `forge upgrade`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { applyTargets, applyRaciChange, readCurrentRaci, registerRaci } from "./raci.js";
import {
  projectRaciPath,
  projectPolicyPath,
  projectRaciAuditPath,
  resolvePolicyPath,
} from "../../raci/project.js";
import { checkForceRuleWeakening, type HostEnv } from "../../raci/route-validate.js";
import type { RoutingPolicy } from "../../raci/policy-schema.js";
import { RACI_PATH, RACI_AUDIT_LOG_PATH } from "../../util/paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "..", "seeds", "forge-raci.md");
const all: HostEnv = { agentInstalled: () => true, workflowKnown: () => true };
const seed = () => readFileSync(SEED_PATH, "utf8");
const IQ_ANCHOR = "responsible: engineer\naccountable: human\npath: invoke_chain";
const CANDIDATE_EDIT = "responsible: frontend-specialist\naccountable: human\npath: invoke_chain";

function project(): string {
  // A bare project dir WITHOUT .forge — apply must create it (mkdir -p).
  return mkdtempSync(join(tmpdir(), "fg778-proj-"));
}

test("AC1/AC3: apply --confirm writes the PROJECT raci, policy, and per-project audit log", () => {
  const dir = project();
  try {
    const targets = applyTargets(dir);
    assert.equal(targets.raciPath, projectRaciPath(dir));
    assert.equal(targets.policyPath, projectPolicyPath(dir));
    assert.equal(targets.auditLogPath, projectRaciAuditPath(dir));

    const candidate = seed().replace(IQ_ANCHOR, CANDIDATE_EDIT);
    // Fresh project override — current is empty.
    assert.equal(readCurrentRaci(targets.raciPath), "");

    const r = applyRaciChange("", candidate, {
      confirm: true,
      candidateLabel: "cand.md",
      host: all,
      targets,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });

    assert.equal(r.written, true, JSON.stringify(r.proposal.validation));
    assert.equal(readFileSync(projectRaciPath(dir), "utf8"), candidate);
    assert.ok(existsSync(projectPolicyPath(dir)), "project policy compiled");
    assert.match(readFileSync(projectPolicyPath(dir), "utf8"), /frontend-specialist/);

    const lines = readFileSync(projectRaciAuditPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!);
    assert.equal(entry.action, "apply");
    assert.equal(entry.current_raci, projectRaciPath(dir));
    // Fresh override (current ""): every candidate route reads as ADDED.
    assert.ok(entry.routes_added.includes("implementation_quick"), "implementation_quick added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC2: apply NEVER writes the host raci or host audit log", () => {
  const dir = project();
  const hostRaciBefore = existsSync(RACI_PATH) ? readFileSync(RACI_PATH, "utf8") : null;
  const hostAuditBefore = existsSync(RACI_AUDIT_LOG_PATH) ? readFileSync(RACI_AUDIT_LOG_PATH, "utf8") : null;
  try {
    const targets = applyTargets(dir);
    assert.notEqual(targets.raciPath, RACI_PATH);
    assert.notEqual(targets.auditLogPath, RACI_AUDIT_LOG_PATH);

    const candidate = seed().replace(IQ_ANCHOR, CANDIDATE_EDIT);
    applyRaciChange("", candidate, { confirm: true, candidateLabel: "cand.md", host: all, targets });

    const hostRaciAfter = existsSync(RACI_PATH) ? readFileSync(RACI_PATH, "utf8") : null;
    const hostAuditAfter = existsSync(RACI_AUDIT_LOG_PATH) ? readFileSync(RACI_AUDIT_LOG_PATH, "utf8") : null;
    assert.equal(hostRaciAfter, hostRaciBefore, "host raci must be untouched by a project apply");
    assert.equal(hostAuditAfter, hostAuditBefore, "host audit log must be untouched by a project apply");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("immediate effectiveness: applied project policy is a project dispatch source, effectiveForDispatch=true, no publish directive", () => {
  const dir = project();
  try {
    const targets = applyTargets(dir);
    const candidate = seed().replace(IQ_ANCHOR, CANDIDATE_EDIT);
    const r = applyRaciChange("", candidate, { confirm: true, candidateLabel: "cand.md", host: all, targets });

    assert.equal(r.written, true);
    assert.equal(r.effectiveForDispatch, true);
    assert.equal((r as { publishDirective?: string }).publishDirective, undefined);

    // resolvePolicyPath (the read side dispatch uses) now resolves the project policy directly.
    const resolved = resolvePolicyPath(dir);
    assert.deepEqual(resolved, { source: "project", path: projectPolicyPath(dir), exists: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative: the gate validates against the REAL host — a candidate the host can't satisfy is refused, nothing written", () => {
  const dir = project();
  try {
    const targets = applyTargets(dir);
    // Host does NOT have frontend-specialist installed; the candidate routes to it.
    const host: HostEnv = { agentInstalled: (role) => role !== "frontend-specialist", workflowKnown: () => true };
    const candidate = seed().replace(IQ_ANCHOR, CANDIDATE_EDIT);

    const r = applyRaciChange("", candidate, { confirm: true, candidateLabel: "cand.md", host, targets });

    assert.equal(r.written, false);
    assert.equal(r.reason, "validation_failed");
    assert.equal(existsSync(projectRaciPath(dir)), false, "no project raci written on a failed gate");
    assert.equal(existsSync(projectPolicyPath(dir)), false, "no project policy written on a failed gate");
    assert.equal(existsSync(projectRaciAuditPath(dir)), false, "no audit entry on a failed gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative: the force-rule superset guarantee refuses a project override that DROPS a host force rule", () => {
  // Structurally enforced (dormant today: no route carries force_rules). A project
  // that omits a host force rule on a SHARED route is refused.
  const host = { version: 1, routes: { implementation_quick: { force_rules: ["human_accountable"] } } } as unknown as RoutingPolicy;
  const weakened = { version: 1, routes: { implementation_quick: { force_rules: [] } } } as unknown as RoutingPolicy;

  const findings = checkForceRuleWeakening(host, weakened);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, "force_rule_weakened");
  assert.equal(findings[0]!.route, "implementation_quick");

  // A superset (keeps the host rule + adds one) is allowed.
  const specialized = { version: 1, routes: { implementation_quick: { force_rules: ["human_accountable", "extra"] } } } as unknown as RoutingPolicy;
  assert.deepEqual(checkForceRuleWeakening(host, specialized), []);
});

test("propose/apply commands expose a --project option (default: cwd)", () => {
  const program = new Command();
  registerRaci(program);
  const raci = program.commands.find((c) => c.name() === "raci")!;
  for (const name of ["propose", "apply"]) {
    const cmd = raci.commands.find((c) => c.name() === name)!;
    const hasProject = cmd.options.some((o) => o.long === "--project");
    assert.ok(hasProject, `\`raci ${name}\` must accept --project`);
  }
});

test("readCurrentRaci reads the PROJECT override when present, empty when a fresh override", () => {
  const dir = project();
  try {
    const targets = applyTargets(dir);
    // Fresh: no override yet.
    assert.equal(readCurrentRaci(targets.raciPath), "");
    // Install one, then current reflects the project override (not the host raci).
    const candidate = seed().replace(IQ_ANCHOR, CANDIDATE_EDIT);
    applyRaciChange("", candidate, { confirm: true, candidateLabel: "cand.md", host: all, targets });
    assert.equal(readCurrentRaci(targets.raciPath), candidate);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
