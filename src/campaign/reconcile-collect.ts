// FG-428: IO collector for `forge campaign reconcile`. Reads durable facts from
// the ticket store, git, the host-verification table, and the run's event log —
// no derivation happens here, that's reconcile-evidence.ts's job.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTicket } from "../backlog/structured.js";
import {
  queryHostVerificationRowsForGate,
  insertHostVerification,
  findCoveringGateEvidence,
  deriveRequiredGateList,
  type CheckStatusProvider,
  type HostVerificationRow,
} from "../store/host-verifications.js";
import { eventsForRun, logEvent } from "../store/events.js";
import { nowIso, newAttemptId } from "../util/ids.js";
import type { CampaignItem, GateDecision } from "../types/index.js";
import type { ReconcileEvidenceInput, ReconcileRunEvent } from "./reconcile-evidence.js";

function readConfigString(projectDir: string, key: string, fallback: string): string {
  try {
    const raw = readFileSync(join(projectDir, ".forge", "config.json"), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (typeof config[key] === "string") return config[key] as string;
  } catch {
    // missing or malformed config — fallback stands
  }
  return fallback;
}

// closedCommit (ticket frontmatter) and baseBranch (.forge/config.json) are both
// operator-editable — reject anything that isn't a plausible sha/ref before it
// reaches git as a positional arg, so a `--`-prefixed value can never be parsed
// as a git option (e.g. closedCommit: "--upload-pack=evil").
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// FG-440: single source of truth for the required host gate command — used both
// by evidence collection (below) and by the reconcile-time capture writer, so
// the command recorded and the command matched against are always the same string.
export function getRequiredHostGate(projectDir: string): string {
  return readConfigString(projectDir, "requiredHostGate", "npm run test:all");
}

// Shared low-level ancestry check: true if `ancestor` is reachable from
// `descendant`, false if git determined it definitively is not (exit 1), null
// on any other git failure (safe-deny — callers must never treat a git error
// as proof of ancestry).
function gitIsAncestor(projectDir: string, ancestor: string, descendant: string): boolean | null {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "--", ancestor, descendant], {
      cwd: projectDir,
      timeout: 5000,
    });
    return true;
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return status === 1 ? false : null;
  }
}

export function checkClosedCommitReachableOnBase(
  projectDir: string,
  closedCommit: string,
  baseBranch: string
): boolean | null {
  if (!SHA_PATTERN.test(closedCommit) || !REF_PATTERN.test(baseBranch)) {
    return null;
  }
  return gitIsAncestor(projectDir, closedCommit, baseBranch);
}

// FG-440: coverage check for the reconcile-time host-verification capture.
// A host_verifications row covers a campaign item ONLY IF, together:
//   - closedCommit (ticket frontmatter) is an ancestor of the row's
//     testedSha — proves the ticket's actual close point is INCLUDED in
//     whatever was tested (testedSha may be a later HEAD than closedCommit —
//     that's expected, since the gate runs at projectDir's current HEAD, not
//     a checkout of closedCommit itself);
//   - the row's testedSha is ITSELF reachable on the configured base branch —
//     proves testedSha is the base line, not a never-merged off-branch build
//     that happens to descend from closedCommit (a feature branch cut from
//     closedCommit satisfies the ancestry check above forever without this,
//     which would let a single stale off-branch run permanently vouch for the
//     ticket even though the base branch was never actually tested);
//   - gateName equals the configured requiredHostGate string (enforced by the
//     caller via queryHostVerificationRowsForGate);
//   - exitCode === 0 (enforced by the caller — this function only proves
//     ancestry + base-reachability, not exit status).
// Every sub-check is proven by git, never asserted — a git error on either
// ancestry check is treated as NOT covered (safe-deny), never as covered.
export function checkClosedCommitCoveredByTestedSha(
  projectDir: string,
  closedCommit: string,
  testedSha: string,
  baseBranch: string
): boolean {
  if (!SHA_PATTERN.test(closedCommit) || !SHA_PATTERN.test(testedSha)) {
    return false;
  }
  if (gitIsAncestor(projectDir, closedCommit, testedSha) !== true) {
    return false;
  }
  return checkClosedCommitReachableOnBase(projectDir, testedSha, baseBranch) === true;
}

