import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { gatesForRun } from "../store/gates.js";
import { verdictsForRun } from "../store/verdicts.js";
import { readTicket } from "../backlog/structured.js";
import { resolveBacklogStore } from "../backlog/storage-mode.js";
import { dispatchEvidenceForTask, getTicket } from "../store/tickets.js";
import type { ReviewerContextPacket, MissingContextItem, Finding, RiskRedsPlan } from "../types/index.js";
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

function hasFanoutChildren(r: unknown): boolean {
  return typeof r === "object" && r !== null && Array.isArray((r as Record<string, unknown>)["children"]);
}

export function assembleReviewerContextPacket(
  runId: string,
  primaryTaskId: string,
  projectDir: string,
  primaryResultOverride?: unknown,
  // FG-385: the orchestrator's advisory risk-targeted reds plan, if it authored one. The
  // packet TRANSPORTS it; it never derives a plan from paths (that would be a classifier).
  riskRedsPlan?: RiskRedsPlan,
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

    // FG-608: dispatch-time ticket evidence vs LIVE authority. The reviewer is
    // handed the CURRENT ticket body (readTicket above resolves the authoritative
    // store), but the engineer built against whatever was current at dispatch. When
    // those differ the reviewer must be told, not silently handed a moved target —
    // and neither record overwrites the other.
    //
    // Surfaced through missingContext because that is the packet's existing typed
    // channel for "context you should know is off"; the ticket body itself stays
    // clean. Guarded whole: a project that never cut over to the DB store has no
    // revision to compare, which is not a failure.
    try {
      const dispatched = dispatchEvidenceForTask(primaryTaskId);
      if (dispatched && structuredTicket) {
        const store = resolveBacklogStore(projectDir);
        const live = store.mode === "db" ? getTicket(store.projectKey, ticketId) : undefined;
        if (live && (live.revision !== dispatched.revision || live.bodyHash !== dispatched.bodyHash)) {
          missingContext.push({
            field: "backlogTicketRevision",
            reason:
              `the ticket ADVANCED during execution: dispatched revision ${dispatched.revision} ` +
              `(body ${dispatched.bodyHash.slice(0, 12)}), current revision ${live.revision} ` +
              `(body ${(live.bodyHash ?? "unknown").slice(0, 12)}). The body above is CURRENT ` +
              `authority; the engineer built against the dispatched revision.`,
            required: false,
          });
        }
      }
    } catch {
      // Revision evidence is diagnostic. A store that cannot be resolved here must
      // never fail packet assembly — the packet's job is to hand over what it has.
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

  // Prefer the in-hand override over DB task.result (null at reds-dispatch time — FG-418).
  const rawOverride = primaryResultOverride !== undefined ? primaryResultOverride : (primaryTask?.result ?? null);

  let engineerSummary: unknown;
  let engineerResult: Record<string, unknown>;

  if (hasFanoutChildren(rawOverride)) {
    // Fanout aggregate: extract reviewer evidence from child results, not the hollow parent.
    const children = (rawOverride as { children: Array<{ index: number; status: string; childTaskId: string; result: unknown }> }).children;
    engineerSummary = { children: children.map((c) => c.result) };
    const seenFiles = new Set<string>();
    const files: string[] = [];
    let lastCommitSha = "";
    let lastDiffRange = "";
    const verCmds: unknown[] = [];
    const defScope: unknown[] = [];
    for (const child of children) {
      if (child.status !== "complete") continue;
      const cr = (child.result ?? {}) as Record<string, unknown>;
      if (Array.isArray(cr["files_modified"])) {
        for (const f of cr["files_modified"] as unknown[]) {
          if (typeof f === "string" && !seenFiles.has(f)) {
            seenFiles.add(f);
            files.push(f);
          }
        }
      }
      // Use the last non-empty commitSha/diffRange from completed children; the
      // integration commit is not threaded here, so last-child approximates it.
      if (typeof cr["commitSha"] === "string" && cr["commitSha"]) lastCommitSha = cr["commitSha"];
      if (typeof cr["diffRange"] === "string" && cr["diffRange"]) lastDiffRange = cr["diffRange"];
      if (Array.isArray(cr["verificationCommands"])) verCmds.push(...(cr["verificationCommands"] as unknown[]));
      if (Array.isArray(cr["deferredScope"])) defScope.push(...(cr["deferredScope"] as unknown[]));
    }
    engineerResult = {
      files_modified: files,
      ...(lastCommitSha ? { commitSha: lastCommitSha } : {}),
      ...(lastDiffRange ? { diffRange: lastDiffRange } : {}),
      verificationCommands: verCmds,
      deferredScope: defScope,
    };
  } else {
    engineerSummary = rawOverride;
    engineerResult = (rawOverride ?? {}) as Record<string, unknown>;
  }

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
    riskRedsPlan: riskRedsPlan ?? null,
    missingContext,
  };
}
