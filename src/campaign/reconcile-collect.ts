// FG-428: IO collector for `forge campaign reconcile`. Reads durable facts from
// the ticket store, git, the host-verification table, and the run's event log —
// no derivation happens here, that's reconcile-evidence.ts's job.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTicket } from "../backlog/structured.js";
import { queryHostVerificationRows } from "../store/host-verifications.js";
import { eventsForRun } from "../store/events.js";
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

export function checkClosedCommitReachableOnBase(
  projectDir: string,
  closedCommit: string,
  baseBranch: string
): boolean | null {
  if (!SHA_PATTERN.test(closedCommit) || !REF_PATTERN.test(baseBranch)) {
    return null;
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "--", closedCommit, baseBranch], {
      cwd: projectDir,
      timeout: 5000,
    });
    return true;
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return status === 1 ? false : null;
  }
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

  const requiredGate = readConfigString(projectDir, "requiredHostGate", "npm run test:all");
  let hostVerification: ReconcileEvidenceInput["hostVerification"] = null;
  if (ticketClosedCommit) {
    // Bound to the SAME ticketClosedCommit asserted above (facts 1-2) — an operator
    // cannot plant a verification row under a different sha and have it count.
    try {
      const rows = queryHostVerificationRows(item.ticketId, projectDir, ticketClosedCommit, requiredGate);
      hostVerification = { recorded: rows.length > 0, allExitZero: rows.length > 0 && rows.every((r) => r.exitCode === 0) };
    } catch {
      hostVerification = null;
    }
  }

  let events: ReconcileRunEvent[] = [];
  if (item.runId) {
    events = eventsForRun(item.runId)
      .filter((e) => e.eventType === "verdict.received" || e.eventType === "gate.decided")
      .map((e): ReconcileRunEvent => {
        if (e.eventType === "verdict.received") {
          const payload = e.payload as { verdict?: string; authority?: string } | null;
          return {
            id: e.id,
            kind: "verdict",
            verdict: (payload?.verdict as "pass" | "fail" | "inconclusive") ?? "inconclusive",
            authority: (payload?.authority as "authoritative" | "specialist") ?? "specialist",
          };
        }
        const payload = e.payload as { decision?: string; rationale?: string; force?: boolean } | null;
        return {
          id: e.id,
          kind: "gate",
          decision: (payload?.decision as GateDecision) ?? "advance",
          rationale: payload?.rationale,
          force: payload?.force ?? false,
        };
      });
  }

  return {
    ticketStatus,
    ticketClosedCommit,
    closedCommitReachableOnBase,
    hostVerification,
    events,
  };
}
