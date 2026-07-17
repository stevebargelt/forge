import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type PlanUsageStatus = "live" | "stale" | "unavailable" | "not_applicable" | "not_configured" | "error";

export type PlanUsageWindow = {
  label: string;
  usedPct: number;
  resetsAt: string | null;
  elapsedPct: number | null;
  pacePct: number | null;
};

export type PlanUsageService = {
  id: "claude-subscription" | "anthropic-api" | "bedrock" | "codex-subscription" | "openai-api";
  name: string;
  plan: string | null;
  authMode: "oauth" | "subscription" | "api_key" | "bedrock" | "unknown";
  status: PlanUsageStatus;
  source: "anthropic-oauth-api" | "codex-app-server" | "codex-rollout" | "environment" | "host-auth" | "none";
  observedAt: string | null;
  windows: PlanUsageWindow[];
  note: string | null;
};

export type PlanUsageResponse = {
  generatedAt: string;
  services: PlanUsageService[];
};

type ClaudeCredential = {
  accessToken: string;
  subscriptionType?: string;
  rateLimitTier?: string;
};

type CollectorOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  readClaudeCredential?: () => ClaudeCredential | null;
  claudeVersion?: string;
  codexAppServerQuery?: (codexDir: string, env: NodeJS.ProcessEnv, now: () => number) => Promise<CodexRateLimits | null>;
};

type ClaudeUsagePayload = {
  five_hour?: { utilization?: number | null; resets_at?: string | null } | null;
  seven_day?: { utilization?: number | null; resets_at?: string | null } | null;
  limits?: Array<{
    kind?: string;
    percent?: number | null;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
  }>;
};

type CodexRateWindow = {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number | null;
  resets_in_seconds?: number | null;
};

export type CodexRateLimits = {
  planType: string | null;
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
  observedAt: string | null;
  source: "codex-app-server" | "codex-rollout";
};

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_SESSION_MS = 5 * 60 * 60 * 1000;
const CLAUDE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 30_000;
const CODEX_FRESH_MS = 10 * 60 * 1000;
const MAX_ROLLOUT_BYTES = 1024 * 1024;
const CODEX_APP_SERVER_TIMEOUT_MS = 6_000;
const MAX_APP_SERVER_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ROLLOUT_CANDIDATES = 50;
const MAX_SESSION_ENTRIES = 5_000;

let cached: { at: number; value: PlanUsageResponse } | null = null;
let inFlight: Promise<PlanUsageResponse> | null = null;

