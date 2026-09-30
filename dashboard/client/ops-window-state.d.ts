export declare const RUNTIME_WINDOW_DEFAULT: string;
export declare const RUNTIME_WINDOWS: readonly string[];
export declare const OPS_FETCH_BUDGET_MS: number;
export declare const OPS_SINCE_DEFAULT: string;
export declare const OPS_SINCES: readonly string[];
export declare function runtimeWindowState(params: Record<string, string> | null | undefined): string;
export declare function opsSinceState(params: Record<string, string> | null | undefined): string;
export declare function runtimeWindowHash(scope: { project?: string | null; checkout?: string | null } | null, window: string, since?: string): string;
export declare function opsSinceHash(scope: { project?: string | null; checkout?: string | null } | null, since: string, window?: string): string;

export interface WindowLoad<T = unknown> {
  data: T | null;
  window: string | null;
  error: { window: string; reason: string } | null;
  pending: string | null;
}
export declare const EMPTY_WINDOW_LOAD: Readonly<WindowLoad<never>>;
export declare function beginWindowRead<T>(load: WindowLoad<T>, window: string): WindowLoad<T>;
export declare function settleWindowRead<T>(window: string, data: T): WindowLoad<T>;
export declare function failWindowRead<T>(load: WindowLoad<T>, window: string, reason: string): WindowLoad<T>;
export declare function windowLoadView(load: WindowLoad, requested: string): {
  loading: boolean;
  loadingWindow: string | null;
  showing: string | null;
  pressed: string;
};

export interface WindowedReader<T = unknown> {
  readonly load: WindowLoad<T>;
  read(url: string, window: string): Promise<void>;
  reset(): void;
}
export declare function createWindowedReader<T = unknown>(options: {
  label: string;
  onUpdate: (load: WindowLoad<T>) => void;
  fetchImpl?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  budgetMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: any) => void;
}): WindowedReader<T>;
