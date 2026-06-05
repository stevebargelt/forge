import type { Command } from "commander";
import { join, resolve } from "node:path";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { RACI_PATH, RACI_AUDIT_LOG_PATH, ROUTING_POLICY_PATH, AGENTS_DIR, WORKFLOWS_DIR, ensureForgeDirs } from "../../util/paths.js";
import { validateRaci, type RaciValidation } from "../../raci/validate.js";
import { proposeRaciChange, type RaciProposal } from "../../raci/propose.js";
import { compileRaciDocument } from "../../raci/compile.js";
import type { HostEnv } from "../../raci/route-validate.js";

// `forge raci` — the RACI authoring surface.
//   validate  — authoring-view lint (#277, host-independent).
//   propose   — run the full gate on a candidate and render the diff; never writes (#279).
//   apply     — re-run the gate and, with --confirm, write the candidate + recompile
//               the policy + append a JSONL audit entry (#279).
//
// `propose`/`apply` are the PRIMARY (orchestrator-mediated) edit channel. The
// guardrail is structural: a candidate that fails either validator produces no
// writable artifact, and `apply` writes ONLY when the gate passes AND --confirm
// is present. apply re-runs the gate immediately before writing — it never trusts
// an earlier propose (closes the stale-candidate gap).

/** Real host lookups against ~/.forge (mirrors route.ts). */
const realHost: HostEnv = {
  agentInstalled: (role) => existsSync(join(AGENTS_DIR, role)),
  workflowKnown: (name) => existsSync(join(WORKFLOWS_DIR, `${name}.yml`)),
};

/** Read + lint a RACI file. A missing/unreadable file becomes a finding rather
 *  than an exception (especially for the default host path). */
export function validateRaciFile(path: string): RaciValidation {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ok: false,
      findings: [
        {
          code: missing ? "file_not_found" : "read_error",
          message: missing
            ? `RACI file not found: ${path}`
            : `cannot read ${path}: ${(e as Error).message}`,
        },
      ],
    };
  }
  return validateRaci(content);
}

export function renderHuman(path: string, v: RaciValidation): string {
  if (v.ok) return `RACI ${path}: OK — no findings.`;
  const lines = [`RACI ${path}: ${v.findings.length} finding(s):`, ""];
  for (const f of v.findings) {
    const where = f.route ? ` [route: ${f.route}]` : "";
    lines.push(`  [${f.code}]${where} ${f.message}`);
  }
  return lines.join("\n");
}

// ── propose / apply ────────────────────────────────────────────────────────

export type ApplyTargets = { raciPath: string; policyPath: string; auditLogPath: string };

/** One append-only JSONL line per applied change. Host-global, repo-independent
 *  (#279 decision: an audit log, not a git commit — works for non-git hosts). */
export type RaciAuditEntry = {
  timestamp: string;
  action: "apply";
  current_raci: string;
  candidate: string;
  routes_added: string[];
  routes_removed: string[];
  routes_modified: string[];
  validation: { raci: boolean; route: boolean };
};

export type ApplyResult = {
  proposal: RaciProposal;
  written: boolean;
  reason?: "validation_failed" | "not_confirmed";
  audit?: RaciAuditEntry;
};

function defaultTargets(): ApplyTargets {
  return { raciPath: RACI_PATH, policyPath: ROUTING_POLICY_PATH, auditLogPath: RACI_AUDIT_LOG_PATH };
}

