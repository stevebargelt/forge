// `forge raci validate` command tests (#277) — the fs-aware wrapper + render.
// The pure lint is covered in src/raci/validate.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRaciFile, renderHuman, applyRaciChange, type ApplyTargets } from "./raci.js";
import type { HostEnv } from "../../raci/route-validate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "..", "seeds", "forge-raci.md");

const all: HostEnv = { agentInstalled: () => true, workflowKnown: () => true };
const seed = () => readFileSync(SEED_PATH, "utf8");
const IQ_ANCHOR = "responsible: engineer\naccountable: human\npath: invoke_chain";

function tmpTargets(): ApplyTargets {
  const dir = mkdtempSync(join(tmpdir(), "raci-apply-"));
  return {
    raciPath: join(dir, "forge-raci.md"),
    policyPath: join(dir, "routing-policy.yml"),
    auditLogPath: join(dir, "raci-audit.log"),
  };
}

test("validateRaciFile lints the real seed clean", () => {
  const v = validateRaciFile(SEED_PATH);
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("a missing file is a structured finding, not a crash", () => {
  const v = validateRaciFile(join(HERE, "does-not-exist.md"));
  assert.equal(v.ok, false);
  assert.equal(v.findings.length, 1);
  assert.equal(v.findings[0]!.code, "file_not_found");
});

test("renderHuman: clean vs findings", () => {
  const clean = renderHuman("/x/forge-raci.md", { ok: true, findings: [] });
  assert.match(clean, /OK/);

  const bad = renderHuman("/x/forge-raci.md", {
    ok: false,
    findings: [{ code: "informed_unknown", route: "bug_fix", message: "bad target" }],
  });
  assert.match(bad, /informed_unknown/);
  assert.match(bad, /route: bug_fix/);
});

// ── confirm-gate (#279) ──────────────────────────────────────────────────────

test("apply without --confirm never writes, even when the gate passes", () => {
  const targets = tmpTargets();
  const candidate = seed().replace(IQ_ANCHOR, "responsible: frontend-specialist\naccountable: human\npath: invoke_chain");
  const r = applyRaciChange(seed(), candidate, { confirm: false, candidateLabel: "cand.md", host: all, targets });

  assert.equal(r.proposal.ok, true, JSON.stringify(r.proposal.validation));
  assert.equal(r.written, false);
  assert.equal(r.reason, "not_confirmed");
  assert.equal(existsSync(targets.raciPath), false, "must not write the RACI");
  assert.equal(existsSync(targets.policyPath), false, "must not write the policy");
  assert.equal(existsSync(targets.auditLogPath), false, "must not write an audit entry");
});

test("apply --confirm on a valid candidate writes RACI + policy + a JSONL audit line", () => {
  const targets = tmpTargets();
  const candidate = seed().replace(IQ_ANCHOR, "responsible: frontend-specialist\naccountable: human\npath: invoke_chain");
  const r = applyRaciChange(seed(), candidate, {
    confirm: true,
    candidateLabel: "cand.md",
    host: all,
    targets,
    now: () => new Date("2026-06-04T12:00:00.000Z"),
  });

  assert.equal(r.written, true);
  assert.equal(readFileSync(targets.raciPath, "utf8"), candidate, "installed RACI must equal the candidate");
  assert.ok(existsSync(targets.policyPath), "policy must be recompiled");
  assert.match(readFileSync(targets.policyPath, "utf8"), /frontend-specialist/);

  const lines = readFileSync(targets.auditLogPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.action, "apply");
  assert.equal(entry.timestamp, "2026-06-04T12:00:00.000Z");
  assert.deepEqual(entry.routes_modified, ["implementation_quick"]);
  assert.deepEqual(entry.validation, { raci: true, route: true });
});

test("FG-778: a written project apply IS immediately effective for dispatch and carries NO forge-upgrade directive", () => {
  const targets = tmpTargets();
  const candidate = seed().replace(IQ_ANCHOR, "responsible: frontend-specialist\naccountable: human\npath: invoke_chain");
  const r = applyRaciChange(seed(), candidate, { confirm: true, candidateLabel: "cand.md", host: all, targets });

  assert.equal(r.written, true);
  // A compiled <project>/.forge/routing-policy.yml is read directly by dispatch — no republish.
  assert.equal(r.effectiveForDispatch, true);
  assert.equal((r as { publishDirective?: string }).publishDirective, undefined, "no host publish directive on a project apply");
});

test("FG-778: an unwritten (dry-run) apply never reports effectiveForDispatch true", () => {
  const targets = tmpTargets();
  const candidate = seed().replace(IQ_ANCHOR, "responsible: frontend-specialist\naccountable: human\npath: invoke_chain");
  const r = applyRaciChange(seed(), candidate, { confirm: false, candidateLabel: "cand.md", host: all, targets });
  assert.equal(r.written, false);
  assert.equal(r.effectiveForDispatch, false);
});

test("apply --confirm on an INVALID candidate writes nothing and reports the failure", () => {
  const targets = tmpTargets();
  const candidate = seed().replace(
    "informed: user_summary, backlog:when=ticketed, docs_impact:when=operator_behavior_changed",
    "informed: not_a_real_target",
  );
  const r = applyRaciChange(seed(), candidate, { confirm: true, candidateLabel: "cand.md", host: all, targets });

  assert.equal(r.written, false);
  assert.equal(r.reason, "validation_failed");
  assert.equal(existsSync(targets.raciPath), false);
  assert.equal(existsSync(targets.policyPath), false);
  assert.equal(existsSync(targets.auditLogPath), false);
});

test("apply --confirm with an unwritable audit target writes neither RACI nor policy", () => {
  const base = mkdtempSync(join(tmpdir(), "raci-apply-"));
  const targets: ApplyTargets = {
    raciPath: join(base, "forge-raci.md"),
    policyPath: join(base, "routing-policy.yml"),
    // Parent dir does not exist -> appendFileSync throws ENOENT.
    auditLogPath: join(base, "no", "such", "dir", "raci-audit.log"),
  };
  const candidate = seed().replace(IQ_ANCHOR, "responsible: frontend-specialist\naccountable: human\npath: invoke_chain");

  // Audit-first ordering means the unwritable audit aborts BEFORE any governance write.
  assert.throws(() =>
    applyRaciChange(seed(), candidate, { confirm: true, candidateLabel: "cand.md", host: all, targets }),
  );
  assert.equal(existsSync(targets.raciPath), false, "RACI must not be written when the audit cannot be journaled");
  assert.equal(existsSync(targets.policyPath), false, "policy must not be written when the audit cannot be journaled");
});

test("apply --confirm appends — a second change adds a second audit line", () => {
  const targets = tmpTargets();
  // Seed the audit log + installed RACI with a first applied change.
  const first = seed().replace(IQ_ANCHOR, "responsible: frontend-specialist\naccountable: human\npath: invoke_chain");
  applyRaciChange(seed(), first, { confirm: true, candidateLabel: "first.md", host: all, targets });
  // A second change, current = the now-installed first candidate.
  const second = first.replace(
    "responsible: frontend-specialist\naccountable: human\npath: invoke_chain",
    "responsible: backend-specialist\naccountable: human\npath: invoke_chain",
  );
  const r = applyRaciChange(readFileSync(targets.raciPath, "utf8"), second, {
    confirm: true,
    candidateLabel: "second.md",
    host: all,
    targets,
  });

  assert.equal(r.written, true);
  const lines = readFileSync(targets.auditLogPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
});
