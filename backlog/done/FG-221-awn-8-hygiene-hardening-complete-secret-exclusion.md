---
id: FG-221
type: story
status: done
title: "AWN-8 hygiene-hardening: complete secret exclusion across bundles/logs/manifests/exports + staged-auth cleanup"
---

**Closed:** 2026-05-30. Commit `48eedf6`.

docs/agentic-workflow-next-steps.md §8. Useful debug artifacts that never preserve secrets/prompts/auth state.

PARTLY DONE this week: forge bundle uses an allowlist (never denylist); bundle.json strips composedSystemPrompt + inputs unless --include-prompts; manifest auth block is booleans-only; logs bounded. AWN-8 = the remainder.

Remaining scope:
- Explicit denylist for .env, auth state, browser profiles, prompt inputs, token-looking values, generated credential copies — across task packages, bundles, manifests, logs, dashboard payloads, AND exports (forge export jsonl/otel payloads).
- Stage-auth cleanup: remove auth-state.json after terminal task state where practical (ties to AWN-3's "no reuse of staged credentials").
- Document redaction behavior; surface it in forge show / bundle metadata.

Acceptance:
- forge bundle tests prove auth state, .env, and prompt inputs excluded by default. (composedSystemPrompt/inputs test already landed.)
- Staged auth files removed/marked for cleanup after terminal task.
- Manifest fields useful but never credential material.
- Redaction documented + visible in forge show or bundle metadata.

Smallest remaining item (allowlist + bundle work already done). Relates to #190 (auth-profile findings). Last of the broadening trio.