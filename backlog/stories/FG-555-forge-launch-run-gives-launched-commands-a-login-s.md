---
id: FG-555
type: story
status: active
title: "forge launch: caller-supplied execution environment can select a Node ABI incompatible with the repo, while launch records cannot explain the mismatch"
created: 2026-07-14
---

## Problem

An FG-425 verification was submitted to `forge launch run` with the explicit
command `bash -lc <test-chain>`. On this host, that caller-supplied login shell
reset `PATH` so `node` resolved to `/usr/local/bin/node` v23.3.0
(`NODE_MODULE_VERSION` 131), while the repository's `better-sqlite3` binding
had been built by Node v24 (`NODE_MODULE_VERSION` 137). Every test that opened
the database then failed with `ERR_DLOPEN_FAILED`, making hundreds of unrelated
tests appear to be product regressions.

The durable causal account matters: `forge launch` did **not** add the login
shell. `src/v2/launch.ts` wraps the exact supplied argv with a recorder running
under `process.execPath`, and that recorder calls `spawnSync` on the supplied
executable and arguments. The orchestrator supplied `bash -lc`; the login shell
changed command resolution.

There is still a Forge reliability gap. A launch records argv and `cwd`, but not
enough effective execution provenance to show that the command resolved a
different Node/toolchain than the submitting Forge process or the repository's
native dependencies. A Forge-owned unattended verification can therefore
spend a full cycle producing an infrastructure-wide false red, and the
controller must reconstruct the cause afterward.

Rebuilding `better-sqlite3` under the accidentally selected Node is not a safe
remediation: it would mutate the shared working tree's native dependency for
the other Node 24 workflows.

## Goal

Forge-owned durable launches must either run with the intended, compatible
toolchain or refuse before executing the workload with an actionable runtime
mismatch. Launch evidence must make the effective executable/runtime provenance
diagnosable without inferring it from a wall of downstream test failures.

Preserve `forge launch run` as an argv launcher. Do not "fix" this by claiming
that Forge inserted a shell, or by silently rewriting arbitrary operator argv.

## Design Boundary

- Decide where Forge-owned controller commands pin or resolve their execution
  environment: at the caller, in a dedicated launch profile/helper, or through
  an explicit launch-environment contract. Generic operator commands must not
  be silently transformed.
- Align this decision with the stable control-runtime and executable-provenance
  work in `docs/prds/durable-orchestration-continuation.md`; do not grow a
  conflicting second runtime-selection mechanism.
- Record enough provenance to distinguish the wrapper runtime from the launched
  workload. `process.execPath` identifies the exit recorder only; it does not
  prove which `node`, `npm`, or nested command a supplied shell resolved.
- Compound verification chains that genuinely require a shell must have an
  explicit environment contract. A login shell must not be used accidentally
  as an implementation detail.

## Acceptance Criteria

- A regression test proves that `forge launch run` preserves and executes the
  exact supplied argv and does not synthesize `bash -lc` or another login shell.
- The Node 23 / ABI 131 versus Node 24 / ABI 137 reproduction is covered at the
  production launch boundary. The workload either runs under the intended
  compatible runtime or fails before the test suite with a named, actionable
  runtime/toolchain mismatch.
- Forge-owned unattended verification callers use the defined launch-environment
  contract; they do not depend on ambient login-shell `PATH` mutation.
- The durable launch record and `forge launch show --json` expose the provenance
  required to diagnose the effective top-level executable and relevant runtime
  environment, while clearly distinguishing recorded fact from commands that a
  nested shell may resolve later.
- Direct argv launches and shell-required launches both have coverage, including
  a caller intentionally supplying `bash -lc`; generic caller argv is never
  silently rewritten.
- No remediation rebuilds or replaces shared native dependencies merely to
  match an accidentally selected runtime.
- Documentation and controller guidance stop attributing caller-supplied login
  shell behavior to `forge launch` itself.
