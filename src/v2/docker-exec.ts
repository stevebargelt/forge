// Shared docker executor for both the invoke path (invoke.ts) and the pipeline
// path (runNext.ts). Single source of truth so liveness/streaming fixes can't
// land in one path and miss the other (they did diverge once — #173/#174).
//
// Each agent runs as `docker run --name forge-<taskId> ...` in the foreground;
// we stream its stdout/stderr to disk live and run an idle watchdog over the
// stdout chunks. On idle, killing the docker CLI client is NOT enough — SIGKILL
// can't be forwarded, so the daemon keeps the container running and the agent
// orphans. We `docker kill <name>` the container itself (authoritative), then
// kill the client to unblock the stream.
//
// FG-492: task containers no longer run with `--rm` (see spawn.ts) — this
// module owns the reap/retain decision instead (see finalizeContainerRetention),
// so a failed container survives long enough to `docker inspect` for causal
// evidence and to be reviewed via `forge show` / `forge ops reap-containers`.

import { spawn as cpSpawn, execFile, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
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
  // evidence gathered at capture-at-close — just before this function decides
  // whether to reap or retain the container (see shouldRetainContainer below).
  // Optional: DockerExecFn's return type stays `Promise<number>` (unchanged —
  // dozens of existing test fakes construct DockerExecFn returning a bare
  // number and must keep working), so this is the non-breaking channel invoke.ts
  // / runNext.ts use to attach the evidence onto their container.exited /
  // container.idle_timeout / container.dependency_provisioning_failed events. A
  // fake DockerExecFn that doesn't care simply never calls it.
  onContainerEvidence?: (evidence: ContainerCausalEvidence) => void;
  // FG-492 finding 2: true for the short-lived dependency-provisioner container
  // (spawn.ts's buildProvisionerDockerArgs, invoked from runNext.ts's
  // provisionDependencyCache call site). FG-437 owns that container's own
  // lifecycle and it already runs with --rm — it was explicitly out of scope
  // for FG-492's capture-at-close/retention policy. Left unset (the default),
  // defaultDockerExec runs captureContainerCausalEvidence (a `docker inspect`)
  // and finalizeContainerRetention (a `docker rm -f`) against a container the
  // daemon has likely already auto-removed — wasted work, and in the reap
  // case a no-op error swallowed silently. Set true so the close handler skips
  // both and resolves the exit code exactly as it did before FG-492. Every
  // other exec() caller (task/reviewer containers) leaves this unset and keeps
  // the new capture/reap behavior unconditionally.
  isProvisionerExec?: boolean;
};

export type DockerExecFn = (args: DockerExecArgs) => Promise<number>;

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
export function captureContainerCausalEvidence(
  containerName: string | undefined,
  execFileSyncFn: typeof execFileSync = execFileSync,
): ContainerCausalEvidence {
  const base: ContainerCausalEvidence = {
    containerName: containerName ?? "(unknown)",
    containerExitedEventObserved: true,
  };
  if (!containerName) return base;
  try {
    const raw = execFileSyncFn("docker", ["inspect", containerName], {
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

// FG-492: retention decision for a task container after its process exits.
// Default posture: reap a clean exit (nothing to investigate) and retain a
// failure (evidence for `forge show --json` / `forge ops reap-containers`
// until an operator or the reaper cleans it up). FORGE_CONTAINER_RETENTION=off
// disables retention entirely — an escape hatch for a host that can't afford
// accumulating stopped containers.
export function shouldRetainContainer(exitCode: number): boolean {
  if (process.env.FORGE_CONTAINER_RETENTION === "off") return false;
  return exitCode !== 0;
}

export type ContainerReapOutcome = "reaped" | "retained" | "reap_failed";

// Best-effort `docker rm -f` — never throws. "reap_failed" (docker error, NOT
// confirmed gone) is distinct from "retained" (a deliberate policy decision) so
// a caller/test can tell a daemon hiccup apart from "we chose to keep this."
export function finalizeContainerRetention(
  containerName: string | undefined,
  exitCode: number,
  execFileSyncFn: typeof execFileSync = execFileSync,
): ContainerReapOutcome {
  if (!containerName) return "retained";
  if (shouldRetainContainer(exitCode)) return "retained";
  try {
    execFileSyncFn("docker", ["rm", "-f", containerName], { stdio: ["ignore", "ignore", "ignore"] });
    return "reaped";
  } catch {
    return "reap_failed";
  }
}

export const defaultDockerExec: DockerExecFn = async ({ args, stdin, stdoutPath, stderrPath, idleTimeoutMs, onContainerEvidence, isProvisionerExec }) => {
  return new Promise<number>((resolve) => {
    const proc = cpSpawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    // Stream to disk live (not buffered-until-close): partial logs are readable
    // mid-run by the dashboard/humans, and a noisy 30-min agent doesn't grow an
    // unbounded in-memory buffer.
    const outStream = createWriteStream(stdoutPath);
    const errStream = createWriteStream(stderrPath);
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
          // inspectable right here, before the retention decision below may
          // remove it. FG-492 finding 2: skipped for the provisioner — it
          // keeps its own --rm (FG-437 owns its lifecycle), so by the time we
          // get here it's typically already gone; a docker inspect/rm -f
          // against it is wasted work, not evidence gathering.
          if (!isProvisionerExec) {
            onContainerEvidence?.(captureContainerCausalEvidence(containerName));
            finalizeContainerRetention(containerName, exitCode);
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
