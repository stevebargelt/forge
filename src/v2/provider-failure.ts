// FG-228: provider-agnostic failure attribution.
//
// A failed agent run — non-zero exit with no result.json, or a clean exit that
// produced no usable result.json — collapses to a generic `container_crash` /
// `result_missing` today, even when the real cause (an invalid model, a quota or
// billing error, a provider 4xx) is sitting right there in the runtime's
// structured stdout. This module scans that stdout, keyed by the runtime's
// log_format (the same dispatch the usage parser uses — NEVER the upstream
// provider name), and attributes the failure: `modelError: true` plus a
// human-readable cause, which the caller maps to forge's `model_error`
// failure_kind. Best-effort: no signal → `modelError: false` and the caller
// keeps its default message.
//
// pi is handled by analyzePiFailure (#267, pi-result.ts). This adds codex
// (codex-jsonl `type:"error"` / `turn.failed`) and a conservative claude
// (claude-stream-json error / is_error result) analyzer behind one dispatcher.

import { analyzePiFailure } from "./pi-result.js";

const MAX_ERR = 200;

function truncate(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_ERR ? `${one.slice(0, MAX_ERR)}…` : one;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Attribution of a failed run. `modelError: true` ⇒ a provider/model error,
 *  with `error` set to the cause. `false` ⇒ no provider signal found; `error`
 *  may be set (pi always explains itself) or undefined (caller keeps its
 *  default container_crash / result_missing message).
 *  FG-337: `finalAssistantText` is set (pi only) on a clean completion so the
 *  caller can synthesize an inferred result for narrative roles. */
export type ProviderFailureAnalysis = { modelError: boolean; error?: string; finalAssistantText?: string };

function eachJsonl(stdoutRaw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdoutRaw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: unknown;
    try { ev = JSON.parse(t); } catch { continue; }
    if (isObj(ev)) out.push(ev);
  }
  return out;
}

/** codex `exec --json` failure signals: a top-level `{type:"error",message}` or
 *  a `{type:"turn.failed",error:{message}}`. The last one wins (closest to the
 *  exit, e.g. turn.failed after the underlying error). */
export function analyzeCodexFailure(stdoutRaw: string): ProviderFailureAnalysis {
  let cause: string | undefined;
  for (const ev of eachJsonl(stdoutRaw)) {
    const type = ev["type"];
    if (type === "error" && typeof ev["message"] === "string") {
      cause = ev["message"];
    } else if (type === "turn.failed") {
      const err = ev["error"];
      if (isObj(err) && typeof err["message"] === "string") cause = err["message"];
    }
  }
  return cause ? { modelError: true, error: `codex run failed: ${truncate(cause)}` } : { modelError: false };
}

/** claude-code `--output-format stream-json` failure signals (conservative,
 *  best-effort pending a captured real error sample): a `{type:"error",...}`
 *  event, or a terminal `{type:"result",is_error:true,...}` carrying a message.
 *  Only fires on a clear signal, so it never regresses the container_crash
 *  fallback. */
export function analyzeClaudeFailure(stdoutRaw: string): ProviderFailureAnalysis {
  let cause: string | undefined;
  const pick = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (isObj(v) && typeof v["message"] === "string") return v["message"];
    return undefined;
  };
  for (const ev of eachJsonl(stdoutRaw)) {
    const type = ev["type"];
    if (type === "error") {
      cause = pick(ev["message"]) ?? pick(ev["error"]) ?? cause;
    } else if (type === "result" && ev["is_error"] === true) {
      cause = pick(ev["error"]) ?? pick(ev["result"]) ?? cause;
    }
  }
  return cause ? { modelError: true, error: `claude run failed: ${truncate(cause)}` } : { modelError: false };
}

/** Dispatch by log_format (preferred) or runtime_kind, mirroring the usage
 *  parser's selection — never keyed on the upstream provider. Unknown format →
 *  no attribution (caller keeps its default). */
export function analyzeProviderFailure(opts: {
  logFormat?: string;
  runtimeKind?: string;
  stdoutRaw: string;
}): ProviderFailureAnalysis {
  switch (opts.logFormat ?? opts.runtimeKind) {
    case "pi-jsonl":
    case "pi":
      return analyzePiFailure(opts.stdoutRaw);
    case "codex-jsonl":
    case "codex":
      return analyzeCodexFailure(opts.stdoutRaw);
    case "claude-stream-json":
    case "claude":
    case "claude-code":
      return analyzeClaudeFailure(opts.stdoutRaw);
    default:
      return { modelError: false };
  }
}