// FG-500 round 2: per-gate-list-member coverage for a single gate command —
// the ONE place ancestry-filtered host_verifications rows for a gate are
// reduced to a verdict, shared by every consumer that needs to know "is THIS
// gate list member covered" (both reconcile pre-checks below, and
// done-audit/collect.ts). verified is null when no covering row exists yet
// for this gate (unknown/not-yet-run, distinct from a proven failure), false
// when every covering row failed, true when at least one covering row passed
// (a later real pass ships over an earlier covering failure — FG-453's
// passing-row model).
export type GateCoverage = { verified: boolean | null; detailRow: HostVerificationRow | null; failureCount: number };

export function resolveGateCoverage(
  ticketId: string,
  projectDir: string,
  gate: string,
  closedCommit: string,
  baseBranch: string
): GateCoverage {
  const rows = queryHostVerificationRowsForGate(ticketId, projectDir, gate);
  const covering = rows.filter((r) => checkClosedCommitCoveredByTestedSha(projectDir, closedCommit, r.commitSha, baseBranch));
  if (covering.length === 0) return { verified: null, detailRow: null, failureCount: 0 };
  const passingRows = covering.filter((r) => r.exitCode === 0);
  const verified = passingRows.length > 0;
  const failureCount = covering.length - passingRows.length;
  const detailRow = verified ? passingRows[passingRows.length - 1]! : covering[covering.length - 1]!;
  return { verified, detailRow, failureCount };
}

// FG-500 round 2: the SINGLE decision of whether a derived gate LIST is fully
// covered, given each member's already-resolved GateCoverage (in gate-list
// order, index 0 = the primary/fast gate). Used by reconcile-collect's and
// reconcile-outofband-collect's pre-checks AND done-audit/collect.ts, so the
// three consumers cannot drift on what "the gate list passed" means.
//   - passed requires EVERY member to have its own covering passing row
//     (perGate[i].verified === true), UNLESS the primary member (index 0) was
//     satisfied by a source:'ci' row — runAndRecordHostVerification only ever
//     writes source:'ci' when EVERY required CI job is green (see
//     findCoveringGateEvidence above), so a ci-sourced primary pass IS
//     whole-workflow evidence and covers the rest of the list on its own.
//   - recordedAny is true once ANY member has seen a covering row (pass or
//     fail) — "some real evidence exists" — as distinct from "nothing has
//     run yet" (every member's verified === null).
//   - anyFailed is true only when a member has a proven failure and the ci
//     shortcut doesn't apply — a real, provable gap on any member must never
//     be laundered into a pass by another member's success (FG-453).
export function evaluateGateListCoverage(perGate: GateCoverage[]): {
  passed: boolean;
  anyFailed: boolean;
  recordedAny: boolean;
  ciShortcutRow: HostVerificationRow | null;
} {
  const primary = perGate[0];
  const ciShortcutRow =
    primary && primary.verified === true && primary.detailRow?.source === "ci" ? primary.detailRow : null;
  const passed = !!ciShortcutRow || perGate.every((g) => g.verified === true);
  const anyFailed = !ciShortcutRow && perGate.some((g) => g.verified === false);
  const recordedAny = !!ciShortcutRow || perGate.some((g) => g.verified !== null);
  return { passed, anyFailed, recordedAny, ciShortcutRow };
}

