# Operator Surface Addons

**Status:** concept / roadmap. This note has no implementation authority.

Forge's core loop should stay focused on orchestrating work: runs, tasks, gates, agents, routing, verification, and durable state. Operator surfaces are different. They make Forge easier to see, supervise, and enjoy using, but they should not become load-bearing runtime behavior.

An **operator surface addon** is an optional human-control surface around Forge. Examples:

- Stream Deck profiles and icons.
- Raycast or Alfred shortcuts.
- Shell aliases.
- Menu bar tools.
- Mobile shortcuts.
- Project-specific dashboard launchers.

These are not a plugin model. They are optional kits that sit beside Forge and call into stable Forge surfaces.

## Core Versus Addon

Forge core should own:

- stable dashboard URLs;
- safe read-only status endpoints;
- project identity and current-project resolution;
- explicit commands for safe actions;
- optional setup/init scaffolding;
- documentation and templates.

An addon should own:

- personal button layouts;
- profile exports;
- icons and visual style;
- local wrapper scripts;
- machine-specific paths;
- private/private-team conventions.

This keeps Forge portable while allowing highly personal operator workflows.

## Setup Shape

`forge setup` or `forge init` may eventually offer optional operator-surface scaffolding:

```text
Configure optional operator surfaces?
- Stream Deck profile kit
- Raycast/Alfred shortcuts
- Shell aliases
- None
```

For Stream Deck, the preferred shape is a separate private repo or host-local directory, not tracked project files:

```text
~/code/forge-streamdeck-control/
  profiles/exported/
  profiles/reviewed/
  icons/source/
  icons/png-144/
  scripts/
  streamdeck-buttons.md
```

Forge can store a host-local pointer to that repo under `~/.forge`, but project repos should not contain personal Stream Deck exports or machine-specific paths.

## Safety Rules

- Addons should start with dashboard-opening and read-mostly actions.
- Agents may edit reviewed artifacts under Git, but must not mutate live app support directories by default.
- Destructive or judgment-heavy actions should open a decision screen with context, not execute on one tap.
- Do not put secrets, private profile exports, or machine-specific credentials in the public Forge repo.
- Forge must remain operable without any addon installed.
- An addon that surfaces **current activity** reads Forge's own read-only surfaces (`forge status`, the dashboard's `/api/current-activity`) rather than re-deriving activity from `forge launch list`, `tmux`, `docker`, or a GitHub token of its own. Those all exist; the point is that Forge already answers this question from durable state, and a second derivation is a second thing to be wrong.
- An addon must not compress the launch status vocabulary. `terminated by SIGTERM (signal sender not recorded — origin unknown)`, `exited 143 (signal-range code, no signal evidence — origin unknown)`, `owner gone`, and `unknown` are four different facts, and **exit 143 alone is never attribution evidence**. A red button that means "failed" for all four is a worse surface than no button — see `docs/concepts.md` → Current activity.
- A stale observation is not a green light and not a red one. Render `unobserved since <time>` as itself; it is a fact about the observer, not about the work. The same discipline applies to required CI, where `not observed` (nobody looked), `not running` (looked, nothing pending), and `stale` (an old observation) are three different answers an addon must not merge into one lamp.

## Automatic terminal-resource cleanup (FG-590)

Forge automatically retires terminal runtime resources — the tmux remains of a finished
`forge launch` and the stopped task container retained for failure investigation — so a
long autonomous run no longer leaves hundreds of dead tmux sessions or stopped containers
behind. Cleanup is **daemon-free**: it runs at the `forge next` wave boundary and can be
triggered on demand. It never removes a running launch, a running container, or a container
owned by a non-terminal task.

**Default retention periods** (shipped as code constants — see `src/v2/retention-policy.ts`):

- **Successful** outcomes are retired **promptly**: `15 minutes`. A clean `exited_ok`
  launch and a `complete`-task container have no diagnostic value, so they are removed
  soon after they settle.
- **Failed / signaled / owner-gone / unknown** outcomes are kept for a **multi-day
  diagnostic window**: `7 days`. They stay inspectable (`forge show --diagnostic`,
  `forge launch show`) for the whole window, then are retired automatically.

**Configuration controls.** The defaults live in code, so **an upgrade needs no per-project
config edit** — every existing project gets the safe defaults automatically. Override only
when you need to, in either of two override-only channels (durations in **milliseconds**):

- `.forge/config.yml`:
  ```yaml
  retention:
    successMs: 900000          # 15 minutes
    failureAmbiguousMs: 604800000   # 7 days
  ```
- Environment: `FORGE_RETENTION_SUCCESS_MS` and `FORGE_RETENTION_FAILURE_MS`.

Precedence is **config override → `FORGE_*` env → code default**. A malformed or negative
value is ignored and falls through to the next layer — an override can only re-time
cleanup, never disable a window or widen the "never remove a running resource" safety
posture.

**Evidence guarantee (fail closed).** Before Forge reaps a failed or ambiguous task
container, it persists the available exit code, signal, OOM flag, timing, and
missing-evidence facts that `forge show --diagnostic` needs. **If that evidence cannot be
persisted, cleanup fails closed**: the container is retained and reported, never destroyed
with its failure evidence unrecorded. Cleanup is idempotent and crash-safe — a crash
between removing a resource and recording its resolution converges truthfully on a later
pass from disk truth, with no fabricated success, no duplicate resolution, and no sticky
incident.

**Cross-project ownership guarantee (fail closed).** A project-scoped launch sweep excludes
any launch the observation store records as owned by a *different* project, so cleanup in
one workspace never retires another's terminal launches. If that ownership cannot be
established — the store exists but the ownership query itself fails — the sweep **fails
closed**: it retires nothing at all (not even this project's own launches) and reports the
failure (`forge ops cleanup` prints `launch sweep failed: <reason>`), rather than falling
back to treating an unread store as "no foreign launches" and sweeping anyway.

**Immediate manual sweep and inspection.** The automatic policy does not replace the manual
commands — they remain available for inspection, early cleanup, and repair:

- `forge ops cleanup` — run the same sweep now, under the configured retention policy
  (`--dry-run` reports container candidates without removing anything).
- `forge ops reap-containers` — the existing container reap; `--dry-run` and
  `--older-than-minutes <n>` still behave exactly as before. It now re-checks each
  candidate's liveness immediately before removal and never destroys one that has come
  back to running (or whose liveness can't be reconfirmed) since the initial scan —
  reported as `skipped (running again / liveness unconfirmed at reap time)`.
- `forge launch rm <id>` — remove one launch record and its tmux remains (refuses a running
  launch without `--force`).

**Retained vs leaked, on the surfaces.** `forge status` — its plain-text rendering and
`--json` alike — and the dashboard label a terminal launch's disposition with one shared
rule: `within_retention_for_investigation` (deliberately kept), `expired_eligible`
(routine, nothing to preserve), or `leaked` (a successful resource still present past its
prompt window). A retained-for-investigation resource is never shown as a leak, and a leak
is never shown as still-useful evidence.

## Stream Deck First Page Ideas

- Needs Me: open dashboard filtered to human action required.
- Active Runs: open the current project/run dashboard.
- Backlog: open the dashboard backlog viewer.
- RACI: open the RACI viewer.
- Reconcile: open ops/reconcile candidates.
- Handoff / Orient: open host-local operational state once available.
- Review / Done Audit: open Shipping Reviewer readiness/done-audit state.
- Pause Queue / Resume Queue: once work queue/campaign support exists.

The goal is not to make humans run CLI commands from buttons. The goal is to make Forge more visible, tactile, and easier to supervise.
