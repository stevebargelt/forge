// forge advise — given a run's current state, recommend the single next CLI command.
//
// Pure: takes a Run + its Tasks and returns structured advice. The CLI prints it
// and the dashboard can render the same shape in a "what should I do next?" panel
// (BACKLOG #57 follow-up). Adding to the result of this function = adding to both
// surfaces at once.

import type { Run, Task } from "../types/index.js";

export type AdviceKind =
  | "complete"
  | "abandoned"
  | "running"
  | "awaiting_gate"
  | "blocked_by_red"
  | "crashed"
  | "ready_to_dispatch"
  | "stuck";

export type Advice = {
  kind: AdviceKind;
  // One-line human-readable summary of what to do (or why nothing to do).
  summary: string;
  // The single literal command to copy/paste. Empty when there's nothing the user
  // can usefully run (e.g. run is complete, or all tasks are still running).
  command: string;
  // Optional secondary command for cases that have a clear "if not the primary,
  // try this" follow-up — e.g. blocked_by_red's force-advance escape hatch.
  alternativeCommand?: string;
  // Counts surfaced for the dashboard / curious humans. Always populated.
  counts: {
    pending: number;
    running: number;
    awaiting_gate: number;
    blocked_by_red: number;
    failed: number;
    complete: number;
  };
};

export function adviseRun(run: Run, tasks: Task[]): Advice {
  const counts = {
    pending: tasks.filter((t) => t.status === "pending").length,
    running: tasks.filter((t) => t.status === "running").length,
    awaiting_gate: tasks.filter((t) => t.status === "awaiting_gate").length,
    blocked_by_red: tasks.filter((t) => t.status === "blocked_by_red").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    complete: tasks.filter((t) => t.status === "complete").length,
  };

  // Terminal run states first — nothing to do.
  if (run.status === "complete") {
    return {
      kind: "complete",
      summary: `Run ${run.id} is complete.`,
      command: "",
      counts,
    };
  }
  if (run.status === "abandoned") {
    return {
      kind: "abandoned",
      summary: `Run ${run.id} was abandoned.`,
      command: "",
      counts,
    };
  }

  // blocked_by_red wins over awaiting_gate: a red verdict failure is the most
  // important thing for the human to look at. Force-advance is the explicit
  // escape hatch — show it as the alternative, never as the primary action.
  if (counts.blocked_by_red > 0) {
    const t = tasks.find((x) => x.status === "blocked_by_red")!;
    return {
      kind: "blocked_by_red",
      summary: `${counts.blocked_by_red} task(s) blocked by red verdict. Inspect first, then decide.`,
      command: `forge show ${t.id}`,
      alternativeCommand: `forge gate ${t.id} advance --force --rationale "..."`,
      counts,
    };
  }

  if (counts.awaiting_gate > 0) {
    if (counts.awaiting_gate === 1) {
      const t = tasks.find((x) => x.status === "awaiting_gate")!;
      return {
        kind: "awaiting_gate",
        summary: `1 task awaiting gate.`,
        command: `forge gate ${t.id} advance`,
        counts,
      };
    }
    return {
      kind: "awaiting_gate",
      summary: `${counts.awaiting_gate} tasks awaiting gate. Batch-advance with --all when they're all ready.`,
      command: `forge gate ${run.id} advance --all`,
      counts,
    };
  }

  if (counts.running > 0) {
    return {
      kind: "running",
      summary: `${counts.running} task(s) running. Wait for them to finish, or check the dashboard.`,
      command: "",
      counts,
    };
  }

  // Container-crashes that didn't auto-recover. Surface the dispatch retry as the
  // primary; the user typically wants to re-run after fixing whatever caused the crash.
  const crashed = tasks.filter((t) => t.status === "failed" && t.error?.startsWith("container_crash"));
  if (crashed.length > 0) {
    return {
      kind: "crashed",
      summary: `${crashed.length} task(s) crashed. Inspect stderr, then retry forge next.`,
      command: `forge next ${run.id}`,
      alternativeCommand: `forge show ${crashed[0]!.id}`,
      counts,
    };
  }

  if (counts.pending > 0) {
    return {
      kind: "ready_to_dispatch",
      summary: `${counts.pending} pending task(s) ready to dispatch.`,
      command: `forge next ${run.id}`,
      counts,
    };
  }

  // No pending, no running, no awaiting_gate, no blocked_by_red, no crashed. Run
  // status is still "active" though — could be a transitional state between phases,
  // or a terminal phase whose tasks are all complete but the run hasn't been
  // finalized (the #41 fix should have closed this; keep the case for safety).
  return {
    kind: "ready_to_dispatch",
    summary: `Run ${run.id} has no work-in-progress; advance to the next phase or finalize.`,
    command: `forge next ${run.id}`,
    counts,
  };
}
