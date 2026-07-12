// FG-540: provider-adapter structured-result recovery.
//
// A codex `exec --json` run can complete its turn cleanly — terminal
// agent_message carrying the exact JSON result object — and still never write
// /task/result.json (intermittent adapter/contract behavior; incident
// run-review-loop-fg-536-eaa5be / task-red-wide-0dc174). That loses a
// schema-valid result that is durably present in the captured JSONL stream.
//
// This module is the ONE extraction rule shared by every missing-result
// consumer (invoke.ts, runNext.ts, reconcile.ts) so watcher loss cannot change
// the result contract. It recovers the exact structured object — it is NOT the
// FG-337 narrative inference (inferred-result.ts), which remains
// narrative-roles-only. Fail-closed by design: anything short of an
// unambiguous, cleanly-completed terminal JSON object recovers nothing, and
// the caller keeps its existing failure classification.
//
// The recovered object is handed back for the caller's NORMAL result path —
// persistence checks, role/schema validation, events, retention — exactly as
// if it had been read from result.json. Recovery never invents a verdict and
// never bypasses a downstream validator.

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract the terminal completed agent_message JSON object from a codex
 *  `exec --json` JSONL stream. Returns undefined (no recovery) unless ALL of:
 *  - every non-empty line parses as a JSON object (one malformed/truncated
 *    record means the stream is not intact, so nothing is recoverable from it);
 *  - no top-level `{type:"error"}` and no `{type:"turn.failed"}` anywhere;
 *  - at least one `{type:"turn.completed"}`;
 *  - at least one completed agent_message, and the LAST one falls INSIDE the
 *    final completed turn — after the preceding `turn.completed` and before the
 *    last one (a message from an earlier turn, or one completing after the turn
 *    ended, is ambiguous);
 *  - that terminal message's text parses as a JSON OBJECT (arrays, primitives,
 *    prose, and malformed JSON all refuse).
 *  Deterministic selection: the last completed agent_message of the final
 *  completed turn wins; earlier progress/narration messages can never outrank it. */
export function extractCodexTerminalJsonObject(stdoutRaw: string): Record<string, unknown> | undefined {
  const events: Record<string, unknown>[] = [];
  for (const line of stdoutRaw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: unknown;
    try { ev = JSON.parse(t); } catch { return undefined; }
    if (!isObj(ev)) return undefined;
    events.push(ev);
  }

  let lastTurnCompleted = -1;
  let prevTurnCompleted = -1;
  let lastAgentMessage = -1;
  let terminalText: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const type = ev["type"];
    if (type === "error" || type === "turn.failed") return undefined;
    if (type === "turn.completed") {
      prevTurnCompleted = lastTurnCompleted;
      lastTurnCompleted = i;
    }
    if (type === "item.completed") {
      const item = ev["item"];
      if (isObj(item) && item["type"] === "agent_message" && typeof item["text"] === "string") {
        lastAgentMessage = i;
        terminalText = item["text"];
      }
    }
  }

  if (lastTurnCompleted === -1) return undefined;             // never completed
  if (lastAgentMessage === -1 || terminalText === undefined) return undefined; // no candidate
  if (lastAgentMessage > lastTurnCompleted) return undefined; // ambiguous post-turn message
  if (lastAgentMessage < prevTurnCompleted) return undefined; // belongs to an earlier turn

  let parsed: unknown;
  try { parsed = JSON.parse(terminalText); } catch { return undefined; }
  return isObj(parsed) ? parsed : undefined;
}

/** Dispatch by log_format (preferred) or runtime_kind, mirroring
 *  analyzeProviderFailure's selection — never keyed on the upstream provider
 *  name. Only codex-jsonl has a structured recovery today; every other format
 *  recovers nothing (fail closed). */
export function recoverStructuredStreamResult(opts: {
  logFormat?: string;
  runtimeKind?: string;
  stdoutRaw: string;
}): Record<string, unknown> | undefined {
  switch (opts.logFormat ?? opts.runtimeKind) {
    case "codex-jsonl":
    case "codex":
      return extractCodexTerminalJsonObject(opts.stdoutRaw);
    default:
      return undefined;
  }
}
