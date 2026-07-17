import { execFileSync } from "node:child_process";
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PlanUsageStatus = "live" | "stale" | "unavailable" | "not_applicable" | "not_configured" | "error";

export type PlanUsageWindow = {
  label: string;
  usedPct: number;
  resetsAt: string | null;
  elapsedPct: number | null;
  pacePct: number | null;
};

export type PlanUsageService = {
  id: "claude" | "codex" | "bedrock";
  name: string;
  plan: string | null;
  authMode: "oauth" | "subscription" | "api_key" | "bedrock" | "unknown";
  status: PlanUsageStatus;
  source: "anthropic-oauth-api" | "codex-rollout" | "environment" | "none";
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

type CodexRateLimits = {
  planType: string | null;
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
  observedAt: string | null;
};

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_SESSION_MS = 5 * 60 * 60 * 1000;
const CLAUDE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 30_000;
const CODEX_FRESH_MS = 10 * 60 * 1000;
const MAX_ROLLOUT_BYTES = 1024 * 1024;

let cached: { at: number; value: PlanUsageResponse } | null = null;
let inFlight: Promise<PlanUsageResponse> | null = null;

export async function getPlanUsage(forceRefresh = false): Promise<PlanUsageResponse> {
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = collectPlanUsage().then((value) => {
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

  const claude = env.CLAUDE_CODE_USE_BEDROCK === "1"
    ? bedrockService(env)
    : env.ANTHROPIC_API_KEY
      ? apiKeyService()
      : await collectClaudeUsage({
          env,
          homeDir,
          fetchImpl,
          now,
          credentialReader: options.readClaudeCredential,
          claudeVersion: options.claudeVersion,
        });

  const codex = collectCodexUsage(env.FORGE_CODEX_DIR ?? join(homeDir, ".codex"), now);
  return { generatedAt: new Date(now()).toISOString(), services: [claude, codex] };
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

function apiKeyService(): PlanUsageService {
  return {
    id: "claude",
    name: "Claude API",
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
}): Promise<PlanUsageService> {
  const credential = args.credentialReader
    ? args.credentialReader()
    : readClaudeCredential(args.env, args.homeDir);
  if (!credential) {
    return {
      id: "claude",
      name: "Claude Code",
      plan: null,
      authMode: "oauth",
      status: "unavailable",
      source: "none",
      observedAt: null,
      windows: [],
      note: "No host Claude OAuth credential was found.",
    };
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
      id: "claude",
      name: "Claude Code",
      plan: claudePlanName(credential.subscriptionType ?? credential.rateLimitTier),
      authMode: "oauth",
      status: "live",
      source: "anthropic-oauth-api",
      observedAt: new Date(args.now()).toISOString(),
      windows,
      note: windows.length === 0 ? "Anthropic returned no active plan windows." : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return claudeErrorService(credential, `Anthropic usage is currently unreachable: ${message}`);
  }
}

function claudeErrorService(credential: ClaudeCredential, note: string): PlanUsageService {
  return {
    id: "claude",
    name: "Claude Code",
    plan: claudePlanName(credential.subscriptionType ?? credential.rateLimitTier),
    authMode: "oauth",
    status: "error",
    source: "none",
    observedAt: null,
    windows: [],
    note,
  };
}

function mapClaudeWindows(payload: ClaudeUsagePayload, now: () => number): PlanUsageWindow[] {
  const limits = payload.limits ?? [];
  const windows: PlanUsageWindow[] = [];
  const session = limits.find((limit) => limit.kind === "session");
  const weekly = limits.find((limit) => limit.kind === "weekly_all");

  const pushWindow = (label: string, rawPct: number | null | undefined, resetsAt: string | null | undefined, windowMs: number) => {
    const usedPct = normalizePct(rawPct);
    if (usedPct === null) return;
    windows.push({ label, usedPct, resetsAt: resetsAt ?? null, ...windowPace(resetsAt, windowMs, usedPct, now()) });
  };

  pushWindow(
    "5-hour limit",
    session?.percent ?? payload.five_hour?.utilization,
    session?.resets_at ?? payload.five_hour?.resets_at,
    CLAUDE_SESSION_MS,
  );
  pushWindow(
    "Weekly · all models",
    weekly?.percent ?? payload.seven_day?.utilization,
    weekly?.resets_at ?? payload.seven_day?.resets_at,
    CLAUDE_WEEK_MS,
  );
  for (const scoped of limits.filter((limit) => limit.kind === "weekly_scoped")) {
    const model = scoped.scope?.model?.display_name ?? "scoped model";
    pushWindow(`Weekly · ${model}`, scoped.percent, scoped.resets_at, CLAUDE_WEEK_MS);
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

function collectCodexUsage(codexDir: string, now: () => number): PlanUsageService {
  const authPath = join(codexDir, "auth.json");
  const auth = readCodexAuth(authPath);
  const rateLimits = readCodexRateLimits(join(codexDir, "sessions"));
  if (!auth && !rateLimits) {
    return {
      id: "codex",
      name: "Codex",
      plan: null,
      authMode: "unknown",
      status: "unavailable",
      source: "none",
      observedAt: null,
      windows: [],
      note: "No host Codex subscription or rate-limit rollout was found.",
    };
  }

  const planType = rateLimits?.planType ?? auth?.planType ?? null;
  if (!rateLimits) {
    return {
      id: "codex",
      name: "Codex",
      plan: codexPlanName(planType),
      authMode: auth?.hasOauth ? "subscription" : auth?.hasApiKey ? "api_key" : "unknown",
      status: auth?.hasApiKey ? "not_applicable" : "unavailable",
      source: "none",
      observedAt: null,
      windows: [],
      note: auth?.hasApiKey
        ? "Subscription limit windows do not apply to OpenAI API-key billing."
        : "No Codex rollout with rate limits was found; run a host Codex turn to record them.",
    };
  }

  const windows = [rateLimits.primary, rateLimits.secondary]
    .map((window) => mapCodexWindow(window, now))
    .filter((window): window is PlanUsageWindow => window !== null);
  const observedMs = Date.parse(rateLimits.observedAt ?? "");
  const stale = !Number.isFinite(observedMs) || now() - observedMs > CODEX_FRESH_MS;
  return {
    id: "codex",
    name: "Codex",
    plan: codexPlanName(planType),
    authMode: auth?.hasApiKey && !auth.hasOauth ? "api_key" : "subscription",
    status: stale ? "stale" : "live",
    source: "codex-rollout",
    observedAt: rateLimits.observedAt,
    windows,
    note: stale ? "These limits are the latest host Codex observation and may have changed since then." : null,
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
    if (typeof token === "string") {
      const payload = token.split(".")[1];
      if (payload) {
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        planType = decoded?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null;
      }
    }
    return { hasOauth, hasApiKey, planType };
  } catch {
    return null;
  }
}

function readCodexRateLimits(sessionsDir: string): CodexRateLimits | null {
  if (!existsSync(sessionsDir)) return null;
  const rollouts: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path, depth + 1);
        else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) rollouts.push({ path, mtime: stat.mtimeMs });
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
          planType: limits.plan_type ?? null,
          primary: limits.primary ?? null,
          secondary: limits.secondary ?? null,
          observedAt: event.timestamp ?? null,
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

function mapCodexWindow(window: CodexRateWindow | null, now: () => number): PlanUsageWindow | null {
  if (!window || typeof window.used_percent !== "number" || typeof window.window_minutes !== "number") return null;
  const resetsAt = window.resets_at != null
    ? new Date(window.resets_at * 1000).toISOString()
    : window.resets_in_seconds != null
      ? new Date(now() + window.resets_in_seconds * 1000).toISOString()
      : null;
  const usedPct = clampPct(window.used_percent);
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

function normalizePct(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampPct(value <= 1 ? value * 100 : value);
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function codexWindowLabel(minutes: number): string {
  if (minutes % 10080 === 0) return minutes === 10080 ? "Weekly" : `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return minutes === 1440 ? "Daily" : `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function claudePlanName(raw: string | null | undefined): string | null {
  const value = raw?.toLowerCase().replace(/[\s_-]/g, "");
  if (!value) return null;
  if (value.includes("max20")) return "Claude Max 20x";
  if (value.includes("max5")) return "Claude Max 5x";
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