// FG-427: the SINGLE events->ReconcileRunEvent[] translation, shared by
// collectReconcileEvidence (the `forge campaign reconcile` command) and by
// executor.ts's drive-path reconciliation — one source of truth for how a
// store Event becomes a ReconcileRunEvent, so the two paths cannot drift.
export function collectAuthoritativeEvents(runId: string): ReconcileRunEvent[] {
  return eventsForRun(runId)
    .filter((e) => e.eventType === "verdict.received" || e.eventType === "gate.decided")
    .map((e): ReconcileRunEvent => {
      if (e.eventType === "verdict.received") {
        const payload = e.payload as { verdict?: string; authority?: string } | null;
        return {
          id: e.id,
          kind: "verdict",
          verdict: (payload?.verdict as "pass" | "fail" | "inconclusive") ?? "inconclusive",
          authority: (payload?.authority as "authoritative" | "specialist") ?? "specialist",
          taskId: e.taskId ?? undefined,
        };
      }
      const payload = e.payload as { decision?: string; rationale?: string; force?: boolean } | null;
      return {
        id: e.id,
        kind: "gate",
        decision: (payload?.decision as GateDecision) ?? "advance",
        rationale: payload?.rationale,
        force: payload?.force ?? false,
        taskId: e.taskId ?? undefined,
      };
    });
}

export function collectReconcileEvidence(projectDir: string, item: CampaignItem): ReconcileEvidenceInput {
  let ticketStatus: string | undefined;
  let ticketClosedCommit: string | undefined;
  try {
    const ticket = readTicket(projectDir, item.ticketId);
    ticketStatus = ticket.status;
    ticketClosedCommit = ticket.closedCommit;
  } catch {
    // ticket unreadable — facts stay undefined, evidence evaluator reports the gap
  }

  const baseBranch = readConfigString(projectDir, "baseBranch", "main");
  const closedCommitReachableOnBase = ticketClosedCommit
    ? checkClosedCommitReachableOnBase(projectDir, ticketClosedCommit, baseBranch)
    : null;

  const requiredGate = getRequiredHostGate(projectDir);
  let hostVerification: ReconcileEvidenceInput["hostVerification"] = null;
  if (ticketClosedCommit) {
    // Bound to the SAME ticketClosedCommit asserted above (facts 1-2) — an operator
    // cannot plant a verification row for an unrelated commit and have it count.
    // "Covers" is ancestry (+ base-reachability), not exact-sha equality — see
    // checkClosedCommitCoveredByTestedSha's header for the full rule: the gate runs
    // at projectDir's current HEAD, not a checkout of closedCommit, so the row's
    // commit_sha is the tested base HEAD, which closedCommit merely needs to be an
    // ancestor of, and which must itself be on the base branch.
    //
    // FG-500 round 2: this pre-check must cover the FULL derived gate list, not
    // just requiredGate — the capture path below and findCoveringGateEvidence
    // already enforce this; a fast-tier-only passing row must never let a
    // tiered project's pre-check report "passed" and skip capture (which would
    // then let reconcile.ts ship without ever running test:extended).
    try {
      const gateList = deriveRequiredGateList(projectDir, requiredGate);
      const perGate = gateList.map((gate) =>
        resolveGateCoverage(item.ticketId, projectDir, gate, ticketClosedCommit!, baseBranch)
      );
      const { passed, recordedAny } = evaluateGateListCoverage(perGate);
      hostVerification = { recorded: recordedAny, passed };
    } catch {
      hostVerification = null;
    }
  }

  const events: ReconcileRunEvent[] = item.runId ? collectAuthoritativeEvents(item.runId) : [];

  return {
    ticketStatus,
    ticketClosedCommit,
    closedCommitReachableOnBase,
    hostVerification,
    events,
  };
}

