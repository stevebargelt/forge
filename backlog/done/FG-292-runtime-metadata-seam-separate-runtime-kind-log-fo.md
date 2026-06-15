---
id: FG-292
type: story
status: done
title: "Runtime metadata seam: separate runtime kind, log format, prompt strategy, auth strategy"
---

**Closed:** 2026-06-05.

**Phase:** Crawl foundation. Part of #258 and #291.

**Why:** The Pi PRD's architectural correction cannot wait until after Pi is wired. Today Forge still leans on provider/profile names to infer execution behavior: model policy resolves `provider + auth -> runtime`, usage parsing is selected by provider in the runner path, and runtime YAML does not explicitly declare the log format, prompt injection strategy, or auth wiring strategy. If #260/#261 add Pi before this seam exists, Forge will be tempted to encode "provider = pi" or add another one-off branch, which is exactly the confusion the PRD rejects.

**Scope:**
- Extend the runtime YAML schema/loader with explicit metadata:
  - `runtime_kind`: `claude-code | codex | pi` (or equivalent open string if the implementation strongly prefers it).
  - `log_format`: `claude-stream-json | codex-jsonl | pi-jsonl`.
  - `prompt_strategy`: e.g. `claude-stdin-package | stdin-prepend | runtime-context-file`.
  - `auth_strategy`: e.g. `oauth-volume | codex-auth | env-provider-api-key | pi-auth-json | local-endpoint`.
- Backfill existing Claude/Codex runtime seeds with metadata, preserving current behavior.
- Thread the resolved runtime metadata into spawn/run task execution and task/run diagnostics so later code can choose parsers and prompt/auth behavior from runtime metadata instead of upstream provider names.
- Convert comments/diagnostic wording in the execution path from "provider selects parser/runtime behavior" to "runtime/log_format selects parser/runtime behavior; upstream provider/model are model-selection facts."
- Keep behavior unchanged for existing Claude Code and Codex runs.

**Acceptance:**
- Existing Claude Code and Codex runtime seeds validate with the new metadata and still resolve to the same command/auth behavior.
- A unit test proves usage-parser selection can be made from `log_format` independent of upstream provider.
- A unit test or resolver fixture proves a Pi-shaped runtime can declare `runtime_kind: pi`, `log_format: pi-jsonl`, `prompt_strategy: stdin-prepend`, and `auth_strategy: env-provider-api-key` without requiring a Pi binary yet.
- Task/run diagnostic output exposes both runtime metadata and upstream provider/model distinctly enough for `forge show --json` or equivalent orchestrator-facing JSON to tell them apart.
- No Pi Docker/image install is required in this story; #260 owns the binary.

**Relations:** #258, #260, #261, #262, #263, #265, #253, `docs/prds/provider-agnostic-runtime-pi.md`.