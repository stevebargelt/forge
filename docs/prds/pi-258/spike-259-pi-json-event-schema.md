# Spike #259 — pi `--mode json` event schema + usage-field mapping

**Status:** schema discovered from pi's published TypeScript types (authoritative).
**Live capture:** DONE in #262 — a real pi 0.74.2 `--mode json` stream (non-zero
usage) was captured via a streaming mock endpoint and committed as the parser
fixture (`src/store/__fixtures__/pi-usage-stream.jsonl`). One correction to the
mapping below: pi's `usage.input` is FRESH (cache excluded; `totalTokens = input +
output + cacheRead + cacheWrite`), so it maps directly to `input_tokens` with NO
subtraction (unlike codex's total `input_tokens`).
**Feeds:** #262 (pi usage-parser hook), #261 (runtime invocation), #267 (error classification).

## How this was discovered

Installed `@earendil-works/pi-coding-agent` in a throwaway `node:20` container and
read the shipped `.d.ts` types. This is more reliable than reverse-engineering a
single live run (which only shows one provider's values). Sources:
- `@earendil-works/pi-ai/dist/types.d.ts` — `Usage`, `AssistantMessage`
- `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — the event union

## Event stream (JSONL, one event per line)

A `session` header first, then lifecycle events. The `ExtensionEvent` union:
`agent_start`/`agent_end`, `turn_start`/`turn_end`,
`message_start`/`message_update`/`message_end`,
`tool_execution_start`/`update`/`end`, plus session/context/model-select/etc.

**Completion signal:** `agent_end` — `{ type: "agent_end", messages: AgentMessage[] }`.

## Where usage / model / stop-reason live

They are fields on each `AssistantMessage` (not a separate usage event):

```ts
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;        // provider actually used
  model: string;             // model actually used
  responseModel?: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

interface Usage {
  input: number;             // input tokens
  output: number;            // output tokens
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

Carried in:
- `turn_end.message` — the turn's AssistantMessage
- `agent_end.messages[]` — every message of the run

## Parser mapping (for #262)

| forge usage field   | pi source |
|---------------------|-----------|
| input_tokens        | Σ `agent_end.messages[assistant].usage.input` |
| output_tokens       | Σ `…usage.output` |
| total_tokens        | Σ `…usage.totalTokens` |
| cache_read / write  | Σ `…usage.cacheRead` / `cacheWrite` |
| cost_usd            | Σ `…usage.cost.total` — **pi pre-computes cost; no forge price table needed for pi runs** |
| model / provider    | `messages[].model` + `messages[].provider` (per message — supports mid-run switches) |
| stop_reason         | last assistant `messages[].stopReason` |
| completion signal   | the `agent_end` event |

Notes:
- Each assistant message has its OWN model/provider/usage → sum across messages
  for a run total; do not assume a single model.
- Errors: `AssistantMessage.errorMessage` + `auto_retry_*` events → maps to #267
  (model_error classification).

## Illustrative sample (schema-derived — replace with a live capture in #262)

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"<iso>","cwd":"/project"}
{"type":"agent_start"}
{"type":"turn_start","turnIndex":0}
{"type":"message_start"}
{"type":"message_end"}
{"type":"turn_end","turnIndex":0,"message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-6","usage":{"input":1234,"output":56,"cacheRead":0,"cacheWrite":0,"totalTokens":1290,"cost":{"input":0.0037,"output":0.0008,"cacheRead":0,"cacheWrite":0,"total":0.0045}},"stopReason":"stop","timestamp":0},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-6","usage":{"input":1234,"output":56,"cacheRead":0,"cacheWrite":0,"totalTokens":1290,"cost":{"input":0.0037,"output":0.0008,"cacheRead":0,"cacheWrite":0,"total":0.0045}},"stopReason":"stop","timestamp":0}]}
```

## Open

- **Live capture** — DONE in #262 (see the header). No provider credential was
  needed in the end: pi was pointed at a local streaming-mock endpoint (Anthropic
  SSE) via a custom `models.json` provider, which produced a real non-zero
  `--mode json` stream committed as `src/store/__fixtures__/pi-usage-stream.jsonl`.
  A genuine credentialed end-to-end run is the separate #296 Crawl exit.
- **StopReason enum values** — still not exhaustively enumerated; the fixture shows
  `"stop"`. Capture the full set from a real credentialed run (#296) if needed.
