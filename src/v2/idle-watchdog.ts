// Idle watchdog for containerized agents.
//
// A hung agent (e.g. a model stream that never returns its first byte) produces
// zero stdout while its container stays alive — the failure mode that left
// task-task-718ad0 "running" for an hour (#173). Detection rides the live
// stdout `data` events the host already receives: every chunk calls bump(); if
// no chunk arrives within `idleMs`, onIdle() fires (the exec path SIGKILLs the
// container). This measures the GAP between chunks, not total runtime, so a
// busy long task that streams steadily never trips. Disabled when idleMs <= 0.

export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

// Exit code the docker exec returns when it kills a container for idleness.
// 124 is the conventional timeout(1) "command timed out" code; the agent never
// produces it on its own, so the caller can treat it as an unambiguous signal.
export const IDLE_TIMEOUT_EXIT_CODE = 124;

// Precedence: FORGE_AGENT_IDLE_TIMEOUT_MS env override > runtime YAML
// (container.idle_timeout_seconds) > hardcoded default. Real runtimes always
// carry a value (the zod schema defaults idle_timeout_seconds to 300), so the
// hardcoded default is only the fallback when no runtime is in play (tests).
export function resolveIdleTimeoutMs(
  runtimeSeconds?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.FORGE_AGENT_IDLE_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n; // 0 disables
  }
  if (runtimeSeconds !== undefined && Number.isFinite(runtimeSeconds) && runtimeSeconds >= 0) {
    return runtimeSeconds * 1000;
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

export type IdleWatchdog = { bump: () => void; stop: () => void };

export function startIdleWatchdog(idleMs: number, onIdle: () => void): IdleWatchdog {
  if (idleMs <= 0) return { bump: () => {}, stop: () => {} };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = () => {
    timer = setTimeout(() => {
      if (!stopped) onIdle();
    }, idleMs);
    // Don't let a live watchdog by itself keep the process alive.
    timer.unref?.();
  };

  const bump = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    arm();
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  arm(); // start the clock at spawn — catches an agent that never emits a byte
  return { bump, stop };
}
