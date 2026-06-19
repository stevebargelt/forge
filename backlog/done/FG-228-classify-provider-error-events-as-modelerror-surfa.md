---
id: FG-228
type: story
status: done
title: Classify provider error events as model_error + surface the cause (not generic container_crash)
closed: 2026-06-19
---

Observed during AWN-7 Walk W4 (Codex failure-path validation). A Codex run with an invalid model exits 1 with no result.json, so classify() returns container_crash — correct (it IS in the taxonomy, #220 acceptance met), but lossy. The actual cause is right there in the stdout JSONL:

  {"type":"error","message":"...status 400 ... The 'X' model is not supported when using Codex with a ChatGPT account."}
  {"type":"turn.failed","error":{"message":"..."}}

forge flattens this to `container_crash (exit 1)`; the precise reason is dropped. There's already a `model_error` FailureKind in the enum (failure-kind.ts) that fits, currently only settable via explicit ctx.source.

This is PROVIDER-AGNOSTIC, not codex-specific: claude model/quota errors also collapse to container_crash/result_missing today.

Proposal:
- On a failed task, scan the result/output stream for a provider error signal (codex: type:"error"/"turn.failed"; claude: stream error events) and pass source:"model_error" to classify, plus carry the human-readable message into the task.failed error.
- Keep it best-effort + provider-keyed (reuse the same provider dispatch as the usage parser); fall back to container_crash when no signal is found.

Ties to #200 (forge show should extract text from stream-json blobs rather than dump them) — same "surface the meaning, not the raw stream" theme. Small, isolated, improves failure diagnostics for all providers.