export async function getPlanUsage(forceRefresh = false, options: CollectorOptions = {}): Promise<PlanUsageResponse> {
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = collectPlanUsage(options).then((value) => {
    cached = { at: Date.now(), value };
    return value;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function resetPlanUsageCacheForTests(): void {
  cached = null;
  inFlight = null;
}

export async function collectPlanUsage(options: CollectorOptions = {}): Promise<PlanUsageResponse> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const services: PlanUsageService[] = [];
  const [claudeSubscription, codexServices] = await Promise.all([
    collectClaudeUsage({
      env,
      homeDir,
      fetchImpl,
      now,
      credentialReader: options.readClaudeCredential,
      claudeVersion: options.claudeVersion,
    }),
    collectCodexUsage(
      env.FORGE_CODEX_DIR ?? join(homeDir, ".codex"),
      now,
      env,
      options.codexAppServerQuery,
    ),
  ]);
  if (claudeSubscription) services.push(claudeSubscription);
  if (env.ANTHROPIC_API_KEY) services.push(anthropicApiService());
  if (env.CLAUDE_CODE_USE_BEDROCK === "1") services.push(bedrockService(env));
  services.push(...codexServices);
  return { generatedAt: new Date(now()).toISOString(), services };
}

function bedrockService(env: NodeJS.ProcessEnv): PlanUsageService {
  const profile = env.AWS_PROFILE ? ` · ${env.AWS_PROFILE}` : "";
  return {
    id: "bedrock",
    name: "Amazon Bedrock",
    plan: `AWS usage${profile}`,
    authMode: "bedrock",
    status: "not_configured",
    source: "environment",
    observedAt: null,
    windows: [],
    note: "Bedrock usage metrics are not configured on this host yet.",
  };
}

function anthropicApiService(): PlanUsageService {
  return {
    id: "anthropic-api",
    name: "Anthropic API",
    plan: "Usage-based billing",
    authMode: "api_key",
    status: "not_applicable",
    source: "environment",
    observedAt: null,
    windows: [],
    note: "Subscription limit windows do not apply to Anthropic API-key billing.",
  };
}

async function collectClaudeUsage(args: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  fetchImpl: typeof fetch;
  now: () => number;
  credentialReader?: () => ClaudeCredential | null;
  claudeVersion?: string;
}): Promise<PlanUsageService | null> {
  const credential = args.credentialReader
    ? args.credentialReader()
    : readClaudeCredential(args.env, args.homeDir);
  if (!credential) {
    return null;
  }

  try {
    const response = await args.fetchImpl(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-code/${args.claudeVersion ?? detectClaudeVersion()}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      return claudeErrorService(
        credential,
        response.status === 401
          ? "The host Claude OAuth credential is expired or revoked; run Claude Code to sign in again."
          : `Anthropic usage returned HTTP ${response.status}.`,
      );
    }
    const payload = await response.json() as ClaudeUsagePayload;
    const windows = mapClaudeWindows(payload, args.now);
    return {
      id: "claude-subscription",
      name: "Claude Code",
      plan: claudePlanName(credential),
      authMode: "oauth",
      status: windows.length > 0 ? "live" : "unavailable",
      source: "anthropic-oauth-api",
      observedAt: new Date(args.now()).toISOString(),
      windows,
      note: windows.length === 0 ? "Anthropic returned no usable plan windows." : null,
    };
  } catch (error) {
    const note = error instanceof SyntaxError
      ? "Anthropic returned an unreadable usage response."
      : error instanceof Error && error.name === "TimeoutError"
        ? "The Anthropic usage request timed out."
        : "Anthropic usage is currently unreachable.";
    return claudeErrorService(credential, note);
  }
}

function claudeErrorService(credential: ClaudeCredential, note: string): PlanUsageService {
  return {
    id: "claude-subscription",
    name: "Claude Code",
    plan: claudePlanName(credential),
    authMode: "oauth",
    status: "error",
    source: "none",
    observedAt: null,
    windows: [],
    note,
  };
}

function mapClaudeWindows(payload: ClaudeUsagePayload, now: () => number): PlanUsageWindow[] {
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const windows: PlanUsageWindow[] = [];
  const session = limits.find((limit) => limit.kind === "session");
  const weekly = limits.find((limit) => limit.kind === "weekly_all");

  const pushWindow = (label: string, usedPct: number | null, rawReset: string | null | undefined, windowMs: number) => {
    if (usedPct === null) return;
    const resetsAt = normalizeTimestamp(rawReset);
    windows.push({ label, usedPct, resetsAt, ...windowPace(resetsAt, windowMs, usedPct, now()) });
  };

  pushWindow(
    "5-hour limit",
    normalizePercent(session?.percent) ?? normalizeUtilization(payload.five_hour?.utilization),
    normalizeTimestamp(session?.resets_at) ?? payload.five_hour?.resets_at,
    CLAUDE_SESSION_MS,
  );
  pushWindow(
    "Weekly · all models",
    normalizePercent(weekly?.percent) ?? normalizeUtilization(payload.seven_day?.utilization),
    normalizeTimestamp(weekly?.resets_at) ?? payload.seven_day?.resets_at,
    CLAUDE_WEEK_MS,
  );
  for (const scoped of limits.filter((limit) => limit.kind === "weekly_scoped")) {
    const model = scoped.scope?.model?.display_name ?? "scoped model";
    pushWindow(`Weekly · ${model}`, normalizePercent(scoped.percent), scoped.resets_at, CLAUDE_WEEK_MS);
  }
  return windows;
}

function readClaudeCredential(env: NodeJS.ProcessEnv, homeDir: string): ClaudeCredential | null {
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(homeDir, ".claude");
  const fileCredential = parseClaudeCredentialFile(join(configDir, ".credentials.json"));
  if (fileCredential) return fileCredential;
  if (process.platform !== "darwin") return null;

  try {
    const account = env.USER;
    if (!account) return null;
    const output = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    ).trim();
    return parseClaudeCredential(output);
  } catch {
    return null;
  }
}

