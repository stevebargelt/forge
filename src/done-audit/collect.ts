import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTicket } from "../backlog/structured.js";
import { tasksForRun } from "../store/tasks.js";
import { queryHostVerificationRowsForGate, deriveRequiredGateList, type HostVerificationRow } from "../store/host-verifications.js";
import { checkClosedCommitCoveredByTestedSha } from "../campaign/reconcile-collect.js";
import type { CampaignItem } from "../types/index.js";
import type { DoneAuditInput } from "./done-audit.js";

// FG-500: per-gate resolution mirrors the single-gate rule this replaces —
// null (unknown) when no covering row exists at all for this gate, false
// (a real, provable gap) when every covering row failed, true when at least
// one covering row for this gate passed (a later real pass ships over an
// earlier covering failure — FG-453's passing-row model).
type GateCoverage = { verified: boolean | null; detailRow: HostVerificationRow | null; failureCount: number };

function resolveGateCoverage(
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

// Host-local operational state (operator notes, scratch dirs) that must not block
// shipped-work audits — done-audit cares about the merge/closed commit + ticket
// state, not transient workspace files. Duplicated in campaign/report.ts on purpose:
// both call sites parse `git status --porcelain` independently and must not disagree.
function isHostLocalNoisePath(path: string): boolean {
  return path === "backlog/notes.md" || path.startsWith(".forge-scratch/");
}

function filterDirtyPorcelainLines(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isHostLocalNoisePath(line.slice(3)));
}

