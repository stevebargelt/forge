// FG-835 — THE MODEL POLICY AUTHORED FROM THE DASHBOARD, THROUGH THE CLI'S OWN GATE.
//
// Two ACTION_ROUTES rows (action-mutation.ts) land here: `POST /api/model-policy/propose`
// and `POST /api/model-policy/apply`. They mirror FG-834's RACI rows (raci-mutation.ts)
// exactly; the gate stays in `forge model policy propose` / `forge model policy apply
// --confirm` (src/v2/model-policy-gate.ts):
//
//  * The target is either a registered project (`projectKey`, whose `--project` is the
//    registry's own checkout, never a caller path) or the host file (`target: "host"`,
//    no `--project`). The typed confirmation is the project key, or the literal `host`.
//  * The candidate YAML travels as TEXT in the JSON body, size-bounded, and is written to
//    a unique scratch file under FORGE_HOME (never the project), removed after the child
//    exits. Only the scratch path reaches argv; `candidate_sha256` identifies it in the audit.
//  * argv is fixed: `model policy propose <scratch> [--project <dir>] --json` and
//    `model policy apply <scratch> [--project <dir>] --confirm --by dashboard --source
//    dashboard --rationale <text> --json`. Never `--allow-undispatchable` (that
//    acceptance stays a terminal decision), never `--force`.
//  * apply is refused HERE unless the same bytes were proposed green for the same target
//    within the window, the typed confirmation matches and a rationale is given. The
//    proposal is taken inside the mutation slot before the spawn and refunded only when
//    the child wrote nothing. The CLI still re-runs the whole gate before it writes.
//
// GET /api/model-policy is the editor's read: the effective source, the FG-827 resolution
// table (roles.ts harnessActivities, so it can never disagree with the Harness tab), the
// audit tail and the backups beside the target. No subprocess (invariant 21).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRecord } from "./queries.js";
import { resolveCheckoutDir } from "./queue-mutation.js";
import { MAX_RATIONALE_CHARS, PROPOSAL_WINDOW_MS, ProposalWindow, sha256Hex } from "./raci-mutation.js";
import { readAuditTail, type RaciAuditLine } from "./raci-audit.js";
import { harnessActivities } from "./roles.js";
import {
  CHILD_TIMEOUT_MS,
  MAX_CONCURRENT_MUTATIONS,
  MAX_REPORTED_STDERR,
  assertOperand,
  cliRefusal,
  guardMutationPost,
  isRefusal,
  readBody,
  refuse,
  resolveForgeBinary,
  runForgeVerb,
  send,
  withMutationSlot,
  type ForgeRunResult,
  type MutationRefusal,
} from "./mutation-guards.js";
import { loadModelPolicyWithSource } from "../../src/v2/loader.js";
import { auditLogPath, policyTarget } from "../../src/v2/model-policy-gate.js";
import { listSeedRoles } from "../../src/v2/role-surface.js";
import { resolveSeedGeneration } from "../../src/v2/seed-generation.js";
import { sha256OfBytes } from "../../src/util/content-digest.js";

export type ModelPolicyAction = "model-policy-propose" | "model-policy-apply";

export const MODEL_POLICY_PATH = /^\/api\/model-policy\/(propose|apply)$/;

export const MAX_POLICY_CANDIDATE_BYTES = 64 * 1024;
const MAX_POLICY_BODY_BYTES = 2 * MAX_POLICY_CANDIDATE_BYTES + 16 * 1024;

/** The typed confirmation for the host file. */
export const HOST_CONFIRM_KEY = "host";

export const MAX_BACKUPS_LISTED = 50;

export type ModelPolicyRefusalCode =
  | "candidate_not_proposed"
  | "candidate_changed"
  | "confirm_key_mismatch"
  | "rationale_required"
  | "rationale_invalid"
  | "gate_failed";

const proposals = new ProposalWindow();

// ─── the request body ────────────────────────────────────────────────────────

export type PolicyRequestTarget = { kind: "host" } | { kind: "project"; projectKey: string; projectDir: string | undefined };

export type ModelPolicyRequest = {
  target: PolicyRequestTarget;
  candidate: string;
  candidateSha256: string;
  proposedSha256?: string;
  confirmKey?: string;
  rationale?: string;
};

const FIELDS: Record<ModelPolicyAction, readonly string[]> = {
  "model-policy-propose": ["projectKey", "target", "projectDir", "candidate"],
  "model-policy-apply": ["projectKey", "target", "projectDir", "candidate", "proposedSha256", "confirmKey", "rationale"],
};

