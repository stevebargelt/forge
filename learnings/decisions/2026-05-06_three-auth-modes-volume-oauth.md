# Decision: Three auth modes; OAuth via a docker volume, not a host file mount

**ID**: FORGE-DEC-007
**Date**: 2026-05-06
**Status**: Decided (supersedes vault DEC-006 for the OAuth-on-Mac case)
**Decided by**: Steven (forge build, hit during first agent spawn on macOS)
**Supersedes**: vault `DEC-006: file-based-oauth-credential-sharing` for macOS hosts
**Scope**: forge

---

## Context

The vault corpus DEC-006 prescribes mounting `~/.claude/.credentials.json` from the host into the agent container, read-only. That works on Linux and on older Claude Code releases that wrote OAuth tokens to that file. On current macOS Claude Code, the OAuth token lives in the macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`) — there is no `.credentials.json` on disk to mount, so the agent container starts with no credential and the agent reports `Not logged in · Please run /login`.

Steven uses two distinct execution contexts that need different auth:

| Context | Provider | Models | Why |
|---|---|---|---|
| Personal Mac | Anthropic OAuth (Pro plan) | Opus 4.7 + everything else | Pro covers the model family; Opus is the headliner |
| Work Mac | AWS Bedrock | Sonnet, Haiku (no Opus) | Corporate-approved provider; Opus is blocked |

Forge has to support both cleanly; no editing of source to switch.

---

## Problem

**How should agent containers acquire Claude credentials, given that (a) the host file mount doesn't work on Mac, and (b) forge must run in two different auth contexts on different machines?**

---

## Options Considered

### Option A: Host file mount only (vault DEC-006)

**Pros**: simplest; no extra concept.

**Cons**: breaks on macOS — `~/.claude/.credentials.json` does not exist there.

---

### Option B: `ANTHROPIC_API_KEY` env var only

**Pros**: mode-agnostic, always works.

**Cons**: an API key is a *separate billing identity* from the Pro subscription. Steven specifically wants to use his Pro plan to get Opus 4.7. An API key would route through API credits, not Pro.

---

### Option C: Extract OAuth token from macOS keychain on demand

**Pros**: leverages the existing host login.

**Cons**: keychain item name and token format are undocumented. The token rotates; a snapshot mount goes stale. Brittle.

---

### Option D: Three modes selected by env var; OAuth in a named docker volume ✅

```
detectCredsMode():
  CLAUDE_CODE_USE_BEDROCK=1 → "bedrock"
  ANTHROPIC_API_KEY set      → "anthropic-apikey"
  else                       → "anthropic-oauth"
```

- **bedrock**: pass `CLAUDE_CODE_USE_BEDROCK=1` and AWS_* env vars into the container. Work default. Model resolution uses Bedrock-style IDs.
- **anthropic-apikey**: pass `ANTHROPIC_API_KEY` env var. Escape hatch.
- **anthropic-oauth**: mount a named docker volume `forge-claude-oauth` at `/home/agent/.claude`. The user runs `forge auth login` once — that spawns an interactive `claude` inside the volume; `/login` writes credentials to the volume. Every subsequent agent spawn mounts the same volume.

**Pros**:
- Switch contexts by exporting (or unsetting) `CLAUDE_CODE_USE_BEDROCK`. No code changes.
- The OAuth volume is *agent-scoped*: the host's Pro session is untouched, the volume's credentials are the agent's. No risk of agents corrupting host credentials.
- Works on Mac, Linux, and CI. The agent gets an `~/.claude` directory of its own; whatever Claude Code stores there (file or otherwise) lives in the volume.
- Credentials persist across agent spawns automatically — log in once, run hundreds of agents.

**Cons**:
- Adds one new concept (a docker volume + a `forge auth` subcommand)
- The volume mount is read-write so claude can write its history/cache. Agents could in principle modify the credential file. Mitigated by the volume being agent-scoped (no host blast radius)
- An expired OAuth token in the volume requires `forge auth login` again — same story as the host

---

## Decision

**Chose**: Option D — three modes; OAuth via named docker volume.

**Rationale**: The vault DEC-006 file-mount pattern was correct for its environment but doesn't generalize to macOS. Bedrock is the work default and was already supported. The OAuth path needs *some* mechanism that doesn't depend on a host file. A docker volume is the standard way to give a container its own credential store while keeping the host's credentials separate; `forge auth login` is the documented entry point. Modes are selected by env var, so a single forge install switches contexts trivially.

This decision *supersedes* vault DEC-006 for macOS hosts. On Linux hosts where the host file still exists, Option D is still preferable for consistency and to keep host credentials out of agent reach.

---

## Consequences

**Positive**:
- Forge runs end-to-end on Steven's personal Mac (Pro/Opus) and on his work Mac (Bedrock/Sonnet) without source changes
- Auth state is explicit and inspectable (`forge auth status`)
- One log-in covers many agent runs

**Negative / Trade-offs**:
- Users must run `forge auth login` once before the first agent spawn in OAuth mode (small first-time cost)
- The OAuth volume is named per-install (`forge-claude-oauth` by default; override via `FORGE_OAUTH_VOLUME`). If a user wants distinct credential stores for distinct forge contexts, they must override the env var

**Risks**:
- If the agent image changes its `agent` user UID, the existing volume's file ownership won't match. Mitigation: volume is cheap to recreate (`forge auth logout && forge auth login`)

---

## Implementation Notes

- `src/util/creds.ts` — `detectCredsMode()`, `oauthVolumeName()`, `ensureCreds()` (validates per-spawn; in OAuth mode, runs a one-shot `docker run -v <vol>:/home/agent/.claude agent-dev-worker test -s /home/agent/.claude/.credentials.json`)
- `src/cli/commands/auth.ts` — `forge auth login`, `forge auth status`, `forge auth logout`
- `src/v2/spawn.ts` — branches on `detectCredsMode()` at `docker run` arg-build time
- `src/workflows/_agentRefs.ts` — model alias resolution branches on `CLAUDE_CODE_USE_BEDROCK`; Bedrock-style IDs in BEDROCK_MAP, Anthropic-direct IDs in DIRECT_MAP. `FORGE_USE_LITELLM=1` shortcuts both
- `scripts/use-bedrock.sh` — sourced helper that exports AWS Bedrock creds + `CLAUDE_CODE_USE_BEDROCK=1` for the current shell

---

## Revisit Conditions

- If Anthropic adds an official "share keychain credentials with subprocess" API on macOS — drop the volume in favor of that
- If Claude Code introduces a Bedrock+Opus path — collapse the work/personal modal split
- If the OAuth volume's file format changes such that credentials are no longer in `.credentials.json` inside the volume, update `ensureCreds()`'s probe path
