import path from "node:path";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getDb } from "./db.js";

// FG-500: the project default gate is a single command, but a project may also
// split its suite across an extended tier (see reconcile-collect.ts's
// getRequiredHostGate + the project's package.json test:extended script).
// Matches the literal default reconcile-collect.ts/done-audit/collect.ts fall
// back to when .forge/config.json has no requiredHostGate configured.
const DEFAULT_REQUIRED_HOST_GATE = "npm run test:all";
const EXTENDED_GATE_COMMAND = "npm run test:extended";

/** The full required-gate LIST for a project: just [requiredGate], UNLESS
 *  requiredGate is still the project default AND the project's package.json
 *  demonstrably defines a test:extended script — in which case the extended
 *  tier joins the list too. A project with a custom requiredHostGate, or no
 *  test:extended script, gets single-gate behavior, unchanged (FG-500's
 *  regression guard — no new false blocks on other managed projects). Every
 *  consumer of "the deterministic gate" (evidence-reuse, reconcile's real-exec
 *  capture, done-audit) must treat this LIST, not requiredGate alone, as what
 *  "the gate" means. */
export function deriveRequiredGateList(projectDir: string, requiredGate: string): string[] {
  if (requiredGate !== DEFAULT_REQUIRED_HOST_GATE) return [requiredGate];
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof pkg.scripts?.["test:extended"] === "string") {
      return [requiredGate, EXTENDED_GATE_COMMAND];
    }
  } catch {
    // missing or malformed package.json — single-gate behavior stands
  }
  return [requiredGate];
}

// FG-431: LOOKUP exact-matches project_dir, but callers (the CLI recorder, the
// reconcile-time auto-capture writer) may hand in a relative or otherwise
// non-canonical path. Canonicalizing to the same absolute form on both the
// insert and the lookup side means a row recorded with an equivalent-but-not-
// identical path string is still found by reconcile — without loosening any
// other match dimension (ticket_id, gate_name, commit_sha stay exact).
function canonicalizeProjectDir(projectDir: string): string {
  return path.resolve(projectDir);
}

// FG-474: 'host' (default) = a real host command execution; 'ci' = sourced from a
// green required CI check rather than a host-run command — see findCoveringGateEvidence.
export type HostVerificationSource = "host" | "ci";

export type HostVerificationRow = {
  id?: number;
  ticketId: string;
  projectDir: string;
  commitSha: string;
  gateName: string;
  command: string;
  exitCode: number;
  runId?: string | null;
  recordedAt: string;
  source?: HostVerificationSource;
  ciUrl?: string | null;
};

type DbRow = {
  id: number;
  ticket_id: string;
  project_dir: string;
  commit_sha: string;
  gate_name: string;
  command: string;
  exit_code: number;
  run_id: string | null;
  recorded_at: string;
  source: string;
  ci_url: string | null;
};

function rowToVerification(row: DbRow): HostVerificationRow {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    projectDir: row.project_dir,
    commitSha: row.commit_sha,
    gateName: row.gate_name,
    command: row.command,
    exitCode: row.exit_code,
    runId: row.run_id,
    recordedAt: row.recorded_at,
    source: row.source === "ci" ? "ci" : "host",
    ciUrl: row.ci_url,
  };
}

function runInsert(v: Omit<HostVerificationRow, "id">, runId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(v.ticketId, v.projectDir, v.commitSha, v.gateName, v.command, v.exitCode, runId, v.recordedAt, v.source ?? "host", v.ciUrl ?? null);
}

// run_id references runs(id) — a run row pruned between dispatch and this write
// leaves run_id dangling, and that must not cost us a REAL gate result. Retry
// exactly once, with run_id nulled, but ONLY when the failure is specifically
// that FK violation; any other DB error (bad column, disk full, etc.) is a real
// error and must surface, not be silently assumed away.
function isDanglingRunIdForeignKeyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

export function insertHostVerification(v: Omit<HostVerificationRow, "id">): void {
  const canonical = { ...v, projectDir: canonicalizeProjectDir(v.projectDir) };
  try {
    runInsert(canonical, canonical.runId ?? null);
  } catch (err) {
    if (canonical.runId && isDanglingRunIdForeignKeyError(err)) {
      runInsert(canonical, null);
      return;
    }
    throw err;
  }
}

