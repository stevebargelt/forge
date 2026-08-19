# FG-679 — Current activity: architecture record

> **Lifecycle:** written with the implementation (FG-679). It records the decisions
> that shaped the `Current activity` surface and, deliberately, the two things a
> later reader would otherwise re-discover as defects: the pre-existing serving-path
> subprocess exceptions, and the fact that a supervised periodic host process *is*
> precedented in this codebase even though this ticket does not use one.

**Ticket:** FG-679 · **Binding decisions:** BD-1 … BD-19, recorded by the operator before implementation.

## What this ticket is

The dashboard projects Forge **tasks**. Two load-bearing kinds of in-flight work are not task rows —
host verification running under `forge launch run`, and the required CI checks running at the candidate
sha — so a run with either in flight reads as though nothing is happening. FG-679 adds one
`Current activity` surface with three distinct sections (`Agents`, `Host verification`, `Required CI`),
projected from durable state only. *(Note 2026-08-10: FG-700 split `Host verification` by a declared
`purpose` field and added a fourth, disjoint `Launch activity` section for every other placed launch —
the projection is four sections now, not three. See `docs/concepts.md` → Current activity → "What a
launch IS" for the current model; the three-section shape above is FG-679's as shipped.)* *(Note
2026-08-18: FG-731 added a fifth, disjoint `CI waits` section for an explicitly REGISTERED Forge-owned
CI wait (`pr_checks` / `push_actions` / `workflow_dispatch`, via `forge ci-wait`) — orthogonal to
`Required CI`'s candidate-sha checks, and the one section whose mere presence forces `WORKING`/never
`IDLE` independent of observation freshness. See `docs/concepts.md` → Current activity → "Registered CI
waits" and `docs/SCHEMA-CONTRACT.md` → `ci_waits`; the four-section shape above predates it.)* *(Note
2026-08-18: FG-734 added a sixth, disjoint `Waiting on operator` section for derived `operatorWaits` —
a task parked at a `human`-gated workflow step, or a campaign item that recorded a
`requested_human_action` hard stop — orthogonal to `CI waits`: an operator wait reports Forge blocked on
a person deciding something, not on GitHub continuing to run something. See `docs/concepts.md` →
Current activity → "Operator waits" and `docs/SCHEMA-CONTRACT.md` → `/api/current-activity`
(`operatorWaits`); the five-section shape above predates it.)*

The ticket was filed as a pure projection gap. **It is not one, and the correction matters** to anyone
reading this later. The CI half *is* a projection gap: `probeCiGateStatus` (FG-501) already probes
required checks at an exact sha. The launch half is not: `readLaunch` derives a launch's status from a
**live tmux probe**, and `running` / `owner_gone` / `unknown` are all probe-derived. Launches emitted no
events and had no table, so nothing durably marked a launch terminal unless something was waiting on it —
and the ticket's own motivating case, a hand-run `forge launch run -- npm run test:worktree`, had no
waiter at all. Durable launch instrumentation is therefore part of this ticket (BD-12), not an
adjacent one.

## Shape

| Piece | Where | Role |
|---|---|---|
| `launch_observations` | `src/store/schema.ts`, one mutable row per launch | Durable start / freshness / terminal / association, carrying **structured** status, never a rendered string |
| Submission-time association | `startLaunch` + `forge launch run --run/--task/--ticket` | The ONLY thing that authorizes run-level placement (BD-2) |
| `promoteLaunchObservations()` | `src/v2/launch.ts`, called from `forge next` / `gate` / `continue` / `status` | Opportunistic promotion of the on-disk exit record (BD-16) |
| `review_loop.ci_observed` | emitted by the existing observer in `src/cli/commands/review-loop.ts` | Per-context required-CI observation bound to an exact candidate sha (BD-5) |
| `src/v2/current-activity.ts` | one exported derivation | Read by BOTH `forge status` and the dashboard, so BD-9 agreement is structural |
| `/api/current-activity`, `/api/launches/:id`, `/api/launches/:id/log` | `dashboard/src/server.ts` | New read-only serving paths, deliberately separate from `/api/in-flight` |

`/status` and the dashboard agree because they call the **same function over the same persisted state**.
That is the whole mechanism; there is no reconciliation step and no second derivation to keep in sync.

## The BD-7 guard, and the two exceptions it does not cover

BD-7: the dashboard makes no outbound call while serving or polling — no GitHub, no shell, no `git`, no
Forge CLI, no tmux. FG-679's new serving paths satisfy this, and it is proven by a **runtime guard**
(spies over `child_process`, the `gh`/`git` binaries and outbound HTTP, driving real requests) rather
than by source inspection.

**The guard is scoped to FG-679's new serving paths.** It is not widened to cover the whole server, and
it is not narrowed to pass over a path that does shell out. That scoping is a decision, not an oversight,
because two pre-existing serving paths would fail it. Both are recorded here by name so the next reader
knows they are **known rather than missed**.

### Exception 1 — FG-290's `docker inspect` on `/api/in-flight` (BD-13)

Every `/api/in-flight` request classifies running containerized tasks by liveness, at a 2-second client
poll:

- `dashboard/src/queries.ts:253` (and `:255` for the scoped form) → `findReconcileCandidates(db(), …, probe)`
- → `probeContainerLiveness` at `src/ops/reconcile-candidate.ts:63`
- → `execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", name], …)`

This is a real subprocess on a real serving path. **It is not absorbed into FG-679.** FG-679's sections
do not need it, `/api/current-activity` is a separate endpoint precisely so the guard can be scoped
without covering it, and folding the new sections into `/api/in-flight` would have made the BD-7
criterion unassertable.

### Exception 2 — project presentation shelling `git` (BD-18)

BD-13 named one exception; there are two. Project presentation shells `git` on the serving path, which
BD-7 names by word:

