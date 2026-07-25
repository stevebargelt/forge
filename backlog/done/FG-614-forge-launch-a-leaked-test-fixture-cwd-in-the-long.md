---
id: FG-614
type: story
status: done
title: "forge launch: a leaked test-fixture cwd in the long-lived tmux server bricks every future launch host-wide"
created: 2026-07-25
closed: 2026-07-25
closed_commit: d92a063
---

## What happened (2026-07-24, hit live during FG-607)

Every `forge launch run` on the host began failing instantly with:

```
Error: ENOENT: process.cwd failed with error no such file or directory,
the current working directory was likely removed without changing the working directory, uv_cwd
```

even for a trivial `node -e "console.log(process.cwd())"`. Cause: the long-lived **tmux server's own cwd** was
`/private/var/folders/.../T/forge-campaign-cli-proj-DTghEp` — a campaign-CLI integration-test FIXTURE directory
that the test had since deleted. Confirmed with `lsof -a -p <tmux-pid> -d cwd`.

The server outlives every session, so once its cwd is gone, sessions it forks inherit a dead cwd and any
process that calls `getcwd()` at startup (node does, via esbuild/tsx) dies before running a single line.

**`tmux new-session -c <valid absolute dir>` does NOT rescue it** — verified by hand. So passing an explicit
start directory is not a sufficient fix on its own.

Blast radius: total. `forge launch run` is the documented owner for all long-running Forge work (FG-535), so a
bricked server halts every pipeline drive, review-loop, invoke and verification run on the machine. Recovery
required `tmux kill-server`, which also killed an unrelated live dashboard that happened to be running inside a
session.

## Why this is a forge defect, not operator error

A forge TEST leaked its temp cwd into a host-wide daemon that forge itself depends on. Nothing in the launch
path notices the server is unusable, and the failure surfaces as an opaque node stack trace attributed to the
launched command rather than to the launcher.

## Scope

- **Make the server's cwd irrelevant.** Ensure the launched process starts in a directory forge controls and has
  verified exists — e.g. have the launch wrapper `chdir()` to the recorded cwd itself (falling back to a known-good
  directory) rather than relying on the inherited/`-c` cwd.
- **Detect the bricked-server condition and say so.** Before launching, probe cheaply; if the server's cwd is gone,
  fail with a NAMED, actionable message ("the tmux server's working directory no longer exists; run
  `tmux kill-server` — this will terminate N sessions, M of them live") instead of an ENOENT stack trace from node.
- **Stop tests from leaking cwd into the shared server.** Any test that starts a tmux session must run against its
  own socket (`tmux -L <name>`), not the default one, so a fixture directory can never become the host server's cwd.
  The FG-569 launch tests already use a `serverEnv` pattern; extend that discipline to every tmux-touching test.

## Acceptance Criteria

- With a tmux server whose cwd has been deleted, `forge launch run` still launches successfully (the process starts
  in the recorded cwd), OR refuses with the named diagnosis and the exact remedy — never an opaque `uv_cwd` trace.
- A regression test reproduces the condition: start a server from a temp dir, delete the dir, then assert the
  launch path behaves per the above.
- No test in the suite creates a session on the DEFAULT tmux socket.
- `forge launch show` for a launch that failed this way names the cause rather than only echoing the child's stderr.

## Non-Goals

- Not replacing tmux as the launch owner (FG-535 settled that).
- Not auto-killing the tmux server. Restarting it terminates live sessions and is the operator's call — the fix is
  to not depend on its cwd, and to diagnose clearly when it is broken.

## Acceptance Evidence

Shipped in `d92a063`, merged to main 2026-07-24. Required CI green at that commit: `test` and `test-extended`.

| AC | Evidence | Verdict |
|---|---|---|
| With a tmux server whose cwd was deleted, `forge launch run` still launches (or refuses with the named diagnosis) — never an opaque `uv_cwd` trace | The wrapper enters the cwd forge RECORDED before the command starts, so the server's cwd is irrelevant. **Driven for real on the macOS host by the orchestrator:** server started from a temp dir on an isolated socket, dir deleted, then `forge launch run` — diagnosis printed, launch SUCCEEDED, child reported the recorded cwd (`CHILD OK`) | met |
| A regression test reproduces the condition (server from a temp dir, delete it, launch) | `src/v2/fg614-launch-cwd.integration.test.ts` (8 tests) + `src/v2/fg614-server-condition.integration.test.ts` (12). **Fail-first proven:** with only the cwd fix neutralised, 5 pass / 2 FAIL — the headline case failing `exit record code 1, expected 0`, i.e. the child inheriting the dead cwd and dying reading it, which is the incident's exact shape | met |
| No test in the suite creates a session on the DEFAULT tmux socket | `src/test-setup.ts` gives every tmux-touching test a private `TMUX_TMPDIR` socket. **Proven by counterfactual, not assertion:** with the line removed, `launch-wait.integration` alone recreates `/tmp/tmux-<uid>/default`; with it, the whole unit tier plus every real-tmux integration file leaves none. `src/v2/fg614-socket-guard-teeth.integration.test.ts` proves the guard FAILS on a bypass and names the offending file | met |
| `forge launch show` names the cause rather than only echoing child stderr | Renders a "tmux server condition at submission (FG-614)" section for a launch submitted under the condition, and does not invent one otherwise | met |
| Forge does NOT auto-kill the tmux server (explicit non-goal) | The remedy is printed with its cost — "`tmux kill-server` kills N tmux session(s), M of which still hold a live process". Host-verified: a live session named `victim-live` was still alive after the launch | met |
| The probe reports only what it observed | `no_server` only when tmux answers and reports none; `unprobed` with a named reason when the probe cannot run. **Fail-first proven, and non-vacuously:** reverting the catch failed both new assertions while the `no_server` CONTROL kept passing, so the pair proves the distinction rather than a blanket state change | met |

**Platform gap, disclosed rather than papered over:** the darwin branch of `readProcCwd` (`lsof -a -p <pid> -d cwd -F n`,
`launch.ts:923-932`) cannot execute in the Linux agent container, so it shipped unexecuted by the implementer. The
orchestrator drove it end-to-end on the macOS host (see AC 1) — it correctly read
`/private/tmp/fg614-dead3 (deleted)`. It is platform-gated in tests and host-verified.

**Also fixes FG-613** — see that ticket's evidence. Per-test socket isolation took `campaign.integration.test.ts`
from 10 failures in aggregate on macOS to 127/127.
