# Decision: Use cross-region inference profile IDs for Claude 4.x on Bedrock

**ID**: FORGE-DEC-008
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Steven (forge build, hit during first Bedrock spawn)
**Supersedes**: N/A
**Scope**: forge

---

## Context

Claude 4.x models on AWS Bedrock cannot be invoked with the bare model ID (e.g. `anthropic.claude-haiku-4-5-20251001-v1:0`). Bedrock returns:

```
400 Invocation of model ID ... with on-demand throughput isn't supported.
Retry your request with the ID or ARN of an inference profile that contains this model.
```

This is because Claude 4.x runs as a cross-region inference profile — Bedrock distributes load across multiple regions because no single region has dedicated capacity for these models. The bare model ID points at on-demand throughput, which doesn't exist for these SKUs.

This bites every forge user on Bedrock with a Claude 4.x agent on the first spawn. The error is clear once seen but easy to mis-diagnose as a credentials or model-availability issue.

---

## Problem

**What model identifier should forge pass to Claude Code when running against Bedrock with Claude 4.x?**

---

## Options Considered

### Option A: Bare model ID

`anthropic.claude-haiku-4-5-20251001-v1:0`

**Pros**: shortest; matches the IDs `aws bedrock list-foundation-models` returns.

**Cons**: rejected by Bedrock for Claude 4.x with the error above.

---

### Option B: Cross-region inference profile ID ✅

`us.anthropic.claude-haiku-4-5-20251001-v1:0` (or `eu.…`, `apac.…` per region group)

**Pros**:
- The official supported way to invoke Claude 4.x on Bedrock
- Stable across regions within a group
- Plain string — no ARN lookup needed

**Cons**:
- Region-group prefix is account/region-dependent — `us-east-1` uses `us.`, but EU accounts use `eu.`, etc.
- Requires the inference profile to be enabled in the account's Bedrock model access settings

---

### Option C: Full inference profile ARN

`arn:aws:bedrock:us-east-1:099841456104:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`

**Pros**: maximum specificity.

**Cons**: account-specific (the account number leaks into source); harder to share workflow definitions across teams.

---

## Decision

**Chose**: Option B — region-group-prefixed inference profile IDs in BEDROCK_MAP, per-alias env-var override for non-default region groups.

**Rationale**: Option B is the supported invocation pattern for Claude 4.x on Bedrock and produces a clean, account-agnostic alias map. The `us.` prefix is hardcoded for the most common case (us-east-1 / us-west-2); users in other regions override per-alias via `FORGE_MODEL_<ALIAS>` env vars. This keeps the source map readable without requiring forge to query Bedrock for the right prefix at startup (which would also fail for accounts that block `bedrock:ListInferenceProfiles`, as Steven's SCP does).

---

## Consequences

**Positive**:
- Bedrock spawns work out of the box on us-east-1 / us-west-2
- Documented override path for other region groups

**Negative / Trade-offs**:
- A first-time user in EU/APAC has to set `FORGE_MODEL_*` env vars or edit BEDROCK_MAP
- The inference profile must be enabled in the account's Bedrock model access — forge can't activate it

**Risks**:
- AWS may rename/restructure inference profile IDs. Mitigation: env-var override means users can patch without a forge release

---

## Implementation Notes

- `src/workflows/_agentRefs.ts` BEDROCK_MAP holds `us.`-prefixed IDs
- Override examples:
  ```bash
  export FORGE_MODEL_FAST_ORCHESTRATOR=eu.anthropic.claude-haiku-4-5-20251001-v1:0
  export FORGE_MODEL_SPEC_WRITER=arn:aws:bedrock:us-west-2:1234:inference-profile/...
  ```
- The original error message from Claude Code is captured in the task's stdout log AND surfaced in `result.error` — users hitting this for the first time can diagnose from `forge show <task-id>`

---

## Revisit Conditions

- If AWS restores on-demand throughput for Claude 4.x models — bare IDs would work again
- If Bedrock introduces a new identifier scheme that supersedes `<region>.<model-id>`
- If forge gains the ability to query Bedrock at startup and auto-discover the correct profile (requires `bedrock:ListInferenceProfiles` permission)
