---
id: FG-173
type: story
status: done
title: "v2 has no idle-watchdog — hung agents run forever (re-files #74)"
closed: 2026-06-19
---

**v2-shaped re-file of #74**, which closed 2026-05-26 with "Re-file a fresh v2-shaped ticket if/when it bites." It bit on 2026-05-29.

**What happened:** `task-task-718ad0` (frontend-specialist, web-admin redesign screens, wnba-led-scoreboard workspace) hung for ~1 hour. The agent stalled during its initial file-reading research — last logged action was a `Glob` at `00:10:26`, 16s after start — then emitted *zero stdout for the next hour*. The agent process (`claude --model claude-sonnet-4-6`, PID 1) was alive the whole time at ~0.1% CPU: blocked waiting on a model stream response that never arrived. The container stayed `Up`, the DB task stayed `running`, and `result.json` was 0 bytes. Nothing killed it — the human noticed and stopped it manually.

**Root cause:** the #26 idle-stdout watchdog (kill container after N min of no stdout, `FORGE_AGENT_IDLE_TIMEOUT_MS`) was lost in the v1→v2 cutover and never re-added. `src/v2/DECISIONS.md` Decision 9 documented the gap verbatim: *"no idle-watchdog yet … The runner's exec stub doesn't implement it."* So v2 had *no liveness protection at all* for a hung-but-alive agent.

**Distinct from #74's original shape (matters for the fix):**
- #74 original: container *dead*, status stuck `running` → a reconcile gap (sniff dead containers, persist `container_id`).
- This incident: container *alive*, agent *hung*, stdout frozen → the idle-stdout watchdog case (#26), which v2 dropped. Detection rides the live stdout `data` events the host already receives — disk-write timing never gated it.

**Tier 0 + Tier 1 — SHIPPED (this session):** `src/v2/idle-watchdog.ts` (`startIdleWatchdog` measures the *gap between* stdout chunks, not total runtime, so a busy long task that streams steadily never trips; disabled when `idleMs <= 0`). Wired into a *single shared* `src/v2/docker-exec.ts` used by BOTH the invoke path (invoke.ts) and the pipeline path (runNext.ts) — they had diverged into two buffered executors, leaving `forge new`/`forge next` tasks unwatched; consolidating closed that gap. Each chunk both streams to disk live (observability + bounded memory; replaces buffer-until-close) and bumps the watchdog. On silence it runs `docker kill <name>` on the container itself (SIGKILLing only the docker CLI client leaves the container orphaned under the daemon; the client kill is just a backstop), then the task fails with `idle_timeout` via a `124` sentinel exit code. Timeout precedence: `FORGE_AGENT_IDLE_TIMEOUT_MS` env override > runtime YAML `container.idle_timeout_seconds` (seeds set 600s — this field existed in the schema but was orphaned/unread until now; bumped 300→600 this session for margin) > 15-min hardcoded fallback. So effective production timeout is **10 min** (from the seeds); revisit if a legit quiet tool call (big test suite / build) ever exceeds it. Host-side `forge design` is exempt by construction (no container, never enters this path). Tests: watchdog units + env/runtime precedence matrix, `containerNameFromArgs`/`killContainer` units, plus idle_timeout integration tests through both `invoke()` and `runNext()`.

**Tier 2 — REMAINING (separate, schema-gated):** dead-container detection for the parent-died orphan (the in-process timer dies with its parent). Persist `tasks.container_id` at spawn; a sweep marks `running` tasks `failed` when `docker inspect` shows the container gone. No `container_id` column exists today. Schema change → machine-wide blast radius, flag per shared-DB-migration rule.

**Possible refinement (only if 15 min feels slow):** tail the stream shape — a pending `tool_use` means the agent is inside a long tool (lenient); a `tool_result`/turn-end with nothing after is the awaiting-model hung signature (strict), letting the timeout drop to ~3–5 min safely.

**Diagnostic playbook:** `forge show` "running" and `docker ps` "Up" both mean *spawned*, not *progressing*. True liveness = `docker logs <c>` last-timestamp vs wall clock. Agent PID alive at ~0% CPU + frozen logs = blocked on I/O (usually a hung model stream). 0-byte `result.json` + age ≫ expected confirms.