export function collectDoneAuditInputFor(projectDir: string, ticketId: string, runId?: string): DoneAuditInput {
  // ticket — best-effort
  let ticket: DoneAuditInput["ticket"] = null;
  try {
    const t = readTicket(projectDir, ticketId);
    ticket = {
      status: t.status,
      closedCommit: t.closedCommit,
      body: t.body,
      related: t.related,
    };
  } catch {
    // ticket = null (→ unknown checks)
  }

  const closedCommit = ticket?.closedCommit;

  // git.dirty — reuse pattern from report.ts computeDirtyGitState. Ignore host-local
  // operational noise (backlog/notes.md, .forge-scratch/) — see isHostLocalNoisePath.
  let dirty: boolean | null = null;
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 5000,
    });
    dirty = filterDirtyPorcelainLines(output).length > 0;
  } catch {
    // dirty = null
  }

  // git.commitExists
  let commitExists: boolean | null = null;
  if (closedCommit) {
    try {
      execFileSync("git", ["cat-file", "-e", `${closedCommit}^{commit}`], {
        cwd: projectDir,
        timeout: 5000,
      });
      commitExists = true;
    } catch {
      commitExists = false;
    }
  }

  // git.pushed — is closedCommit reachable from any remote branch?
  // pushed=null + pushedReason="no_remote": no remote configured (local-only repo).
  // pushed=false: remote exists but commit not reachable from any remote branch.
  // pushed=null + no pushedReason: git error or no closedCommit.
  let pushed: boolean | null = null;
  let pushedReason: string | null = null;
  if (closedCommit) {
    try {
      const remoteOut = execFileSync("git", ["remote"], {
        cwd: projectDir,
        encoding: "utf8",
        timeout: 5000,
      });
      if (remoteOut.trim().length > 0) {
        const output = execFileSync("git", ["branch", "-r", "--contains", closedCommit], {
          cwd: projectDir,
          encoding: "utf8",
          timeout: 5000,
        });
        pushed = output.trim().length > 0;
      } else {
        pushedReason = "no_remote";
      }
    } catch {
      pushed = null;
    }
  }

  let containerTestsRun: number | null = null;
  if (runId) {
    try {
      let sum = 0;
      let contributed = false;
      for (const task of tasksForRun(runId)) {
        const r = task.result;
        if (r !== null && typeof r === "object") {
          const testsRun = (r as Record<string, unknown>)["tests_run"];
          if (typeof testsRun === "number") {
            sum += testsRun;
            contributed = true;
          }
        }
      }
      if (contributed) containerTestsRun = sum;
    } catch {
      // containerTestsRun stays null
    }
  }

  // host verification — read matching evidence from the store
  // projectDir is the operator-supplied project path stored on the campaign — not arbitrary
  // end-user input — so path traversal via projectDir is outside the threat model here.
  let hostVerified: boolean | null = null;
  let hostVerificationDetail: string | null = null;
  if (closedCommit) {
    try {
      let requiredGate = "npm run test:all";
      let baseBranch = "main";
      try {
        const configRaw = readFileSync(join(projectDir, ".forge", "config.json"), "utf8");
        const config = JSON.parse(configRaw) as Record<string, unknown>;
        if (typeof config["requiredHostGate"] === "string") {
          requiredGate = config["requiredHostGate"];
        }
        if (typeof config["baseBranch"] === "string") {
          baseBranch = config["baseBranch"];
        }
      } catch {
        // missing or malformed config — defaults stand
      }

      // FG-500: "the deterministic gate" is the FULL derived gate list, not just
      // requiredGate — a fast-tier-only row must not satisfy a project with an
      // extended tier. A ci-sourced passing row for the PRIMARY gate is
      // whole-workflow evidence (runAndRecordHostVerification only ever writes
      // source:'ci' when EVERY required CI job is green — see
      // findCoveringGateEvidence) and covers the full list on its own, without
      // needing a separate row per extended-tier member (no double-charging CI).
      const gateList = deriveRequiredGateList(projectDir, requiredGate);
      const primary = resolveGateCoverage(ticketId, projectDir, gateList[0]!, closedCommit, baseBranch);
      const primaryCiPassingRow =
        primary.verified === true && primary.detailRow?.source === "ci" ? primary.detailRow : null;

      let hostVerifiedLocal: boolean | null;
      let detailRow: HostVerificationRow | null;
      let failureCount: number;

      if (primaryCiPassingRow) {
        hostVerifiedLocal = true;
        detailRow = primaryCiPassingRow;
        failureCount = primary.failureCount;
      } else {
        const perGate = gateList.map((gate, i) =>
          i === 0 ? primary : resolveGateCoverage(ticketId, projectDir, gate, closedCommit, baseBranch)
        );
        const failing = perGate.find((g) => g.verified === false);
        if (failing) {
          // FG-453: a real, provable gap on ANY list member must never be
          // laundered into a pass by another member's success.
          hostVerifiedLocal = false;
          detailRow = failing.detailRow;
          failureCount = failing.failureCount;
        } else if (perGate.every((g) => g.verified === true)) {
          hostVerifiedLocal = true;
          detailRow = perGate[perGate.length - 1]!.detailRow;
          failureCount = perGate.reduce((sum, g) => sum + g.failureCount, 0);
        } else {
          // No member proven to have failed, but at least one has no covering
          // evidence at all yet — incomplete, not a proven gap (unknown, per the
          // single-gate "no matching rows" convention).
          hostVerifiedLocal = null;
          detailRow = null;
          failureCount = 0;
        }
      }

      hostVerified = hostVerifiedLocal;
      if (detailRow) {
        // Evidence must match the verdict: a true verdict shows the passing row that
        // establishes it (latest one), a false verdict shows a failing row — never the
        // reverse. Earlier covering failures are retained as visible audit history.
        // FG-474: source distinguishes a real host exec ('host') from evidence
        // sourced from a green required CI check ('ci') — ci_url is present only
        // for the latter.
        hostVerificationDetail =
          `gate: ${detailRow.gateName}; command: ${detailRow.command}; exit_code: ${detailRow.exitCode}; ` +
          `commit: ${detailRow.commitSha}; recorded_at: ${detailRow.recordedAt}; source: ${detailRow.source ?? "host"}` +
          (detailRow.source === "ci" && detailRow.ciUrl ? `; ci_url: ${detailRow.ciUrl}` : "") +
          (hostVerifiedLocal && failureCount > 0 ? `; earlier_covering_failures: ${failureCount}` : "");
      }
    } catch {
      // hostVerified stays null on any store error
    }
  }

  return {
    ticket,
    item: { lifecycleStatus: "complete" },
    git: { dirty, commitExists, pushed, pushedReason },
    verification: {
      hostVerified,
      hostVerificationDetail,
      containerTestsRun,
      acceptedException: null,
    },
  };
}

export function collectDoneAuditInput(projectDir: string, item: CampaignItem): DoneAuditInput {
  const input = collectDoneAuditInputFor(projectDir, item.ticketId, item.runId);
  return { ...input, item: { lifecycleStatus: item.lifecycleStatus, outcome: item.outcome } };
}
