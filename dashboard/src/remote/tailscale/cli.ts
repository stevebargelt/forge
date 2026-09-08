// FG-782 (step 5): the injectable local-tailscaled client seam.
//
// THREAT MODEL. The Remote Board's Tailscale Serve adapter (step 6) must NOT trust inbound
// Tailscale-*/X-Forwarded-* header VALUES to establish who a request is from — a local curl
// and a Serve proxy both arrive on 127.0.0.1 with attacker-settable headers. Identity is
// established out-of-band ONLY: by asking the LOCAL tailscaled, over its own trusted channel,
// `tailscale whois <peer-addr>` for the connection's real 100.x peer. This module is that
// channel.
//
// Two properties this module makes structural:
//   (1) NO hardcoded execFileSync. The command runner is an INJECTED seam (mirroring
//       RemoteBoardDeps / AuthCommandRunner), so tests drive a fake tailscale binary and the
//       adapter never reaches a real process in unit tier. This is deliberately NOT the
//       non-injected execFileSync shape of src/cli/commands/doctor.ts.
//   (2) FAIL CLOSED. When the daemon is unreachable, the peer is not on the tailnet, or the
//       output is unparseable, every function here returns null — never a fallback identity
//       and never "assume funnel is off". A refusal is the only safe default for an identity
//       oracle: a confirmed peer is the ONLY thing that yields a non-null whois.
//
// The raw-JSON parsers are exported PURE (no process) so the whole decision surface unit-tests
// without spawning anything; only the runner that actually spawns the binary lives behind the
// injected seam and is exercised in cli.integration.test.ts.

import { execFileSync } from "node:child_process";

/** The result of running one `tailscale` subcommand. `ok` is a clean exit 0 with parseable
 *  stdout available; a spawn failure (binary absent) or the daemon being down surfaces as
 *  `ok: false` — the caller fails closed rather than reading `stdout`. `code` is the process
 *  exit code, or -1 when the process could not be spawned / errored before exiting. */
export interface TailscaleCommandResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
}

/**
 * The injected command runner: talks to the LOCAL tailscaled by invoking the `tailscale` CLI
 * with an ARGV ARRAY (never a shell string — the peer address is passed positionally, so no
 * shell metacharacter in it could ever be interpreted). Tests supply a runner that points at a
 * fake binary; production uses {@link createTailscaleRunner}.
 */
export type TailscaleRunner = (args: readonly string[]) => TailscaleCommandResult;

/** How long a single `tailscale` invocation may run before it is killed. A hung local daemon
 *  must not wedge a request handler; a kill surfaces as `ok: false` → fail closed. */
const TAILSCALE_COMMAND_TIMEOUT_MS = 5000;

/**
 * Build the production runner. `bin` defaults to `"tailscale"` (resolved on PATH); the
 * integration test overrides it with the path to a fake executable to exercise the REAL spawn
 * path. Uses execFileSync with an argv array — NO `shell: true` — so nothing in `args` is ever
 * shell-interpreted. Any spawn error / non-zero exit / timeout is caught and reported as a
 * closed result; stdout is captured but only trusted when the exit was clean.
 */
