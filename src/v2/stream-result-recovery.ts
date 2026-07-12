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
 *  `exec --json` JSONL stream.
 *
 *  Intactness rule (operator-decided, FG-540 final pass): codex event records
 *  are JSON OBJECTS, so only a `{`-prefixed line can be a record. A line that
 *  does not begin with `{` is wrapper/log noise — tolerated and skipped
 *  wherever it appears, so ordinary warning text never makes recovery silently
 *  inert. A line that DOES begin with `{` but cannot be parsed as a JSON
 *  object is a truncated/corrupt RECORD; one corrupt record makes the whole
 *  stream untrustworthy, so recovery refuses outright REGARDLESS of position —
 *  a corrupt terminal record can therefore never silently promote an earlier
 *  intermediate agent_message to the result.
 *  Returns undefined (no recovery) unless ALL of:
 *  - no top-level `{type:"error"}` and no `{type:"turn.failed"}` anywhere;
 *  - at least one `{type:"turn.completed"}`, and the turn markers strictly
 *    alternate `turn.started` → `turn.completed` (overlapping turns, a
 *    completion with no start, or a trailing turn that began but never
 *    completed all make the stream ambiguous);
 *  - the final completed turn has its own `turn.started`, and the LAST
 *    completed agent_message in the stream falls strictly INSIDE that
 *    started→completed envelope — a message from an earlier turn, one stranded
 *    BETWEEN turns, or one completing after the turn ended all refuse;
 *  - that terminal message's text parses as a JSON OBJECT (arrays, primitives,
 *    prose, and malformed JSON all refuse).
 *  Deterministic selection: the last completed agent_message of the final
 *  completed turn wins; earlier progress/narration messages can never outrank it. */
export function extractCodexTerminalJsonObject(stdoutRaw: string): Record<string, unknown> | undefined {
  const events: Record<string, unknown>[] = [];
  for (const line of stdoutRaw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith("{")) continue; // wrapper/noise line — cannot be a codex event object
    let ev: unknown;
    try { ev = JSON.parse(t); } catch { return undefined; } // corrupt record — refuse the stream
    if (!isObj(ev)) return undefined; // `{`-prefixed yet not an object — not a trustworthy record
    events.push(ev);
  }

  // Turn markers must strictly alternate started → completed. A second
  // turn.started while a turn is still open, or a turn.completed with no open
  // turn, means the stream's turns overlap or are incomplete — the envelope we
  // would scope recovery to is then not a real turn boundary, so refuse.
  let openTurnStarted = -1;
  let finalTurnStarted = -1;
  let lastTurnCompleted = -1;
  let lastAgentMessage = -1;
  let terminalText: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const type = ev["type"];
    if (type === "error" || type === "turn.failed") return undefined;
    if (type === "turn.started") {
      if (openTurnStarted !== -1) return undefined;           // overlapping turns
      openTurnStarted = i;
    }
    if (type === "turn.completed") {
      if (openTurnStarted === -1) return undefined;           // completion with no envelope
      finalTurnStarted = openTurnStarted;
      openTurnStarted = -1;
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

  if (openTurnStarted !== -1) return undefined;               // trailing turn began but never completed
  if (lastTurnCompleted === -1) return undefined;             // never completed
  if (lastAgentMessage === -1 || terminalText === undefined) return undefined; // no candidate
  if (lastAgentMessage > lastTurnCompleted) return undefined; // ambiguous post-turn message
  if (lastAgentMessage < finalTurnStarted) return undefined;  // earlier turn or stranded between turns

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
