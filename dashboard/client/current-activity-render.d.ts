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
