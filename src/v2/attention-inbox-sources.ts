// FG-820: the stale-verification (FG-746) and kanban-conflict (FG-785) source MAPPERS,
// moved out of dashboard/src/queries.ts so the core derivation (deriveAttentionInbox) owns
// every mapping from a source record to an AttentionItem. Pure: the caller reads the rows
// (the dashboard's scope-resolved verification read, the open kanban_conflicts rows) and
// hands them in; nothing here touches a store.

import { basename } from "node:path";
import type { KanbanConflict, KanbanConflictKind } from "../store/kanban-projection.js";
import type { AttentionItem, AttentionSeverity } from "./attention-inbox.js";
import { redactRemoteFreeText } from "./remote-free-text-redaction.js";

/** An unmatched host/CI verification start that survived terminal authority (FG-594 /
 *  FG-746). Produced by the dashboard's `inProgressVerifications` read. */
export type InProgressVerification =
  | {
      kind: "review_loop_verification";
      attemptId: string;
      runId: string | null;
      ticketId: string | null;
      sha: string | null;
      mode: string | null;
      round: number | null;
      startedAt: string;
      stale: boolean;
    }
  | {
      kind: "campaign_reconcile_gate";
      attemptId: string;
      runId: string | null;
      campaignId: string | null;
      itemId: string | null;
      ticketId: string | null;
      command: string | null;
      testedSha: string | null;
      startedAt: string;
      stale: boolean;
    };


// ── FG-746 (C3): stale-verification attention source ────────────────────────────
//
// The Human Attention destination for an unmatched host/CI verification start that
// has gone STALE under still-active, nonterminal work. It consumes the SAME
// terminal-authority-corrected `inProgressVerifications` the Current Activity live
// view reads, split by the SAME `classifyVerification` predicate — so a terminal
// FG-667 attempt (already dropped upstream) is neither live nor an attention item,
// with no forked terminal logic (protected_invariant #3). Only the `actionable`
// (stale) rows become items; the `live` rows stay in Current Activity.

/** One actionable verification plus the project dir its link resolves to (the run's
 *  project_dir for a review-loop attempt, the campaign's for a reconcile gate). */
export type StaleVerificationRow = { verification: InProgressVerification; projectDir: string | null };

function verificationLabelForProjectDir(projectDir: string | null): string | null {
  return projectDir ? basename(projectDir) : null;
}

export function staleVerificationAttentionItems(rows: readonly StaleVerificationRow[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const { verification: v, projectDir } of rows) {
    if (v.kind === "review_loop_verification") {
      items.push({
        id: `verification:${v.attemptId}`,
        kind: "stale_verification",
        severity: "medium",
        startedAt: v.startedAt,
        reason: `A review-loop ${v.mode === "ci-wait" ? "CI wait" : "host verification"} for ${v.ticketId ?? "an unknown ticket"} (candidate ${v.sha ? v.sha.slice(0, 10) : "unknown"}) started but never reported a result, and is now past its staleness bound — its owning run is still active.`,
        requestedAction: `Inspect the run and re-run or clear the stalled verification (\`forge show ${v.runId ?? v.ticketId ?? v.attemptId}\`).`,
        openState: "open",
        source: "verification",
        links: {
          runId: v.runId,
          taskId: null,
          ticketId: v.ticketId,
          campaignId: null,
          itemId: null,
          projectDir,
          projectLabel: verificationLabelForProjectDir(projectDir),
        },
      });
    } else {
      items.push({
        id: `verification:${v.attemptId}`,
        kind: "stale_verification",
        severity: "medium",
        startedAt: v.startedAt,
        reason: `A campaign reconcile host gate (${v.command ?? "host verification"}) for ${v.ticketId ?? "an unknown ticket"} on candidate ${v.testedSha ? v.testedSha.slice(0, 10) : "unknown"} started but never reported a result, and is now past its staleness bound under active, nonterminal campaign work.`,
        requestedAction: `Inspect the campaign item and re-run or clear the stalled gate (\`forge campaign show ${v.campaignId ?? "<campaign>"}\`).`,
        openState: "open",
        source: "campaign_item",
        links: {
          runId: v.runId,
          taskId: null,
          ticketId: v.ticketId,
          campaignId: v.campaignId,
          itemId: v.itemId,
          projectDir,
          projectLabel: verificationLabelForProjectDir(projectDir),
        },
      });
    }
  }
  return items;
}

