// Shared docker executor for both the invoke path (invoke.ts) and the pipeline
// path (runNext.ts). Single source of truth so liveness/streaming fixes can't
// land in one path and miss the other (they did diverge once — #173/#174).
//
// PRODUCTION DEFAULT (FG-536): agents run DETACHED — see detachedDockerExec
// below; the daemon owns the container and the host process is a disposable
// watcher. The attached executor (defaultDockerExec) remains for the
// dependency provisioner, imageIndex-less legacy callers, and the
// FORGE_DETACHED_EXEC=off escape hatch. In attached mode each agent runs as a
// foreground `docker run --name forge-<taskId> ...`; stdout/stderr stream to
// disk live and an idle watchdog rides the chunks. On idle, killing the docker
// CLI client is NOT enough — SIGKILL can't be forwarded, so the daemon keeps
// the container running and the agent orphans. We `docker kill <name>` the
// container itself (authoritative), then kill the client to unblock the stream.
//
// FG-492: task containers no longer run with `--rm` (see spawn.ts), so a
// failed container survives long enough to `docker inspect` for causal
// evidence and to be reviewed via `forge show` / `forge ops reap-containers`.
// FG-492 review: this module captures that evidence at close, but does NOT
// decide reap-vs-retain itself anymore — the container's exit code alone
// doesn't say whether the TASK succeeded (a clean exit with no result.json is
// exactly the case worth investigating). The caller (invoke.ts / runNext.ts /
// reconcile.ts) makes that call once it knows the real outcome, via
// shouldRetainContainer / finalizeContainerRetention below.