function optionalString(input: Record<string, unknown>, field: string): string | undefined | MutationRefusal {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return refuse(400, `${field} must be a string.`);
  return value;
}

/** PURE: the body checked against the one shape each model-policy route takes. */
export function parseModelPolicyRequest(action: ModelPolicyAction, body: unknown): ModelPolicyRequest | MutationRefusal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse(400, "the request body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  const allowed = FIELDS[action];
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    return refuse(
      400,
      `this route takes ${allowed.join(", ")}; refusing ${extra.join(", ")}. The dashboard never passes --force or --allow-undispatchable.`,
    );
  }
  const projectKey = optionalString(input, "projectKey");
  if (isRefusal(projectKey)) return projectKey;
  const projectDir = optionalString(input, "projectDir");
  if (isRefusal(projectDir)) return projectDir;
  const hostTarget = input["target"];
  if (hostTarget !== undefined && hostTarget !== HOST_CONFIRM_KEY) return refuse(400, `target must be "host" when given.`);
  let target: PolicyRequestTarget;
  if (hostTarget === HOST_CONFIRM_KEY) {
    if (projectKey !== undefined || projectDir !== undefined) return refuse(400, `pass either target: "host" or projectKey, not both.`);
    target = { kind: "host" };
  } else {
    if (projectKey === undefined || projectKey.trim() === "") {
      return refuse(400, `projectKey is required (the registered project whose .forge/model-policy.yml this is), or target: "host" for the host file.`);
    }
    target = { kind: "project", projectKey, projectDir };
  }
  const candidate = input["candidate"];
  if (typeof candidate !== "string" || candidate.trim() === "") return refuse(400, "candidate is required: the model-policy YAML text to gate.");
  const bytes = Buffer.byteLength(candidate, "utf8");
  if (bytes > MAX_POLICY_CANDIDATE_BYTES) {
    return refuse(413, `the candidate model policy is ${bytes} bytes; at most ${MAX_POLICY_CANDIDATE_BYTES} are accepted.`);
  }
  const out: ModelPolicyRequest = { target, candidate, candidateSha256: sha256Hex(candidate) };
  if (action === "model-policy-apply") {
    for (const field of ["proposedSha256", "confirmKey", "rationale"] as const) {
      const value = optionalString(input, field);
      if (isRefusal(value)) return value;
      if (value !== undefined) out[field] = value;
    }
  }
  return out;
}

/** What the operator must type to confirm an apply to this target. */
export function confirmKeyFor(target: PolicyRequestTarget): string {
  return target.kind === "host" ? HOST_CONFIRM_KEY : target.projectKey;
}

export type ModelPolicyApplyRefusal = MutationRefusal & { refusal: ModelPolicyRefusalCode };

function named(status: number, refusal: ModelPolicyRefusalCode, error: string): ModelPolicyApplyRefusal {
  return { ...refuse(status, error), refusal };
}

/** The apply preconditions, by name. `scope` is the resolved target's proposal scope, so
 *  a propose for one target never admits an apply to another. */
export function policyApplyRefusal(
  request: ModelPolicyRequest,
  scope: string,
  window: ProposalWindow,
  now: number,
): ModelPolicyApplyRefusal | null {
  const rationale = request.rationale?.trim() ?? "";
  if (rationale === "") return named(400, "rationale_required", "a rationale is required to apply a model-policy change: it is the human decision record.");
  if (request.rationale!.length > MAX_RATIONALE_CHARS) return named(400, "rationale_invalid", `rationale must be at most ${MAX_RATIONALE_CHARS} characters.`);
  if (rationale.startsWith("-")) return named(400, "rationale_invalid", `rationale must not begin with "-": it would be read as a flag by the CLI.`);
  const expected = confirmKeyFor(request.target);
  if (request.confirmKey !== expected) {
    return named(400, "confirm_key_mismatch", `type ${request.target.kind === "host" ? "host" : `the project key (${expected})`} to confirm this model-policy change.`);
  }
  if (request.proposedSha256 !== request.candidateSha256) {
    return named(409, "candidate_changed", "the candidate is not the one that was proposed (its sha256 differs); propose it again before applying.");
  }
  if (!window.has(scope, request.candidateSha256, now)) return notProposed();
  return null;
}

function notProposed(): ModelPolicyApplyRefusal {
  return named(
    409,
    "candidate_not_proposed",
    `this candidate has no green propose for this target in the last ${Math.round(PROPOSAL_WINDOW_MS / 60000)} minutes; propose it first.`,
  );
}

