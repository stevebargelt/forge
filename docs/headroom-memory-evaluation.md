# Headroom Cross-Agent Memory: Integration Evaluation

**Status:** Research / decision doc (FG-319)
**Phase:** FG-314 Phase 4 — cross-agent memory & learning

---

## 1. How headroom's cross-agent memory works

### `SharedContext` API (TypeScript)

The TypeScript `headroom-ai` package exports a `SharedContext` class that is the primary
cross-agent memory primitive. Examined source: `headroom-ai@0.22.4` (dist/index.js).

```typescript
const ctx = new SharedContext({ model: 'gpt-4o', ttl: 3600, maxEntries: 100 });
const entry = await ctx.put('research', bigAgentOutput, { agent: 'researcher' });
const summary = ctx.get('research');          // compressed
const full    = ctx.get('research', { full: true }); // original
```

**Storage format: in-memory `Map`, not SQLite or files.**

`SharedContext` holds all entries in a plain JavaScript `Map<string, entry>`. There is no
file write or database access. The class exposes `entries` as an instance property; once the
process exits the data is gone.

The entry object shape:
```
{ key, original, compressed, originalTokens, compressedTokens, agent, timestamp, transforms, savingsPercent }
```

**Eviction:** TTL-based (`ttl` seconds since last write, default 3600) plus LRU eviction
when `maxEntries` (default 100) is hit. Both are enforced eagerly on `put()` and lazily on
`get()`.

### Deduplication

There is no content-based deduplication in `SharedContext`. Keys are plain strings; writing
the same key twice overwrites the old entry. Agents must coordinate key names themselves to
share data.

### Scope: global vs per-project

**`SharedContext` is entirely global within a process.** It has no project-scope notion.
The workspace-dir functions (`workspaceDir()`, `memoryDbPath()`, `nativeMemoryDir()`) are
exported from the paths module and point to `~/.headroom/` (overridable via
`HEADROOM_WORKSPACE_DIR`), but `SharedContext` itself does **not** read or write those
paths — it is purely in-memory.

The `~/.headroom/` files (`memory.db`, `memories/`) appear to be proxy-side state written
by the headroom proxy process, not by the TypeScript library class.

### Cross-run persistence

None. `SharedContext` is per-process. A new process gets a fresh instance with no knowledge
of prior runs.

### Compression mechanism

`put()` calls `HeadroomClient.compress()` on the content before storing. `HeadroomClient`
talks to the headroom proxy over HTTP (`baseUrl`, default `http://localhost:8787`). If the
proxy is unreachable, it falls back to storing uncompressed. The stored `compressed` value
is what agents share; the `original` is retained in the same entry.

---

## 2. How this fits (or doesn't fit) with forge's design

### Forge's isolation model

| Forge property | Implication for SharedContext |
|---|---|
| Each task runs in its own ephemeral Docker container | A `SharedContext` instance inside a container lives only for that container's lifetime — no cross-run persistence |
| Task dirs are cleaned up after runs | Headroom's workspace files (`~/.headroom/`) are on the host or inside the container depending on mount — containers don't mount `~/.headroom` by default |
| SQLite on the host is the state blackboard | SharedContext is not SQLite; its data doesn't feed into forge's run/task model |
| Orchestrator runs on the host; agents run in containers | A `SharedContext` on the host and one inside a container are separate instances — no shared memory channel |

### The core mismatch

`SharedContext` is designed for **within-session, within-process sharing** — e.g. multiple
agents in a single Python/TypeScript process, or a multi-agent loop in one container. Forge
runs each agent as an isolated container; there is no shared process between them.

For SharedContext to span forge tasks, the orchestrator would have to:
1. Instantiate `SharedContext` on the host (in `invoke.ts` or similar),
2. Serialize its entries to files or SQLite after each agent completes,
3. Deserialize them before dispatching the next agent, and
4. Somehow inject the relevant entries into the next agent's prompt/context.

That is a significant amount of glue, and it replicates what forge's own SQLite already
provides: a persistent, cross-run, queryable store of agent outputs.

### Compression function depends on proxy

`SharedContext.put()` calls the headroom proxy to compress. In a container running with
`compression_mode: mcp` (the default), the proxy is **not** started. With
`compression_mode: proxy` it is. The fallback is graceful (stores uncompressed) but the
compression benefit is lost.

---

## 3. Integration options

### Option A: Use `SharedContext` as-is (global cross-agent store)

Start one `SharedContext` in the forge orchestrator process, write agent outputs to it after
each task, read relevant entries before dispatching the next agent, inject them into the task
prompt.

**Pros:**
- Compression is automatic — `put()` handles it
- Clean API — key/value access with TTL

**Cons:**
- No persistence across forge restarts (host process restart loses all context)
- No integration with forge's run model (entries aren't queryable from the dashboard or `forge show`)
- Context injection into prompts must be hand-coded per workflow
- Requires the headroom proxy running on the host (`compression_mode: proxy` or `mcp` at host level) for the compression benefit — not the current setup
- TTL default (1h) is too short for slow multi-day projects; arbitrary to extend

**Verdict:** Adds complexity for minimal gain. Forge already has this exact pattern (result.json → SQLite → next task prompt) without the in-memory volatility.

