// #264: deterministic mapping of pi's `--mode json` output to forge's result /
// completion contract.
//
// THE SUCCESS PATH IS UNCHANGED FROM EVERY OTHER RUNTIME: the agent honors the
// task package's output contract and writes /task/result.json; forge reads it and
// the task completes (parity with claude/codex). This module handles only the
// FAILURE side: pi streams JSONL to stdout and exits 0 even on a provider error,
// so a pi run that produced no usable result.json otherwise lands in forge's
// generic `no_result_json` branch — ambiguous (auth error? crash? agent ignored
// the contract?). Here we ATTRIBUTE that case from pi's structured stdout so the
// failure is loud and explains itself.
//
// Scope: completion/error attribution ONLY. Parsing pi's token usage from the
// same JSONL is #262 (the pi-jsonl usage parser) and is deliberately not done
// here — this never touches model_calls.

const MAX_ERR = 200;

function truncate(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_ERR ? `${one.slice(0, MAX_ERR)}…` : one;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Given pi's stdout (read when no usable /task/result.json was produced), return
 *  a loud, attributable failure reason — never the bare "no_result_json". The
 *  three distinguishable causes, in priority order:
 *   1. pi surfaced a provider/model error  → "pi run failed: <errorMessage>"
 *   2. no `agent_end` terminal event       → truncated / crashed mid-run
 *   3. clean completion but no result.json → the agent ignored the contract */
export function attributePiNoResult(stdoutRaw: string): string {
  const lines = stdoutRaw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "pi produced no output (no JSONL on stdout)";

  let sawAgentEnd = false;
  let lastError: string | undefined;

  const noteAssistant = (m: unknown): void => {
    if (isObj(m) && m["role"] === "assistant" && typeof m["errorMessage"] === "string") {
      lastError = m["errorMessage"];
    }
  };

  for (const line of lines) {
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isObj(ev)) continue;
    const type = ev["type"];
    if (type === "agent_end") {
      sawAgentEnd = true;
      const msgs = ev["messages"];
      if (Array.isArray(msgs)) for (const m of msgs) noteAssistant(m);
    } else if (type === "turn_end" || type === "message_end") {
      noteAssistant(ev["message"]);
    }
  }

  if (lastError) return `pi run failed: ${truncate(lastError)}`;
  if (!sawAgentEnd) {
    return "pi produced no completion event (agent_end) — output truncated or the container crashed mid-run";
  }
  return "pi completed but wrote no /task/result.json (the agent did not honor the output contract)";
}