// ─── argv ────────────────────────────────────────────────────────────────────

export type BuiltModelPolicy = { ok: true; verb: "model"; argv: string[]; command: string };

/** THE ARGV BUILDER. Only the scratch path, the registry's checkout (a project target) and
 *  (apply) the rationale — as its own element — reach argv. */
export function buildModelPolicyArgv(
  action: ModelPolicyAction,
  scratchPath: string,
  projectDir: string | undefined,
  actor: string,
  rationale?: string,
): BuiltModelPolicy | MutationRefusal {
  const operands: Array<[string, string]> = [[scratchPath, "the scratch candidate path"]];
  if (projectDir !== undefined) operands.push([projectDir, "the resolved project checkout"]);
  for (const [value, field] of operands) {
    if (!isAbsolute(value)) return refuse(500, `${field} is not an absolute path.`);
    const dash = assertOperand(value, field);
    if (dash) return dash;
  }
  const project = projectDir !== undefined ? ["--project", projectDir] : [];
  const shown = projectDir !== undefined ? ` --project ${projectDir}` : "";
  if (action === "model-policy-propose") {
    return {
      ok: true,
      verb: "model",
      argv: ["model", "policy", "propose", scratchPath, ...project, "--json"],
      command: `forge model policy propose <candidate>${shown} --json`,
    };
  }
  if (rationale === undefined || rationale.trim() === "") return refuse(400, "a rationale is required to apply a model-policy change.");
  if (rationale.length > MAX_RATIONALE_CHARS) return refuse(400, `rationale must be at most ${MAX_RATIONALE_CHARS} characters.`);
  const dash = assertOperand(rationale.trimStart(), "the rationale");
  if (dash) return dash;
  return {
    ok: true,
    verb: "model",
    argv: ["model", "policy", "apply", scratchPath, ...project, "--confirm", "--by", actor, "--source", "dashboard", "--rationale", rationale, "--json"],
    command: `forge model policy apply <candidate>${shown} --confirm --by ${actor} --source dashboard --rationale <rationale> --json`,
  };
}

// ─── the scratch candidate ───────────────────────────────────────────────────

function forgeHome(): string {
  return process.env["FORGE_HOME"] ?? join(homedir(), ".forge");
}

/** Where candidates are staged: FORGE_HOME, never a project checkout. */
export function modelPolicyScratchRoot(): string {
  return join(forgeHome(), "dashboard", "model-policy-candidates");
}