// ── FG-785: kanban-conflict attention source ─────────────────────────────────────
//
// The Human Attention destination for an external-board divergence recorded by the
// outbound kanban sync (step 4). It is a PURE, OPEN-ONLY projection of the store's
// `kanban_conflicts` rows: a conflict item exists exactly while its row is `open`, and
// resolution is a store write (the `forge kanban conflicts-resolve` CLI, step 6), NEVER
// an inbox mutation — the inbox holds no resolution state of its own (AC5). The mapper
// writes nothing; the caller reads the open rows via the store accessor and hands them in.
//
// The both-versions payload is arbitrary JSON the store keeps verbatim, and the EXTERNAL
// side is untrusted provider content. Each embedded version is passed through
// redactRemoteFreeText (the FG-781 free-text denylist) before it enters the operator-
// facing `reason`, so a path/secret pasted onto an external card cannot ride the seal
// out through this item. The `requestedAction` carries only the opaque Forge conflict id
// and static text, so it is left intact for host copy-paste (the remote projection
// redacts it again at the boundary, like every other source).

/** Per-kind severity: an externally DELETED card is the most consequential divergence
 *  (the projected card is gone), a move/edit is medium. An unknown future kind a newer
 *  binary wrote falls back to medium rather than throwing. */
const KANBAN_CONFLICT_SEVERITY: Record<KanbanConflictKind, AttentionSeverity> = {
  deleted: "high",
  moved: "medium",
  edited: "medium",
};

/** A bounded, single-line digest of one side of a conflict's both-versions payload, so the
 *  operator sees WHAT diverged without the inbox item growing unbounded. The value is
 *  arbitrary (the store keeps it verbatim); it is stringified and clamped here, then
 *  redacted by the caller before it enters the item text. */
function summarizeConflictVersion(value: unknown): string {
  if (value === null || value === undefined) return "none";
  const raw = typeof value === "string" ? value : safeJson(value);
  // RF-3: redact on the FULL text BEFORE clamping. A credential-shaped token straddling the clamp
  // cutoff would otherwise lose the shape the redactor keys on, so its prefix would survive the
  // slice and ride into the browser-facing inbox reason. Redacting first, then clamping the
  // already-scrubbed result, keeps no fragment of an untrusted external secret intact.
  const redacted = redactRemoteFreeText(raw);
  const CLAMP = 240;
  return redacted.length > CLAMP ? `${redacted.slice(0, CLAMP)}…` : redacted;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** PURE mapper (unit-testable, no store access): project OPEN kanban conflicts into
 *  attention items of the `kanban_conflict` kind, carrying both-version context and the
 *  ticket/project links. Callers pass only open rows (see kanbanConflictAttentionItems);
 *  a resolved row simply never reaches here, so it disappears from the inbox. */
export function kanbanConflictsToAttentionItems(conflicts: readonly KanbanConflict[]): AttentionItem[] {
  return conflicts.map((c) => {
    const verb = c.kind === "deleted" ? "deleted" : c.kind === "moved" ? "moved" : "edited";
    const forgeSide = summarizeConflictVersion(c.forgeVersion);
    const externalSide = summarizeConflictVersion(c.externalVersion);
    // Redact the whole reason: it embeds untrusted external card content, and it carries
    // no host command (the id lives only in requestedAction), so redaction can't harm a
    // copy-pasteable action here.
    const reason = redactRemoteFreeText(
      `An external kanban card for ticket ${c.ticketIdentity} on the "${c.provider}" board was ${verb} outside Forge; ` +
        `Forge's one-way projection and the external state have diverged and the change was NOT applied to any Forge state. ` +
        `Forge version: ${forgeSide} · External version: ${externalSide}.`,
    );
    const requestedAction =
      `Review the divergence and record an authorized resolution — \`forge kanban conflicts-resolve ${c.id}\`. ` +
      `Resolution is host-operator only; no inbound planning change is applied to Forge this release.`;
    return {
      id: `kanban_conflict:${c.id}`,
      kind: "kanban_conflict",
      severity: KANBAN_CONFLICT_SEVERITY[c.kind] ?? "medium",
      // The conflict's detection time is when this attention condition began — never "now".
      startedAt: c.detectedAt,
      reason,
      requestedAction,
      openState: "open",
      source: "kanban_conflict",
      links: {
        runId: null,
        taskId: null,
        // Opaque Forge identity (AC1): the ticket the projected card maps to, and the
        // project key as a display label. No provider concept, no filesystem path.
        ticketId: c.ticketIdentity,
        campaignId: null,
        itemId: c.id,
        projectDir: null,
        projectLabel: c.projectIdentity,
      },
    };
  });
}
