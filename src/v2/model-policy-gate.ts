// FG-835: the write gate for model-policy.yml — `forge model policy propose|apply`.
//
// Until FG-835 there was no write path for model policy at all (loading is read-only and
// `forge upgrade` is the sole MIGRATION authority, invariant 7). This adds an operator
// REPLACEMENT path that mirrors `forge raci propose|apply`: propose validates a candidate
// and renders the per-role × activity resolution diff, never writing; apply re-runs the
// SAME gate immediately before writing (never trusting an earlier propose), then keeps a
// timestamped backup, appends a JSONL audit line and atomically replaces the file.
//
// A candidate is refused exactly as loading would refuse it (parseModelPolicyText), so
// apply can never install a legacy/newer-schema file — it replaces, it never migrates.

import { appendFileSync, copyFileSync, constants as fsConstants, existsSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertCurrentModelPolicyVersion, loadModelPolicyWithSource, loadRuntime, parseModelPolicyText, type LoadContext } from "./loader.js";
import { bindRuntime, defaultActivityForRole, detectAuthMode } from "./model-resolution.js";
import { modelResolveReport } from "./model-resolve-report.js";
import { probeAuth } from "./provider-doctor.js";
import { listSeedRoles, roleActivities } from "./role-surface.js";
import { resolveSeedGeneration, type SeedGeneration } from "./seed-generation.js";
import type { ModelPolicy } from "./schema.js";
import { sha256OfString } from "../util/content-digest.js";
import { writeFileAtomic } from "../util/atomic-write.js";

