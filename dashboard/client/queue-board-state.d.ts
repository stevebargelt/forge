// Types for the pure queue-board state module. Hand-written beside the .js exactly
// as backlog-state.d.ts is — the client has no build step, so the declaration is what
// lets the TypeScript test suite (and `npm --workspace=dashboard typecheck`) see it.

export type QueueBoardViewName =
  | "backlog"
  | "queued"
  | "in_progress"
  | "blocked"
  | "done"
  | "executing_not_queued";

export type BoardColumnDef = {
  view: QueueBoardViewName;
  title: string;
  hint: string;
  /** True for the columns that are DERIVED from evidence and never toggled. */
  derived: boolean;
};

export type BoardColumn = BoardColumnDef & {
  rows: any[];
  /** Ids the payload partitioned into this column but did not describe. */
  missing: string[];
  count: number;
};

export type WaitTone =
  | "blocker"
  | "scheduling"
  | "capacity"
  | "readiness"
  | "claimed"
  | "disarmed"
  | "neutral"
  | "unknown";

export type WaitBadge = {
  kind: string;
  label: string;
  tone: WaitTone;
  durability: "durable" | "temporary" | "unknown";
  note: string;
  reason: string;
  source: string | null;
  observedAt: string | null;
  evidence: "per-evaluation" | "durable";
};

export type DispatcherSummary = {
  present: boolean;
  armed: boolean;
  configured: boolean;
  maxActiveRuns?: number | null;
  capacityScope?: string | null;
  leaseTtlMs?: number | null;
  heartbeatMs?: number | null;
  defaultWorkflow?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
  state: string;
  label: string;
  tone: string;
  detail: string;
  lease: Record<string, any> | null;
  leaseLive: boolean;
  leaseExpired: boolean;
  leaseStaleness: number | null;
  lastEvaluation: Record<string, any> | null;
  lastEvaluationAgeMs: number | null;
  nextWatchdogInMs: number | null;
  pendingWakes: number;
  controlSurface: string;
  controlNotice: string;
};

export type CapacitySummary = {
  present: boolean;
  scope: string | null;
  limit: number | null;
  queueOwnedActive: number;
  holders: any[];
  otherProjectHolders: number;
  notCounted: { activeTasks: number; policy: string } | null;
  lastRefusal: Record<string, any> | null;
};

export type QueueBoardUiState = {
  kind: "no-project" | "loading" | "error" | "no-truth" | "unavailable" | "empty" | "board";
  message: string | null;
  error: string | null;
  projectKey: string | null;
  storageMode: string | null;
  version: number;
  rows: any[];
  rowsById: Map<string, any>;
  columns: BoardColumn[];
  queuedIds: string[];
  dispatcher: DispatcherSummary;
  capacity: CapacitySummary;
  degraded: string[];
  nowMs: number | null;
};

export type RelativeMove = {
  ticketId: string;
  reference: string;
  placement: "before" | "after";
};

export type MutationRequest = { path: string; body: Record<string, unknown> };

export type MutationOutcome = {
  ok: boolean;
  kind: "applied" | "stale_version" | "refused" | "rejected" | "error";
  verb: string | null;
  message: string | null;
  needsReload: boolean;
  blocking: boolean;
  hint?: string | null;
};

export declare const BOARD_COLUMNS: BoardColumnDef[];
export declare const BOARD_VIEWS: QueueBoardViewName[];
export declare const WAIT_PRESENTATION: Record<
  string,
  { label: string; tone: WaitTone; durability: "durable" | "temporary" | "unknown"; note: string }
>;
export declare const DISPATCHER_STATE_PRESENTATION: Record<string, { label: string; tone: string }>;
export declare const DISPATCH_CONTROL_NOTICE: string;
export declare const DEQUEUE_NOTE: string;

export declare function queueBoardState(
  data: any,
  options?: { projectSelected?: boolean },
): QueueBoardUiState;
export declare function waitBadge(row: any): WaitBadge | null;
export declare function isBlockerWait(row: any): boolean;
export declare function isSchedulingWait(row: any): boolean;
export declare function dispatcherSummary(panel: any, nowMs?: number | null): DispatcherSummary;
export declare function capacitySummary(capacity: any): CapacitySummary;
export declare function planRelativeMove(
  queuedIds: readonly string[],
  ticketId: string,
  targetIndex: number,
): RelativeMove | null;
export declare function previewMove(queuedIds: readonly string[], move: RelativeMove | null): string[];
export declare function rankRequest(move: RelativeMove | null, version: number): MutationRequest | null;
export declare function enqueueRequest(ticketId: string, note?: string): MutationRequest;
export declare function dequeueRequest(ticketId: string): MutationRequest;
export declare function mutationOutcome(response: { status: number; payload: any }): MutationOutcome;
