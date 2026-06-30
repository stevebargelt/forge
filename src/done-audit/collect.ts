import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTicket } from "../backlog/structured.js";
import { tasksForRun } from "../store/tasks.js";
import { queryHostVerificationRows } from "../store/host-verifications.js";
import type { CampaignItem } from "../types/index.js";
import type { DoneAuditInput } from "./done-audit.js";

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

  // git.dirty — reuse pattern from report.ts computeDirtyGitState
  let dirty: boolean | null = null;
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 5000,
    });
    dirty = output.trim().length > 0;
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
      try {
        const configRaw = readFileSync(join(projectDir, ".forge", "config.json"), "utf8");
        const config = JSON.parse(configRaw) as Record<string, unknown>;
        if (typeof config["requiredHostGate"] === "string") {
          requiredGate = config["requiredHostGate"];
        }
      } catch {
        // missing or malformed config — default stands
      }

      const rows = queryHostVerificationRows(ticketId, projectDir, closedCommit, requiredGate);
      if (rows.length > 0) {
        const anyFail = rows.some((r) => r.exitCode !== 0);
        hostVerified = !anyFail;
        // When any row fails (any-fail-wins), use the first failing row so the displayed
        // evidence matches the verdict — the trailing pass row must not overwrite it.
        const detailRow = anyFail ? rows.find((r) => r.exitCode !== 0)! : rows[rows.length - 1]!;
        hostVerificationDetail =
          `gate: ${detailRow.gateName}; command: ${detailRow.command}; exit_code: ${detailRow.exitCode}; ` +
          `commit: ${closedCommit}; recorded_at: ${detailRow.recordedAt}`;
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