// ── FG-440: reconcile-time host-verification capture ───────────────────────────
//
// A trust-token writer: every field written to host_verifications must be
// causally derived from one real command execution against projectDir's ACTUAL
// current HEAD — never asserted, defaulted, or read from events (a
// force-advance gate.decided event is a DIFFERENT, independent fact — see
// reconcile-evidence.ts's fact-4/fact-5 separation — and must never be read
// here).
//
// Earlier design checked out closedCommit into a throwaway detached worktree.
// That's wrong: a detached checkout has no node_modules, so any npm-based
// requiredHostGate (including the project default "npm run test:all") is
// guaranteed to false-fail on missing dependencies — and that false failure
// got recorded as a real recorded_but_failed row. Instead we run the gate in
// projectDir itself, where dependencies already exist, at whatever commit
// projectDir's HEAD actually is — and we record THAT sha, never closedCommit.
// See checkClosedCommitCoveredByTestedSha above for how a recorded row still
// gets matched back to a ticket's closedCommit (via ancestry, not equality).
//
// Result is a skip/recorded split, never a fabricated pass:
//   - "skipped": the gate did not run for a real reason — a dirty/untracked
//     working tree (never test an operator's uncommitted state), a git
//     failure reading HEAD, HEAD not reachable on the configured base branch
//     (an operator sitting on a feature branch — testing it would let an
//     off-branch build stand in for the base line), no matching script for
//     the required gate, or the working tree/HEAD moved during the run (see
//     the post-run re-verification below). Writes NO row.
//   - "recorded": the gate command actually ran to completion (or was
//     killed/timed out) against projectDir's real HEAD, and that HEAD was
//     confirmed unchanged and the tree still clean immediately afterward.
//     Writes exactly one row with the REAL exit code and the REAL tested sha
//     — a timeout/crash is recorded as a non-zero sentinel, never fabricated
//     as 0. "source" is 'host' for a real exec here, or 'ci' when the row was
//     written from a green required CI check instead (see the evidence-reuse
//     consult below) — never fabricated as 'host' for CI-sourced evidence.
//   - "reused": covering evidence ALREADY existed as a passing host_verifications
//     row for this exact sha+command — no exec, no duplicate row written;
//     coveringRowId references the row that satisfied it.

export type HostVerificationCaptureResult =
  | { status: "skipped"; reason: string }
  | { status: "recorded"; exitCode: number; commitSha: string; source: "host" | "ci"; ciUrl?: string }
  | { status: "reused"; commitSha: string; coveringRowId: number };

const HOST_GATE_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;
// A timed-out or signal-killed gate must still record a real non-zero exit —
// this sentinel (matching the conventional shell "killed by timeout" code) is
// never confused with a genuine 0 pass.
const TIMEOUT_OR_SIGNAL_EXIT_SENTINEL = 124;

function hostGateTimeoutMs(): number {
  const envTimeout = Number(process.env.FORGE_HOST_GATE_TIMEOUT_MS);
  return Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : HOST_GATE_TIMEOUT_MS_DEFAULT;
}

// Mirrors integration-gate.ts's hasTestUnitScript, generalized to the
// configured requiredHostGate command. A missing script is a project-config
// gap, not a merge defect — it must skip, never fabricate a pass.
// Non-"npm run <script>" commands are attempted as-is; a command that
// genuinely doesn't exist surfaces as a real (non-zero) execution failure
// below, not a skip — only "no matching npm script" is a skip per FG-440's
// contract.
function checkGateRunnable(dir: string, requiredGate: string): { runnable: boolean; reason?: string } {
  const argv = requiredGate.trim().split(/\s+/).filter(Boolean);
  if (argv[0] === "npm" && argv[1] === "run" && argv[2]) {
    const script = argv[2];
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (typeof pkg.scripts?.[script] !== "string") {
        return { runnable: false, reason: `no "${script}" script in package.json — required gate skipped` };
      }
    } catch {
      return { runnable: false, reason: "package.json missing or malformed — required gate skipped" };
    }
  }
  return { runnable: true };
}

// Post-run TOCTOU guard: the gate can take up to hostGateTimeoutMs() to run,
// during which projectDir is not otherwise locked. If HEAD moved or the tree
// became dirty while the gate was running, the exit code we just observed no
// longer corresponds to a stable committed sha — discard it rather than
// record a result for a state that no longer exists.
function projectSnapshotStillValid(projectDir: string, expectedHeadSha: string): boolean {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf8", timeout: 10000 });
    if (status.trim().length > 0) return false;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf8", timeout: 10000 }).trim();
    return head === expectedHeadSha;
  } catch {
    return false;
  }
}

