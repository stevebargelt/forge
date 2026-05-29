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

import { spawn as cpSpawn, execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { startIdleWatchdog, resolveIdleTimeoutMs, IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";

export type DockerExecArgs = {
  args: string[];
  stdin: string | undefined;
  stdoutPath: string;
  stderrPath: string;
  // Resolved idle timeout (ms) for this run — caller computes it via
  // resolveIdleTimeoutMs(runtime.container.idle_timeout_seconds) so runtime YAML
  // + env override are honored. Falls back to env/default when omitted.
  idleTimeoutMs?: number;
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

export const defaultDockerExec: DockerExecFn = async ({ args, stdin, stdoutPath, stderrPath, idleTimeoutMs }) => {
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
        if (--pending === 0) resolve(killedForIdle ? IDLE_TIMEOUT_EXIT_CODE : (code ?? 1));
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