import { spawn as cpSpawn, execFile, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, createWriteStream, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startIdleWatchdog, resolveIdleTimeoutMs, IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { parseDockerInspectState, type ContainerCausalEvidence } from "./failure-kind.js";

export type DockerExecArgs = {
  args: string[];
  stdin: string | undefined;
  stdoutPath: string;
  stderrPath: string;
  // Resolved idle timeout (ms) for this run — caller computes it via
  // resolveIdleTimeoutMs(runtime.container.idle_timeout_seconds) so runtime YAML
  // + env override are honored. Falls back to env/default when omitted.
  idleTimeoutMs?: number;
  // FG-492: called once, synchronously, with the best-effort container causal
  // evidence gathered at capture-at-close. FG-492 review: this is now the
  // ONLY thing captured here — reap/retain is decided by the caller once it
  // has validated result.json (see finalizeContainerRetention in invoke.ts /
  // runNext.ts). Optional: DockerExecFn's return type stays `Promise<number>`
  // (unchanged — dozens of existing test fakes construct DockerExecFn
  // returning a bare number and must keep working), so this is the
  // non-breaking channel invoke.ts / runNext.ts use to attach the evidence
  // onto their container.exited / container.idle_timeout /
  // container.dependency_provisioning_failed events. A fake DockerExecFn that
  // doesn't care simply never calls it.
  onContainerEvidence?: (evidence: ContainerCausalEvidence) => void;
  // FG-492 finding 2: true for the short-lived dependency-provisioner container
  // (spawn.ts's buildProvisionerDockerArgs, invoked from runNext.ts's
  // provisionDependencyCache call site). FG-437 owns that container's own
  // lifecycle and it already runs with --rm — it was explicitly out of scope
  // for FG-492's capture-at-close policy. Left unset (the default),
  // defaultDockerExec runs captureContainerCausalEvidence (a `docker inspect`)
  // against a container the daemon has likely already auto-removed — wasted
  // work. Set true so the close handler skips it and resolves the exit code
  // exactly as it did before FG-492. Every other exec() caller (task/reviewer
  // containers) leaves this unset and keeps the capture behavior unconditionally.
  isProvisionerExec?: boolean;
  // FG-536: index of the image in `args` (spawn.ts's BuildArgsResult.imageIndex).
  // The detached executor interposes its entry script right after it. Optional:
  // fakes and legacy callers omit it, and detachedDockerExec falls back to the
  // attached executor when it's absent (never guesses the boundary).
  imageIndex?: number;
  // FG-536 review: called once, synchronously, the moment the container is
  // REALLY running under the daemon — for the detached executor that is after
  // `docker run -d` returns success, not before it. The caller records
  // container.started from here (invoke.ts / runNext.ts), so the durable start
  // record means "a container exists" and the watcher-death window (the span the
  // FG-530 probe kills in) begins where the container actually does.
  // The detached executor passes the container ID `docker run -d` printed —
  // the daemon's identity for the container, recorded alongside the name so a
  // replaced/renamed container can never be confused with the one this task
  // actually started. Attached execution has no id to offer and passes none.
  onContainerStarted?: (containerId?: string) => void;
};

export type DockerExecFn = {
  (args: DockerExecArgs): Promise<number>;
  // FG-536 review: set on the executors here, which report a real container
  // start via onContainerStarted. Test fakes and legacy executors leave it
  // unset, and their callers record the start up-front (they have no other
  // signal) — see runContainer / invoke.
  signalsContainerStart?: boolean;
};

// The container name buildDockerArgs put after `--name` (spawn.ts always emits
// it). Lets the watchdog kill the container, not just the local docker client.
export function containerNameFromArgs(args: string[]): string | undefined {
  const i = args.indexOf("--name");
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

// Stop the container under the daemon. SIGKILLing only the `docker run` client
// leaves the container orphaned (SIGKILL can't be forwarded), so this is the
// authoritative kill. Best-effort: errors are swallowed (container may already
// be gone). Injectable for testing.
export function killContainer(
  containerName: string | undefined,
  execFileFn: typeof execFile = execFile,
): void {
  if (!containerName) return;
  execFileFn("docker", ["kill", containerName], () => {});
}

// FG-492: best-effort `docker inspect` on a task container right after its
// process exits. Task containers no longer run with `--rm` (spawn.ts) so the
// container is reliably still inspectable here, before finalizeContainerRetention
// below may remove it. Never throws — mirrors reconcile.ts's
// defaultContainerExitInfo posture; an unreachable daemon or an
// already-vanished container just yields the observed-only shape (still
// evidence: "Forge watched this exit; docker itself couldn't be probed after").
// FG-536: `inspectRef` is what docker is ASKED about (the daemon's container ID
// when the detached executor has one — a name can be re-bound to a replacement
// container the moment the original exits); `containerName` stays what the
// evidence REPORTS, so `forge show` keeps naming forge-<taskId>. They differ only
// on the detached path; every other caller passes the name and gets today's behavior.
export function captureContainerCausalEvidence(
  containerName: string | undefined,
  execFileSyncFn: typeof execFileSync = execFileSync,
  inspectRef: string | undefined = containerName,
): ContainerCausalEvidence {
  const base: ContainerCausalEvidence = {
    containerName: containerName ?? "(unknown)",
    containerExitedEventObserved: true,
  };
  if (!inspectRef) return base;
  try {
    const raw = execFileSyncFn("docker", ["inspect", inspectRef], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    const parsed = parseDockerInspectState(raw);
    return {
      ...base,
      ...(parsed.startedAt !== undefined ? { startedAt: parsed.startedAt } : {}),
      ...(parsed.finishedAt !== undefined ? { finishedAt: parsed.finishedAt } : {}),
      ...(parsed.exitCode !== undefined ? { dockerExitCode: parsed.exitCode } : {}),
      ...(parsed.signal !== undefined ? { signal: parsed.signal } : {}),
      ...(parsed.oomKilled !== undefined ? { oomKilled: parsed.oomKilled } : {}),
      ...(parsed.dockerStateError !== undefined ? { dockerStateError: parsed.dockerStateError } : {}),
    };
  } catch {
    return base;
  }
}

// FG-492 review: retention decision for a task container, keyed on whether the
// TASK actually succeeded — not on the container's raw exit code. A clean
// exit (0) that never produced a usable result.json, or a pipeline step whose
// host-side finalize never ran, is exactly the case worth investigating; the
// old exitCode-based check reaped it anyway, at the moment it mattered most.
// Default posture: reap a genuine success (nothing to investigate) and retain
// anything else (evidence for `forge show --json` / `forge ops reap-containers`
// until an operator or the reaper cleans it up). FORGE_CONTAINER_RETENTION=off
// disables retention entirely — an escape hatch for a host that can't afford
// accumulating stopped containers.
export function shouldRetainContainer(taskSucceeded: boolean): boolean {
  if (process.env.FORGE_CONTAINER_RETENTION === "off") return false;
  return !taskSucceeded;
}

export type ContainerReapOutcome = "reaped" | "retained" | "reap_failed";

// Best-effort `docker rm -f` — never throws. "reap_failed" (docker error, NOT
// confirmed gone) is distinct from "retained" (a deliberate policy decision) so
// a caller/test can tell a daemon hiccup apart from "we chose to keep this."
// Callers invoke this once they know the task's real outcome (see
// shouldRetainContainer above) — invoke.ts / runNext.ts call it right after
// result.json is validated; reconcile.ts calls its own equivalent once it
// knows whether the task it just reconciled actually completed.
export function finalizeContainerRetention(
  containerName: string | undefined,
  taskSucceeded: boolean,
  execFileSyncFn: typeof execFileSync = execFileSync,
): ContainerReapOutcome {
  if (!containerName) return "retained";
  if (shouldRetainContainer(taskSucceeded)) return "retained";
  try {
    // -v: task containers no longer run --rm, so the anonymous node_modules
    // shadow volume (DEC-019) must be removed with the container or it leaks.
    execFileSyncFn("docker", ["rm", "-f", "-v", containerName], { stdio: ["ignore", "ignore", "ignore"] });
    return "reaped";
  } catch {
    return "reap_failed";
  }
}

export const defaultDockerExec: DockerExecFn = async ({ args, stdin, stdoutPath, stderrPath, idleTimeoutMs, onContainerEvidence, isProvisionerExec, onContainerStarted }) => {
  return new Promise<number>((resolve) => {
    const proc = cpSpawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    // Attached: the client owns the container from the spawn onward, so this is
    // as close to "the container is up" as this executor can get.
    onContainerStarted?.();
    // Stream to disk live (not buffered-until-close): partial logs are readable
    // mid-run by the dashboard/humans, and a noisy 30-min agent doesn't grow an
    // unbounded in-memory buffer.
    const outStream = createWriteStream(stdoutPath);
    const errStream = createWriteStream(stderrPath);
    // createWriteStream opens the fd ASYNCHRONOUSLY, so an open failure (the task
    // dir went away, a full disk) surfaces as an 'error' event some ticks later —
    // possibly after this executor has already resolved, e.g. on the spawn-error
    // path below. With no listener that event is an unhandled 'error' and takes the
    // whole forge process down over a LOG file. Logs are evidence, not control flow:
    // absorb it. The exit code, the result.json and the container evidence are all
    // decided elsewhere and none of them depend on these streams.
    outStream.on("error", () => { /* log-file write failure — never fatal to the run */ });
    errStream.on("error", () => { /* log-file write failure — never fatal to the run */ });
    const containerName = containerNameFromArgs(args);

    // Idle watchdog (#173): each stdout/stderr chunk is a sign of life; silence
    // past the timeout means the agent is hung — kill it so the task fails fast
    // instead of sitting "running" forever.
    let killedForIdle = false;
    const idleMs = idleTimeoutMs ?? resolveIdleTimeoutMs();
    const watchdog = startIdleWatchdog(idleMs, () => {
      killedForIdle = true;
      killContainer(containerName); // authoritative — stop the container itself
      proc.kill("SIGKILL"); // backstop, in case the container is already gone
    });

    proc.stdout.on("data", (c: Buffer) => {
      outStream.write(c);
      watchdog.bump();
    });
    proc.stderr.on("data", (c: Buffer) => {
      errStream.write(c);
      watchdog.bump();
    });

    proc.on("close", (code) => {
      watchdog.stop();
      // Flush both streams before resolving so downstream readers
      // (captureUsageForTask, result.json) see the complete file.
      let pending = 2;
      const settle = () => {
        if (--pending === 0) {
          const exitCode = killedForIdle ? IDLE_TIMEOUT_EXIT_CODE : (code ?? 1);
          // FG-492: capture-at-close — the container is not auto-removed
          // (spawn.ts drops --rm for task containers), so it's still
          // inspectable right here. FG-492 review: reap/retain is NOT decided
          // here anymore — the exit code alone can't say whether the task
          // succeeded (a clean exit with no result.json is the case worth
          // investigating). The caller reaps or retains once it has validated
          // result.json — see finalizeContainerRetention's callers in
          // invoke.ts / runNext.ts. FG-492 finding 2: capture is skipped for
          // the provisioner — it keeps its own --rm (FG-437 owns its
          // lifecycle), so by the time we get here it's typically already
          // gone; a docker inspect against it is wasted work, not evidence
          // gathering.
          if (!isProvisionerExec) {
            onContainerEvidence?.(captureContainerCausalEvidence(containerName));
          }
          resolve(exitCode);
        }
      };
      outStream.end(settle);
      errStream.end(settle);
    });
    proc.on("error", () => {
      watchdog.stop();
      outStream.end();
      errStream.end();
      resolve(1);
    });
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
};

// ── FG-536: detached execution — the container survives host-side parent death ──
//
// The attached executor above proxies signals: SIGTERM of the forge CLI reaches
// the `docker run` client, which forwards it into the container — a harness
// sweep of the CLI's process tree (si_pid-proven, FG-535) kills the agent
// mid-work. Detached execution severs that lifeline BY CONSTRUCTION:
//
//   docker run -d …            the daemon owns the container
//   docker logs -f <name>      a WATCHER streams output to disk + feeds the
//                              idle watchdog — it may die freely; logs live in
//                              the daemon and re-attach re-delivers them
//   docker wait <name>         a second watcher collects the exit code
//
// If the CLI dies mid-wait the container runs to completion, writes
// /task/result.json through its bind mount, and exits normally; the next
// reconcile pass finalizes the task from that REAL result through the ordinary
// container-gone evidence path (validation contract included, FG-523) — the
// recovery model is unchanged, only the container's survival is new.
//
// stdin delivery: a detached container has no client pipe, so the payload goes
// through the /task bind mount instead — the SAME BYTES land on the agent
// CLI's fd0 via an entry script (`exec "$@" < /task/detached-stdin`). The
// script takes the original command as "$@", so every argv element stays a
// separate arg (FG-497's per-arg E2BIG bound is unchanged — nothing is merged
// into one shell string).
//
// The dependency provisioner stays ATTACHED deliberately: FG-437 owns its
// lifecycle (short-lived, --rm, provision_* events), and its crash windows are
// separately swept. Fallback to attached is also taken when imageIndex is
// absent (a legacy caller) — the boundary is never guessed.

export const DETACHED_STDIN_FILE = "detached-stdin";
export const DETACHED_ENTRY_FILE = "detached-entry.sh";

/** The argv transformation, pure and testable: `run -i […] IMAGE cmd…` →
 *  `run -d […] IMAGE sh /task/detached-entry.sh cmd…`. `-i` (an option, so
 *  always before the image) is replaced in place; without one, `-d` is
 *  inserted right after `run` and the image position shifts by one. */
export function toDetachedArgs(args: string[], imageIndex: number): string[] {
  const out = [...args];
  const iFlag = out.indexOf("-i");
  let idx = imageIndex;
  if (iFlag > 0 && iFlag < imageIndex) {
    out.splice(iFlag, 1, "-d");
  } else {
    out.splice(1, 0, "-d");
    idx = imageIndex + 1;
  }
  out.splice(idx + 1, 0, "sh", `/task/${DETACHED_ENTRY_FILE}`);
  return out;
}

/** Entry script content. With a stdin payload the command's fd0 is the mounted
 *  file; without one it inherits /dev/null (docker -d default). */
export function detachedEntryScript(hasStdin: boolean): string {
  return hasStdin ? `#!/bin/sh\nexec "$@" < /task/${DETACHED_STDIN_FILE}\n` : `#!/bin/sh\nexec "$@"\n`;
}

export const detachedDockerExec: DockerExecFn = async (execArgs) => {
  const { args, stdin, stdoutPath, stderrPath, idleTimeoutMs, onContainerEvidence, isProvisionerExec, imageIndex, onContainerStarted } = execArgs;
  // Provisioner and boundary-unknown callers keep the attached executor.
  if (isProvisionerExec || imageIndex === undefined || args[imageIndex] === undefined) {
    return defaultDockerExec(execArgs);
  }

  const taskDir = dirname(stdoutPath);
  const containerName = containerNameFromArgs(args);
  try {
    writeFileSync(join(taskDir, DETACHED_ENTRY_FILE), detachedEntryScript(stdin !== undefined));
    chmodSync(join(taskDir, DETACHED_ENTRY_FILE), 0o755);
    if (stdin !== undefined) writeFileSync(join(taskDir, DETACHED_STDIN_FILE), stdin);
  } catch (e) {
    appendFileSync(stderrPath, `forge detached exec: failed to stage entry/stdin files — ${(e as Error).message}\n`);
    return 1;
  }

  const detachedArgs = toDetachedArgs(args, imageIndex);

  // Start detached. `docker run -d` returns once the container is created and
  // started; a failure here (bad image, name clash) is a plain failure.
  const started = await new Promise<{ ok: boolean; containerId?: string }>((resolve) => {
    execFile("docker", detachedArgs, (err, stdout, stderr) => {
      if (err) {
        try { appendFileSync(stderrPath, String(stderr ?? err.message)); } catch { /* best-effort */ }
        resolve({ ok: false });
      } else {
        // `docker run -d` prints the new container's ID — the daemon's
        // authoritative identity, recorded so the task's start evidence names
        // more than a reusable container NAME. Success is the exit status;
        // the id is evidence, and its absence never fails the launch.
        const containerId = String(stdout).trim();
        resolve({ ok: true, ...(containerId !== "" ? { containerId } : {}) });
      }
    });
  });
  if (!started.ok) return 1;
  // The container exists under the daemon from here on: every span below is the
  // watcher half, which the host may lose without touching the run.
  onContainerStarted?.(started.containerId);

  // Every docker call below addresses the daemon's container ID when we have it.
  // `forge-<taskId>` is REUSABLE: the moment this container exits, a retry can
  // bind the name to a different container — and a `docker kill` or `docker
  // inspect` racing that would hit the replacement. The ID cannot be re-bound.
  const containerRef = started.containerId ?? containerName;

  return new Promise<number>((resolve) => {
    const outStream = createWriteStream(stdoutPath);
    const errStream = createWriteStream(stderrPath, { flags: "a" });
    // Same rule as the attached executor: a log-file write failure is never fatal.
    outStream.on("error", () => { /* log-file write failure — never fatal to the run */ });
    errStream.on("error", () => { /* log-file write failure — never fatal to the run */ });

    // The WATCHER half: docker logs -f re-delivers the container's output from
    // t=0 and keeps streaming. It is disposable — if this process dies, the
    // container is untouched and a later reconcile finalizes from disk.
    const logsProc = cpSpawn("docker", ["logs", "-f", containerRef ?? ""], { stdio: ["ignore", "pipe", "pipe"] });

    let killedForIdle = false;
    const idleMs = idleTimeoutMs ?? resolveIdleTimeoutMs();
    const watchdog = startIdleWatchdog(idleMs, () => {
      killedForIdle = true;
      killContainer(containerRef); // authoritative — the daemon stops the container
    });

    logsProc.stdout.on("data", (c: Buffer) => {
      outStream.write(c);
      watchdog.bump();
    });
    logsProc.stderr.on("data", (c: Buffer) => {
      errStream.write(c);
      watchdog.bump();
    });
    logsProc.on("error", () => { /* watcher-only failure — never fatal to the run */ });

    // The WAITER half: docker wait blocks until the container exits and prints
    // its exit code. Also disposable — reconcile is the backstop.
    execFile("docker", ["wait", containerRef ?? ""], (err, stdout) => {
      watchdog.stop();
      // Give the log stream a beat to drain the final chunks, then settle.
      setTimeout(() => {
        try { logsProc.kill(); } catch { /* already gone */ }
        let pending = 2;
        const settle = () => {
          if (--pending === 0) {
            const code = err ? 1 : Number(String(stdout).trim());
            const exitCode = killedForIdle ? IDLE_TIMEOUT_EXIT_CODE : (Number.isInteger(code) ? code : 1);
            onContainerEvidence?.(captureContainerCausalEvidence(containerName, execFileSync, containerRef));
            resolve(exitCode);
          }
        };
        outStream.end(settle);
        errStream.end(settle);
      }, 250);
    });
  });
};

// The production default: detached unless explicitly disabled. The attached
// executor remains reachable via FORGE_DETACHED_EXEC=off (operational escape
// hatch) and for the provisioner/legacy-caller fallbacks above.
export const productionDockerExec: DockerExecFn = (execArgs) =>
  process.env.FORGE_DETACHED_EXEC === "off" ? defaultDockerExec(execArgs) : detachedDockerExec(execArgs);

defaultDockerExec.signalsContainerStart = true;
detachedDockerExec.signalsContainerStart = true;
productionDockerExec.signalsContainerStart = true;
