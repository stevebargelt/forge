import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTicket } from "../backlog/structured.js";
import { tasksForRun } from "../store/tasks.js";
import { queryHostVerificationRowsForGate } from "../store/host-verifications.js";
import type { CampaignItem } from "../types/index.js";
import type { DoneAuditInput } from "./done-audit.js";

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

// FG-452: a host_verifications row covers closedCommit if closedCommit is an
// ancestor of the row's tested commit — the gate runs at projectDir's current
// HEAD, which may be a later commit than closedCommit (exactly the out-of-band
// code-touching shape). Exact-sha matching alone leaves those rows invisible to
// this done-audit surface even though reconcile already shipped the item via
// this same ancestry rule (reconcile-collect.ts's checkClosedCommitCoveredByTestedSha).
function isCoveringCommit(projectDir: string, closedCommit: string, testedSha: string): boolean {
  if (closedCommit === testedSha) return true;
  if (!SHA_PATTERN.test(closedCommit) || !SHA_PATTERN.test(testedSha)) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "--", closedCommit, testedSha], {
      cwd: projectDir,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
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
      try {
        const configRaw = readFileSync(join(projectDir, ".forge", "config.json"), "utf8");
        const config = JSON.parse(configRaw) as Record<string, unknown>;
        if (typeof config["requiredHostGate"] === "string") {
          requiredGate = config["requiredHostGate"];
        }
      } catch {
        // missing or malformed config — default stands
      }

      const rows = queryHostVerificationRowsForGate(ticketId, projectDir, requiredGate);
      const covering = rows.filter((r) => isCoveringCommit(projectDir, closedCommit, r.commitSha));
      if (covering.length > 0) {
        const anyFail = covering.some((r) => r.exitCode !== 0);
        hostVerified = !anyFail;
        // When any row fails (any-fail-wins), use the first failing row so the displayed
        // evidence matches the verdict — the trailing pass row must not overwrite it.
        const detailRow = anyFail ? covering.find((r) => r.exitCode !== 0)! : covering[covering.length - 1]!;
        hostVerificationDetail =
          `gate: ${detailRow.gateName}; command: ${detailRow.command}; exit_code: ${detailRow.exitCode}; ` +
          `commit: ${detailRow.commitSha}; recorded_at: ${detailRow.recordedAt}`;
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