export function queryHostVerificationRows(
  ticketId: string,
  projectDir: string,
  commitSha: string,
  gateName: string
): HostVerificationRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM host_verifications
       WHERE ticket_id = ? AND project_dir = ? AND commit_sha = ? AND gate_name = ?
       ORDER BY recorded_at ASC`
    )
    .all(ticketId, canonicalizeProjectDir(projectDir), commitSha, gateName) as DbRow[];
  return rows.map(rowToVerification);
}

// FG-440: unfiltered by commit_sha — reconcile-collect.ts's ancestry-based
// coverage check needs every recorded row for this ticket+project+gate so it
// can test each row's commit_sha for ancestry, not just an exact-sha match.
export function queryHostVerificationRowsForGate(
  ticketId: string,
  projectDir: string,
  gateName: string
): HostVerificationRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM host_verifications
       WHERE ticket_id = ? AND project_dir = ? AND gate_name = ?
       ORDER BY recorded_at ASC`
    )
    .all(ticketId, canonicalizeProjectDir(projectDir), gateName) as DbRow[];
  return rows.map(rowToVerification);
}

// ── FG-474: covering-evidence lookup for the deterministic gate ────────────────
//
// "Covering evidence" answers: for (projectDir, sha, command), has the canonical
// deterministic gate already run — for real — against this exact commit? Consumers
// (review-loop's verification phase, campaign reconcile's host-verification capture)
// consult this BEFORE re-running the gate on the host, so one real gate result per
// commit is reused instead of re-executed. Two sources, checked in order:
//   (a) an existing PASSING host_verifications row for the exact sha + command;
//   (b) a green required CI check ("CI / test") for the exact sha, via an
//       injectable provider — see CheckStatusProvider below.
// Fails closed: no evidence, a different sha, a different command, a failing/
// pending/skipped check, or a check for a DIFFERENT sha must all return null so
// the caller falls back to actually running the gate.

export type CiCheckState = "success" | "pending" | "failure" | "other";

export type CiCheckStatus = {
  /** the sha the CI API response actually reports on — read from the response
   *  body, never assumed to equal the requested sha (see defaultCheckStatusProvider). */
  sha: string;
  state: CiCheckState;
  detailsUrl?: string;
};

export type CheckStatusProvider = (opts: {
  projectDir: string;
  sha: string;
  checkContext: string;
}) => CiCheckStatus | null;

// The required merge-gate check FG-474 wired up: workflow "CI", job "test".
export const REQUIRED_CI_CHECK_CONTEXT = "CI / test";

// FG-474 red-review fix (task-red-wide-16933b): forge is host-global — this
// constant describes what THIS repo's own ci.yml runs, and is only meaningful
// to src/v2/ci-workflow.test.ts's structural self-check. The general-purpose
// lookup gate (findCoveringGateEvidence below) does NOT use this constant: it
// reads the ARBITRARY managed project's own ci.yml via projectCiRunsCommand,
// because a green REQUIRED_CI_CHECK_CONTEXT on some other project only proves
// that project's own workflow ran opts.command — never that it ran this one.
export const REQUIRED_CI_GATE_COMMAND = "npm run test:all";

type WorkflowStep = { run?: unknown };
type WorkflowJob = { name?: unknown; steps?: unknown };
type WorkflowFile = { name?: unknown; jobs?: unknown };

// Reads <projectDir>/.github/workflows/*.y[a]ml and returns the `jobs` object
// of every workflow file whose top-level `name` equals workflowName — the
// parsing projectCiRunsCommand and projectCiWorkflowJobIds both need. Fails
// closed with null (not []) only when the workflows dir itself can't be read
// (missing dir, permissions) — the distinction matters to callers that must
// tell "no workflow files at all" apart from "workflows dir exists but none
// of them are named workflowName" (both cases still yield no jobs, but the
// null case is the "we couldn't even look" signal).
function matchingWorkflowJobs(projectDir: string, workflowName: string): Record<string, unknown>[] | null {
  const workflowsDir = path.join(projectDir, ".github", "workflows");
  let files: string[];
  try {
    files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/i.test(f));
  } catch {
    return null;
  }

  const matches: Record<string, unknown>[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(path.join(workflowsDir, file), "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const workflow = parsed as WorkflowFile;
    if (workflow.name !== workflowName) continue;
    matches.push(typeof workflow.jobs === "object" && workflow.jobs !== null ? (workflow.jobs as Record<string, unknown>) : {});
  }
  return matches;
}

