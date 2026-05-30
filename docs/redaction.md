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

## Auth profiles

- `required_env` is checked by **name** only; forge never reads or logs the values.
- Project-command login errors never surface the command's stderr (it can echo
  secrets) — only an exit code and a generic reason.
- Reds never receive auth state, regardless of profile `roles`.

## Events / exports

Lifecycle event payloads are booleans + safe text by design (the Crawl
discipline). `auth.profile_applied` carries only `{ profile, kind }`;
`auth.profile_failed` carries `{ profile, reason }` (a secret-free message).
`forge export` (JSONL / OTLP) dumps these payloads as-is — there is no credential
material to redact because none is ever written.
