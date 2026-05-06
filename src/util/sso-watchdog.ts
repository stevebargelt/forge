// SSO watchdog. Started when a run begins; killed on completion or SIGINT/SIGTERM.
// In v0 this is a thin placeholder: spawn a child process if a watchdog script is available
// at $FORGE_SSO_WATCHDOG, otherwise log that none is configured.
//
// The interface is stable so workflows that need it (long investigations, multi-hour feature runs)
// can wire in Terry's run-sso-watchdog.sh by setting FORGE_SSO_WATCHDOG=/path/to/script.

import { spawn, ChildProcess } from "node:child_process";

let watchdog: ChildProcess | null = null;

export function startSsoWatchdog(runId: string): void {
  const script = process.env.FORGE_SSO_WATCHDOG;
  if (!script) return;
  if (watchdog) return;
  watchdog = spawn(script, [runId], { stdio: "ignore", detached: false });
  watchdog.on("exit", () => {
    watchdog = null;
  });
}

export function stopSsoWatchdog(): void {
  if (watchdog && !watchdog.killed) {
    watchdog.kill("SIGTERM");
    watchdog = null;
  }
}

process.on("SIGINT", () => {
  stopSsoWatchdog();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopSsoWatchdog();
  process.exit(143);
});