/** Does <projectDir>/.github/workflows/*.y[a]ml define a workflow whose name
 *  matches the workflow half of checkContext ("<workflow> / <job>", e.g.
 *  "CI / test") with a job (matched by job id or job `name`) matching the job
 *  half, one of whose steps has a `run:` string that (trimmed) exactly equals
 *  `command`? This is what actually pins a green check named checkContext to
 *  proof that `command` ran — a check name alone proves nothing about which
 *  command backs it (the FG-419/FG-474 spoofing vector). Fails closed: no
 *  workflows dir, no matching workflow/job, unparseable YAML, or no exactly-
 *  matching run step all return false — never assume coverage we couldn't
 *  actually verify from the project's own workflow content. */
export function projectCiRunsCommand(projectDir: string, checkContext: string, command: string): boolean {
  const [workflowName, jobName] = checkContext.split("/").map((s) => s.trim());
  if (!workflowName || !jobName) return false;

  const jobsList = matchingWorkflowJobs(projectDir, workflowName);
  if (!jobsList) return false;

  for (const jobs of jobsList) {
    for (const [jobId, jobRaw] of Object.entries(jobs)) {
      if (typeof jobRaw !== "object" || jobRaw === null) continue;
      const job = jobRaw as WorkflowJob;
      if (jobId !== jobName && job.name !== jobName) continue;

      const steps = Array.isArray(job.steps) ? job.steps : [];
      for (const stepRaw of steps) {
        if (typeof stepRaw !== "object" || stepRaw === null) continue;
        const step = stepRaw as WorkflowStep;
        if (typeof step.run === "string" && step.run.trim() === command.trim()) return true;
      }
    }
  }
  return false;
}

/** Every job id defined under the workflow(s) named workflowName in
 *  <projectDir>/.github/workflows/*.y[a]ml — the same parsing
 *  projectCiRunsCommand uses. This is what lets findCoveringGateEvidence
 *  require the WHOLE workflow green at a sha (FG-495 review finding), not
 *  just the one job paired to opts.command: post-FG-495, forge's own CI
 *  workflow splits the suite across `test` + `test-extended`, so a green
 *  "CI / test" alone no longer proves the whole gate passed. Fails closed
 *  with null — not [] — when the workflows dir can't be read, or no workflow
 *  named workflowName exists, or it exists with no jobs: callers must never
 *  treat "couldn't enumerate the jobs" as "there are zero jobs to check". */
export function projectCiWorkflowJobIds(projectDir: string, workflowName: string): string[] | null {
  const jobsList = matchingWorkflowJobs(projectDir, workflowName);
  if (!jobsList || jobsList.length === 0) return null;

  const ids = new Set<string>();
  for (const jobs of jobsList) {
    for (const jobId of Object.keys(jobs)) ids.add(jobId);
  }
  return ids.size > 0 ? Array.from(ids) : null;
}

type GhCheckRun = {
  head_sha?: unknown;
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  details_url?: unknown;
};

type GhCheckRunsResponse = {
  check_runs?: unknown;
};

function checkRunNameFromContext(checkContext: string): string {
  const idx = checkContext.lastIndexOf("/");
  return (idx === -1 ? checkContext : checkContext.slice(idx + 1)).trim();
}

function checkRunDetailsUrl(run: GhCheckRun): string | undefined {
  if (typeof run.html_url === "string") return run.html_url;
  if (typeof run.details_url === "string") return run.details_url;
  return undefined;
}

// Aggregates a GitHub check-runs API response (GET .../commits/<sha>/check-runs)
// into a single CiCheckStatus for one check name. Pure — no gh invocation — so
// tests exercise the aggregation rules directly. The workflow triggers on both
// push and pull_request, so the same sha legitimately carries MULTIPLE runs of
// the same-named check; this is where that gets collapsed to one verdict, fail-
// closed: any completed failure wins outright (disagreement on the same sha is a
// flake signal, never covering evidence), then any still-running run means
// pending, then a completed success, else "other".
//
// Matching is by run name only (e.g. "test"), not by workflow — the check-runs
// API doesn't cheaply expose the parent workflow name per run without an extra
// API call, so this assumes no OTHER workflow in this repo defines a same-named
// job. True today (only the "CI" workflow exists); revisit if that changes.
export function aggregateCiCheckRuns(parsed: unknown, opts: { sha: string; checkName: string }): CiCheckStatus | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const runsRaw = (parsed as GhCheckRunsResponse).check_runs;
  if (!Array.isArray(runsRaw)) return null;

  // The sha each run covers comes from the response body itself, never assumed
  // from the request — a run reporting a different head_sha (e.g. a stale or
  // ambiguous lookup) must never be trusted as covering the requested commit.
  const matching = runsRaw.filter((r): r is GhCheckRun => {
    if (typeof r !== "object" || r === null) return false;
    const run = r as GhCheckRun;
    return run.head_sha === opts.sha && run.name === opts.checkName;
  });
  if (matching.length === 0) return null;

  const completed = matching.filter((r) => r.status === "completed");
  const failed = completed.find((r) => r.conclusion === "failure");
  if (failed) return { sha: opts.sha, state: "failure", detailsUrl: checkRunDetailsUrl(failed) };

  const incomplete = matching.some((r) => r.status !== "completed");
  if (incomplete) return { sha: opts.sha, state: "pending" };

  const succeeded = completed.find((r) => r.conclusion === "success");
  if (succeeded) return { sha: opts.sha, state: "success", detailsUrl: checkRunDetailsUrl(succeeded) };

  return { sha: opts.sha, state: "other" };
}

