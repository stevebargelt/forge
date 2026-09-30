// FG-834 — GOVERNANCE AUTHORED FROM THE DASHBOARD, THROUGH THE CLI'S OWN GATE.
//
// Two ACTION_ROUTES rows (action-mutation.ts) land here: `POST /api/raci/propose` and
// `POST /api/raci/apply`. They revise FG-591 D2's exclusion of routing application
// from this surface, and only as far as this: a human may CONFIRM a project RACI
// change from the dashboard instead of a terminal. Everything that makes the write
// safe stays where it was — in `forge raci propose` / `forge raci apply --confirm`:
//
//  * The candidate travels as TEXT in the JSON body, size-bounded, and is written to a
//    unique scratch file under FORGE_HOME (never the project), which is removed after
//    the child exits. The candidate text never reaches argv — only the scratch path does,
//    so the audit line's `candidate` names a deleted file; `candidate_sha256` identifies it.
//  * `--project` is the registry's own checkout for the requested project key
//    (resolveCheckoutDir, the FG-591 rule), never a caller-supplied path.
//  * argv is fixed: `raci propose <scratch> --project <dir> --json` and
//    `raci apply <scratch> --project <dir> --confirm --by dashboard --source dashboard
//    --rationale <text> --json` — the rationale is one argv element, never interpolated,
//    bounded and refused if it begins with "-". No `--force`
//    exists on either verb, and there is no route to `route compile` or `raci validate`.
//  * apply is refused HERE unless the same candidate bytes were proposed green for the
//    same checkout within PROPOSAL_WINDOW_MS, the typed confirmation equals the project
//    key, and a rationale is given. Inside the mutation slot, before the spawn, the
//    proposal is taken, so one green propose admits one apply; it is refunded only when
//    the child wrote nothing. These refusals are enforced before any spawn, but they are
//    not the write authority: the CLI re-runs the whole gate before it writes, recompiles
//    the policy and appends the audit line, and its refusal is passed back verbatim.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRecord, WorkbenchPanel } from "./queries.js";
import { resolveCheckoutDir } from "./queue-mutation.js";
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

export type RaciAction = "raci-propose" | "raci-apply";

export const RACI_PATH = /^\/api\/raci\/(propose|apply)$/;

export const MAX_RACI_CANDIDATE_BYTES = 256 * 1024;
/** JSON escaping at most doubles markdown prose (newlines, quotes); the candidate's own
 *  byte bound is checked again after parsing. */
const MAX_RACI_BODY_BYTES = 2 * MAX_RACI_CANDIDATE_BYTES + 16 * 1024;
export const MAX_RATIONALE_CHARS = 2000;

export const PROPOSAL_WINDOW_MS = 15 * 60 * 1000;
const MAX_PROPOSALS = 256;

export const AUDIT_TAIL_LINES = 20;

export type RaciRefusalCode = "candidate_not_proposed" | "candidate_changed" | "confirm_key_mismatch" | "rationale_required" | "rationale_invalid" | "gate_failed";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ─── the proposal window ─────────────────────────────────────────────────────

/** The green proposes this server has seen, keyed by checkout scope + candidate sha, each
 *  admissible for `windowMs` after it was recorded. In-memory by design: a restart forgets
 *  every proposal, which only ever costs a re-propose. Bounded so an unauthenticated
 *  loopback caller cannot grow it without limit. */