/** Run the project's requiredHostGate command in projectDir at its current
 *  HEAD — never a checkout of any other commit — and record the real result
 *  under the sha actually tested. gateName/command are always the configured
 *  requiredHostGate string, never the executed argv — so a lesser command can
 *  never wear the required gate's label (the FG-419 gate_name spoofing
 *  vector). Refuses to run (and writes no row) against a dirty or untracked
 *  working tree, against a HEAD not reachable on the configured base branch,
 *  or if the tree/HEAD changed out from under the run before the result is
 *  written — an operator's uncommitted or off-branch state must never be
 *  recorded as the tested result for a base HEAD sha.
 *
 *  FG-474: before exec, consults findCoveringGateEvidence for HEAD — a passing
 *  host_verifications row already covering the exact sha+command short-circuits
 *  with "reused" (no exec, no duplicate row); CI evidence for the exact sha only
 *  short-circuits (with a fresh 'ci'-sourced row, no exec) when EVERY job of the
 *  project's matched CI workflow is green at that sha (FG-495, via
 *  findCoveringGateEvidence) — a green fast job with another job red, pending,
 *  or absent does not cover. Only when neither covers does this fall through to
 *  the real host exec.
 *
 *  FG-500: when it falls through, it runs and records EVERY member of
 *  deriveRequiredGateList(projectDir, requiredGate), in order — not just
 *  requiredGate — fail-closed on the first failing member (that member's row
 *  is still recorded with its real exit code; remaining members are never run,
 *  so a failing extended run blocks exactly like a failing fast run). Each
 *  member gets its own row under its OWN command string (never requiredGate's
 *  label) — the FG-419 gate_name spoofing guard applies per member.
 *
 *  FG-487: each gate-list member's real exec (below) emits a
 *  campaign_item.host_gate_started/_finished event pair around its execFileSync
 *  call, keyed by a fresh attemptId — the evidence-reuse/CI-shortcut branches
 *  above return before reaching this loop and never emit these (no real exec
 *  happened, nothing host-side to show as "in progress"). opts.itemId/
 *  campaignId are optional and threaded straight into the event payload when
 *  the caller has them; reconcile.ts's current call sites don't pass them yet
 *  (see this step's build notes), so those events carry ticketId only until
 *  that wiring lands — this function is ready to receive them either way. */
