# Decision: Run agent containers docker-detached — survive host-side parent death by construction

**ID**: FORGE-DEC-025
**Date**: 2026-07-12
**Status**: Decided
**Decided by**: Steve (forge build, FG-536)
**Supersedes**: N/A
**Scope**: forge

---

## Context

FG-535 established, with `si_pid` evidence, that something on the host kills the forge CLI's process tree mid-run: a harness sweep SIGTERMs the submitting process and its children. That ticket made the *launcher* durable (`forge launch run`, a tmux-owned session — see [Durable launch](../../docs/concepts.md#durable-launch)), but it left the agent itself exposed, because of how the agent container was being run.

Every agent ran as a foreground `docker run` (`defaultDockerExec` in `src/v2/docker-exec.ts`). The docker CLI client in that mode is a **signal proxy**: it forwards SIGTERM into the container's PID 1. So a sweep of the CLI's process tree didn't just kill forge's bookkeeping — it reached through the client and killed the agent, mid-work, at exit 143. Everything downstream of that (reconcile, the orphan evidence path, `forge recover`) is recovery *after* the agent has already died. The work itself was gone.

The constraints on any fix:

- **FG-497's argv bound.** Linux caps a single argv/env string at `MAX_ARG_STRLEN`. `spawn.ts` asserts every element stays under it. Any change that merges the invocation into one shell string (`sh -c "…"`) would collapse many small args into one giant one and re-open E2BIG.
- **FG-437 owns the dependency provisioner.** The short-lived `forge-provision-<cacheKey>` container has its own lifecycle (`--rm`, `provision_*` events, liveness-aware lock steal) and its own crash windows. It was not in scope to re-home it.
- **The idle watchdog is in-process.** `startIdleWatchdog` bumps on each stdout/stderr chunk from the attached client. Detach the container and that watchdog no longer has an authoritative lifetime — it dies with whatever host process happens to be watching.
- **`spawn.ts`'s docker invocation pattern is protected** (CLAUDE.md: read DEC-004 — orchestrator on host, agents in containers — DEC-005, DEC-006, DEC-009 before changing it). DEC-004's split is *unchanged* by this decision: the orchestrator still runs on the host and agents still run in containers. What changes is which process **owns** the container.

---

## Problem

**How does an agent container survive the death of the host process that submitted it, without weakening the argv bound, the provisioner's lifecycle, or the idle bound?**

---

## Options Considered

### Option A: Keep the container attached; harden the host process against signals

Trap SIGTERM in the forge CLI, refuse to forward it, re-parent, `setsid`, ignore the sweep.

**Pros**: no change to the docker invocation pattern at all.

**Cons**: it is a fight against an adversary we do not control and cannot enumerate. FG-535 proved one sender; the next sweep may use SIGKILL, which cannot be trapped at all, and the attached client dying by SIGKILL still strands (or, with a stop-signal configured, still kills) the container. Every hardening is a guess at the *cause* of the kill; none of them make the agent's survival a property of the system. This is the same shape as FORGE-DEC-009's rejected Option A — chasing individual causes down a long tail — and it loses for the same reason.

---

### Option B: Detach the container; the host process is only a watcher ✅

Run the agent with `docker run -d`. The **daemon** owns the container. The host process keeps two disposable watchers:

- `docker logs -f <name>` — re-delivers the container's output from t=0, streams it to the task dir, and bumps the idle watchdog. It may die freely: the logs live in the daemon, and re-attaching re-delivers them.
- `docker wait <name>` — blocks and yields the exit code.

Kill either watcher, or the whole host process, and the container is untouched. It runs to completion, writes `/task/result.json` through its bind mount, and exits normally. The next reconcile pass finalizes the task from that **real result** through the ordinary container-gone evidence path — which already existed and is unchanged (invoke-like completion with the FG-523 validation contract; `orphaned_needs_finalize` for a pipeline step, which must not skip its host-side finalize).

**Pros**: survival is structural, not a countermeasure — it holds for *any* signal from *any* sender, including SIGKILL. The recovery model is not new code: detached execution only changes whether the container is still alive to finish its own work.

**Cons**: a detached container has no client stdin pipe, so the stdin payload needs another route; and the in-process idle watchdog stops being an authoritative bound (see both below).

---

## Decision

**Chose**: Option B — detached execution. `productionDockerExec` (detached unless disabled) is the default in `invoke.ts` and `runNext.ts`.

**Rationale**: the attached client's signal proxying *is* the casualty chain. Severing it makes agent survival a property of the architecture rather than a defense that has to out-guess whatever kills the CLI next. Live-proven both ways before landing: a SIGKILL of the CLI, and a SIGTERM of its whole process subtree (the FG-535 kill signature), each left the container running to completion, with reconcile finalizing both tasks from the real result on disk.

Three sub-decisions fall out of it.

**stdin travels through the `/task` bind mount, not a pipe.** The payload is written to `/task/detached-stdin`, and a generated `/task/detached-entry.sh` (`exec "$@" < /task/detached-stdin`) is interposed immediately after the image, taking the original command as `"$@"`. The same bytes land on the agent CLI's fd 0. Crucially, **every argv element stays a separate argument** — nothing is merged into one shell string — so FG-497's per-arg bound is untouched. Without a stdin payload the script is a bare `exec "$@"` and fd 0 is docker's `-d` default.