- `dashboard/src/queries.ts:1371` `projectPresentation(projectDir)`
- → `repositoryCheckoutIdentity(projectDir)` (`src/util/repository-identity.ts`)
- → `src/util/repository-identity.ts:13` `const defaultGit: GitRunner = (args) => execFileSync("git", args, …)`

It is reached from `/api/in-flight` (`queries.ts:263`), the task view (`:420`) and the run view (`:1807`),
behind a 5-second presentation cache.

**FG-679's new sections avoid subprocess-backed presentation entirely.** They carry a weaker project
label derived from the registry rather than acquiring a second `git` call — that is why
`dashboard/src/queries.ts`'s `currentActivity(scope)` does not reach for `projectPresentation` /
`repositoryCheckoutIdentity`.

### Disposition of both

Recorded, not absorbed, not narrowed, not silently ignored. **No follow-up ticket is filed for either**,
per BD-13 and BD-18, absent measured latency, failure, or dashboard-hang impact beyond the bare fact
that the call occurs. If someone later measures such an impact, that measurement is the ticket — the
observation that a subprocess exists is not.

## No daemon — and why that is BD-16, not an absence of precedent

FG-679 introduces no daemon and no resident observer. **The reason is BD-16: the terminal outcome is
already durable on disk**, so a resident observer would buy nothing.

`buildWrapperCommand` (`src/v2/launch.ts`) builds the command the tmux pane runs, and it embeds a
recorder that writes the exit record to `exitPath`. The pane records its own disposition; `forge launch
wait` only *reads* that file. So every launch's terminal outcome is durable without any waiter, and the
only missing step was promoting the on-disk record into the store. `promoteLaunchObservations()` does
exactly that, opportunistically, from Forge invocations that already run — mirroring the
publication-reconcile-at-top-of-wave sweep and the SSO watchdog that is stopped by "the next `forge next`
or `forge gate` invocation".

**The architect-phase claim that no supervised periodic host process exists in this codebase is false,
and this record must not repeat it (BD-17).** `src/util/sso-watchdog.ts` is exactly that: a host-side
poller, spawned detached and `unref()`'d, tracked by a PID file at `~/.forge/sso-watchdog.pid`,
surviving short Forge invocations, and stopped from Forge lifecycle code (FORGE-DEC-013).

The distinction is worth keeping straight because it decides what a future ticket has to argue.
A future ticket that genuinely needs a bounded observer — one whose evidence is *not* already durable on
disk — should **inherit the `sso-watchdog` precedent** rather than re-litigate whether a supervised
periodic host process is allowed here. It is. FG-679 simply does not need one.

## Honesty properties this design is built to hold

These are the properties the surface would be worthless without, stated so a later change can be
measured against them:

- **An observation is evidence of what was observed and when — never a claim about the present.** A
  stale or incomplete row renders `unobserved since <time>`, never `running` and never terminal.
  Absence of a fresh observation is a fact about the **observer**, not about the work.
- **Placement is authorized by explicit submission metadata alone.** Never by launch name, argv, or log
  text. `extractForgeIds` (`src/v2/launch.ts`) regexes `run-…` / `task-…` out of raw log text and stays
  published on `LaunchView` for compatibility and diagnostics — **quarantined, not removed** (BD-15) —
  and authorizes nothing. FG-492 is why: long-lived agent processes carry conversation text in argv and
  falsely match unrelated role and ticket names.
- **`statusLine` (`src/v2/launch.ts`) remains the ONE human rendering** of the launch status vocabulary.
  Rows carry the structured `LaunchStatus.state`, so the four BD-4 facts stay four facts on every
  surface and none collapses into a generic `failed`.
- **The observer declares the candidate sha; no reader derives it.** The dashboard has no `git` and no
  GitHub. Only the newest observation is presented, so an observation bound to a superseded candidate
  simply stops being the newest and disappears (BD-6) — no supersession column, no relabeling.
- **Instrumentation never refuses the work.** `startLaunch` is refuse-before-execute; the observation
  write lands *after* those gates and is best-effort in both directions. A launch that could not be
  recorded still runs and reads as unobserved, and an unwritable store never becomes a launch refusal.
  The pane recorder's spawn body and exit-record write ordering (FG-535 / FG-552) are untouched, and
  nothing in the pane loads `better-sqlite3`.
- **Read-only.** No start, stop or retry affordance, and no arbitrary host filesystem path accepted,
  exposed or linked. Launch detail is addressed by launch **identity**, validated against the same
  charset guard that `launchDir` uses before it becomes a path, and the log response is a **bounded
  tail** — the log file is unbounded host-command output served by a server with no authentication and
  an env-overridable bind address (`dashboard/src/server.ts:35`). Identity-only addressing constrains
  path traversal; the tail bound is what constrains content exposure.

## Explicitly out of scope

- **FG-683's historical completed-run throughput** (BD-11). Not folded in, not partially added, not
  scaffolded for. This ticket is live activity only.
- Start / stop / retry affordances for launches or CI.
- Any dashboard-initiated subprocess, credential, second CI poller, or second auth path.
- Changing what `forge launch show` reports, or the launch status vocabulary itself. FG-679 **projects**
  that vocabulary; it does not define it.
- Fixing the FG-676 phantom `awaiting_gate` row. FG-676 removed the false signal; this ticket adds the
  missing true one. Neither substitutes for the other.

## Related

- `docs/concepts.md` → **Current activity**, **Durable launch** — the operator-facing model.
- `docs/invariants.md` → invariants 21 and 22 — the two rules this ticket establishes.
- `docs/SCHEMA-CONTRACT.md` → `launch_observations` and the `review_loop.ci_observed` event contract.
- `dashboard/README.md` → the surface and its endpoints.
