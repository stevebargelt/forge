// FG-576 D14: the ONE place a process fence is captured and compared.
//
// A pid alone is not an identity. Pids are recycled, and a launcher record that
// says "pid 4711" reads as ALIVE forever once some unrelated process lands on
// 4711 — that is the phantom-orchestrator failure D14 names. So a fence records
// the pid PLUS an OS-derived start token that changes when the pid is reused,
// plus the host and boot the pid is meaningful on.
//
// The three answers are deliberately distinct and none of them is a guess:
//   alive   — this exact process is still running.
//   dead    — nothing holds the pid, the pid is held by a DIFFERENT process, or
//             the machine has rebooted since the fence was taken.
//   unknown — we cannot judge (foreign host, or an OS that supplied no token).
//             "unknown" is never upgraded to "alive"; a fence we cannot read is
//             not evidence of life.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export type ProcessIdentity = {
  pid: number;
  /** OS-derived token that changes when the pid is reused. Absent when the host supplies none. */
  startToken?: string;
  /** Host the pid is meaningful on. A record from another host cannot be judged here. */
  host: string;
  /** Boot identity. A pid captured before a reboot cannot still be running after it. */
  boot?: string;
};

export type ProcessLiveness = "alive" | "dead" | "unknown";

export type ProcessProbe = {
  host(): string;
  boot(): string | undefined;
  /** Identity of whatever currently holds the pid, or null when nothing does. */
  identify(pid: number): ProcessIdentity | null;
};

function linuxStartToken(pid: number): string | undefined {
  try {
    // /proc/<pid>/stat field 22 is starttime (jiffies since boot). comm (field 2)
    // is parenthesized and may itself contain spaces and parens, so split only
    // what follows the LAST ")": index 0 there is field 3, so field 22 is index 19.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const starttime = fields[19];
    return starttime ? `linux-starttime:${starttime}` : undefined;
  } catch {
    return undefined;
  }
}

function psStartToken(pid: number): string | undefined {
  try {
    // `lstart` is an ABSOLUTE wall-clock start time, so unlike Linux's
    // jiffies-since-boot it is already reboot-safe on its own.
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? `ps-lstart:${out}` : undefined;
  } catch {
    return undefined;
  }
}

let bootCache: { value: string | undefined } | undefined;

function systemBoot(): string | undefined {
  if (bootCache) return bootCache.value;
  let value: string | undefined;
  if (process.platform === "linux") {
    try {
      const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (id) value = `boot-id:${id}`;
    } catch {
      // no procfs; the token comparison still fences pid reuse within this boot
    }
  } else if (process.platform === "darwin") {
    try {
      const out = execFileSync("sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) value = `boottime:${out}`;
    } catch {
      // ps-lstart is absolute, so darwin tolerates the absence
    }
  }
  bootCache = { value };
  return value;
}

export const systemProcessProbe: ProcessProbe = {
  host: () => hostname(),
  boot: () => systemBoot(),
  identify(pid: number): ProcessIdentity | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
    } catch (err) {
      // EPERM means the pid IS held — by a process we don't own, which for a
      // recycled pid is exactly the case we must classify as dead below.
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return null;
    }
    const startToken = process.platform === "linux" ? linuxStartToken(pid) : psStartToken(pid);
    const boot = systemBoot();
    return {
      pid,
      host: hostname(),
      ...(startToken ? { startToken } : {}),
      ...(boot ? { boot } : {}),
    };
  },
};

/** Fence for a currently-running pid (defaults to this process — the launcher). */
export function captureProcessIdentity(
  pid: number = process.pid,
  probe: ProcessProbe = systemProcessProbe,
): ProcessIdentity {
  const observed = probe.identify(pid);
  if (observed) return observed;
  // The pid is already gone (or unreadable). Record what we know rather than
  // fabricating a token — a fence with no token reads as `unknown`, never alive.
  const boot = probe.boot();
  return { pid, host: probe.host(), ...(boot ? { boot } : {}) };
}

export function classifyProcessIdentity(
  recorded: ProcessIdentity | undefined,
  probe: ProcessProbe = systemProcessProbe,
): ProcessLiveness {
  if (!recorded || !Number.isInteger(recorded.pid) || recorded.pid <= 0) return "unknown";
  if (recorded.host && recorded.host !== probe.host()) return "unknown";

  const currentBoot = probe.boot();
  if (recorded.boot && currentBoot && recorded.boot !== currentBoot) return "dead";

  const current = probe.identify(recorded.pid);
  if (!current) return "dead";
  if (!recorded.startToken || !current.startToken) return "unknown";
  return recorded.startToken === current.startToken ? "alive" : "dead";
}

export function coerceProcessIdentity(value: unknown): ProcessIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const pid = o["pid"];
  const host = o["host"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof host !== "string" || host.length === 0) return undefined;
  const startToken = o["startToken"];
  const boot = o["boot"];
  return {
    pid,
    host,
    ...(typeof startToken === "string" && startToken ? { startToken } : {}),
    ...(typeof boot === "string" && boot ? { boot } : {}),
  };
}