function forgeHome(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

export type PolicyTarget = { kind: "host" | "project"; path: string; projectDir?: string };

/** The file apply replaces: the project override with --project, else the host file. */
export function policyTarget(projectDir?: string): PolicyTarget {
  return projectDir
    ? { kind: "project", path: join(projectDir, ".forge", "model-policy.yml"), projectDir }
    : { kind: "host", path: join(forgeHome(), "model-policy.yml") };
}

export function auditLogPath(target: PolicyTarget): string {
  return join(dirname(target.path), "model-policy-audit.log");
}

export type GateFindingCode =
  | "yaml_parse"
  | "schema_version"
  | "schema_invalid"
  | "grammar"
  | "no_generation"
  | "runtime_missing"
  | "auth_unbound"
  | "auth_unavailable"
  | "default_undispatchable";

export type GateFinding = { code: GateFindingCode; message: string };

/** One side of a resolution row. Every field null when the resolution itself failed. */
export type RowState = {
  profile: string | null;
  provider: string | null;
  model: string | null;
  auth: string | null;
  runtime: string | null;
  costTier: string | null;
  outcome: string | null;
  dispatchable: boolean | null;
  error: string | null;
};

export const DIFF_FIELDS = ["profile", "provider", "model", "auth", "runtime", "costTier"] as const;

export type ResolutionDiffRow = {
  role: string;
  activity: string;
  /** The role's default activity — resolved role-derived, as a dispatch without an
   *  explicit activity would resolve it. */
  isDefault: boolean;
  before: RowState;
  after: RowState;
  changed: Array<{ field: (typeof DIFF_FIELDS)[number]; before: string | null; after: string | null }>;
  becomesUnmapped: boolean;
  becomesUndispatchable: boolean;
};

export function isUndispatchable(s: RowState): boolean {
  return s.error !== null || s.dispatchable === false || s.outcome === "activity_unmapped";
}

export function rowState(report: ReturnType<typeof modelResolveReport>): RowState {
  if (!report.ok) {
    return { profile: null, provider: null, model: null, auth: null, runtime: null, costTier: null, outcome: null, dispatchable: null, error: report.error };
  }
  const r = report.resolution;
  return {
    profile: r.profile ?? null,
    provider: r.provider ?? null,
    model: r.model || null,
    auth: r.auth ?? null,
    runtime: r.runtime || null,
    costTier: r.costTier ?? null,
    outcome: r.outcome ?? null,
    dispatchable: report.dispatchable ?? null,
    error: null,
  };
}

export function diffRow(role: string, activity: string, isDefault: boolean, before: RowState, after: RowState): ResolutionDiffRow {
  const changed = DIFF_FIELDS.filter((f) => before[f] !== after[f]).map((field) => ({ field, before: before[field], after: after[field] }));
  return {
    role,
    activity,
    isDefault,
    before,
    after,
    changed,
    becomesUnmapped: after.outcome === "activity_unmapped" && before.outcome !== "activity_unmapped",
    becomesUndispatchable: isUndispatchable(after) && !isUndispatchable(before),
  };
}

export function rowIsChange(row: ResolutionDiffRow): boolean {
  return (
    row.changed.length > 0 ||
    row.before.outcome !== row.after.outcome ||
    row.before.dispatchable !== row.after.dispatchable ||
    row.before.error !== row.after.error
  );
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function grammarFindings(policy: ModelPolicy): GateFinding[] {
  const out: GateFinding[] = [];
  const check = (kind: string, name: string) => {
    if (!NAME_RE.test(name)) {
      out.push({ code: "grammar", message: `${kind} '${name}' must match ${NAME_RE.source}` });
    }
  };
  for (const [name, profile] of Object.entries(policy.model_profiles)) {
    check("profile", name);
    for (const activity of Object.keys(profile.map)) check(`activity (model_profiles.${name}.map)`, activity);
  }
  for (const activity of Object.keys(policy.defaults.activity)) check("activity (defaults.activity)", activity);
  for (const role of Object.keys(policy.overrides.agents)) check("role (overrides.agents)", role);
  return out;
}

function hostFindings(policy: ModelPolicy, gen: SeedGeneration | null): GateFinding[] {
  const out: GateFinding[] = [];
  if (!gen) {
    out.push({
      code: "no_generation",
      message: `no complete seed generation is published under ${forgeHome()}, so runtime seeds cannot be checked. Fix: run \`forge upgrade\`.`,
    });
  }
  for (const [name, profile] of Object.entries(policy.model_profiles)) {
    const auth = profile.auth === "auto" ? detectAuthMode() : profile.auth;
    let runtime = profile.runtime;
    if (!runtime) {
      try {
        runtime = bindRuntime(profile.provider, auth);
      } catch (e) {
        out.push({ code: "auth_unbound", message: `profile '${name}': ${(e as Error).message}` });
      }
    }
    if (runtime && gen) {
      try {
        loadRuntime(runtime, { seedGeneration: gen });
      } catch (e) {
        out.push({
          code: "runtime_missing",
          message: `profile '${name}' needs runtime '${runtime}', which the current seed generation (${gen.root}) does not carry: ${(e as Error).message.split("\n")[0]}`,
        });
      }
    }
    const probe = probeAuth(profile.provider, auth);
    if (probe.status === "unavailable") {
      out.push({
        code: "auth_unavailable",
        message: `profile '${name}': ${profile.provider}/${auth}${profile.auth === "auto" ? " (auto)" : ""} is not satisfiable on this host — ${probe.detail}`,
      });
    }
  }
  return out;
}

function parseFindings(text: string, label: string): { policy?: ModelPolicy; findings: GateFinding[] } {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { findings: [{ code: "yaml_parse", message: `model-policy (${label}): YAML parse error — ${(e as Error).message}` }] };
  }
  try {
    assertCurrentModelPolicyVersion(doc, label);
  } catch (e) {
    return { findings: [{ code: "schema_version", message: (e as Error).message }] };
  }
  try {
    return { policy: parseModelPolicyText(text, label), findings: [] };
  } catch (e) {
    return { findings: [{ code: "schema_invalid", message: (e as Error).message }] };
  }
}

export type PolicyProposal = {
  ok: boolean;
  target: PolicyTarget;
  current: { source: "host" | "project" | "absent"; path: string | null; error: string | null };
  candidate: { label: string; sha256: string };
  findings: GateFinding[];
  /** Default-activity rows that become undispatchable, accepted by --allow-undispatchable. */
  allowedUndispatchable: string[];
  /** Every installed role × activity, changed or not. */
  rows: ResolutionDiffRow[];
};

export type ProposeOpts = {
  target: PolicyTarget;
  candidateLabel: string;
  allowUndispatchable?: boolean;
  /** Roles to resolve; default: every installed role seed under $FORGE_HOME/agents. */
  roles?: string[];
};

/** The gate. Never writes. `ok` is false when any finding is present. */
export function proposeModelPolicy(candidateText: string, opts: ProposeOpts): PolicyProposal {
  const { target } = opts;
  const gen = resolveSeedGeneration(forgeHome());
  const currentCtx: LoadContext = { seedGeneration: gen, ...(target.projectDir ? { projectDir: target.projectDir } : {}) };
  const runtimeCtx: LoadContext = { seedGeneration: gen };

  let current: PolicyProposal["current"];
  let currentPolicy: ModelPolicy | undefined;
  try {
    const loaded = loadModelPolicyWithSource(currentCtx);
    currentPolicy = loaded.policy;
    current = loaded.source === "absent" ? { source: "absent", path: null, error: null } : { source: loaded.source, path: loaded.path, error: null };
  } catch (e) {
    current = { source: existsSync(target.path) ? target.kind : "absent", path: existsSync(target.path) ? target.path : null, error: (e as Error).message };
  }

  const base = {
    target,
    current,
    candidate: { label: opts.candidateLabel, sha256: sha256OfString(candidateText) },
    allowedUndispatchable: [] as string[],
  };

  const parsed = parseFindings(candidateText, opts.candidateLabel);
  if (!parsed.policy) return { ok: false, ...base, findings: parsed.findings, rows: [] };
  const candidate = parsed.policy;

  const findings: GateFinding[] = [...grammarFindings(candidate), ...hostFindings(candidate, gen)];

  const candidateCtx: LoadContext = { ...currentCtx, modelPolicy: { policy: candidate, source: target.kind, path: target.path } };
  const policyActivities = [...Object.keys(currentPolicy?.defaults.activity ?? {}), ...Object.keys(candidate.defaults.activity)];
  const rows: ResolutionDiffRow[] = [];
  for (const role of opts.roles ?? listSeedRoles(forgeHome())) {
    const defaultActivity = defaultActivityForRole(role);
    for (const activity of roleActivities(defaultActivity, policyActivities)) {
      const isDefault = activity === defaultActivity;
      const resolveActivity = isDefault ? undefined : activity;
      const before = rowState(modelResolveReport(role, { activity: resolveActivity, ctx: currentCtx, runtimeCtx }));
      const after = rowState(modelResolveReport(role, { activity: resolveActivity, ctx: candidateCtx, runtimeCtx }));
      rows.push(diffRow(role, activity, isDefault, before, after));
    }
  }

  const broken = rows.filter((r) => r.isDefault && r.becomesUndispatchable);
  const allowedUndispatchable: string[] = [];
  for (const r of broken) {
    const why = r.after.error ?? (r.after.outcome === "activity_unmapped" ? "activity_unmapped" : "not dispatchable (tool capability)");
    if (opts.allowUndispatchable) {
      allowedUndispatchable.push(r.role);
    } else {
      findings.push({
        code: "default_undispatchable",
        message: `role '${r.role}' becomes undispatchable for its default activity '${r.activity}': ${why}. Pass --allow-undispatchable to accept this.`,
      });
    }
  }

  return { ok: findings.length === 0, ...base, allowedUndispatchable, findings, rows };
}

export type ModelPolicyAuditEntry = {
  timestamp: string;
  action: "apply";
  by: string;
  target: string;
  target_kind: "host" | "project";
  candidate: string;
  candidate_sha256: string;
  backup: string | null;
  allow_undispatchable: boolean;
  allowed_undispatchable: string[];
  diff: Array<Pick<ResolutionDiffRow, "role" | "activity" | "isDefault" | "changed" | "becomesUnmapped" | "becomesUndispatchable">>;
};

export type PolicyApplyResult = {
  proposal: PolicyProposal;
  written: boolean;
  reason?: "validation_failed" | "not_confirmed";
  backup?: string | null;
  auditLog?: string;
  audit?: ModelPolicyAuditEntry;
};

export function defaultApplier(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "unknown";
  }
}

