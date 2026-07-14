---
id: FG-551
type: story
status: done
title: agent-dev-worker image lacks tmux — FG-535 tmux tests hard-fail in every agent container (10 failures per run; agents must apt-get install tmux to get a green suite)
created: 2026-07-13
closed: 2026-07-14
closed_commit: b3d77b3
---

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (Slice 0)
**Blocks:** nothing structurally — but it poisons the test signal every other slice depends on, which is
why it runs first.

## Problem

`docker/agent-dev-worker.Dockerfile` does not install `tmux`. FG-535's launch tests exercise the real
tmux-owned launch path, so **10 tests hard-fail in every agent container, on every run.**

The cost is not the ten failures. It is that **every agent's suite looks red**, so:

- every session re-litigates whether the redness is a regression from the diff under review;
- an implementer can honestly report `tests_run > 0` with failures and be indistinguishable from one that
  broke something;
- agents have taken to `apt-get install tmux` mid-task to get a green suite — an undeclared, unreproducible
  environment mutation inside a supposedly fixed image;
- a real tmux regression would be **invisible**, buried in expected noise.

They pass on the host and in CI. This is a **test-environment parity gap**, not a product defect.

## Scope

Add the minimum supported `tmux` dependency to `docker/agent-dev-worker.Dockerfile`, **or** prove a cleaner
test-environment mechanism that does **not** skip the production behavior.

**Explicitly NOT an ownership change (BD-1, BD-2, BD-8).** This is test-tool availability. Agents do **not**
use tmux to own their own task work — tmux owns long *host-side* Forge commands, and that boundary is
unchanged. Do not let "make the tests pass" drift into "let agents launch under tmux."

## Acceptance Criteria

**First, record the PRE-FIX INVENTORY.** Before changing anything, run the launch tier inside the **current**
`agent-dev-worker` image and record the **exact test inventory**: every test in the tier, its outcome, and —
critically — **every existing INTENTIONAL skip together with its stated reason.** Closure is judged against
this inventory. Without it, "no skips" is unmeasurable and a pre-existing skip can be silently reclassified
as either a success or a new problem.

Closure means **all** of:

- **No tmux-caused failures and no tmux-caused skips.**
- **Every test intended to exercise the production tmux path actually RUNS** (it is not skipped, stubbed,
  or gated away).
- **No NEW skip is introduced to obtain green.** Adding a skip to turn a failure green is a coverage
  regression wearing a green suite, and it fails this ticket.
- **Pre-existing intentional skips unrelated to tmux are NOT silently pulled into FG-551's scope** — but they
  **must be listed explicitly**, with their reasons, in the closure evidence. They are neither fixed here nor
  hidden here.
- **Skipping the production behavior remains forbidden.** If a test is skipped rather than made to pass, the
  production behavior it covered must be shown to be covered elsewhere, explicitly — otherwise the skip is a
  coverage regression disguised as a green suite.

Additionally:

- The image is rebuilt and the tier is executed **inside it** — a host-side or CI-side pass does not
  satisfy this, because the host and CI already pass today. That is the whole point.
- No agent needs to mutate its own environment to get a green suite; the `apt-get install tmux` workaround
  is gone.
- Work ownership is unchanged: no agent owns its task work under tmux; the FG-535/FG-536 boundaries (BD-2)
  are untouched.
- A regression guard prevents the image from silently losing tmux again.

## RECORDED EVIDENCE — pre-fix inventory and post-fix result

Reproduce either half with **`docker/verify-launch-tier-in-image.sh`** (builds the agent image via
`docker/build.sh`, runs the launch tier **inside** the built image with the TAP reporter, prints the exact
per-test inventory, and **exits non-zero on any failure OR any skip** — a skip is a failure here on purpose).

### PRE-FIX — `agent-dev-worker:latest`, tmux ABSENT (`command -v tmux` → not found)

```
# tests 36   # pass 26   # fail 10   # skipped 0   # todo 0
```

**Intentional skips present pre-fix: ZERO.** The tier had no intentional skips of any kind, so there are no
unrelated skips to carry forward, exclude from scope, or disentangle. Closure is unambiguous.

**All 10 failures asserted the same message — `these tests require tmux — install it`** — thrown from the
file-wide `before()` hook at `src/v2/launch-cli.integration.test.ts:62`. A throwing `before` hook fails every
test in the file, which is why these are hard FAILURES and not skips. The ten:

1. FG-535 CLI: a FAST command keeps its durable record and its inspectable pane (remain-on-exit is armed before the command runs)
2. FG-535 tmux: a command that finishes BEFORE remain-on-exit could be armed still keeps its record
3. FG-535 CLI: tmux owns the process — it outlives the submitting CLI call, which returns at once
4. FG-535 CLI: the persisted owner pid names the REAL live process that owns the command
5. FG-535 CLI: a REAL SIGTERM records WIFSIGNALED evidence and still refuses to name a sender
6. FG-535 CLI: killing the OWNER itself (the wrapper, SIGKILL — no exit record possible) reads owner_gone, not running-forever
7. FG-535 CLI: a wrapper that FAILS its last-act write (I/O failure, no kill at all) also reads owner_gone — which is why the claim stays indeterminate
8. FG-535 CLI: a command that DELIBERATELY exits 143 is not reported as a kill
9. FG-535 CLI: list and show render the operator surface, and rm cleans up
10. FG-535 CLI: rm refuses a RUNNING launch without --force — removal must never be what kills the work

### POST-FIX — rebuilt image, tmux 3.2a at `/usr/bin/tmux`

```
# tests 41   # pass 41   # fail 0   # skipped 0   # todo 0
```

`docker/verify-launch-tier-in-image.sh` → **exit 0**, *"PASS: 41 tests ran inside agent-dev-worker, all
passed, none skipped."*

All 10 above now pass. The 5 new FG-551 guard tests pass. **No new skip was introduced** (skip count is 0
both before and after), and `src/v2/launch-cli.integration.test.ts` is **byte-identical** to its pre-fix
state — no launch test was skipped, stubbed, gated, or weakened.

> **Rejected during review:** a fixer attempt added an "integration test" titled *"execute the real launch
> tier in the shipped image"* that **never invoked Docker** — it ran the tier in the ambient process and
> simulated the pre-fix image with a PATH shim making `tmux -V` exit 127. A test whose name claims
> verification it does not perform is worse than no test. It was discarded. The script above does the real
> thing, and its result is reproducible by anyone with a Docker daemon.

## Falsification

Per the PRD's campaign rule — **the guard must be observed RED against the pre-fix image.** Build the
current `agent-dev-worker`, run the launch tier inside it, and capture the 10 failures. A guard that cannot
go red against the unfixed image proves nothing.
