import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { gatesForRun } from "../store/gates.js";
import { verdictsForRun } from "../store/verdicts.js";
import { readTicket } from "../backlog/structured.js";
import type { ReviewerContextPacket, MissingContextItem, Finding } from "../types/index.js";
import { collectDoneAuditInputFor } from "../done-audit/collect.js";
import { evaluateDoneAudit } from "../done-audit/done-audit.js";

function extractSection(body: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}\\s*$`, "m");
  const match = re.exec(body);
  if (!match) return "";
  const rest = body.slice(match.index + match[0].length);
  const nextMatch = /^##\s/m.exec(rest);
  return rest.slice(0, nextMatch ? nextMatch.index : rest.length).trim();
}

export function assembleReviewerContextPacket(
  runId: string,
  primaryTaskId: string,
  projectDir: string,
): ReviewerContextPacket {
  const run = getRun(runId);
  if (!run) throw new Error(`assembleReviewerContextPacket: run not found: ${runId}`);
  const rawTicketIdForAudit = run.metadata?.["ticketId"];

  const allTasks = tasksForRun(runId);
  const allGates = gatesForRun(runId);
  const allVerdicts = verdictsForRun(runId);

  const architectTask = allTasks.find(
    (t) => t.agentRole === "architecture-advisor" && t.status === "complete" && t.parentId === undefined,
  );
  const techLeadTask = allTasks.find(
    (t) => t.agentRole === "tech-lead" && t.status === "complete" && t.parentId === undefined,
  );
  const primaryTask = allTasks.find((t) => t.id === primaryTaskId);

  const architectDecisions: unknown = architectTask?.result ?? null;
  const techLeadPlan: unknown = techLeadTask?.result ?? null;
  const engineerSummary: unknown = primaryTask?.result ?? null;

  const missingContext: MissingContextItem[] = [];
  let backlogData: ReviewerContextPacket["backlog"] = null;

  const rawTicketId = run.metadata?.["ticketId"];

  if (rawTicketId === undefined || rawTicketId === null) {
    missingContext.push({
      field: "backlogTicket",
      reason: "run.metadata.ticketId is absent; cannot resolve the backlog ticket",
      required: true,
    });
  } else {
    const ticketId = String(rawTicketId);
    let structuredTicket;
    try {
      structuredTicket = readTicket(projectDir, ticketId);
    } catch {
      missingContext.push({
        field: "backlogTicket",
        reason: `structured backlog ticket ${ticketId} not found under backlog/ (ideas|epics|stories|done)`,
        required: true,
      });
    }

    if (structuredTicket) {
      backlogData = {
        id: structuredTicket.id,
        title: structuredTicket.title,
        type: structuredTicket.type,
        status: structuredTicket.status,
        body: structuredTicket.body,
        acceptanceCriteria: extractSection(structuredTicket.body, "Acceptance Criteria"),
        nonGoals: extractSection(structuredTicket.body, "Non-Goals"),
        parentEpic: structuredTicket.epic ?? "",
      };
    }
  }

  // Use the LAST human-advance gate so the reviewer gets the latest operator intent.
  let humanAdvanceGate;
  for (const g of allGates) {
    if (g.decidedBy !== "system" && g.decision === "advance") humanAdvanceGate = g;
  }
  const operatorAsk: string | null = humanAdvanceGate?.rationale ?? null;
  if (!operatorAsk) {
    missingContext.push({
      field: "operatorAsk",
      reason: "No human-advance gate rationale found (FG-380 known gap)",
      required: false,
    });
  }

  const requestChangesGates = allGates
    .filter((g) => g.decision === "request-changes")
    .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));

  const requestChangesHistory = requestChangesGates.map((g) => {
    const verdictFindings: Finding[] = allVerdicts
      .filter((v) => v.taskId === g.taskId)
      .flatMap((v) => v.findings);
    return {
      taskId: g.taskId,
      rationale: g.rationale ?? "",
      decidedAt: g.decidedAt,
      verdictFindings,
    };
  });

  const redFindings = allVerdicts.filter(
    (v) => v.taskId === primaryTaskId && v.redRole !== "shipping-reviewer",
  );

  const engineerResult = (primaryTask?.result ?? {}) as Record<string, unknown>;
  const changedFiles = Array.isArray(engineerResult["files_modified"])
    ? (engineerResult["files_modified"] as unknown[]).filter(
        (f): f is string => typeof f === "string",
      )
    : [];
  const git: ReviewerContextPacket["git"] = {
    ...(typeof engineerResult["commitSha"] === "string" ? { commitSha: engineerResult["commitSha"] } : {}),
    ...(typeof engineerResult["diffRange"] === "string" ? { diffRange: engineerResult["diffRange"] } : {}),
    changedFiles,
    ...(primaryTask?.worktreePath ? { worktreePath: primaryTask.worktreePath } : {}),
  };

  const verificationCommands: ReviewerContextPacket["verificationCommands"] = Array.isArray(
    engineerResult["verificationCommands"],
  )
    ? (engineerResult["verificationCommands"] as unknown[]).filter(
        (c): c is { command: string; context: "host" | "container" } =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as Record<string, unknown>)["command"] === "string" &&
          ((c as Record<string, unknown>)["context"] === "host" ||
            (c as Record<string, unknown>)["context"] === "container"),
      )
    : [];

  const deferredScope: ReviewerContextPacket["deferredScope"] = Array.isArray(
    engineerResult["deferredScope"],
  )
    ? (engineerResult["deferredScope"] as unknown[]).filter(
        (d): d is { description: string; followUpTicketId?: string } =>
          typeof d === "object" &&
          d !== null &&
          typeof (d as Record<string, unknown>)["description"] === "string",
      )
    : [];

  // doneAudit: best-effort; only when the backlog ticket resolved (mirrors backlogData null rule).
  let doneAudit: ReviewerContextPacket["doneAudit"] = null;
  if (rawTicketIdForAudit !== undefined && rawTicketIdForAudit !== null && backlogData !== null) {
    try {
      const auditInput = collectDoneAuditInputFor(projectDir, String(rawTicketIdForAudit), runId);
      doneAudit = evaluateDoneAudit(auditInput);
    } catch {
      // best-effort — null on failure
    }
  }

  return {
    backlog: backlogData,
    operatorAsk,
    architectDecisions,
    techLeadPlan,
    requestChangesHistory,
    redFindings,
    engineerSummary,
    git,
    verificationCommands,
    deferredScope,
    doneAudit,
    missingContext,
  };
}
