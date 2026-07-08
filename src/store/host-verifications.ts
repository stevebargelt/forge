import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDb } from "./db.js";

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

type GhCombinedStatusResponse = {
  sha?: unknown;
  statuses?: Array<{ context?: unknown; state?: unknown; target_url?: unknown }>;
};

function normalizeCiState(raw: unknown): CiCheckState {
  if (raw === "success") return "success";
  if (raw === "pending") return "pending";
  if (raw === "failure" || raw === "error") return "failure";
  return "other";
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
function defaultCheckStatusProvider(opts: { projectDir: string; sha: string; checkContext: string }): CiCheckStatus | null {
  let raw: string;
  try {
    raw = execFileSync("gh", ["api", `repos/{owner}/{repo}/commits/${opts.sha}/status`], {
      cwd: opts.projectDir,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  let parsed: GhCombinedStatusResponse;
  try {
    parsed = JSON.parse(raw) as GhCombinedStatusResponse;
  } catch {
    return null;
  }
  // The sha this status covers comes from the API response body itself, never from
  // the requested opts.sha — a mismatched response (e.g. a stale/ambiguous lookup)
  // must never be trusted as covering the requested commit.
  if (typeof parsed.sha !== "string" || parsed.sha !== opts.sha) return null;
  const match = (parsed.statuses ?? []).find((s) => s.context === opts.checkContext);
  if (!match) return null;
  return {
    sha: parsed.sha,
    state: normalizeCiState(match.state),
    detailsUrl: typeof match.target_url === "string" ? match.target_url : undefined,
  };
}

export type GateEvidence =
  | { source: "host_row"; row: HostVerificationRow }
  | { source: "ci"; sha: string; checkUrl?: string };

const SHA_LOOKUP_RE = /^[0-9a-f]{7,40}$/i;

/** Does covering deterministic-gate evidence already exist for (ticketId,
 *  projectDir, sha, command)? Command match is EXACT — every host_verifications row
 *  is written with the single canonical requiredHostGate string as both its
 *  gate_name and command (see reconcile-collect.ts's getRequiredHostGate), so exact
 *  equality is the correct (and only currently meaningful) "covers" relation; a row
 *  recorded under a different command (e.g. a narrower `npm run test` vs the
 *  required `npm run test:all`) must never satisfy a broader requirement. Returns
 *  null (fail closed) when neither source covers the exact sha. */
export function findCoveringGateEvidence(opts: {
  ticketId: string;
  projectDir: string;
  sha: string;
  command: string;
  checkStatusProvider?: CheckStatusProvider;
}): GateEvidence | null {
  if (!SHA_LOOKUP_RE.test(opts.sha)) return null;

  const rows = queryHostVerificationRowsForGate(opts.ticketId, opts.projectDir, opts.command);
  const coveringRow = rows.find(
    (r) => r.commitSha === opts.sha && r.command === opts.command && r.exitCode === 0
  );
  if (coveringRow) return { source: "host_row", row: coveringRow };

  const provider = opts.checkStatusProvider ?? defaultCheckStatusProvider;
  const status = provider({ projectDir: opts.projectDir, sha: opts.sha, checkContext: REQUIRED_CI_CHECK_CONTEXT });
  if (status && status.state === "success" && status.sha === opts.sha) {
    return { source: "ci", sha: status.sha, checkUrl: status.detailsUrl };
  }
  return null;
}

/** Human-readable description of WHAT covered a reuse — used in place of raw run
 *  output wherever verification is reported (the review-loop note, CLI logs). */
export function describeGateEvidence(evidence: GateEvidence): string {
  return evidence.source === "host_row"
    ? `host_verifications row #${evidence.row.id} (sha ${evidence.row.commitSha}, command: ${evidence.row.command})`
    : `CI check "${REQUIRED_CI_CHECK_CONTEXT}" (sha ${evidence.sha})${evidence.checkUrl ? ` — ${evidence.checkUrl}` : ""}`;
}
