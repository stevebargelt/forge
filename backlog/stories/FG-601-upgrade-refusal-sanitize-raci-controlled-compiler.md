---
id: FG-601
type: story
status: active
title: "upgrade refusal: sanitize RACI-controlled compiler error before writing to operator terminal (escape-sequence hardening)"
created: 2026-07-22
---

Source: FG-581 build red-build-3038ae (low, fail-safe).

`src/cli/commands/upgrade.ts` threads `res.error` (the compiler's verbatim message, which embeds the unvalidated `accountable` field from `src/raci/parse.ts:111`) directly into `warn()` on the post-promotion compile-failure path. A crafted RACI could embed terminal escape sequences that render in the operator terminal.

Threat model is weak (the RACI is operator-authored — self-inflicted) so this is fail-safe hardening, not a trust-gate wrong-ship. Deferred from FG-581 as a follow-up per the review-disposition policy. Fix: strip/escape control characters from any RACI-sourced string before terminal rendering (human + repair surfaces); the --json field can stay verbatim.

Parent: FG-572 · Epic: FG-561 (sibling hardening to FG-581).