async function withScratchCandidate<T>(candidate: string, use: (path: string) => Promise<T>): Promise<T> {
  const root = modelPolicyScratchRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, "c-"));
  try {
    const path = join(dir, "model-policy.yml");
    writeFileSync(path, candidate, { mode: 0o600 });
    return await use(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── the handler ─────────────────────────────────────────────────────────────

export type ModelPolicyMutationContext = {
  /** Resolved only after every header and body guard has passed. */
  resolveProject: (projectKey: string) => ProjectRecord | undefined;
  actor: string;
  now?: () => number;
  window?: ProposalWindow;
};

function parseCliJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function gateFindings(result: Record<string, unknown>): string[] {
  const findings = (result["findings"] ?? []) as Array<{ code?: string; message?: string }>;
  return findings.map((f) => `[${f.code}] ${f.message}`);
}

export async function handleModelPolicyMutation(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: ModelPolicyMutationContext,
): Promise<void> {
  const m = path.match(MODEL_POLICY_PATH);
  if (!m) {
    send(res, 404, { ok: false, error: "not found" });
    return;
  }
  const action = `model-policy-${m[1]}` as ModelPolicyAction;
  const now = context.now ?? Date.now;
  const window = context.window ?? proposals;

  const headerRefusal = guardMutationPost(req, "model-policy changes");
  if (headerRefusal) {
    send(res, headerRefusal.status, { ok: false, action, error: headerRefusal.error });
    return;
  }
  const body = await readBody(req, MAX_POLICY_BODY_BYTES);
  if (isRefusal(body)) {
    send(res, body.status, { ok: false, action, error: body.error });
    return;
  }
  let parsed: unknown;
  try {
    parsed = body.text.trim() === "" ? {} : JSON.parse(body.text);
  } catch {
    send(res, 400, { ok: false, action, error: "the request body is not valid JSON." });
    return;
  }
  const request = parseModelPolicyRequest(action, parsed);
  if (isRefusal(request)) {
    send(res, request.status, { ok: false, action, error: request.error });
    return;
  }

  let checkout: string | undefined;
  let scope: string;
  let target: { kind: "host" } | { kind: "project"; key: string; checkoutDir: string };
  if (request.target.kind === "project") {
    const owner = context.resolveProject(request.target.projectKey);
    if (!owner) {
      send(res, 404, { ok: false, action, error: `no registered project has the key ${JSON.stringify(request.target.projectKey)}.` });
      return;
    }
    const dir = resolveCheckoutDir(owner, request.target.projectDir);
    if (isRefusal(dir)) {
      send(res, dir.status, { ok: false, action, error: dir.error });
      return;
    }
    checkout = dir;
    scope = `${owner.key}\n${dir}`;
    target = { kind: "project", key: owner.key, checkoutDir: dir };
  } else {
    scope = HOST_CONFIRM_KEY;
    target = { kind: "host" };
  }

  if (action === "model-policy-apply") {
    const refused = policyApplyRefusal(request, scope, window, now());
    if (refused) {
      send(res, refused.status, { ok: false, action, refusal: refused.refusal, error: refused.error });
      return;
    }
  }

  const binary = resolveForgeBinary();
  if (isRefusal(binary)) {
    send(res, binary.status, { ok: false, action, error: binary.error });
    return;
  }
  const cwd = checkout ?? forgeHome();

  let command = "";
  let taken = null as number | null;
  const result = await withMutationSlot(() => {
    if (action === "model-policy-apply") {
      taken = window.take(scope, request.candidateSha256, now());
      if (taken === null) return Promise.resolve(notProposed());
    }
    return withScratchCandidate(request.candidate, async (scratch): Promise<ForgeRunResult | MutationRefusal> => {
      const built = buildModelPolicyArgv(action, scratch, checkout, context.actor, request.rationale);
      if (isRefusal(built)) return built;
      if (
        built.argv[0] !== "model" ||
        built.argv[1] !== "policy" ||
        built.argv.includes("--force") ||
        built.argv.includes("--allow-undispatchable") ||
        built.argv.includes(request.candidate)
      ) {
        return refuse(500, "refusing to spawn an unregistered model-policy argv.");
      }
      command = built.command;
      return runForgeVerb(binary.path, built.argv, cwd);
    });
  });
  if (result === null) {
    send(res, 503, { ok: false, action, error: `too many dashboard mutations in flight (${MAX_CONCURRENT_MUTATIONS}); retry in a moment.` });
    return;
  }
  // A timed-out child may still have written, so its proposal stays spent.
  const wroteNothing = isRefusal(result) || (!result.timedOut && (result.code !== 0 || parseCliJson(result.stdout)?.["written"] !== true));
  if (taken !== null && wroteNothing) window.refund(scope, request.candidateSha256, taken, now());
  if (isRefusal(result)) {
    send(res, result.status, { ok: false, action, ...("refusal" in result ? { refusal: result.refusal } : {}), error: result.error });
    return;
  }

  const summary = { action, verb: command, target, candidateSha256: request.candidateSha256, exitCode: result.code };
  if (result.timedOut) {
    send(res, 504, { ok: false, ...summary, error: `\`${command}\` did not finish within ${CHILD_TIMEOUT_MS}ms.` });
    return;
  }
  const cli = parseCliJson(result.stdout);
  if (result.code !== 0) {
    if (cli && Array.isArray(cli["findings"]) && cli["ok"] === false) {
      const findings = gateFindings(cli);
      send(res, 409, {
        ok: false,
        ...summary,
        refusal: "gate_failed",
        error: findings.length ? `the model-policy gate refused the candidate:\n${findings.join("\n")}` : "the model-policy gate refused the candidate.",
        result: cli,
      });
      return;
    }
    const verb = `model policy ${action === "model-policy-apply" ? "apply" : "propose"}`;
    const detail = cli && typeof cli["detail"] === "string" ? `: ${cli["detail"]}` : "";
    send(res, 409, { ok: false, ...summary, error: `${cliRefusal(result, verb)}${detail}`.slice(-MAX_REPORTED_STDERR).trim(), ...(cli ? { result: cli } : {}) });
    return;
  }

  if (action === "model-policy-propose") {
    const expiresAt = window.record(scope, request.candidateSha256, now());
    send(res, 200, { ok: true, ...summary, proposalExpiresAt: new Date(expiresAt).toISOString(), result: cli });
    return;
  }
  if (cli?.["written"] !== true) {
    send(res, 409, { ok: false, ...summary, error: "`forge model policy apply` exited 0 but reports nothing written.", result: cli });
    return;
  }
  send(res, 200, { ok: true, ...summary, result: cli });
}

// ─── GET /api/model-policy ───────────────────────────────────────────────────

export type PolicyResolutionRow = {
  role: string;
  activity: string;
  isDefault: boolean;
  profile: string | null;
  provider: string | null;
  model: string | null;
  auth: string | null;
  runtime: string | null;
  costTier: string | null;
  outcome: string | null;
  dispatchable: boolean | null;
  resolvedBy: string | null;
  error: string | null;
};

export type PolicyBackup = { path: string; name: string; timestamp: string; sha256: string; bytes: number };

export type ModelPolicyReadModel = {
  /** The file an apply from this view replaces, and the confirmation it takes. */
  target: {
    kind: "host" | "project";
    path: string;
    exists: boolean;
    sha256: string | null;
    confirmKey: string;
    project: { key: string; label: string; checkoutDir: string } | null;
  };
  /** The policy in force for this scope: the project override when present, else the host file. */
  source: { kind: "project" | "host" | "absent"; path: string | null; text: string | null; error: string | null };
  resolution: { rows: PolicyResolutionRow[]; policyError: string | null };
  audit: { path: string; entries: RaciAuditLine[]; skippedLines: number };
  backups: { dir: string; entries: PolicyBackup[] };
  proposalWindowMs: number;
  maxCandidateBytes: number;
};

/** The timestamped `<target>.bak-<iso>` files apply keeps beside the target, newest first. */
export function listPolicyBackups(targetPath: string, limit: number = MAX_BACKUPS_LISTED): PolicyBackup[] {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) return [];
  const prefix = `${basename(targetPath)}.bak-`;
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => {
      const path = join(dir, name);
      return { path, name, timestamp: name.slice(prefix.length), sha256: sha256OfBytes(path), bytes: statSync(path).size };
    });
}