function parseClaudeCredentialFile(path: string): ClaudeCredential | null {
  try {
    return parseClaudeCredential(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseClaudeCredential(raw: string): ClaudeCredential | null {
  if (raw.startsWith("sk-ant-oat01-")) return { accessToken: raw };
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed?.claudeAiOauth ?? parsed;
    return typeof inner?.accessToken === "string" && inner.accessToken.startsWith("sk-ant-oat01-")
      ? inner as ClaudeCredential
      : null;
  } catch {
    return null;
  }
}

function detectClaudeVersion(): string {
  try {
    const output = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    return output.match(/\d+\.\d+\.\d+/)?.[0] ?? "2.1.148";
  } catch {
    return "2.1.148";
  }
}

async function collectCodexUsage(
  codexDir: string,
  now: () => number,
  env: NodeJS.ProcessEnv,
  appServerQuery?: CollectorOptions["codexAppServerQuery"],
): Promise<PlanUsageService[]> {
  const authPath = join(codexDir, "auth.json");
  const auth = readCodexAuth(authPath);
  const liveRateLimits = env.FORGE_DASHBOARD_DISABLE_CODEX_APP_SERVER === "1"
    ? null
    : await (appServerQuery ?? queryCodexAppServerRateLimits)(codexDir, env, now);
  const rateLimits = liveRateLimits ?? readCodexRateLimits(join(codexDir, "sessions"));
  const services: PlanUsageService[] = [];
  const subscription = codexSubscriptionService(auth, rateLimits, now, liveRateLimits === null);
  if (subscription) services.push(subscription);
  if (env.OPENAI_API_KEY || auth?.hasApiKey) {
    services.push(openAiApiService(env.OPENAI_API_KEY ? "environment" : "host-auth"));
  }
  return services;
}

function codexSubscriptionService(
  auth: { hasOauth: boolean; hasApiKey: boolean; planType: string | null } | null,
  rateLimits: CodexRateLimits | null,
  now: () => number,
  liveQueryUnavailable: boolean,
): PlanUsageService | null {
  if (!auth?.hasOauth && !rateLimits) return null;
  const planType = rateLimits?.planType ?? auth?.planType ?? null;
  if (!rateLimits) {
    return {
      id: "codex-subscription",
      name: "Codex",
      plan: codexPlanName(planType),
      authMode: "subscription",
      status: "unavailable",
      source: "none",
      observedAt: null,
      windows: [],
      note: liveQueryUnavailable
        ? "The Codex App Server did not return current limits and no local fallback observation was found."
        : "Codex returned no current plan-limit windows.",
    };
  }

  const windows = [rateLimits.primary, rateLimits.secondary]
    .map((window) => mapCodexWindow(window, rateLimits.observedAt, now))
    .filter((window): window is PlanUsageWindow => window !== null);
  const observedMs = Date.parse(rateLimits.observedAt ?? "");
  if (windows.length === 0) {
    return {
      id: "codex-subscription",
      name: "Codex",
      plan: codexPlanName(planType),
      authMode: "subscription",
      status: "unavailable",
      source: rateLimits.source,
      observedAt: rateLimits.observedAt,
      windows: [],
      note: rateLimits.source === "codex-app-server"
        ? "The Codex App Server returned no usable limit windows."
        : "The latest Codex fallback observation contained no usable limit windows.",
    };
  }
  const observedNow = now();
  const stale = rateLimits.source === "codex-rollout"
    || !Number.isFinite(observedMs)
    || observedMs > observedNow + 60_000
    || observedNow - observedMs > CODEX_FRESH_MS;
  return {
    id: "codex-subscription",
    name: "Codex",
    plan: codexPlanName(planType),
    authMode: "subscription",
    status: stale ? "stale" : "live",
    source: rateLimits.source,
    observedAt: rateLimits.observedAt,
    windows,
    note: rateLimits.source === "codex-rollout"
      ? "The live Codex query was unavailable; these limits are a local rollout observation and may have changed."
      : stale
        ? "These Codex limits may have changed since they were queried."
        : null,
  };
}

function openAiApiService(source: "environment" | "host-auth"): PlanUsageService {
  return {
    id: "openai-api",
    name: "OpenAI API",
    plan: "Usage-based billing",
    authMode: "api_key",
    status: "not_applicable",
    source,
    observedAt: null,
    windows: [],
    note: "Subscription limit windows do not apply to OpenAI API-key billing.",
  };
}

function readCodexAuth(path: string): { hasOauth: boolean; hasApiKey: boolean; planType: string | null } | null {
  if (!existsSync(path)) return null;
  try {
    const auth = JSON.parse(readFileSync(path, "utf8"));
    const hasOauth = Boolean(auth.tokens);
    const hasApiKey = Boolean(auth.OPENAI_API_KEY);
    let planType: string | null = null;
    const token = auth.tokens?.access_token;
    if (typeof token === "string") try {
      const payload = token.split(".")[1];
      if (payload) {
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        planType = decoded?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null;
      }
    } catch {
      // A malformed cached token must not hide the otherwise observable auth mode.
    }
    return { hasOauth, hasApiKey, planType };
  } catch {
    return null;
  }
}

/**
 * Read current ChatGPT/Codex limits through the documented local Codex App
 * Server protocol. The child process owns credential access; this dashboard
 * only accepts the normalized rate-limit response and never reads or forwards
 * App Server account/auth payloads.
 */
export function queryCodexAppServerRateLimits(
  codexDir: string,
  env: NodeJS.ProcessEnv,
  now: () => number,
  timeoutMs = CODEX_APP_SERVER_TIMEOUT_MS,
): Promise<CodexRateLimits | null> {
  return new Promise((resolve) => {
    const codexBin = env.FORGE_CODEX_BIN || "codex";
    let settled = false;
    let initialized = false;
    let proc: ChildProcessWithoutNullStreams;

    const finish = (value: CodexRateLimits | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines?.close();
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        proc.stdin.end();
        proc.kill();
      }
      resolve(value);
    };

    let lines: ReturnType<typeof createInterface> | null = null;
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    try {
      proc = spawn(codexBin, ["app-server", "--stdio"], {
        env: codexAppServerEnvironment(env, codexDir),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }

    proc.stderr.resume();
    proc.on("error", () => finish(null));
    proc.on("exit", () => finish(null));
    lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => {
      if (Buffer.byteLength(line) > MAX_APP_SERVER_LINE_BYTES) {
        finish(null);
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const rpc = message as { id?: number; result?: unknown; error?: unknown };
      if (rpc.id === 1 && !rpc.error && !initialized) {
        initialized = true;
        writeAppServerMessage(proc, { method: "initialized", params: {} });
        writeAppServerMessage(proc, { method: "account/rateLimits/read", id: 2, params: {} });
        return;
      }
      if (rpc.id === 2) {
        finish(rpc.error ? null : parseCodexAppServerRateLimits(rpc.result, now));
      }
    });

    proc.once("spawn", () => {
      writeAppServerMessage(proc, {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "forge_dashboard",
            title: "Forge Dashboard",
            version: "0.1.0",
          },
        },
      });
    });
  });
}

function codexAppServerEnvironment(env: NodeJS.ProcessEnv, codexDir: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { CODEX_HOME: codexDir };
  for (const name of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]) {
    if (env[name] !== undefined) child[name] = env[name];
  }
  return child;
}