export function runAndRecordHostVerification(
  projectDir: string,
  ticketId: string,
  opts: {
    runId?: string | null;
    checkStatusProvider?: CheckStatusProvider;
    /** FG-487: campaign item / campaign identity, for the host-gate start/finish
     *  event payload — optional so existing callers keep compiling unchanged. */
    itemId?: string | null;
    campaignId?: string | null;
  } = {}
): HostVerificationCaptureResult {
  let statusOutput: string;
  try {
    statusOutput = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 10000,
    });
  } catch (e) {
    const err = e as { message?: string };
    return { status: "skipped", reason: `git status --porcelain failed: ${err.message ?? String(e)}` };
  }
  if (statusOutput.trim().length > 0) {
    return {
      status: "skipped",
      reason: "working tree is not clean (uncommitted or untracked changes) — refusing to test an operator's dirty working state",
    };
  }

  let headSha: string;
  try {
    headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf8", timeout: 10000 }).trim();
  } catch (e) {
    const err = e as { message?: string };
    return { status: "skipped", reason: `git rev-parse HEAD failed: ${err.message ?? String(e)}` };
  }
  if (!SHA_PATTERN.test(headSha)) {
    return { status: "skipped", reason: `HEAD did not resolve to a plausible sha: ${headSha}` };
  }

  // FIX 1 (FG-440 follow-up): a clean, committed HEAD can still be a
  // never-merged feature branch — ancestry from closedCommit alone doesn't
  // prove the base line was tested. Require HEAD itself to be on the base
  // branch before running (or recording) anything.
  const baseBranch = readConfigString(projectDir, "baseBranch", "main");
  if (checkClosedCommitReachableOnBase(projectDir, headSha, baseBranch) !== true) {
    return {
      status: "skipped",
      reason: `HEAD (${headSha}) is not reachable on base branch '${baseBranch}' — refusing to test an off-branch build as though it were the base line`,
    };
  }

  const requiredGate = getRequiredHostGate(projectDir);

  // FG-474: one canonical gate result per commit — reuse covering evidence
  // instead of re-running. Consulted AFTER the dirty/off-branch checks above
  // (so those refusal reasons still take priority for a genuinely bad state)
  // but BEFORE actually executing anything.
  const evidence = findCoveringGateEvidence({
    ticketId,
    projectDir,
    sha: headSha,
    command: requiredGate,
    checkStatusProvider: opts.checkStatusProvider,
  });
  if (evidence) {
    if (evidence.source === "host_row") {
      return { status: "reused", commitSha: headSha, coveringRowId: evidence.row.id! };
    }
    // CI-sourced: the CI check already proves the gate passed for this exact sha —
    // record it as a real row (source: 'ci') rather than re-executing.
    insertHostVerification({
      ticketId,
      projectDir,
      commitSha: evidence.sha,
      gateName: requiredGate,
      command: requiredGate,
      exitCode: 0,
      runId: opts.runId ?? null,
      recordedAt: nowIso(),
      source: "ci",
      ciUrl: evidence.checkUrl ?? null,
    });
    return { status: "recorded", exitCode: 0, commitSha: evidence.sha, source: "ci", ciUrl: evidence.checkUrl };
  }

  const gateList = deriveRequiredGateList(projectDir, requiredGate);

  for (const gate of gateList) {
    const runnable = checkGateRunnable(projectDir, gate);
    if (!runnable.runnable) {
      return { status: "skipped", reason: runnable.reason ?? `required gate not runnable in projectDir: ${gate}` };
    }

    const argv = gate.trim().split(/\s+/).filter(Boolean);
    const [cmd, ...args] = argv;

    // FG-487: start/finish bracket the REAL exec only — the evidence-reuse/CI
    // shortcuts above return long before this loop, so those never emit these.
    // attemptId is fresh per gate-list member (each is its own real exec, up to
    // hostGateTimeoutMs() independently).
    const attemptId = newAttemptId();
    logEvent("campaign_item.host_gate_started", {
      runId: opts.runId ?? undefined,
      payload: { attemptId, ticketId, itemId: opts.itemId ?? null, campaignId: opts.campaignId ?? null, gate, command: gate, testedSha: headSha, projectDir },
    });

    let exitCode: number;
    try {
      execFileSync(cmd!, args, {
        cwd: projectDir,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: hostGateTimeoutMs(),
        maxBuffer: 20 * 1024 * 1024,
      });
      exitCode = 0;
    } catch (e) {
      const err = e as { status?: number | null };
      exitCode = typeof err.status === "number" && err.status !== 0 ? err.status : TIMEOUT_OR_SIGNAL_EXIT_SENTINEL;
    }

    logEvent("campaign_item.host_gate_finished", {
      runId: opts.runId ?? undefined,
      payload: { attemptId, ticketId, itemId: opts.itemId ?? null, campaignId: opts.campaignId ?? null, gate, command: gate, testedSha: headSha, exitCode },
    });

    // FIX 3 (FG-440 follow-up): the gate just spent up to hostGateTimeoutMs()
    // running — re-confirm projectDir is still exactly the sha/state we
    // snapshotted before the run. If it moved, the exit code above no longer
    // corresponds to any stable committed sha; discard rather than record it.
    if (!projectSnapshotStillValid(projectDir, headSha)) {
      return {
        status: "skipped",
        reason: "projectDir HEAD or working tree changed during the gate run — discarding the result rather than recording it against a sha that may no longer reflect what was tested",
      };
    }

    insertHostVerification({
      ticketId,
      projectDir,
      commitSha: headSha,
      gateName: gate,
      command: gate,
      exitCode,
      runId: opts.runId ?? null,
      recordedAt: nowIso(),
      source: "host",
    });

    // FG-500: fail closed on the first failing member — a failing extended run
    // blocks exactly like a failing fast run, and remaining list members
    // (if any) are never run once the gate has already failed.
    if (exitCode !== 0) {
      return { status: "recorded", exitCode, commitSha: headSha, source: "host" };
    }
  }

  return { status: "recorded", exitCode: 0, commitSha: headSha, source: "host" };
}
