// SSO watchdog lifecycle. Started when a forge run begins; stopped when the run completes.
//
// Design (FORGE-DEC-013):
//   - The watchdog is a host-side shell script that polls AWS SSO cache expiry and
//     refreshes silently via the SSO refresh token (or via browser login if the refresh
//     token has also expired). Path comes from FORGE_SSO_WATCHDOG.
//   - We spawn it DETACHED + unref()'d. forge invocations are short-lived (one `forge
//     next` call per phase, typically); the watchdog must outlive each invocation so
//     long-running docker children continue to see fresh creds via the mounted ~/.aws.
//   - Lifecycle is tracked via a PID file at ~/.forge/sso-watchdog.pid. Subsequent
//     forge calls check if a watchdog is already running and skip the start; the run's
//     completion path stops it explicitly.
//   - No SIGINT/SIGTERM cleanup in this module — by design. If forge is killed, the
//     watchdog keeps running so any active docker children still get refreshes. The
//     next `forge next` or `forge gate` invocation will see the run is complete and
//     stop the watchdog cleanly.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Resolve the PID file path at call time, not at module load. paths.ts captures
// FORGE_HOME at module load too, so reading from there directly would lock us into
// whatever value of FORGE_HOME was set when paths.ts first loaded — fine in production,
// brittle in tests that want to override FORGE_HOME per-test.
function pidFile(): string {
  const forgeHome = process.env.FORGE_HOME ?? join(homedir(), ".forge");
  return join(forgeHome, "sso-watchdog.pid");
}

// #118: watchdog log path. Single append-only file so it tail-able with
// `forge auth watchdog-tail`. The script already timestamps each line so a
// single log stays grep-friendly across multiple watchdog restarts.
export function ssoWatchdogLogFile(): string {
  const forgeHome = process.env.FORGE_HOME ?? join(homedir(), ".forge");
  return join(forgeHome, "sso-watchdog.log");
}

export function startSsoWatchdog(runId: string): void {
  const script = process.env.FORGE_SSO_WATCHDOG;
  if (!script) return;
  if (!existsSync(script)) return;
  if (isWatchdogRunning()) return;
  // Ensure the directory holding the PID file exists. We resolve it locally so we
  // don't accidentally create dirs at a stale FORGE_HOME captured by paths.ts.
  mkdirSync(dirname(pidFile()), { recursive: true });

  // #118: redirect watchdog stdout+stderr to a log so failures (wrong profile,
  // missing aws cli, network blip) leave a trace instead of vanishing into
  // /dev/null. Open append-only; user rotates manually if it grows.
  const logFd = openSync(ssoWatchdogLogFile(), "a");
  const child = spawn("bash", [script, runId], {
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  // Unref so the watchdog doesn't keep the forge event loop alive after dispatch.
  child.unref();
  if (typeof child.pid === "number") {
    writeFileSync(pidFile(), String(child.pid));
  }
}

export function stopSsoWatchdog(): void {
  const file = pidFile();
  if (!existsSync(file)) return;
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number(raw);
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already dead or not ours; fall through and clean up the PID file.
    }
  }
  try {
    unlinkSync(file);
  } catch {
    // Already removed; harmless.
  }
}

export function isWatchdogRunning(): boolean {
  const file = pidFile();
  if (!existsSync(file)) return false;
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  // Signal 0 doesn't actually deliver a signal — it just probes whether the pid is
  // alive and we have permission to signal it.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH (no such process) or EPERM. Either way, it's not a watchdog we can manage.
    // Clean up the stale PID file so the next start spawns a fresh one.
    try {
      unlinkSync(file);
    } catch {
      // ignore
    }
    return false;
  }
}

// Test seam: read the PID-file path resolved against the current env. Tests override
// FORGE_HOME and call this to know where the file lives.
export function _ssoWatchdogPidFile(): string {
  return pidFile();
}