/** Re-runs the gate and, when it passes AND `confirm`, backs up the current file, appends
 *  the audit line, then atomically replaces the target. Without `confirm` it is propose. */
export function applyModelPolicy(
  candidateText: string,
  opts: ProposeOpts & { confirm: boolean; by?: string; now?: () => Date },
): PolicyApplyResult {
  const proposal = proposeModelPolicy(candidateText, opts);
  if (!proposal.ok) return { proposal, written: false, reason: "validation_failed" };
  if (!opts.confirm) return { proposal, written: false, reason: "not_confirmed" };

  const { target } = opts;
  const timestamp = (opts.now ?? (() => new Date()))().toISOString();
  mkdirSync(dirname(target.path), { recursive: true });

  let backup: string | null = null;
  if (existsSync(target.path)) {
    backup = `${target.path}.bak-${timestamp}`;
    copyFileSync(target.path, backup, fsConstants.COPYFILE_EXCL);
  }

  const audit: ModelPolicyAuditEntry = {
    timestamp,
    action: "apply",
    by: opts.by ?? defaultApplier(),
    target: target.path,
    target_kind: target.kind,
    candidate: opts.candidateLabel,
    candidate_sha256: proposal.candidate.sha256,
    backup,
    allow_undispatchable: opts.allowUndispatchable ?? false,
    allowed_undispatchable: proposal.allowedUndispatchable,
    diff: proposal.rows.filter(rowIsChange).map(({ role, activity, isDefault, changed, becomesUnmapped, becomesUndispatchable }) => ({
      role, activity, isDefault, changed, becomesUnmapped, becomesUndispatchable,
    })),
  };
  // Audit-first, as `forge raci apply`: an unwritable audit log throws before the policy
  // is replaced, so apply never lands a change it cannot record.
  const log = auditLogPath(target);
  appendFileSync(log, JSON.stringify(audit) + "\n");
  writeFileAtomic(target.path, candidateText);
  return { proposal, written: true, backup, auditLog: log, audit };
}