/** Read the current installed RACI; absent => "" (every candidate route is new). */
export function readCurrentRaci(raciPath: string): string {
  try {
    return readFileSync(raciPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/** The confirm-gate. Operates on STRINGS + explicit targets so it is testable
 *  without touching real ~/.forge. Re-runs the full gate; writes only when the
 *  gate passes AND confirm is true. */
export function applyRaciChange(
  current: string,
  candidate: string,
  opts: {
    confirm: boolean;
    candidateLabel: string;
    host?: HostEnv;
    targets?: ApplyTargets;
    now?: () => Date;
  },
): ApplyResult {
  const host = opts.host ?? realHost;
  const targets = opts.targets ?? defaultTargets();
  const now = opts.now ?? (() => new Date());

  // Always re-run the gate immediately before writing — never trust an earlier propose.
  const proposal = proposeRaciChange(current, candidate, host);
  if (!proposal.ok) return { proposal, written: false, reason: "validation_failed" };
  if (!opts.confirm) return { proposal, written: false, reason: "not_confirmed" };

  // Gate passed + confirmed. Precompute everything that can fail BEFORE touching
  // any file, then journal the audit entry FIRST (write-ahead). The audit log is
  // #279's substitute for a git commit, so an applied-but-unaudited change is a
  // correctness bug, not a cosmetic gap. The gate already proved the candidate
  // compiles, so this recompile cannot fail.
  const policyYaml = yamlStringify(compileRaciDocument(candidate));
  const audit: RaciAuditEntry = {
    timestamp: now().toISOString(),
    action: "apply",
    current_raci: targets.raciPath,
    candidate: opts.candidateLabel,
    routes_added: proposal.routeChanges.added,
    routes_removed: proposal.routeChanges.removed,
    routes_modified: proposal.routeChanges.modified.map((m) => m.route),
    validation: { raci: proposal.validation.raci.ok, route: proposal.validation.route.ok },
  };

  // Audit-first: an unwritable audit target throws HERE, before the source or
  // policy is written — apply never lands a change it cannot record.
  appendFileSync(targets.auditLogPath, JSON.stringify(audit) + "\n");
  writeFileSync(targets.raciPath, candidate);
  writeFileSync(targets.policyPath, policyYaml);

  return { proposal, written: true, audit };
}

function renderFindings(label: string, findings: { code: string; message: string; route?: string }[]): string[] {
  if (findings.length === 0) return [`  ${label}: OK`];
  const lines = [`  ${label}: ${findings.length} finding(s):`];
  for (const f of findings) {
    const where = f.route ? ` [route: ${f.route}]` : "";
    lines.push(`    [${f.code}]${where} ${f.message}`);
  }
  return lines;
}

export function renderProposal(p: RaciProposal): string {
  const lines: string[] = [];
  lines.push(p.ok ? "Gate: PASS" : "Gate: FAIL");
  lines.push("");
  lines.push("Validation:");
  lines.push(...renderFindings("raci validate", p.validation.raci.findings));
  lines.push(...renderFindings("route validate", p.validation.route.findings));
  lines.push("");

  const { added, removed, modified } = p.routeChanges;
  lines.push("Route changes:");
  if (added.length === 0 && removed.length === 0 && modified.length === 0) {
    lines.push("  (none)");
  } else {
    if (added.length) lines.push(`  added:    ${added.join(", ")}`);
    if (removed.length) lines.push(`  removed:  ${removed.join(", ")}`);
    for (const m of modified) {
      lines.push(`  modified: ${m.route}`);
      for (const f of m.fields) {
        lines.push(`              ${f.field}: ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`);
      }
    }
  }
  lines.push("");
  lines.push("Diff (current -> candidate):");
  lines.push(p.raciDiff === "" ? "  (no change)" : p.raciDiff);
  return lines.join("\n");
}

export function registerRaci(program: Command): void {
  const raci = program.command("raci").description("Work with the RACI routing source (authoring view).");

  raci
    .command("validate")
    .argument("[path]", "RACI file to validate (default: the installed ~/.forge/forge-raci.md)")
    .option("--json", "emit structured { ok, path, findings } as JSON")
    .description(
      "Lint a RACI source document. Host-independent: no agent/workflow/command resolution or drift checks (those are route validate, #278).",
    )
    .action((pathArg: string | undefined, opts: { json?: boolean }) => {
      const path = pathArg ? resolve(pathArg) : RACI_PATH;
      const v = validateRaciFile(path);

      if (opts.json) {
        console.log(JSON.stringify({ ok: v.ok, path, findings: v.findings }, null, 2));
      } else {
        console.log(renderHuman(path, v));
      }
      if (!v.ok) process.exit(1);
    });

  raci
    .command("propose")
    .argument("<candidate>", "candidate RACI file to gate against the installed source")
    .option("--json", "emit the structured proposal as JSON")
    .description(
      "Run the full authoring gate on a candidate RACI (raci validate -> compile -> route validate) and render the diff + route-change summary. Never writes.",
    )
    .action((candidateArg: string, opts: { json?: boolean }) => {
      const candidatePath = resolve(candidateArg);
      if (!existsSync(candidatePath)) {
        process.stderr.write(`forge raci propose: candidate not found: ${candidatePath}\n`);
        process.exit(1);
      }
      const candidate = readFileSync(candidatePath, "utf8");
      const current = readCurrentRaci(RACI_PATH);
      const proposal = proposeRaciChange(current, candidate, realHost);

      if (opts.json) {
        console.log(JSON.stringify({ candidate: candidatePath, current: RACI_PATH, ...proposal }, null, 2));
      } else {
        console.log(renderProposal(proposal));
      }
      if (!proposal.ok) process.exit(1);
    });

  raci
    .command("apply")
    .argument("<candidate>", "candidate RACI file to write as the installed source")
    .option("--confirm", "actually write the change (without it, behaves like propose)")
    .option("--json", "emit the structured apply result as JSON")
    .description(
      "Re-run the full gate and, with --confirm, install the candidate RACI, recompile the routing policy, and append a JSONL audit entry. The gate is re-run immediately before writing.",
    )
    .action((candidateArg: string, opts: { confirm?: boolean; json?: boolean }) => {
      const candidatePath = resolve(candidateArg);
      if (!existsSync(candidatePath)) {
        process.stderr.write(`forge raci apply: candidate not found: ${candidatePath}\n`);
        process.exit(1);
      }
      const candidate = readFileSync(candidatePath, "utf8");
      const current = readCurrentRaci(RACI_PATH);
      ensureForgeDirs();
      let result: ApplyResult;
      try {
        result = applyRaciChange(current, candidate, { confirm: opts.confirm ?? false, candidateLabel: candidatePath });
      } catch (e) {
        process.stderr.write(`forge raci apply: failed to write change (nothing applied): ${(e as Error).message}\n`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ candidate: candidatePath, ...result }, null, 2));
      } else {
        console.log(renderProposal(result.proposal));
        console.log("");
        if (result.written) {
          console.log(`Applied -> ${RACI_PATH} (policy recompiled, change audited to ${RACI_AUDIT_LOG_PATH}).`);
        } else if (result.reason === "not_confirmed") {
          console.log("Not applied — gate passed. Re-run with --confirm to write.");
        } else {
          console.log("Not applied — gate FAILED. Fix the findings above; nothing was written.");
        }
      }
      // Exit non-zero only when the gate failed; a passing-but-unconfirmed dry run is a success.
      if (result.reason === "validation_failed") process.exit(1);
    });
}
