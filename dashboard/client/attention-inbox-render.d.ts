// FG-402: types for the pure Human Attention Inbox render helpers. Mirrors the JSON
// contract `/api/attention-inbox` serves (dashboard/src/attention-inbox.ts).

export type AttentionItemKind =
  | "waiting_gate"
  | "campaign_paused"
  | "blocked_by_red_or_reviewer"
  | "missing_acceptance_or_readiness"
  | "auth_setup"
  | "merge_conflict"
  | "integration_blocked_park";

export type AttentionSeverity = "high" | "medium" | "low";

export type AttentionLinks = {
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  campaignId: string | null;
  itemId: string | null;
  projectDir: string | null;
  projectLabel: string | null;
};

export type AttentionItem = {
  id: string;
  kind: AttentionItemKind;
  severity: AttentionSeverity | null;
  startedAt: string | null;
  reason: string;
  requestedAction: string;
  openState: "open";
  source: string;
  links: AttentionLinks;
};

export type InboxEnvelope = {
  generatedAt: string;
  scope: { runId: string | null; projectDirs: string[] | null };
  items: AttentionItem[];
  empty: boolean;
  degraded: string[];
};

export const INBOX_UNAVAILABLE_LABEL: string;
export const INBOX_LOADING_LABEL: string;
export const INBOX_EMPTY_LABEL: string;
export const INBOX_TIMEOUT_MS: number;
export const INBOX_LOADING: { phase: "loading" };

export function inboxItemBadge(item: Partial<AttentionItem> | null | undefined): { class: string; label: string };
export function inboxSeverityBadge(item: Partial<AttentionItem> | null | undefined): { class: string; label: string };
export function inboxItemLink(item: Partial<AttentionItem> | null | undefined): { hash: string; label: string } | null;

export type InboxItemSummary = {
  id: string | undefined;
  kind: string | undefined;
  badgeClass: string;
  badgeLabel: string;
  severityClass: string;
  severityLabel: string;
  reason: string;
  requestedAction: string;
  startedAt: string | null;
  source: string;
  ticketId: string | null;
  projectLabel: string | null;
  link: { hash: string; label: string } | null;
};

export function inboxItemSummary(item: Partial<AttentionItem> | null | undefined): InboxItemSummary;
export function inboxItemAge(item: Partial<AttentionItem> | null | undefined, now: number): string;
export function isRenderableInboxItem(value: unknown): boolean;
export function isAttentionInboxPayload(value: unknown): boolean;

export type InboxUnavailableReason = "http" | "malformed" | "timeout" | "network";

export type InboxLoad =
  | { phase: "loading" }
  | { phase: "ready"; envelope: InboxEnvelope }
  | { phase: "unavailable"; reason: InboxUnavailableReason; status: number | null };

export function inboxUnavailable(
  reason: InboxUnavailableReason,
  status?: number | null,
): { phase: "unavailable"; reason: InboxUnavailableReason; status: number | null };
export function inboxFromBody(body: unknown): InboxLoad;
export function readAttentionInbox(url: string, fetchImpl?: typeof fetch | null, timeoutMs?: number): Promise<InboxLoad>;
export function inboxPhase(load: unknown): "loading" | "ready" | "unavailable";
export function inboxUnavailableDetail(load: unknown): string;

export type InboxView = {
  phase: "loading" | "ready" | "unavailable";
  message?: string | null;
  detail?: string;
  retry?: boolean;
  items: InboxItemSummary[];
  empty: boolean;
  degraded: string[];
};

export function inboxView(load: unknown): InboxView;