function fmt(v: string | null): string {
  return v ?? "—";
}

export function renderPolicyProposal(p: PolicyProposal): string {
  const lines: string[] = [];
  lines.push(`  target:     ${p.target.kind} ${p.target.path}`);
  lines.push(
    `  current:    ${p.current.source === "absent" ? "none (legacy resolution)" : `${p.current.source} ${p.current.path}`}` +
      (p.current.error ? ` — fails to load: ${p.current.error.split("\n")[0]}` : ""),
  );
  lines.push(`  candidate:  ${p.candidate.label} (sha256 ${p.candidate.sha256})`);
  lines.push("");
  lines.push(p.ok ? "Gate: PASS" : "Gate: FAIL");
  for (const f of p.findings) lines.push(`  [${f.code}] ${f.message}`);
  for (const role of p.allowedUndispatchable) lines.push(`  [allowed] role '${role}' becomes undispatchable for its default activity (--allow-undispatchable)`);
  if (p.rows.length === 0 && !p.ok) return lines.join("\n");

  const changed = p.rows.filter(rowIsChange);
  lines.push("");
  lines.push(`Resolution diff (${changed.length} of ${p.rows.length} role × activity rows change):`);
  if (changed.length === 0) lines.push("  (no change)");
  for (const r of changed) {
    const parts = r.changed.map((c) => `${c.field} ${fmt(c.before)} → ${fmt(c.after)}`);
    if (r.after.error && r.after.error !== r.before.error) parts.push(`error: ${r.after.error.split("\n")[0]}`);
    if (r.becomesUnmapped) parts.push("becomes activity_unmapped");
    if (r.becomesUndispatchable) parts.push("becomes UNDISPATCHABLE");
    else if (isUndispatchable(r.before) && !isUndispatchable(r.after)) parts.push("becomes dispatchable");
    lines.push(`  ${r.role} / ${r.activity}${r.isDefault ? " (default)" : ""}: ${parts.join("; ") || "outcome changed"}`);
  }
  return lines.join("\n");
}
