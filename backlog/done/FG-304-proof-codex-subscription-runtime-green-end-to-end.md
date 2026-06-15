---
id: FG-304
type: story
status: done
title: "proof: codex-subscription runtime green end-to-end on this host"
---

**Closed:** 2026-06-07.

**Type:** Proof / verification (no code change). Part of #258 multi-runtime work; relates to #229.
**Date:** 2026-06-06. **Run:** run-invoke-engineer-9840d7 (task-engineer-02efa6).

Live smoke of the `codex-subscription` runtime on this host. Read-only image
checks first, then one live ChatGPT-subscription invoke against a throwaway
read-only temp project (the forge repo was never mounted).

**Result — green end-to-end:**
- Image `agent-dev-worker:latest` (built 2026-06-06) ships `codex-cli 0.135.0`; `codex --version` runs as uid=1000(agent). Matches the Dockerfile pin (CODEX_CLI_VERSION=0.135.0) and the seed's "verified against 0.135.0" note.
- Auth: `auth.mode: codex-auth` RO-mounts host `~/.codex/auth.json` (0600) → entrypoint copies to a writable CODEX_HOME → token accepted, no host write-back.
- Execution: `codex exec --json` ran (`gpt-5.5`), exit 0.
- result.json contract honored → status complete, output "Codex ran successfully."
- Usage captured by the `codex-jsonl` parser: 1 req · 9.8K in · 770 out · 59.8K cache-read · 86% hit (proves usage dispatch keys off log_format, not provider name).
- No repo mutation: `--read-only` + throwaway temp `--project`; files_modified=[]. result.json landed in the task dir under ~/.forge/runs/, outside the repo.

**#229 is NOT blocking on this host** — Codex is built into the live image and works; the gap #229 tracks does not apply here.

**Note:** the smoke was a bare `forge invoke --runtime codex-subscription` (a deliberately unrouted smoke, not routed implementation work), so it printed the expected #287/#297 "dispatching WITHOUT a resolved route" warning — harmless here; `--unrouted` would have acknowledged it.