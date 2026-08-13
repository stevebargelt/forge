# Secret hygiene & redaction (AWN-8)

What forge does to keep debug artifacts useful without preserving secrets,
prompts, auth state, or project-local credentials.

## Staged auth state

When a task uses an auth profile, forge stages a mode-600 `auth-state.json` in the
task dir (the bearer session) and mounts it read-only. **It is deleted as soon as
the task reaches a terminal state** (`cleanupStagedAuth`, on every exit path:
normal, crash, idle-timeout, build failure). A retry mints a fresh session — no
reuse of staged credentials. The container's own logs never contain it (it's a
mounted file, not printed).

## `forge bundle`

- **Allowlist, not denylist.** Only known-safe files are copied
  (`result.json`, `manifest.json`, `progress.jsonl`, bounded logs; prompts only
  with `--include-prompts`). A file not on the allowlist cannot leak by default.
- **Explicit denylist guard** (defense-in-depth): after assembly, the bundle
  refuses to ship if any included path matches the denylist (`auth-state.json`,
  `.env*`, `storageState.json`, `qa.json`). This should be impossible by
  construction; if it ever trips, assembly fails loudly.
- `bundle.json` carries the task rows but **strips `taskPackage.composedSystemPrompt`
  and `inputs`** (prompt/task context) unless `--include-prompts`.
- The bundle's `note` field states the sanitization applied (visible in bundle
  metadata).

## Manifest

`manifest.json`'s `auth` block is **booleans only** — `profileRequested` /
`stateMounted`. It records *whether* a sensitive capability was mounted, never
*where* a credential lives or any token material.

The `controlPlane` block (added FG-350) records dispatch-time config provenance:
config file paths, source labels (`host`/`project`/`absent`/`built-in`), and
constraint counts. It stores **no secrets, token material, or auth file paths** —
the same discipline as the `auth` block. Auth profile names and runtime paths are
config references, not credential material.

## Auth profiles

- `required_env` is checked by **name** only; forge never reads or logs the values.
- Project-command login errors never surface the command's stderr (it can echo
  secrets) — only an exit code and a generic reason.
- Reds never receive auth state, regardless of profile `roles`.

## Launch env forwarding (FG-626 / FG-707)

`forge launch run` forwards every `FORGE_`-prefixed variable on the invocation into
the launched workload, and records the forwarded/dropped set on the durable launch
record (`meta.json`) for audit — see `docs/concepts.md` → **Durable launch**. The
recorded value is redacted by a **fail-closed allowlist**, not a scan of the value:
`isAllowlistedForgeEnvName` (`src/v2/launch.ts`) checks the NAME against
`NON_SECRET_FORGE_ENV_ALLOWLIST` — ten gate names (`FORGE_WORKTREES`,
`FORGE_NO_WORKTREES`, `FORGE_WORKTREE_IGNORE_DIRTY`, `FORGE_WORKTREES_EPHEMERAL`,
`FORGE_CI_POLL_SECONDS`, `FORGE_CI_WAIT_TIMEOUT_SECONDS`, `FORGE_NO_BROWSER`,
`FORGE_NO_NM_SHADOW`, `FORGE_CONTAINER_RETENTION`, `FORGE_NOTIFY_ON`) whose value
the audit genuinely needs and which carry no secret. A name on that list keeps its
recorded value; **every other name is redacted by default** — including
`FORGE_CONTROLLER_ID` (the lease-fencing controller identity: capability-adjacent,
not configuration — see `docs/concepts.md` → **Campaign** → **Crash recovery**) and any
credential-bearing name never enumerated (an injected `FORGE_TOKEN`,
`FORGE_AWS_CREDS_FOR_TEST`, …) — replaced with the `«redacted»` marker in
`meta.json` and in `forge launch show`. This inverts FG-626's original RF-3
denylist, which matched credential-shaped name segments (`CRED`, `SECRET`,
`TOKEN`, …) and failed **open**: a credential-bearing name that matched no listed
segment was recorded and printed verbatim. The workload itself always receives the
real, un-redacted value over the `-e` channel — redaction applies only to the
durable record and its human rendering, never to what the launched command sees.

## Events / exports

Lifecycle event payloads are booleans + safe text by design (the Crawl
discipline). `auth.profile_applied` carries only `{ profile, kind }`;
`auth.profile_failed` carries `{ profile, reason }` (a secret-free message).
`forge export` (JSONL / OTLP) dumps these payloads as-is — there is no credential
material to redact because none is ever written.