---

### Option B: Scope headroom memory per forge project

Same as Option A but key every `SharedContext` entry with the project path or run ID, and
serialize/restore to a per-project file (e.g. `<project>/.forge/shared-context.json`).

**Pros:**
- Persistence across restarts
- Project isolation built in

**Cons:**
- `SharedContext` has no built-in serialization — would have to implement dump/restore
- `.forge/` directory is already a config location; mixing agent memory there is awkward
- Still requires the proxy for compression; still not queryable from the dashboard
- Maintains a parallel state store alongside forge's SQLite — two sources of truth

**Verdict:** Too much glue code for something forge's own patterns already handle. The serialization gap alone means writing a custom persistence layer on top of SharedContext.

---

### Option C: Disable headroom memory, rely on forge's own state

Do nothing with `SharedContext`. Forge's orchestrator already passes prior task results into
subsequent agents' task descriptions (the `--task` text). The SQLite `result` column is the
cross-agent persistent store.

**Pros:**
- No new code
- Consistent with forge's existing design (SQLite blackboard, orchestrator composes context)
- No proxy dependency at the orchestrator level
- All state is queryable via `forge show`, dashboard, direct SQL

**Cons:**
- No automatic compression of intermediate results stored in SQLite
- Agent context grows unbounded in long multi-step runs if the orchestrator naively concatenates results

**Verdict:** The right default. The orchestrator already has compression for large outputs (FG-317 safety net). The orchestrator pattern (not SharedContext) is the right place to manage what context flows between agents.

---

### Option D: Hybrid — use SharedContext only for within-run intra-agent data

In a future scenario where forge runs multiple cooperating agents **within a single
container** (a "multi-agent step"), `SharedContext` would be the right primitive for
sharing compressed context between those co-resident agents. Today, each forge step is one
container, so there are no co-resident agents.

**Pros:**
- Architecturally sound for co-resident agents
- Compression benefit is real when the proxy runs in the same container

**Cons:**
- Forge doesn't have co-resident agents today
- Adds a new pattern that would need documentation and testing

**Verdict:** File for later. The right time to evaluate this is when/if forge adds multi-agent steps within a single container.

---

## 4. Recommendation

**Option C — do nothing with SharedContext now. Close FG-319 as "not needed at this phase."**

### Rationale

1. **`SharedContext` is in-memory and per-process.** It was designed for co-resident agents in a single process. Forge's architecture is the opposite: isolated containers, each its own process. Bridging this gap requires more glue code than the pattern is worth.

2. **Forge already has cross-run state.** SQLite holds every agent's `result.json` output. The orchestrator composes the next agent's task from prior results. This is the same pattern as `SharedContext`, minus the automatic compression and plus persistence, queryability, and auditability.

3. **The compression benefit doesn't require SharedContext.** Forge has three compression paths already (library compression in `invoke.ts`, MCP tool in-container, proxy sidecar). None of them need SharedContext — they compress content in-transit, not in cross-agent shared memory.

4. **`memory.db` / `nativeMemoryDir` are proxy-side, not library-side.** The paths module exports them but `SharedContext` doesn't use them. If headroom proxy writes persistent memory, that's proxy state — not something the TypeScript library controls or that forge needs to manage.

5. **No parity with Python.** The BACKLOG question about TypeScript/Python parity is relevant: the README says "Requires a running Headroom proxy" for `SharedContext.put()` compression. If the Python SDK has richer in-process memory (headroom docs reference a `SharedContext` Python API), the TypeScript version at 0.22.4 is the simpler in-memory map.

---

## 5. If integration is revisited

If a future ticket re-examines cross-agent memory (e.g. for a multi-step run where passing
full result.json would exceed context), the minimal viable approach would be:

1. **Store compressed summaries in SQLite, not in headroom.** Add a `compressed_summary`
   column to the `tasks` table. After each task, if `result.json` > threshold, run the
   orchestrator-side compressor (already in `compression.ts`) and store the summary.

2. **Orchestrator reads summaries, not raw results.** When composing subsequent tasks,
   prefer `compressed_summary` over full result when it exists.

3. **Skip SharedContext entirely.** All cross-run state stays in SQLite, which is already
   the canonical blackboard.

This approach reuses the existing compressor, extends the existing schema, and needs no
proxy dependency at the orchestrator level.

---

## 6. Open questions answered

| Question | Answer |
|---|---|
| Does headroom store context across runs? | No. `SharedContext` is in-memory per-process. Proxy state in `~/.headroom/memory.db` is proxy-managed, not library-managed. |
| Storage format? | In-memory JavaScript `Map` (not SQLite, not files) for `SharedContext`. Proxy writes to `~/.headroom/` SQLite/JSON files independently. |
| How does deduplication work? | Key-based overwrite only — no content deduplication in SharedContext. |
| Per-project or global? | Global (no project scope). The workspace env var is respected by paths but not by SharedContext's storage. |
| Does it conflict with forge's design? | Yes — process-scoped in-memory store conflicts with forge's container-isolated, SQLite-backed architecture. |
| TypeScript/Python parity? | TypeScript 0.22.4 is functional but lightweight; SharedContext is a thin in-memory layer with a proxy dependency for compression. |