export function createTailscaleRunner(bin = "tailscale"): TailscaleRunner {
  return (args) => {
    try {
      // encoding: "utf8" → execFileSync returns the child's stdout as a string.
      const stdout = execFileSync(bin, [...args], {
        timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, code: 0, stdout };
    } catch (err) {
      // execFileSync throws on non-zero exit, timeout, or spawn failure (ENOENT). In every one
      // of those the local daemon assertion could not be established → fail closed. We keep any
      // captured stdout out of the return (a non-zero exit's stdout is not a trusted answer).
      const code = (err as { status?: number | null }).status ?? -1;
      return { ok: false, code: typeof code === "number" ? code : -1, stdout: "" };
    }
  };
}

/** A whois-confirmed tailnet peer: the identity the LOCAL tailscaled vouches for a connection.
 *  `login` is the load-bearing field (the tailnet user); a result is only ever produced with a
 *  non-empty login. `node` is the peer's MagicDNS name and `tailnet` its tailnet suffix, both
 *  best-effort context for the audit trail. */
export interface TailscaleWhois {
  readonly login: string;
  readonly node?: string;
  readonly tailnet?: string;
}

/** A parsed view of `tailscale serve status --json`, reduced to what the security surface
 *  needs: whether Funnel (public exposure) is enabled anywhere (AC5), and the proxied
 *  loopback targets Serve is fronting (so setup/doctor/disable can inspect the real mapping). */
export interface TailscaleServeStatus {
  /** AC5: true if ANY host:port has Funnel (public internet exposure) enabled. */
  readonly funnel: boolean;
  /** The Serve web handlers Forge (or anything) has configured: the fronted host and the
   *  loopback target it proxies to. */
  readonly proxies: readonly { readonly host: string; readonly target: string }[];
}

/** A peer address is a CONNECTION FACT (socket.remoteAddress), not a header — but we still
 *  refuse anything that is not IP-shaped before handing it to the CLI, so a stray value could
 *  never be read by the CLI as a flag (e.g. a leading `-`) or otherwise steer the command. */
function isPlausiblePeerAddress(peerAddr: string): boolean {
  const v = peerAddr.trim();
  if (v === "" || v.startsWith("-")) return false;
  // Whitelist the character set an IPv4/IPv6/zoned-IPv6 socket peer can legitimately take
  // (digits, hex letters, an interface zone like `%eth0`, separators) — no whitespace and no
  // shell metacharacter, so "127.0.0.1; rm -rf" or "not an ip" can never pass. The leading-dash
  // reject above closes flag injection ("--help"); requiring a `.` or `:` keeps a bare token
  // like "notanip" from being handed to the CLI as an address.
  if (!/^[0-9a-zA-Z:._%-]+$/.test(v)) return false;
  return /[.:]/.test(v);
}

/** Trim a MagicDNS name of its trailing root dot (`host.tailnet.ts.net.` → `host.tailnet.ts.net`). */
function trimDnsRoot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/** Derive the tailnet suffix from a MagicDNS node name: everything after the first label.
 *  `myhost.tail1234.ts.net` → `tail1234.ts.net`. Best-effort; undefined when the name is a
 *  single label or empty. */
function deriveTailnet(node: string | undefined): string | undefined {
  if (!node) return undefined;
  const trimmed = trimDnsRoot(node);
  const dot = trimmed.indexOf(".");
  if (dot < 0 || dot === trimmed.length - 1) return undefined;
  return trimmed.slice(dot + 1);
}

/**
 * PURE parser: raw `tailscale whois --json` stdout → a confirmed peer, or null.
 *
 * Fail closed. A result is produced ONLY when the JSON parses AND carries a non-empty
 * `UserProfile.LoginName` — the tailnet login is the identity we confirm. Malformed JSON,
 * empty output, a missing/empty login, or a non-object all yield null (no fallback identity).
 * `Node.Name` and the derived tailnet are optional context and never gate the result.
 */
export function parseWhois(raw: string): TailscaleWhois | null {
  const text = raw.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const userProfile = obj["UserProfile"];
  if (typeof userProfile !== "object" || userProfile === null) return null;
  const loginRaw = (userProfile as Record<string, unknown>)["LoginName"];
  const login = typeof loginRaw === "string" ? loginRaw.trim() : "";
  if (login === "") return null;
  let node: string | undefined;
  const nodeObj = obj["Node"];
  if (typeof nodeObj === "object" && nodeObj !== null) {
    const nameRaw = (nodeObj as Record<string, unknown>)["Name"];
    if (typeof nameRaw === "string" && nameRaw.trim() !== "") node = trimDnsRoot(nameRaw.trim());
  }
  return { login, node, tailnet: deriveTailnet(node) };
}

/**
 * PURE parser: raw `tailscale serve status --json` stdout → the reduced serve view, or null.
 *
 * Fail closed for identity purposes: unparseable / empty output → null so the caller treats
 * "can't determine" as unknown rather than "funnel off". A parsed status with any truthy
 * `AllowFunnel[host]` sets `funnel: true` (AC5). `Web[host].Handlers[path].Proxy` entries
 * become the proxied targets.
 */
export function parseServeStatus(raw: string): TailscaleServeStatus | null {
  const text = raw.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // AllowFunnel is a map host:port → bool. ANY true value is public exposure (AC5).
  let funnel = false;
  const allowFunnel = obj["AllowFunnel"];
  if (typeof allowFunnel === "object" && allowFunnel !== null) {
    for (const v of Object.values(allowFunnel as Record<string, unknown>)) {
      if (v === true) {
        funnel = true;
        break;
      }
    }
  }

  // Web is a map host:port → { Handlers: { path → { Proxy: target } } }.
  const proxies: { host: string; target: string }[] = [];
  const web = obj["Web"];
  if (typeof web === "object" && web !== null) {
    for (const [host, entry] of Object.entries(web as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const handlers = (entry as Record<string, unknown>)["Handlers"];
      if (typeof handlers !== "object" || handlers === null) continue;
      for (const handler of Object.values(handlers as Record<string, unknown>)) {
        if (typeof handler !== "object" || handler === null) continue;
        const proxy = (handler as Record<string, unknown>)["Proxy"];
        if (typeof proxy === "string" && proxy.trim() !== "") {
          proxies.push({ host, target: proxy.trim() });
        }
      }
    }
  }

  return { funnel, proxies };
}

/**
 * Confirm a connection's tailnet identity by asking the LOCAL tailscaled `tailscale whois`
 * for its peer address. Returns the confirmed peer, or null.
 *
 * This is the ONLY identity oracle: an inbound Tailscale-User-Login header is at most a hint
 * that must be confirmed HERE; this function reads none of them — it anchors solely on the
 * connection's real peer address. Fail closed on a non-IP peer, a daemon that is down / the
 * peer not being on the tailnet (runner `ok: false`), or unparseable output.
 */
export function whois(peerAddr: string, runner: TailscaleRunner): TailscaleWhois | null {
  if (!isPlausiblePeerAddress(peerAddr)) return null;
  const res = runner(["whois", "--json", peerAddr.trim()]);
  if (!res.ok) return null;
  return parseWhois(res.stdout);
}

/**
 * Read the local tailscaled's Serve configuration, reduced to the Funnel flag and proxied
 * targets. Returns null when the daemon is unreachable or the output is unparseable — the
 * caller (doctor/setup, step 8) treats null as "could not determine" and, for Funnel, must not
 * read that as "off".
 */
export function serveStatus(runner: TailscaleRunner): TailscaleServeStatus | null {
  const res = runner(["serve", "status", "--json"]);
  if (!res.ok) return null;
  return parseServeStatus(res.stdout);
}