export class ProposalWindow {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number = PROPOSAL_WINDOW_MS,
    private readonly maxEntries: number = MAX_PROPOSALS,
  ) {}

  private static key(scope: string, sha: string): string {
    return `${scope}\n${sha}`;
  }

  private prune(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at > this.windowMs) this.seen.delete(key);
    }
  }

  /** Record a green propose; returns when it stops being admissible. */
  record(scope: string, sha: string, now: number): number {
    this.prune(now);
    const key = ProposalWindow.key(scope, sha);
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > this.maxEntries) {
      this.seen.delete(this.seen.keys().next().value!);
    }
    return now + this.windowMs;
  }

  has(scope: string, sha: string, now: number): boolean {
    this.prune(now);
    return this.seen.has(ProposalWindow.key(scope, sha));
  }

  /** Spend an admissible proposal, returning when it was recorded, or null when there is
   *  none. Synchronous, so two applies racing on one green propose cannot both take it. */
  take(scope: string, sha: string, now: number): number | null {
    this.prune(now);
    const key = ProposalWindow.key(scope, sha);
    const at = this.seen.get(key);
    if (at === undefined) return null;
    this.seen.delete(key);
    return at;
  }

  /** Give back a proposal whose apply wrote nothing, keeping its original expiry. A
   *  propose recorded meanwhile wins. */
  refund(scope: string, sha: string, at: number, now: number): void {
    const key = ProposalWindow.key(scope, sha);
    if (this.seen.has(key) || now - at > this.windowMs) return;
    this.seen.set(key, at);
    while (this.seen.size > this.maxEntries) {
      this.seen.delete(this.seen.keys().next().value!);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

const proposals = new ProposalWindow();

// ─── the request body ────────────────────────────────────────────────────────

export type RaciRequest = {
  projectKey: string;
  projectDir: string | undefined;
  candidate: string;
  candidateSha256: string;
  proposedSha256?: string;
  confirmKey?: string;
  rationale?: string;
};

const FIELDS: Record<RaciAction, readonly string[]> = {
  "raci-propose": ["projectKey", "projectDir", "candidate"],
  "raci-apply": ["projectKey", "projectDir", "candidate", "proposedSha256", "confirmKey", "rationale"],
};

function optionalString(input: Record<string, unknown>, field: string): string | undefined | MutationRefusal {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return refuse(400, `${field} must be a string.`);
  return value;
}

/** PURE: the body checked against the one shape each RACI route takes. The apply
 *  preconditions that need the proposal window are decided later, in `applyRefusal`. */
export function parseRaciRequest(action: RaciAction, body: unknown): RaciRequest | MutationRefusal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse(400, "the request body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  const allowed = FIELDS[action];
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    return refuse(400, `this route takes ${allowed.join(", ")}; refusing ${extra.join(", ")}. The dashboard never passes --force.`);
  }
  const projectKey = input["projectKey"];
  if (typeof projectKey !== "string" || projectKey.trim() === "") return refuse(400, "projectKey is required: the registered project whose RACI this is.");
  const projectDir = optionalString(input, "projectDir");
  if (isRefusal(projectDir)) return projectDir;
  const candidate = input["candidate"];
  if (typeof candidate !== "string" || candidate.trim() === "") return refuse(400, "candidate is required: the RACI source text to gate.");
  const bytes = Buffer.byteLength(candidate, "utf8");
  if (bytes > MAX_RACI_CANDIDATE_BYTES) {
    return refuse(413, `the candidate RACI is ${bytes} bytes; at most ${MAX_RACI_CANDIDATE_BYTES} are accepted.`);
  }
  const out: RaciRequest = { projectKey, projectDir, candidate, candidateSha256: sha256Hex(candidate) };
  if (action === "raci-apply") {
    for (const field of ["proposedSha256", "confirmKey", "rationale"] as const) {
      const value = optionalString(input, field);
      if (isRefusal(value)) return value;
      if (value !== undefined) out[field] = value;
    }
  }
  return out;
}

export type RaciApplyRefusal = MutationRefusal & { refusal: RaciRefusalCode };

function named(status: number, refusal: RaciRefusalCode, error: string): RaciApplyRefusal {
  return { ...refuse(status, error), refusal };
}

/** The four apply preconditions, by name. `scope` is the resolved checkout's proposal
 *  scope, so a propose on one checkout never admits an apply on another. */
export function applyRefusal(
  request: RaciRequest,
  scope: string,
  window: ProposalWindow,
  now: number,
): RaciApplyRefusal | null {
  const rationale = request.rationale?.trim() ?? "";
  if (rationale === "") return named(400, "rationale_required", "a rationale is required to apply a RACI change: it is the human decision record.");
  if (request.rationale!.length > MAX_RATIONALE_CHARS) return named(400, "rationale_invalid", `rationale must be at most ${MAX_RATIONALE_CHARS} characters.`);
  if (rationale.startsWith("-")) return named(400, "rationale_invalid", `rationale must not begin with "-": it would be read as a flag by the CLI.`);
  if (request.confirmKey !== request.projectKey) {
    return named(400, "confirm_key_mismatch", `type the project key (${request.projectKey}) to confirm this RACI change.`);
  }
  if (request.proposedSha256 !== request.candidateSha256) {
    return named(409, "candidate_changed", "the candidate is not the one that was proposed (its sha256 differs); propose it again before applying.");
  }
  if (!window.has(scope, request.candidateSha256, now)) return notProposed();
  return null;
}

function notProposed(): RaciApplyRefusal {
  return named(
    409,
    "candidate_not_proposed",
    `this candidate has no green propose for this checkout in the last ${Math.round(PROPOSAL_WINDOW_MS / 60000)} minutes; propose it first.`,
  );
}

// ─── argv ────────────────────────────────────────────────────────────────────

export type BuiltRaci = { ok: true; verb: "raci"; argv: string[]; command: string };

/** THE ARGV BUILDER. Only the scratch path, the registry's checkout and (apply) the
 *  rationale — as its own element — reach argv. */
export function buildRaciArgv(action: RaciAction, scratchPath: string, projectDir: string, actor: string, rationale?: string): BuiltRaci | MutationRefusal {
  for (const [value, field] of [[scratchPath, "the scratch candidate path"], [projectDir, "the resolved project checkout"]] as const) {
    if (!isAbsolute(value)) return refuse(500, `${field} is not an absolute path.`);
    const dash = assertOperand(value, field);
    if (dash) return dash;
  }
  if (action === "raci-propose") {
    return { ok: true, verb: "raci", argv: ["raci", "propose", scratchPath, "--project", projectDir, "--json"], command: `forge raci propose <candidate> --project ${projectDir} --json` };
  }
  if (rationale === undefined || rationale.trim() === "") return refuse(400, "a rationale is required to apply a RACI change.");
  if (rationale.length > MAX_RATIONALE_CHARS) return refuse(400, `rationale must be at most ${MAX_RATIONALE_CHARS} characters.`);
  const dash = assertOperand(rationale.trimStart(), "the rationale");
  if (dash) return dash;
  return {
    ok: true,
    verb: "raci",
    argv: ["raci", "apply", scratchPath, "--project", projectDir, "--confirm", "--by", actor, "--source", "dashboard", "--rationale", rationale, "--json"],
    command: `forge raci apply <candidate> --project ${projectDir} --confirm --by ${actor} --source dashboard --rationale <rationale> --json`,
  };
}

// ─── the scratch candidate ───────────────────────────────────────────────────

function forgeHome(): string {
  return process.env["FORGE_HOME"] ?? join(homedir(), ".forge");
}

/** Where candidates are staged: FORGE_HOME, never a project checkout. */
export function raciScratchRoot(): string {
  return join(forgeHome(), "dashboard", "raci-candidates");
}

/** Write the candidate to a fresh per-request directory, run `use`, remove it. */
async function withScratchCandidate<T>(candidate: string, use: (path: string) => Promise<T>): Promise<T> {
  const root = raciScratchRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, "c-"));
  try {
    const path = join(dir, "forge-raci.md");
    writeFileSync(path, candidate, { mode: 0o600 });
    return await use(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── the handler ─────────────────────────────────────────────────────────────

export type RaciMutationContext = {
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

type Finding = { code?: string; route?: string; message?: string };

/** The gate's findings as one line each, for the refusal text. */
function gateFindings(result: Record<string, unknown>): string[] {
  const proposal = (result["proposal"] ?? result) as { validation?: Record<string, { findings?: Finding[] }> };
  const lines: string[] = [];
  for (const part of Object.values(proposal.validation ?? {})) {
    for (const f of part.findings ?? []) lines.push(`[${f.code}]${f.route ? ` [route: ${f.route}]` : ""} ${f.message}`);
  }
  return lines;
}

export async function handleRaciMutation(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: RaciMutationContext,
): Promise<void> {
  const m = path.match(RACI_PATH);
  if (!m) {
    send(res, 404, { ok: false, error: "not found" });
    return;
  }
  const action = `raci-${m[1]}` as RaciAction;
  const now = context.now ?? Date.now;
  const window = context.window ?? proposals;

  const headerRefusal = guardMutationPost(req, "RACI changes");
  if (headerRefusal) {
    send(res, headerRefusal.status, { ok: false, action, error: headerRefusal.error });
    return;
  }
  const body = await readBody(req, MAX_RACI_BODY_BYTES);
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
  const request = parseRaciRequest(action, parsed);
  if (isRefusal(request)) {
    send(res, request.status, { ok: false, action, error: request.error });
    return;
  }

  const owner = context.resolveProject(request.projectKey);
  if (!owner) {
    send(res, 404, { ok: false, action, error: `no registered project has the key ${JSON.stringify(request.projectKey)}.` });
    return;
  }
  const checkout = resolveCheckoutDir(owner, request.projectDir);
  if (isRefusal(checkout)) {
    send(res, checkout.status, { ok: false, action, error: checkout.error });
    return;
  }
  const scope = `${owner.key}\n${checkout}`;

  if (action === "raci-apply") {
    const refused = applyRefusal(request, scope, window, now());
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

  let command = "";
  let taken = null as number | null;
  const result = await withMutationSlot(() => {
    if (action === "raci-apply") {
      taken = window.take(scope, request.candidateSha256, now());
      if (taken === null) return Promise.resolve(notProposed());
    }
    return withScratchCandidate(request.candidate, async (scratch): Promise<ForgeRunResult | MutationRefusal> => {
      const built = buildRaciArgv(action, scratch, checkout, context.actor, request.rationale);
      if (isRefusal(built)) return built;
      if (built.argv[0] !== "raci" || built.argv.includes("--force") || built.argv.includes(request.candidate)) {
        return refuse(500, "refusing to spawn an unregistered RACI argv.");
      }
      command = built.command;
      return runForgeVerb(binary.path, built.argv, checkout);
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

  const summary = { action, verb: command, project: { key: owner.key, checkoutDir: checkout }, candidateSha256: request.candidateSha256, exitCode: result.code };
  if (result.timedOut) {
    send(res, 504, { ok: false, ...summary, error: `\`${command}\` did not finish within ${CHILD_TIMEOUT_MS}ms.` });
    return;
  }
  const cli = parseCliJson(result.stdout);
  if (result.code !== 0) {
    if (cli && ("validation" in cli || "proposal" in cli)) {
      const findings = gateFindings(cli);
      send(res, 409, {
        ok: false,
        ...summary,
        refusal: "gate_failed",
        error: findings.length ? `the RACI gate refused the candidate:\n${findings.join("\n")}` : "the RACI gate refused the candidate.",
        result: cli,
      });
      return;
    }
    send(res, 409, { ok: false, ...summary, error: cliRefusal(result, `raci ${action === "raci-apply" ? "apply" : "propose"}`).slice(-MAX_REPORTED_STDERR).trim() });
    return;
  }

  if (action === "raci-propose") {
    const expiresAt = window.record(scope, request.candidateSha256, now());
    send(res, 200, { ok: true, ...summary, proposalExpiresAt: new Date(expiresAt).toISOString(), result: cli });
    return;
  }
  if (cli?.["written"] !== true) {
    send(res, 409, { ok: false, ...summary, error: "`forge raci apply` exited 0 but reports nothing written.", result: cli });
    return;
  }
  send(res, 200, { ok: true, ...summary, result: cli });
}

// ─── GET /api/raci ───────────────────────────────────────────────────────────

export type RaciAuditLine = Record<string, unknown>;

export type RaciReadModel = {
  project: { key: string; label: string; checkoutDir: string };
  source: { kind: "project" | "host"; path: string; text: string | null };
  governance: WorkbenchPanel;
  audit: { path: string; entries: RaciAuditLine[]; skippedLines: number };
  proposalWindowMs: number;
  maxCandidateBytes: number;
};

/** The last `limit` parseable lines of a JSONL audit log, newest first. */
export function readAuditTail(path: string, limit: number = AUDIT_TAIL_LINES): { entries: RaciAuditLine[]; skippedLines: number } {
  if (!existsSync(path)) return { entries: [], skippedLines: 0 };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").slice(-limit);
  const entries: RaciAuditLine[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(parsed as RaciAuditLine);
      else skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }
  return { entries: entries.reverse(), skippedLines };
}

/** READ-ONLY: the effective RACI source for one checkout (project override if present,
 *  else the host default the editor starts from), the governance panel, and the
 *  checkout's own `raci-audit.log` tail. No subprocess. */
export function raciReadModel(owner: ProjectRecord, checkoutDir: string, governance: WorkbenchPanel): RaciReadModel {
  const kind = governance.source.kind;
  const path = governance.source.raciPath;
  const auditPath = join(checkoutDir, ".forge", "raci-audit.log");
  return {
    project: { key: owner.key, label: owner.label, checkoutDir },
    source: { kind, path, text: existsSync(path) ? readFileSync(path, "utf8") : null },
    governance,
    audit: { path: auditPath, ...readAuditTail(auditPath) },
    proposalWindowMs: PROPOSAL_WINDOW_MS,
    maxCandidateBytes: MAX_RACI_CANDIDATE_BYTES,
  };
}
