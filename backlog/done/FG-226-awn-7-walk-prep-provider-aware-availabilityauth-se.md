---
id: FG-226
type: story
status: done
title: "AWN-7 Walk-prep: provider-aware availability/auth seam (no Codex yet)"
---

**Closed:** 2026-06-01. Commit `579f895`.

First prep slice for AWN-7 Walk (#224). Closes the provider-blind availability seam BEFORE a second provider exists, so adding Codex is a localized extension, not a mid-Walk signature retrofit. No behavior change today — only `anthropic` resolves (unknown providers fail loud at `bindRuntime`).

Seam (shipped code):
- `probeAuth(mode)` (src/v2/provider-doctor.ts) checks ANTHROPIC_API_KEY for ANY `api` auth, AWS for bedrock, OAuth hint for subscription — provider is never consulted. An `openai/api` profile would wrongly probe ANTHROPIC_API_KEY.
- `checkResolvedAvailability(res)` calls `probeAuth(res.auth)` — drops `res.provider`.
- `doctorReport()` hard-lists the three anthropic modes.

Scope:
- Thread `provider` through: `probeAuth(provider, mode)`; `checkResolvedAvailability` passes `res.provider`; `doctorReport` iterates known providers (today: just anthropic).
- Unknown provider → `status: "unknown"` with a clear detail (defensive; unreachable until Walk adds the runtime+binding).
- Anthropic logic byte-identical. Update the two callers in src/cli/commands (model.ts `--check`, providers.ts doctor).

Acceptance:
- All existing provider-doctor / model-resolution tests pass unchanged.
- New test: an `openai/api` resolution does NOT report available off ANTHROPIC_API_KEY (proves provider is honored).
- `forge providers doctor` output unchanged for an anthropic-only environment.

Deferred to Walk proper (#224): detectAuthMode provider-awareness, RUNTIME_BINDING openai row + codex-*.yml runtimes, the captureUsageForTask per-provider hook, failure_kind review.