function writeAppServerMessage(proc: ChildProcessWithoutNullStreams, message: unknown): void {
  if (proc.stdin.destroyed || !proc.stdin.writable) return;
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function parseCodexAppServerRateLimits(result: unknown, now: () => number): CodexRateLimits | null {
  if (!result || typeof result !== "object") return null;
  const response = result as Record<string, unknown>;
  const buckets = response.rateLimitsByLimitId;
  let snapshot: unknown = response.rateLimits;
  if (buckets && typeof buckets === "object") {
    const byId = buckets as Record<string, unknown>;
    snapshot = byId.codex
      ?? Object.values(byId).find((candidate) => {
        return candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).limitId === "codex";
      })
      ?? snapshot;
  }
  if (!snapshot || typeof snapshot !== "object") return null;
  const limits = snapshot as Record<string, unknown>;
  return {
    planType: typeof limits.planType === "string" ? limits.planType : null,
    primary: parseAppServerWindow(limits.primary),
    secondary: parseAppServerWindow(limits.secondary),
    observedAt: new Date(now()).toISOString(),
    source: "codex-app-server",
  };
}

function parseAppServerWindow(value: unknown): CodexRateWindow | null {
  if (!value || typeof value !== "object") return null;
  const window = value as Record<string, unknown>;
  return {
    used_percent: typeof window.usedPercent === "number" ? window.usedPercent : undefined,
    window_minutes: typeof window.windowDurationMins === "number" ? window.windowDurationMins : undefined,
    resets_at: typeof window.resetsAt === "number" ? window.resetsAt : null,
  };
}

function readCodexRateLimits(sessionsDir: string): CodexRateLimits | null {
  if (!existsSync(sessionsDir)) return null;
  const rollouts: Array<{ path: string; mtime: number }> = [];
  let visitedEntries = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || visitedEntries >= MAX_SESSION_ENTRIES || rollouts.length >= MAX_ROLLOUT_CANDIDATES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch { return; }
    for (const entry of entries) {
      if (visitedEntries++ >= MAX_SESSION_ENTRIES || rollouts.length >= MAX_ROLLOUT_CANDIDATES) return;
      const path = join(dir, entry.name);
      try {
        if (entry.isDirectory()) walk(path, depth + 1);
        else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
          rollouts.push({ path, mtime: statSync(path).mtimeMs });
        }
      } catch {
        // A session can disappear while Codex rotates it; keep scanning.
      }
    }
  };
  walk(sessionsDir, 0);
  rollouts.sort((a, b) => b.mtime - a.mtime);

  for (const rollout of rollouts.slice(0, 5)) {
    const raw = readTail(rollout.path, MAX_ROLLOUT_BYTES);
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line?.includes('"rate_limits"')) continue;
      try {
        const event = JSON.parse(line);
        const limits = event?.payload?.rate_limits;
        if (!limits) continue;
        return {
          planType: typeof limits.plan_type === "string" ? limits.plan_type : null,
          primary: limits.primary ?? null,
          secondary: limits.secondary ?? null,
          observedAt: normalizeTimestamp(event.timestamp),
          source: "codex-rollout",
        };
      } catch {
        // Ignore a partial or malformed line and continue backwards.
      }
    }
  }
  return null;
}

