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

## Control-plane config graph (FG-349)

`forge config graph [--json]`, the dashboard's control-plane tab, and its
`/api/config-graph` read path expose the same kind of provenance as the
`controlPlane` manifest block above, but live (EFFECTIVE) rather than
dispatch-time (RECORDED) — see `docs/concepts.md` and `docs/invariants.md` for
that vocabulary. `buildConfigGraph()` (`src/v2/config-graph.ts`) runs a final
whole-graph redaction sweep (`redactGraph` → `redactSecrets`) over every string
in the object, including each row's verbatim `native` verdict, as
defense-in-depth over the per-row redaction each section builder already
performs before assembling its row. Provider/auth readiness in the Capabilities
panel is checked by env-var **presence** only, exactly like the `auth` block
above — a provider's readiness is never derived from reading its value, and no
capability or prerequisite row probes a subprocess or makes a billed call.

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

## Host-readiness records / events (FG-634)

[Host verification readiness](concepts.md#host-verification-readiness) persists the
setup command, the refusal command/message, and the setup output tail
(`setupCommand`, `stderrTail`, the refusal's `command`/`message`) into the durable
readiness record under `~/.forge/host-readiness/` and into the `host_readiness.ready`
/ `host_readiness.refused` events the dashboard task timeline renders. Any of those
four free-text fields can carry an operator credential — a `hostVerificationSetup`
that pulls from an authenticated mirror embeds a basic-auth URL or a registry token,
and a failing `npm ci` against an authenticated registry echoes one into stderr.

`redactSecrets` (`src/v2/host-readiness.ts`) blanks credential-shaped substrings —
URL basic-auth, npm `_authToken`/`_auth`/`_password`, `*_TOKEN`/`*_SECRET`/`*_KEY`/
`PASSWORD=` assignments, `Authorization:` headers — with the `«redacted»` marker,
reusing launch.ts's `REDACTED_ENV_VALUE` and the same fail-closed philosophy as
**Launch env forwarding** above. It runs at the **persistence boundary**, on the way
into the record and the event payload (including when an existing record is reused,
not just when a fresh one is written), never at render time, so no downstream reader
— dashboard, event-store backup, `forge` CLI — has to remember to redact. It is
**audit-surface-only**: the setup child that actually executes the command still gets
the real, un-redacted value, so install behavior is unchanged; only what gets written
and displayed is. Ordinary (non-credential) command text and output pass through
byte-intact.

## `forge backup`

Unlike every artifact above, `forge backup create` (FG-669) is **not** redacted, by
design: it writes a byte-for-byte SQLite snapshot of the live control-plane store,
not a debug artifact assembled for sharing. The manifest alongside it (`createdAt`,
`forgeVersion`, `schemaVersion`, `sourcePath`, source device/inode identity, size,
sha256) carries no secrets, but the artifact it describes is the whole store, and the
store carries every field the surfaces above are busy redacting *out* of debug
artifacts. Confidentiality here is enforced by **filesystem permission**, not
content: backup directories are `0700` and both files inside them are `0600`,
readable only by the account that ran `forge backup create`. Treat a backup exactly
like the live `forge.db` — do not attach one to a bundle, ticket, or chat message.
See [Backing up and restoring the shared store](how-to-backup.md).

## Events / exports

Lifecycle event payloads are booleans + safe text by design (the Crawl
discipline). `auth.profile_applied` carries only `{ profile, kind }`;
`auth.profile_failed` carries `{ profile, reason }` (a secret-free message).
`forge export` (JSONL / OTLP) dumps these payloads as-is — there is no credential
material to redact because none is ever written.
