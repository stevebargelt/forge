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