function readTail(path: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function mapCodexWindow(
  window: CodexRateWindow | null,
  observedAt: string | null,
  now: () => number,
): PlanUsageWindow | null {
  if (!window
    || typeof window.used_percent !== "number"
    || !Number.isFinite(window.used_percent)
    || window.used_percent < 0
    || window.used_percent > 100
    || typeof window.window_minutes !== "number"
    || !Number.isFinite(window.window_minutes)
    || window.window_minutes <= 0) return null;
  const absoluteResetMs = typeof window.resets_at === "number" && Number.isFinite(window.resets_at)
    ? window.resets_at * 1000
    : null;
  const observedMs = Date.parse(observedAt ?? "");
  const relativeResetMs = typeof window.resets_in_seconds === "number"
    && Number.isFinite(window.resets_in_seconds)
    && window.resets_in_seconds >= 0
    && Number.isFinite(observedMs)
    ? observedMs + window.resets_in_seconds * 1000
    : null;
  const resetsAt = normalizeTimestamp(absoluteResetMs ?? relativeResetMs);
  const usedPct = Math.round(window.used_percent);
  return {
    label: codexWindowLabel(window.window_minutes),
    usedPct,
    resetsAt,
    ...windowPace(resetsAt, window.window_minutes * 60_000, usedPct, now()),
  };
}

function windowPace(
  resetsAt: string | null | undefined,
  windowMs: number,
  usedPct: number,
  now: number,
): { elapsedPct: number | null; pacePct: number | null } {
  if (!resetsAt || !(windowMs > 0)) return { elapsedPct: null, pacePct: null };
  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return { elapsedPct: null, pacePct: null };
  const elapsed = (now - (end - windowMs)) / windowMs;
  if (!(elapsed > 0.01 && elapsed <= 1)) return { elapsedPct: null, pacePct: null };
  return { elapsedPct: Math.round(elapsed * 100), pacePct: Math.round(usedPct / elapsed) };
}

function normalizePercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value);
}

function normalizeUtilization(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Math.round(value * 100);
}

function normalizeTimestamp(value: unknown): string | null {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function codexWindowLabel(minutes: number): string {
  if (minutes % 10080 === 0) return minutes === 10080 ? "Weekly" : `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return minutes === 1440 ? "Daily" : `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function claudePlanName(credential: Pick<ClaudeCredential, "subscriptionType" | "rateLimitTier">): string | null {
  const tier = credential.rateLimitTier?.toLowerCase().replace(/[\s_-]/g, "");
  const tierNames: Record<string, string> = {
    defaultclaudemax20x: "Claude Max (20x)",
    claudemax20x: "Claude Max (20x)",
    defaultclaudemax5x: "Claude Max (5x)",
    claudemax5x: "Claude Max (5x)",
  };
  if (tier && tierNames[tier]) return tierNames[tier];

  const raw = credential.subscriptionType;
  const value = raw?.toLowerCase().replace(/[\s_-]/g, "");
  if (!value) return null;
  if (value === "max20" || value === "max20x") return "Claude Max (20x)";
  if (value === "max5" || value === "max5x") return "Claude Max (5x)";
  if (value === "max") return "Claude Max";
  if (value.includes("pro")) return "Claude Pro";
  return `Claude (${raw})`;
}

function codexPlanName(raw: string | null): string | null {
  const value = raw?.toLowerCase().replace(/[\s_-]/g, "");
  const names: Record<string, string> = {
    free: "ChatGPT Free",
    go: "ChatGPT Go",
    plus: "ChatGPT Plus",
    prolite: "ChatGPT Pro (5×)",
    pro: "ChatGPT Pro (20×)",
    team: "ChatGPT Team",
    business: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise",
  };
  if (!value) return null;
  return names[value] ?? `ChatGPT (${raw})`;
}
