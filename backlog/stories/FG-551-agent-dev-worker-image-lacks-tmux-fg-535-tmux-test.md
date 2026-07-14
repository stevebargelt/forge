---
id: FG-551
type: story
status: active
title: agent-dev-worker image lacks tmux — FG-535 tmux tests hard-fail in every agent container (10 failures per run; agents must apt-get install tmux to get a green suite)
created: 2026-07-13
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

- The standard `agent-dev-worker` image runs the FG-535 launch integration tier **with no failures and no
  skips**, without any in-container `apt-get`.
- The image is rebuilt and the tier is executed **inside it** — a host-side or CI-side pass does not
  satisfy this, because the host and CI already pass today. That is the whole point.
- **Skipping the tests is not an acceptable fix.** If a test is skipped rather than made to pass, the
  production behavior it covered must be shown to be covered elsewhere, explicitly, or the skip is a
  regression in coverage disguised as a green suite.
- No agent needs to mutate its own environment to get a green suite; the `apt-get install tmux` workaround
  is gone.
- Work ownership is unchanged: no agent owns its task work under tmux; the FG-535/FG-536 boundaries (BD-2)
  are untouched.
- A regression guard prevents the image from silently losing tmux again.

## Falsification

Per the PRD's campaign rule — **the guard must be observed RED against the pre-fix image.** Build the
current `agent-dev-worker`, run the launch tier inside it, and capture the 10 failures. A guard that cannot
go red against the unfixed image proves nothing.