**The protected `spawn.ts` pattern gains exactly one field: `BuildArgsResult.imageIndex`.** The arg-*building* is unchanged — same flags, same mounts, same order. The executor needs to interpose the entry script right after the image, and docker's `[OPTIONS] IMAGE [COMMAND]` boundary cannot be re-derived downstream without flag knowledge `docker-exec.ts` doesn't have (which options take values?). `spawn.ts` already knows where it pushed the image, so it just says so. **The boundary is never guessed**: an executor call with no `imageIndex` falls back to the attached path.

**The idle bound relocates to reconcile.** The in-process watchdog still runs (it bumps off the `docker logs -f` stream), but it now dies with its watcher while the container lives on — so it is no longer a bound anyone can rely on. `reconcile.ts` becomes the bound that survives: for a **live** container, it reads last log activity (`docker logs --timestamps`, falling back to the container's `StartedAt` when it has produced no output yet) and, if that is older than the task's manifest `idleTimeoutMs`, issues the same authoritative `docker kill` the watchdog would have, plus a `container.idle_timeout` event tagged `source: reconcile_idle_bound`. It writes **no status** that pass; the next pass lands the task from container-gone evidence like any other. **Unknowable activity enforces nothing** — if docker can't answer, reconcile never kills on missing evidence.

**Two deliberate exemptions from detachment.** The FG-437 dependency provisioner stays attached (`isProvisionerExec`) — that container is short-lived, `--rm`, and FG-437 owns its lifecycle and crash windows. Any caller without an `imageIndex` (a legacy call site, a test fake) stays attached too.

**Escape hatch**: `FORGE_DETACHED_EXEC=off` restores the attached executor for every caller.

---

## Consequences

**Positive**:
- An agent container survives the death of the forge CLI *for any reason* — harness sweep, SIGKILL, closed terminal, host process crash. Work in flight is no longer collateral.
- The FG-530 crash-point registry gains `runContainer:after-container-started-before-exec` — the watcher-death window — and every existing lifecycle invariant holds across it. The kill leaves a `running` task with `container.started` on the record: exactly the shape the container-gone sweep already recovers from the real result.
- Nothing about the recovery taxonomy changed. No new `failure_kind`, no new operator verb.

**Negative / Trade-offs**:
- The idle bound is now only as timely as the next reconcile pass (`forge next` / `forge status`), where before it fired from a live in-process timer. A hung agent may therefore be killed later than it once was.
- Two entry files (`detached-entry.sh`, `detached-stdin`) now appear in the task dir. `detached-stdin` contains the composed prompt — same content as the pipe carried before, now at rest on disk under the task dir.
- Output arrives via `docker logs -f` rather than a direct pipe, so it depends on the daemon's log driver retaining the container's output.

**Risks**:
- A container that outlives *everything* watching it (both the CLI and every subsequent reconcile) would sit running until something sweeps it. Mitigated by the reconcile idle bound above: any pass that sees it past its budget kills it.
- `docker logs -f` re-delivers from t=0 on attach; a watcher that dies and is replaced would rewrite the stdout file from the beginning rather than appending. Acceptable today because the watcher is not restarted within a run — reconcile finalizes from `result.json`, not from a stitched log.

---

## Implementation Notes

- `src/v2/docker-exec.ts` — `detachedDockerExec` (the `-d` / `logs -f` / `wait` triple), `toDetachedArgs` (the pure argv transform, `run -i […] IMAGE cmd…` → `run -d […] IMAGE sh /task/detached-entry.sh cmd…`), `detachedEntryScript`, and `productionDockerExec` (the env-gated default). `defaultDockerExec` — the attached executor — is retained, not deleted: it is the provisioner path, the legacy-caller fallback, and the escape hatch.
- `src/v2/spawn.ts` — `BuildArgsResult.imageIndex`. The one addition to the protected pattern; the arg-building itself is unchanged.
- `src/v2/reconcile.ts` — `defaultIdleBound` / `defaultContainerActivity` / `manifestIdleTimeoutMs`, applied in the live-container branch of `reconcileRun`. Wrapped so the idle bound can never abort the pass (the FG-459 posture).
- `src/v2/fg530-harness.ts` — `runContainer:after-container-started-before-exec`.
- Operator-facing description: [docs/concepts.md → Detached execution](../../docs/concepts.md#detached-execution).

---

## Revisit Conditions

- If the reconcile-pass cadence proves too slow an idle bound in practice (a hung agent burning tokens for far longer than its budget), reconsider a host-side supervisor that outlives the CLI — but note that any such supervisor is itself killable, which is precisely why the bound was put in reconcile rather than in another watcher.
- If a future runtime needs stdin *streamed* (rather than a payload delivered once at start), the bind-mount route no longer models it and the entry-script approach must be revisited.
- If the dependency provisioner ever grows long enough to be worth surviving a CLI death, re-home it onto the detached executor — FG-437 owns that call.
