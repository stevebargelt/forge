import { execFileSync } from "node:child_process";
import { readTicket } from "../backlog/structured.js";
import { tasksForRun } from "../store/tasks.js";
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
  let pushed: boolean | null = null;
  if (closedCommit) {
    try {
      const output = execFileSync("git", ["branch", "-r", "--contains", closedCommit], {
        cwd: projectDir,
        encoding: "utf8",
        timeout: 5000,
      });
      pushed = output.trim().length > 0;
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

  return {
    ticket,
    item: { lifecycleStatus: "complete" },
    git: { dirty, commitExists, pushed },
    verification: {
      hostVerified: null,   // recorder out of scope for FG-383
      containerTestsRun,
      acceptedException: null,
    },
  };
}

export function collectDoneAuditInput(projectDir: string, item: CampaignItem): DoneAuditInput {
  const input = collectDoneAuditInputFor(projectDir, item.ticketId, item.runId);
  return { ...input, item: { lifecycleStatus: item.lifecycleStatus, outcome: item.outcome } };
}