/** READ-ONLY: the model-policy editor's view of one target — the host file, or one
 *  project checkout's override. No subprocess, no outbound call. */
export function modelPolicyReadModel(project?: { owner: ProjectRecord; checkoutDir: string }): ModelPolicyReadModel {
  const home = forgeHome();
  const gen = resolveSeedGeneration(home);
  const target = policyTarget(project?.checkoutDir);

  const hostPath = join(home, "model-policy.yml");
  const projectPath = project ? join(project.checkoutDir, ".forge", "model-policy.yml") : null;
  const effectivePath = projectPath && existsSync(projectPath) ? projectPath : existsSync(hostPath) ? hostPath : null;
  let error: string | null = null;
  try {
    loadModelPolicyWithSource({ seedGeneration: gen, ...(project ? { projectDir: project.checkoutDir } : {}) });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const source: ModelPolicyReadModel["source"] = {
    kind: effectivePath === null ? "absent" : effectivePath === projectPath ? "project" : "host",
    path: effectivePath,
    text: effectivePath ? readFileSync(effectivePath, "utf8") : null,
    error,
  };

  const harnessProject = project ? { key: project.owner.key, dir: project.checkoutDir } : undefined;
  const rows: PolicyResolutionRow[] = [];
  let policyError: string | null = null;
  for (const role of listSeedRoles(home)) {
    const harness = harnessActivities(role, gen, harnessProject);
    policyError ??= harness.policyError;
    for (const r of harness.rows) {
      rows.push({
        role,
        activity: r.activity,
        isDefault: r.isDefault,
        profile: r.profile,
        provider: r.provider,
        model: r.model,
        auth: r.auth,
        runtime: r.runtime,
        costTier: r.costTier,
        outcome: r.outcome,
        dispatchable: r.dispatchable,
        resolvedBy: r.resolvedBy,
        error: r.error,
      });
    }
  }

  const exists = existsSync(target.path);
  const auditPath = auditLogPath(target);
  return {
    target: {
      kind: target.kind,
      path: target.path,
      exists,
      sha256: exists ? sha256OfBytes(target.path) : null,
      confirmKey: project ? project.owner.key : HOST_CONFIRM_KEY,
      project: project ? { key: project.owner.key, label: project.owner.label, checkoutDir: project.checkoutDir } : null,
    },
    source,
    resolution: { rows, policyError },
    audit: { path: auditPath, ...readAuditTail(auditPath) },
    backups: { dir: dirname(target.path), entries: listPolicyBackups(target.path) },
    proposalWindowMs: PROPOSAL_WINDOW_MS,
    maxCandidateBytes: MAX_POLICY_CANDIDATE_BYTES,
  };
}
