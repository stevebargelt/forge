export type BacklogBoardState = {
  total: number;
  projectKey: string | null;
  storageMode: string | null;
  error: string | null;
  kind: "error" | "no-truth" | "empty" | "tickets";
  shadow: boolean;
};

export declare function backlogBoardState(data: {
  tickets?: unknown[];
  ticketsProjectKey?: string | null;
  ticketsStorageMode?: string | null;
  ticketsError?: string;
}): BacklogBoardState;

export declare const NO_TRUTH_MESSAGE: string;
export declare const SHADOW_BADGE_TITLE: string;

export type BacklogFilterState = { type: string; status: string };
export declare const BACKLOG_FILTER_DEFAULT: Readonly<BacklogFilterState>;
export declare function backlogFilterState(params: Record<string, string> | null | undefined): BacklogFilterState;
export declare function backlogFilterHash(scope: { project?: string | null; checkout?: string | null } | null, state: BacklogFilterState): string;
export declare function filterBacklogTickets<T extends { type: string; status: string }>(tickets: T[] | null | undefined, state: BacklogFilterState): T[];
export declare function backlogCountLabel(shown: number, total: number): string;