// The real, gh-backed default provider. Only ever invoked LAZILY, per lookup call,
// from findCoveringGateEvidence's fallback branch below — never at module load and
// never unconditionally. Agent containers have no `gh` binary and no GitHub
// credentials (forge itself always runs on the host, never in a container — see
// CLAUDE.md), so a missing binary (ENOENT) or absent auth (gh exits non-zero
// immediately, no network attempted) both fail fast and are treated as "no CI
// evidence available", never as a crash. Real callers on the operator's host (which
// has `gh` authenticated) get the real check status; tests always inject a stub via
// opts.checkStatusProvider so they never depend on this path.
//
// Uses the check-runs API, not the legacy combined-status API: GitHub Actions
// publishes check runs, not legacy commit statuses, so the status endpoint always
// reports "pending" with zero statuses for an Actions-only repo (FG-474).
function defaultCheckStatusProvider(opts: { projectDir: string; sha: string; checkContext: string }): CiCheckStatus | null {
  const checkName = checkRunNameFromContext(opts.checkContext);
  let raw: string;
  try {
    raw = execFileSync(
      "gh",
      ["api", `repos/{owner}/{repo}/commits/${opts.sha}/check-runs?check_name=${encodeURIComponent(checkName)}`],
      {
        cwd: opts.projectDir,
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return aggregateCiCheckRuns(parsed, { sha: opts.sha, checkName });
}

export type GateEvidence =
  | { source: "host_row"; row: HostVerificationRow; rows: HostVerificationRow[] }
  | { source: "ci"; sha: string; checkUrl?: string; checks: { context: string; url?: string }[] };

const SHA_LOOKUP_RE = /^[0-9a-f]{7,40}$/i;

// FG-501: shared by findCoveringGateEvidence AND probeCiGateStatus so the
// fail-closed preconditions (REQUIRED_CI_CHECK_CONTEXT shape, this project's
// own ci.yml demonstrably running `command`, whole-workflow job enumeration)
// live in exactly one place. Two independent copies of this logic could drift
// — probeCiGateStatus exists to report status WHILE covering evidence isn't
// there yet, so it must apply the identical trust chain findCoveringGateEvidence
// does, not a laxer or differently-shaped approximation of it.
type CiPairing = { workflowName: string; pairedJobId: string; jobIds: string[] } | { unavailableReason: string };

function resolveCiPairing(projectDir: string, command: string): CiPairing {
  const [workflowName, pairedJobId] = REQUIRED_CI_CHECK_CONTEXT.split("/").map((s) => s.trim());
  if (!workflowName || !pairedJobId) return { unavailableReason: `REQUIRED_CI_CHECK_CONTEXT "${REQUIRED_CI_CHECK_CONTEXT}" is malformed` };
  if (!projectCiRunsCommand(projectDir, REQUIRED_CI_CHECK_CONTEXT, command)) {
    return { unavailableReason: `${projectDir}'s CI workflow does not demonstrably run "${command}" as the "${REQUIRED_CI_CHECK_CONTEXT}" check` };
  }
  const jobIds = projectCiWorkflowJobIds(projectDir, workflowName);
  if (!jobIds) return { unavailableReason: `could not enumerate jobs for the "${workflowName}" workflow in ${projectDir} (missing/unparseable workflow file)` };
  return { workflowName, pairedJobId, jobIds };
}

/** Does covering deterministic-gate evidence already exist for (ticketId,
 *  projectDir, sha, command)? opts.command is the project's requiredHostGate —
 *  FG-500: the actual covering set is deriveRequiredGateList(opts.projectDir,
 *  opts.command), not opts.command alone, so a fast-tier-only row can never
 *  stand in for a project's whole deterministic set (single-gate/custom-gate
 *  projects derive a one-element list, so behavior there is unchanged). Command
 *  match per row is EXACT — every host_verifications row is written with one
 *  canonical gate string as both its gate_name and command (see
 *  reconcile-collect.ts's getRequiredHostGate/runAndRecordHostVerification), so
 *  exact equality is the correct "covers" relation for a single row; a row
 *  recorded under a different command (e.g. a narrower `npm run test` vs the
 *  required `npm run test:all`) must never satisfy a broader requirement.
 *  Returns null (fail closed) when neither source covers the exact sha. */
export function findCoveringGateEvidence(opts: {
  ticketId: string;
  projectDir: string;
  sha: string;
  command: string;
  checkStatusProvider?: CheckStatusProvider;
}): GateEvidence | null {
  if (!SHA_LOOKUP_RE.test(opts.sha)) return null;

  // FG-500: host-row coverage requires a PASSING row for EVERY member of the
  // derived gate list at this exact sha — stops at the first uncovered member,
  // never partially credits a fast-tier-only row against a broader list.
  const gateList = deriveRequiredGateList(opts.projectDir, opts.command);
  const coveringRows: HostVerificationRow[] = [];
  for (const gate of gateList) {
    const rows = queryHostVerificationRowsForGate(opts.ticketId, opts.projectDir, gate);
    const row = rows.find((r) => r.commitSha === opts.sha && r.command === gate && r.exitCode === 0);
    if (!row) break;
    coveringRows.push(row);
  }
  if (coveringRows.length === gateList.length) {
    return { source: "host_row", row: coveringRows[0]!, rows: coveringRows };
  }

  // forge is host-global — opts.projectDir is an ARBITRARY managed project, so
  // the only thing that can prove a green REQUIRED_CI_CHECK_CONTEXT ran
  // opts.command is THAT PROJECT'S OWN workflow content, read fresh at lookup
  // time. A REQUIRED_CI_GATE_COMMAND-style constant-equality check would only
  // prove pairing with forge's own ci.yml (task-red-wide-16933b) — never with
  // the project actually being gated. FG-495 review finding: pairing alone
  // only proves ONE job of this workflow runs opts.command — post-FG-495 the
  // suite is split across sibling required jobs (e.g. `test` + `test-
  // extended`), so a green paired job no longer proves the whole gate passed;
  // every job in the workflow must be green at this exact sha, or this is not
  // covering evidence. resolveCiPairing fails closed (never consults the
  // provider) when pairing or job enumeration can't be established.
  const pairing = resolveCiPairing(opts.projectDir, opts.command);
  if ("unavailableReason" in pairing) return null;

  const provider = opts.checkStatusProvider ?? defaultCheckStatusProvider;
  let pairedStatus: CiCheckStatus | null = null;
  const checks: { context: string; url?: string }[] = [];
  for (const jobId of pairing.jobIds) {
    const checkContext = `${pairing.workflowName} / ${jobId}`;
    const status = provider({ projectDir: opts.projectDir, sha: opts.sha, checkContext });
    if (!status || status.state !== "success" || status.sha !== opts.sha) return null;
    checks.push({ context: checkContext, ...(status.detailsUrl ? { url: status.detailsUrl } : {}) });
    if (jobId === pairing.pairedJobId) pairedStatus = status;
  }
  if (!pairedStatus) return null;
  return { source: "ci", sha: pairedStatus.sha, checkUrl: pairedStatus.detailsUrl, checks };
}

// ── FG-501: CI gate STATUS (not just coverage) ──────────────────────────────
//
// findCoveringGateEvidence answers a binary "does covering evidence exist yet"
// and fails closed to null for ANYTHING short of full success (pending,
// failing, unavailable all collapse to the same null). review-loop needs to
// tell those apart: pending CI should be waited on, a failing check should stop
// the loop with a named failure instead of running local verification, and only
// a genuinely unavailable/unqueryable CI setup should fall back to a local run.
// probeCiGateStatus applies the IDENTICAL preconditions (via resolveCiPairing)
// and reports which of those states the required CI gate is actually in.

export type CiGateStatus =
  | { kind: "success" }
  | { kind: "pending"; checks: { context: string; url?: string }[] }
  | { kind: "failed"; failing: { context: string; url?: string } }
  | { kind: "unavailable"; reason: string };

/** Probe the STATUS of the required CI gate for (projectDir, sha, command) —
 *  same trust chain as findCoveringGateEvidence's CI branch (sha shape,
 *  content-verified pairing, whole-workflow job enumeration), but reports
 *  WHY reuse isn't possible instead of collapsing every non-success case to
 *  null. Every required job is checked before classifying (no short-circuit on
 *  the first non-success job), since an earlier job the provider can't report
 *  on must never mask a later sibling's genuine failure. Priority when jobs
 *  disagree: any completed-non-success job (failure, or a completed-but-not-
 *  successful conclusion like cancelled/skipped) wins outright as "failed" —
 *  waiting longer cannot fix a terminal state. Otherwise a job the provider
 *  couldn't report on (missing/mismatched-sha status) wins as "unavailable",
 *  since coverage can't be proven for it either. Otherwise any still-incomplete
 *  job makes the whole gate "pending". All-success is "success". A missing/
 *  unparseable precondition is "unavailable" with a concrete reason — never
 *  silently treated as pending or success. */
export function probeCiGateStatus(opts: {
  projectDir: string;
  sha: string;
  command: string;
  checkStatusProvider?: CheckStatusProvider;
}): CiGateStatus {
  if (!SHA_LOOKUP_RE.test(opts.sha)) return { kind: "unavailable", reason: `sha "${opts.sha}" is not a valid lookup sha` };

  const pairing = resolveCiPairing(opts.projectDir, opts.command);
  if ("unavailableReason" in pairing) return { kind: "unavailable", reason: pairing.unavailableReason };

  const provider = opts.checkStatusProvider ?? defaultCheckStatusProvider;
  let failing: { context: string; url?: string } | null = null;
  let unavailableReason: string | null = null;
  const pending: { context: string; url?: string }[] = [];
  for (const jobId of pairing.jobIds) {
    const checkContext = `${pairing.workflowName} / ${jobId}`;
    const status = provider({ projectDir: opts.projectDir, sha: opts.sha, checkContext });
    if (!status) {
      unavailableReason ??= `no CI status available for check "${checkContext}" at sha ${opts.sha}`;
      continue;
    }
    if (status.sha !== opts.sha) {
      unavailableReason ??= `CI status for "${checkContext}" reported a different sha than the one requested`;
      continue;
    }
    if (status.state === "failure" || status.state === "other") {
      failing ??= { context: checkContext, ...(status.detailsUrl ? { url: status.detailsUrl } : {}) };
      continue;
    }
    if (status.state === "pending") pending.push({ context: checkContext, ...(status.detailsUrl ? { url: status.detailsUrl } : {}) });
  }
  // A genuine red always wins over a mere reporting hiccup (a later sibling job
  // must not be masked by an earlier one the provider couldn't report on), and
  // unavailable still wins over pending/success since coverage cannot be proven
  // for a job the provider never confirmed.
  if (failing) return { kind: "failed", failing };
  if (unavailableReason) return { kind: "unavailable", reason: unavailableReason };
  if (pending.length > 0) return { kind: "pending", checks: pending };
  return { kind: "success" };
}

/** Human-readable description of WHAT covered a reuse — used in place of raw run
 *  output wherever verification is reported (the review-loop note, CLI logs).
 *  FG-500: host_row evidence.rows carries a covering row per derived gate list
 *  member, not just the fast tier — every row is cited so the note attests to
 *  the FULL verified set, not a single (possibly fast-tier-only) row. FG-501:
 *  ci evidence.checks likewise carries every job of the matched workflow that
 *  was verified green (e.g. `test` AND `test-extended`), not just the one job
 *  paired to REQUIRED_CI_CHECK_CONTEXT — the description must name every
 *  verified check context with its URL when available (AC2), since a green
 *  paired job alone no longer proves the whole gate passed post-FG-495. */
export function describeGateEvidence(evidence: GateEvidence): string {
  return evidence.source === "host_row"
    ? evidence.rows
        .map((row) => `host_verifications row #${row.id} (sha ${row.commitSha}, command: ${row.command})`)
        .join("; ")
    : evidence.checks
        .map((check) => `CI check "${check.context}" (sha ${evidence.sha})${check.url ? ` — ${check.url}` : ""}`)
        .join("; ");
}
