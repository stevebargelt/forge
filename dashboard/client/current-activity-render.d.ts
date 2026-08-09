// FG-679: types for the pure Current-activity render helpers. Mirrors the JSON
// contract `/api/current-activity` serves (src/v2/current-activity.ts).

export type LaunchStatusState =
  | "running"
  | "exited_ok"
  | "exited_error"
  | "signaled"
  | "terminated_unattributed"
  | "owner_gone"
  | "unknown";

export type HostLaunchEntry = {
  launchId: string;
  name: string | null;
  command: string[];
  commandLine: string;
  projectDir: string | null;
  projectLabel: string | null;
  associationKind: "explicit" | "cwd" | "none";
  unassociated: boolean;
  placement: "run" | "project" | "host";
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  campaignId: string | null;
  itemId: string | null;
  startedAt: string;
  observedAt: string;
  status: { state: LaunchStatusState };
  recordedStatus: { state: LaunchStatusState };
  /** Rendered by src/v2/launch.ts's `statusLine` (or the explicit
   *  `unobserved since <t>`). Never composed on the client. */
  statusLabel: string;
  observation: "fresh" | "unobserved";
};

export type RequiredCiContextEntry = {
  context: string;
  state: string;
  url: string | null;
  observedAt: string;
};

export type RequiredCiObservationEntry = {
  runId: string | null;
  projectDir: string | null;
  projectLabel: string | null;
  attemptId: string;
  ticketId: string | null;
  candidateSha: string;
  observedAt: string;
  outcome: string;
  unavailableReason: string | null;
  contexts: RequiredCiContextEntry[];
  state: "running" | "not_running" | "stale";
  label: string;
};

export type RequiredCiSectionEntry = {
  /** FG-694 added the third value. `no_current_candidate` means nothing in scope
   *  could be waiting on required checks — no active run, no open review — which is
   *  a different fact from `not_observed` ("current work exists and no CI observation
   *  has been recorded for it"). The renderer omits the CI row entirely for the
   *  former; it must never report it as CI having gone unobserved. Mirrors
   *  RequiredCiSection in src/v2/current-activity.ts, which is what the API serves. */
  state: "no_current_candidate" | "not_observed" | "observed";
  label: string;
  observations: RequiredCiObservationEntry[];
};

export type CurrentActivityPayload = {
  generatedAt: string;
  scope: { runId: string | null; projectDirs: string[] | null };
  agents: Array<{
    runId: string;
    runTitle: string;
    workflow: string;
    projectDir: string | null;
    projectLabel: string | null;
    taskId: string;
    agentRole: string;
    agentModel: string | null;
    phase: string;
    status: string;
    startedAt: string | null;
  }>;
  hostVerification: HostLaunchEntry[];
  requiredCi: RequiredCiSectionEntry;
  unassociated: HostLaunchEntry[];
};

export function launchBadgeClass(entry: Partial<HostLaunchEntry> | null | undefined): string;
export function launchBadgeText(entry: Partial<HostLaunchEntry> | null | undefined): string;
export function launchBadge(entry: Partial<HostLaunchEntry> | null | undefined): { class: string; text: string };
export function launchAssociationLabel(entry: Partial<HostLaunchEntry> | null | undefined): string | null;
export function launchIdentityLine(entry: Partial<HostLaunchEntry> | null | undefined): string;
export function ciSectionLabel(section: Partial<RequiredCiSectionEntry> | null | undefined): string | null;
export function ciBadgeClass(observation: Partial<RequiredCiObservationEntry> | null | undefined): string;
export function ciBadgeText(observation: Partial<RequiredCiObservationEntry> | null | undefined): string;
export function ciContextClass(state: unknown): string;
export function ciContextRows(
  observation: Partial<RequiredCiObservationEntry> | null | undefined,
): Array<{ context: string; state: string; url: string | null; observedAt: string; class: string }>;
export function activityIsEmpty(activity: Partial<CurrentActivityPayload> | null | undefined): boolean;
export function activityCounts(activity: Partial<CurrentActivityPayload> | null | undefined): {
  agents: number;
  hostVerification: number;
  requiredCi: number;
  unassociated: number;
};

// ───────────────────────────── FG-694 ─────────────────────────────

export const CURRENT_ACTIVITY_UNAVAILABLE_LABEL: string;
export const CURRENT_ACTIVITY_LOADING_LABEL: string;
export const NOTHING_RUNNING_LABEL: string;
export const CI_NOT_STARTED_LABEL: string;
export const CI_STATUS_UNAVAILABLE_LABEL: string;
export const CI_RUNNING_LABEL: string;
export const CI_FAILED_LABEL: string;
export const CI_PASSED_LABEL: string;
/** The four strings a failed or absent read may never render (AC7). */
export const OBSERVATION_CLAIMS: readonly string[];

/** Why a read of /api/current-activity produced no payload. */
export type ActivityUnavailableReason = "http" | "malformed" | "timeout" | "network";

export type ActivityLoad =
  | { phase: "loading" }
  | { phase: "ready"; activity: CurrentActivityPayload }
  | { phase: "unavailable"; reason: ActivityUnavailableReason; status: number | null };

export const ACTIVITY_LOADING: { phase: "loading" };
export function activityUnavailable(
  reason: ActivityUnavailableReason,
  status?: number | null,
): { phase: "unavailable"; reason: ActivityUnavailableReason; status: number | null };
export const CURRENT_ACTIVITY_TIMEOUT_MS: number;
/** Reads /api/current-activity. Never rejects — its failure IS its return value. */
export function readCurrentActivity(
  url: string,
  fetchImpl?: typeof fetch | null,
  timeoutMs?: number,
): Promise<ActivityLoad>;
export function isCurrentActivityPayload(value: unknown): boolean;
export function activityFromBody(body: unknown): ActivityLoad;
export function activityPhase(load: unknown): "loading" | "ready" | "unavailable";
export function activityUnavailableDetail(load: unknown): string;
export function caElapsedText(startedAt: string | null | undefined, now: number): string;
export function ciCandidateLabel(
  observation: Partial<RequiredCiObservationEntry> | null | undefined,
): string | null;

/** One compact Home line for one current candidate (AC4). */
export type CiCompactSummary = {
  /** Ticket id, else the SHORT sha, else null when the candidate carries no identity. */
  identity: string | null;
  state: "running" | "failed" | "passed" | "not_started" | "not_running" | "unavailable";
  label: string;
  /** `7/10 complete`, the failing context names, or null. */
  detail: string | null;
  class: string;
  /** The full observation, for the drill-down. Null for a synthesized row. */
  observation: RequiredCiObservationEntry | null;
};

export function ciCompactSummary(
  observation: Partial<RequiredCiObservationEntry> | null | undefined,
): CiCompactSummary;
/** Null means "render no CI row at all" — no current candidate, or nothing readable. */
export function homeCiSummaries(
  section: Partial<RequiredCiSectionEntry> | null | undefined,
): CiCompactSummary[] | null;

export type HomeActivityView = {
  phase: "loading" | "ready" | "unavailable";
  message: string | null;
  detail?: string;
  retry?: boolean;
  /** ONLY non-empty sections — an empty section's heading does not render (AC6). */
  sections: Array<{ kind: string; heading: string; entries: unknown[] }>;
  ci: CiCompactSummary[] | null;
  empty: boolean;
};

export function homeActivityView(load: unknown): HomeActivityView;
