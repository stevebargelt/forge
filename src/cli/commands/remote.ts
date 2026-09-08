// FG-782 (step 8): `forge remote tailscale setup|doctor|disable` — the operator surface that
// puts a Tailscale Serve proxy in front of the loopback-only Remote Board, and takes it down
// again, WITHOUT ever widening the board's bind or exposing it publicly.
//
// THREAT MODEL. This command MUTATES the host's tailscaled Serve configuration, so its blast
// radius is the adversary set:
//   (A1) accidental host mutation — `setup --dry-run` MUST change nothing on the host or the
//        tailnet (AC1). It is enforced two ways: the plan for a dry-run carries an EMPTY
//        mutation set, and the runner it is handed THROWS if any mutating command is attempted
//        (a bug cannot silently mutate under --dry-run).
//   (A2) public exposure — Tailscale Funnel (public-internet exposure) is REFUSED. doctor
//        detects and calls it out; setup refuses to proceed while Funnel is enabled anywhere,
//        and setup itself NEVER passes a `funnel` flag (AC5). The board is tailnet-private only.
//   (A3) blast-radius on teardown — `disable` removes ONLY the exact mapping Forge recorded at
//        setup time (serve-state.ts), by replaying its recorded inverse argv — NEVER a blanket
//        `tailscale serve reset`, and never touching Forge data or the local dashboard (AC6).
//   (A4) bind widening — the proposed Serve target is ALWAYS http://127.0.0.1:<remote port>.
//        This command proposes a proxy IN FRONT of the loopback board; it does not (and cannot
//        from here) change what the board binds. The loopback target is asserted, not assumed.
//
// PACKAGE-BOUNDARY NOTE (plan defect worked around). The plan places this command in src/ but
// has it depend on dashboard/src modules (config/mapping/cli step 3/4/5 + serve-state step 8).
// The root tsconfig sets rootDir: src and forbids a static src→dashboard import (TS6059) — even
// `import type`. The `forge` CLI runs under tsx (TS at runtime), where cross-dir imports resolve
// fine; only `tsc --noEmit` is the gate. So every cross-package dependency is loaded through a
// VARIABLE-specifier dynamic import (tsc cannot statically pull the file into the program, so no
// TS6059) behind the typed loaders below, and the whole rest of this module — plus its tests —
// depends only on src-local, fully type-checked code. The dynamic surface is deliberately tiny:
// the tailscale runner + serve-status parser (step 5) and the serve-state store (this step).

import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------
// Contracts mirrored across the package boundary (see PACKAGE-BOUNDARY NOTE). These are the
// public shapes of the dashboard modules this command drives; the loaders below produce values
// that satisfy them at runtime.
// ---------------------------------------------------------------------------------------------

/** One `tailscale` invocation's result — mirrors dashboard cli.ts's TailscaleCommandResult.
 *  `ok` is a clean exit with trusted stdout; a spawn failure / non-zero exit / timeout is
 *  `ok:false` and the caller fails closed. */
export interface CliResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
}

/** The injected command runner — argv array (never a shell string), mirrors cli.ts's
 *  TailscaleRunner. Tests supply a recording fake; production uses {@link createTailscaleRunner}. */
export type CliRunner = (args: readonly string[]) => CliResult;

/** The reduced serve-status view — mirrors cli.ts's TailscaleServeStatus. `funnel` is the AC5
 *  load-bearing flag. */
export interface ServeStatusView {
  readonly funnel: boolean;
  readonly proxies: readonly { readonly host: string; readonly target: string }[];
}

/** The serve-state store — mirrors dashboard serve-state.ts's public functions. */
export interface ServeStateRecord {
  readonly version: number;
  readonly serveHost: string;
  readonly servePort: number;
  readonly loopbackPort: number;
  readonly target: string;
  readonly url: string;
  readonly createArgs: readonly string[];
  readonly disableArgs: readonly string[];
  readonly createdAt?: string;
}

export interface ServeStateStore {
  read(env: NodeJS.ProcessEnv): ServeStateRecord | null;
  write(record: ServeStateRecord, env: NodeJS.ProcessEnv): void;
  clear(env: NodeJS.ProcessEnv): void;
  path(env: NodeJS.ProcessEnv): string;
}

// ---------------------------------------------------------------------------------------------
// Env / config contract. The env var NAMES are the public boot contract dashboard/src/remote/
// config.ts resolves — repeated here (as dashboard.ts already repeats FORGE_DASHBOARD_REMOTE_
// PORT) rather than imported across the boundary. Kept in lockstep with config.ts by name.
// ---------------------------------------------------------------------------------------------

const REMOTE_PORT_ENV = "FORGE_DASHBOARD_REMOTE_PORT";
const REMOTE_TRANSPORT_ENV = "FORGE_DASHBOARD_REMOTE_TRANSPORT";
const DEFAULT_REMOTE_PORT = 8025;
/** The remote board's loopback bind — the config.ts constant, restated so the proposed target
 *  is provably loopback here without a cross-boundary import. */
export const REMOTE_LOOPBACK_HOST = "127.0.0.1";
/** The identity→authorization mapping filename (mapping.ts step 4), for doctor's identity
 *  report. Just the filename + FORGE_HOME join; no cross-boundary import needed. */
const IDENTITY_MAPPING_FILENAME = "remote-board-identity.yml";
/** The HTTPS port Serve exposes on the TAILNET side. Constant — never a Funnel/public port. */
const SERVE_HTTPS_PORT = 443;

/** Resolve the remote board's loopback port from the env, mirroring config.ts's resolver
 *  (fail-safe fallback to the default on a non-integer / out-of-range value). */
export function resolveRemotePort(env: NodeJS.ProcessEnv): number {
  const raw = env[REMOTE_PORT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_REMOTE_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_REMOTE_PORT;
  return n;
}

/** Resolve the selected transport token for the identity report (fail-closed: unknown → null,
 *  matching config.ts). Recognises the two canonical transports Forge fronts the board with —
 *  `tailscale` (FG-782) and `cloudflare` (FG-784); anything else is `null` (the board refuses
 *  every request). Widened additively for FG-784; still fail-closed on an unknown token. */
export function resolveTransport(env: NodeJS.ProcessEnv): string | null {
  const raw = env[REMOTE_TRANSPORT_ENV];
  if (raw === undefined) return null;
  const token = raw.trim().toLowerCase();
  return token === "tailscale" || token === "cloudflare" ? token : null;
}

function resolveMappingPath(env: NodeJS.ProcessEnv): string {
  const forgeHome = env["FORGE_HOME"] ?? join(homedir(), ".forge");
  return join(forgeHome, IDENTITY_MAPPING_FILENAME);
}

// ---------------------------------------------------------------------------------------------
// Command classification + serve argv construction (pure, type-checked, unit-tested).
// ---------------------------------------------------------------------------------------------

/**
 * Is this `tailscale` argv a MUTATING command (changes host/tailnet state) rather than a pure
 * read? Fail-safe by construction: the READ set is a closed allowlist (version / status / serve
 * status / whois); ANYTHING else — every `serve` set/off, up/down, funnel, cert, login — is
 * treated as mutating. Used both to guard the --dry-run path (a mutating command there THROWS)
 * and to let the tests assert a zero-mutation stream (AC1).
 */
export function isMutatingTailscaleCommand(args: readonly string[]): boolean {
  const [cmd, sub] = args;
  if (cmd === "version") return false;
  if (cmd === "whois") return false;
  if (cmd === "status") return false;
  if (cmd === "serve" && sub === "status") return false;
  return true;
}

/** The create + inverse-disable argv for the Serve mapping in front of the loopback board.
 *  Centralized so `disable`'s recorded removal is provably the inverse of `setup`'s create, and
 *  the disable argv is a SURGICAL per-handler `off` — never `serve reset` (AC6). */
export function serveArgs(loopbackPort: number): {
  readonly target: string;
  readonly createArgs: readonly string[];
  readonly disableArgs: readonly string[];
} {
  const target = `http://${REMOTE_LOOPBACK_HOST}:${loopbackPort}`;
  return {
    target,
    // `--bg` persists the mapping; `--https=443` scopes it to the one tailnet HTTPS handler.
    createArgs: ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, target],
    // Removes ONLY the 443 web handler this created — surgical, never a blanket reset.
    disableArgs: ["serve", `--https=${SERVE_HTTPS_PORT}`, "off"],
  };
}

// ---------------------------------------------------------------------------------------------
// Local-daemon reads: self-node identity (for the proposed target hostname). The peer whois +
// serve-status live in dashboard cli.ts (step 5); the SELF node identity does not, and setup
// needs it to name https://<self>. Parsed purely here, fail-closed.
// ---------------------------------------------------------------------------------------------

export interface SelfNodeView {
  /** tailscaled BackendState, e.g. "Running" (logged in) / "NeedsLogin" / "Stopped". */
  readonly backendState: string | null;
  /** The local node's MagicDNS name with the trailing root dot trimmed, or null. */
  readonly dnsName: string | null;
  /** The tailnet suffix derived from dnsName, or null. */
  readonly tailnet: string | null;
}

function trimDnsRoot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/** PURE parser: `tailscale status --json` stdout → the self node view, or null. Fail closed on
 *  unparseable/empty output. dnsName is only produced when non-empty. */
export function parseSelfNode(raw: string): SelfNodeView | null {
  const text = raw.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const backendRaw = obj["BackendState"];
  const backendState = typeof backendRaw === "string" && backendRaw.trim() !== "" ? backendRaw.trim() : null;
  let dnsName: string | null = null;
  const self = obj["Self"];
  if (typeof self === "object" && self !== null) {
    const nameRaw = (self as Record<string, unknown>)["DNSName"];
    if (typeof nameRaw === "string" && nameRaw.trim() !== "") dnsName = trimDnsRoot(nameRaw.trim());
  }
  let tailnet: string | null = null;
  if (dnsName) {
    const dot = dnsName.indexOf(".");
    if (dot > 0 && dot < dnsName.length - 1) tailnet = dnsName.slice(dot + 1);
  }
  return { backendState, dnsName, tailnet };
}

// ---------------------------------------------------------------------------------------------
// The doctor report + setup/disable plans (pure decision logic — the unit-tested core).
// ---------------------------------------------------------------------------------------------

export interface DoctorReportInput {
  readonly cliPresent: boolean;
  readonly daemonReachable: boolean;
  readonly selfNode: SelfNodeView | null;
  readonly serveStatus: ServeStatusView | null;
  readonly loopbackPort: number;
  readonly transport: string | null;
  readonly mappingPath: string;
  readonly serveState: ServeStateRecord | null;
}

export interface DoctorReport {
  readonly prerequisites: {
    readonly cliPresent: boolean;
    readonly daemonReachable: boolean;
    readonly loggedIn: boolean;
    readonly magicDnsName: string | null;
    /** null = could not determine (daemon down / logged out). */
    readonly httpsCapable: boolean | null;
  };
  readonly proposedTarget: { readonly url: string | null; readonly loopback: string };
  readonly identity: {
    readonly transport: string | null;
    readonly transportSelected: boolean;
    readonly mappingPath: string;
  };
  readonly requiredGrants: readonly string[];
  /** AC5. `detected`: Funnel is on somewhere. `determinable`: we could read serve status at
   *  all — a null serve status means we must NOT assume Funnel is off. */
  readonly funnel: { readonly detected: boolean; readonly determinable: boolean };
  readonly activeServeMapping: ServeStateRecord | null;
  /** Human-readable reasons setup would refuse to proceed. Empty ⇒ ready. */
  readonly refusals: readonly string[];
  /** All prerequisites met AND no Funnel AND Funnel status determinable. */
  readonly ok: boolean;
}

/** The tailnet-side prerequisites an operator must arrange (Forge does NOT administer the
 *  tailnet). Includes the explicit Funnel-unsupported statement (AC5/AC7). */
export function requiredAclGrants(mappingPath: string): readonly string[] {
  return Object.freeze([
    "MagicDNS and HTTPS certificates enabled for the tailnet (Tailscale admin console → DNS).",
    "This device permitted to run Tailscale Serve (tailnet members can by default).",
    "Tailscale Funnel NOT enabled for this node — the Remote Board is tailnet-private only; " +
      "public exposure is unsupported.",
    `Each remote operator's tailnet login mapped to exactly one project (read-only) in ${mappingPath}.`,
  ]);
}

/** Build the doctor report from gathered inputs. Pure. */
export function buildDoctorReport(input: DoctorReportInput): DoctorReport {
  const loggedIn = input.selfNode?.backendState === "Running";
  const magicDnsName = input.selfNode?.dnsName ?? null;
  const httpsCapable = input.daemonReachable ? loggedIn && magicDnsName !== null : null;

  const funnelDeterminable = input.serveStatus !== null;
  const funnelDetected = input.serveStatus?.funnel === true;

  const url = magicDnsName ? `https://${magicDnsName}` : null;
  const loopback = `http://${REMOTE_LOOPBACK_HOST}:${input.loopbackPort}`;

  const refusals: string[] = [];
  if (!input.cliPresent) {
    refusals.push("The `tailscale` CLI is not on PATH — install Tailscale first.");
  }
  if (!input.daemonReachable) {
    refusals.push("The local tailscaled is not reachable — start Tailscale and log in.");
  } else if (!loggedIn) {
    refusals.push("This device is not logged in to a tailnet — run `tailscale up`.");
  }
  if (input.daemonReachable && loggedIn && !magicDnsName) {
    refusals.push("MagicDNS name unavailable — enable MagicDNS/HTTPS for the tailnet.");
  }
  if (funnelDetected) {
    refusals.push(
      "Tailscale Funnel (public-internet exposure) is ENABLED on this node — REFUSED. " +
        "The Remote Board is tailnet-private only. Disable Funnel before exposing the board.",
    );
  } else if (input.daemonReachable && !funnelDeterminable) {
    refusals.push(
      "Could not read Tailscale Serve status — refusing rather than assuming Funnel is off.",
    );
  }

  return {
    prerequisites: {
      cliPresent: input.cliPresent,
      daemonReachable: input.daemonReachable,
      loggedIn,
      magicDnsName,
      httpsCapable,
    },
    proposedTarget: { url, loopback },
    identity: {
      transport: input.transport,
      transportSelected: input.transport === "tailscale",
      mappingPath: input.mappingPath,
    },
    requiredGrants: requiredAclGrants(input.mappingPath),
    funnel: { detected: funnelDetected, determinable: funnelDeterminable },
    activeServeMapping: input.serveState,
    refusals: Object.freeze(refusals),
    ok: refusals.length === 0,
  };
}

export interface SetupPlanInput {
  readonly report: DoctorReport;
  readonly selfNode: SelfNodeView | null;
  readonly loopbackPort: number;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  readonly now?: string;
}

export interface SetupPlan {
  /** Commands that WILL actually be executed. Empty on dry-run, preview, and refusal (AC1). */
  readonly mutations: readonly (readonly string[])[];
  /** What a confirmed apply WOULD run — for display, never executed under dry-run/preview. */
  readonly proposedMutations: readonly (readonly string[])[];
  /** true only when not dry-run, confirmed, and no refusals. */
  readonly willApply: boolean;
  readonly refusals: readonly string[];
  /** The record to persist IF applied — also shown as the proposal under dry-run/preview. */
  readonly record: ServeStateRecord | null;
}

/**
 * Decide what `setup` does. Pure. The mutation set is EMPTY unless the run is a confirmed,
 * non-dry-run apply with no refusals — so --dry-run (AC1), an unconfirmed preview, and any
 * refusal (Funnel/AC5, missing prereqs) all mutate nothing.
 */
export function planSetup(input: SetupPlanInput): SetupPlan {
  const refusals = input.report.refusals;
  const dnsName = input.selfNode?.dnsName ?? null;

  // No self identity ⇒ no target to propose. Treated as a refusal (already surfaced by the
  // report's prereq refusals, but guard here so we never build a record with a null host).
  if (dnsName === null || refusals.length > 0) {
    return {
      mutations: [],
      proposedMutations: [],
      willApply: false,
      refusals: refusals.length > 0 ? refusals : ["No MagicDNS name — cannot propose a Serve target."],
      record: null,
    };
  }

  const { target, createArgs, disableArgs } = serveArgs(input.loopbackPort);
  const record: ServeStateRecord = {
    version: 1,
    serveHost: dnsName,
    servePort: SERVE_HTTPS_PORT,
    loopbackPort: input.loopbackPort,
    target,
    url: `https://${dnsName}`,
    createArgs,
    disableArgs,
    ...(input.now ? { createdAt: input.now } : {}),
  };

  const willApply = !input.dryRun && input.confirmed;
  return {
    mutations: willApply ? [createArgs] : [],
    proposedMutations: [createArgs],
    willApply,
    refusals: [],
    record,
  };
}

export interface DisablePlan {
  /** The single surgical removal command, or empty when nothing Forge-owned is recorded. */
  readonly mutations: readonly (readonly string[])[];
  readonly hadRecord: boolean;
  readonly note: string;
}

/**
 * Decide what `disable` does. Pure. Replays ONLY the recorded inverse argv — exactly one
 * command, a per-handler `off`, never `serve reset` (AC6). A missing record ⇒ no command.
 */
export function planDisable(serveState: ServeStateRecord | null): DisablePlan {
  if (serveState === null) {
    return { mutations: [], hadRecord: false, note: "No Forge-created Serve mapping recorded — nothing to remove." };
  }
  return {
    mutations: [serveState.disableArgs],
    hadRecord: true,
    note: `Will remove the recorded Serve mapping ${serveState.url} → ${serveState.target}.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering (human + JSON). Pure functions of the report/plan.
// ---------------------------------------------------------------------------------------------

export function renderDoctor(r: DoctorReport): string {
  const yn = (b: boolean): string => (b ? "OK" : "MISSING");
  const lines: string[] = [];
  lines.push("forge remote tailscale doctor");
  lines.push("");
  lines.push("Prerequisites:");
  lines.push(`  tailscale CLI on PATH ......... ${yn(r.prerequisites.cliPresent)}`);
  lines.push(`  tailscaled reachable .......... ${yn(r.prerequisites.daemonReachable)}`);
  lines.push(`  logged in to a tailnet ........ ${yn(r.prerequisites.loggedIn)}`);
  lines.push(`  MagicDNS name ................. ${r.prerequisites.magicDnsName ?? "(unknown)"}`);
  lines.push(
    `  HTTPS-capable ................. ${
      r.prerequisites.httpsCapable === null ? "(undetermined)" : yn(r.prerequisites.httpsCapable)
    }`,
  );
  lines.push("");
  lines.push("Proposed Serve mapping (tailnet-private):");
  lines.push(`  ${r.proposedTarget.url ?? "https://<this-host>.<tailnet>.ts.net"} → ${r.proposedTarget.loopback}`);
  lines.push("");
  lines.push("Identity:");
  lines.push(
    `  transport (${REMOTE_TRANSPORT_ENV}) ... ${r.identity.transport ?? "(unset — remote board refuses every request)"}`,
  );
  lines.push(`  identity mapping file ......... ${r.identity.mappingPath}`);
  lines.push("");
  lines.push("Required tailnet configuration (you arrange these — Forge does not):");
  for (const g of r.requiredGrants) lines.push(`  - ${g}`);
  lines.push("");
  lines.push(
    `Funnel (public exposure): ${
      !r.funnel.determinable ? "UNDETERMINED (treated as unsafe)" : r.funnel.detected ? "ENABLED — REFUSED (AC5)" : "off"
    }`,
  );
  if (r.activeServeMapping) {
    lines.push("");
    lines.push(`Active Forge Serve mapping: ${r.activeServeMapping.url} → ${r.activeServeMapping.target}`);
  }
  if (r.refusals.length > 0) {
    lines.push("");
    lines.push("NOT READY — setup would refuse:");
    for (const x of r.refusals) lines.push(`  ✗ ${x}`);
  } else {
    lines.push("");
    lines.push("READY — run `forge remote tailscale setup --confirm` to apply.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Cross-boundary loaders (see PACKAGE-BOUNDARY NOTE). Variable-specifier dynamic imports keep
// `tsc` clean; tsx resolves them at runtime.
// ---------------------------------------------------------------------------------------------

/** The production `tailscale` runner: execFileSync with an ARGV array (never a shell string, so
 *  nothing in args is shell-interpreted), fail-closed on spawn error / non-zero exit / timeout.
 *  Mirrors dashboard cli.ts's createTailscaleRunner; kept src-local so production needs no
 *  cross-boundary import for the common case. */
export function createTailscaleRunner(bin = "tailscale"): CliRunner {
  return (args) => {
    try {
      const stdout = execFileSync(bin, [...args], {
        timeout: 5000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, code: 0, stdout };
    } catch (err) {
      const code = (err as { status?: number | null }).status ?? -1;
      return { ok: false, code: typeof code === "number" ? code : -1, stdout: "" };
    }
  };
}

/** Load the serve-state store from the dashboard package at runtime. */
export async function loadServeStore(): Promise<ServeStateStore> {
  const spec = "../../../dashboard/src/remote/tailscale/serve-state.js";
  const mod = (await import(spec)) as {
    readServeState: (env: NodeJS.ProcessEnv) => ServeStateRecord | null;
    writeServeState: (record: ServeStateRecord, env: NodeJS.ProcessEnv) => void;
    clearServeState: (env: NodeJS.ProcessEnv) => void;
    resolveServeStatePath: (env: NodeJS.ProcessEnv) => string;
  };
  return {
    read: (env) => mod.readServeState(env),
    write: (record, env) => mod.writeServeState(record, env),
    clear: (env) => mod.clearServeState(env),
    path: (env) => mod.resolveServeStatePath(env),
  };
}

/** Load the serve-status parser from dashboard cli.ts (step 5) — the single source of truth for
 *  the AC5 Funnel parse — at runtime. */
export async function loadServeStatusFn(): Promise<(runner: CliRunner) => ServeStatusView | null> {
  const spec = "../../../dashboard/src/remote/tailscale/cli.js";
  const mod = (await import(spec)) as {
    serveStatus: (runner: CliRunner) => ServeStatusView | null;
  };
  return mod.serveStatus;
}

// ---------------------------------------------------------------------------------------------
// Deps + gathering. Everything the actions need is injectable so tests drive a fake tailscale
// and a temp FORGE_HOME without a real tailnet or the operator's real state.
// ---------------------------------------------------------------------------------------------

export interface RemoteTailscaleDeps {
  runner: CliRunner;
  env: NodeJS.ProcessEnv;
  serveStatusFn: (runner: CliRunner) => ServeStatusView | null;
  store: ServeStateStore;
  out: (line: string) => void;
  now: () => string;
}

async function resolveDeps(partial?: Partial<RemoteTailscaleDeps>): Promise<RemoteTailscaleDeps> {
  return {
    runner: partial?.runner ?? createTailscaleRunner(),
    env: partial?.env ?? process.env,
    serveStatusFn: partial?.serveStatusFn ?? (await loadServeStatusFn()),
    store: partial?.store ?? (await loadServeStore()),
    out: partial?.out ?? ((line: string) => console.log(line)),
    now: partial?.now ?? (() => new Date().toISOString()),
  };
}

/** Gather the raw host facts the report/plans consume, using the injected runner. Read-only. */
function gather(deps: RemoteTailscaleDeps): DoctorReportInput {
  const cliPresent = deps.runner(["version"]).ok;
  const statusRes = deps.runner(["status", "--json"]);
  const daemonReachable = statusRes.ok;
  const selfNode = statusRes.ok ? parseSelfNode(statusRes.stdout) : null;
  const serveStatus = deps.serveStatusFn(deps.runner);
  const loopbackPort = resolveRemotePort(deps.env);
  return {
    cliPresent,
    daemonReachable,
    selfNode,
    serveStatus,
    loopbackPort,
    transport: resolveTransport(deps.env),
    mappingPath: resolveMappingPath(deps.env),
    serveState: deps.store.read(deps.env),
  };
}

/** Wrap a runner so any MUTATING command throws — the belt on the --dry-run path so a bug can
 *  never mutate the host under an inspection-only run (AC1). */
function readOnlyGuardRunner(runner: CliRunner): CliRunner {
  return (args) => {
    if (isMutatingTailscaleCommand(args)) {
      throw new Error(`dry-run refused to run a mutating tailscale command: ${args.join(" ")}`);
    }
    return runner(args);
  };
}

// ---------------------------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------------------------

export async function runDoctor(partial: Partial<RemoteTailscaleDeps>, json: boolean): Promise<number> {
  const deps = await resolveDeps(partial);
  const report = buildDoctorReport(gather(deps));
  deps.out(json ? JSON.stringify(report, null, 2) : renderDoctor(report));
  return report.ok ? 0 : 1;
}

export async function runSetup(
  partial: Partial<RemoteTailscaleDeps>,
  opts: { dryRun: boolean; confirm: boolean; json: boolean },
): Promise<number> {
  const deps = await resolveDeps(partial);
  // AC1 belt: on a dry-run, route EVERY tailscale call through a guard that throws on any
  // mutating command. Reads (version/status/serve-status) pass; a mutation — from a bug or a
  // future edit — cannot slip through under an inspection-only run. The plan's empty mutation
  // set is the suspenders; this is the belt.
  const runDeps: RemoteTailscaleDeps = opts.dryRun ? { ...deps, runner: readOnlyGuardRunner(deps.runner) } : deps;
  const input = gather(runDeps);
  const report = buildDoctorReport(input);
  const plan = planSetup({
    report,
    selfNode: input.selfNode,
    loopbackPort: input.loopbackPort,
    dryRun: opts.dryRun,
    confirmed: opts.confirm,
    now: deps.now(),
  });

  if (opts.json) {
    deps.out(JSON.stringify({ report, plan, dryRun: opts.dryRun, confirmed: opts.confirm }, null, 2));
  }

  // Refusal (Funnel/AC5, missing prereqs) — mutate nothing, non-zero exit.
  if (plan.refusals.length > 0) {
    if (!opts.json) {
      deps.out("forge remote tailscale setup: REFUSED — the host is not ready:");
      for (const x of plan.refusals) deps.out(`  ✗ ${x}`);
    }
    return 1;
  }

  // Dry-run (AC1): inspect only. The runner is already guarded (runDeps above); execute nothing.
  if (opts.dryRun) {
    if (!opts.json) {
      deps.out("forge remote tailscale setup --dry-run: NO changes made.");
      deps.out(`  Would create: ${plan.record?.url} → ${plan.record?.target}`);
      for (const m of plan.proposedMutations) deps.out(`  Would run: tailscale ${m.join(" ")}`);
    }
    return 0;
  }

  // Preview (no --confirm): show the plan, mutate nothing.
  if (!opts.confirm) {
    if (!opts.json) {
      deps.out("forge remote tailscale setup (preview — no --confirm):");
      deps.out(`  Would create: ${plan.record?.url} → ${plan.record?.target}`);
      for (const m of plan.proposedMutations) deps.out(`  Would run: tailscale ${m.join(" ")}`);
      deps.out("  Re-run with --confirm to apply. Tailscale Funnel is never enabled.");
    }
    return 0;
  }

  // Apply: execute exactly the planned create command(s), then persist the record.
  for (const m of plan.mutations) {
    const res = runDeps.runner(m);
    if (!res.ok) {
      if (!opts.json) deps.out(`forge remote tailscale setup: FAILED — \`tailscale ${m.join(" ")}\` exited ${res.code}.`);
      return 1;
    }
  }
  if (plan.record) deps.store.write(plan.record, deps.env);
  if (!opts.json) {
    deps.out("forge remote tailscale setup: Serve mapping applied (tailnet-private, Funnel NOT enabled).");
    deps.out(`  ${plan.record?.url} → ${plan.record?.target}`);
    deps.out(`  Recorded in ${deps.store.path(deps.env)} — remove it with \`forge remote tailscale disable\`.`);
  }
  return 0;
}

export async function runDisable(partial: Partial<RemoteTailscaleDeps>, json: boolean): Promise<number> {
  const deps = await resolveDeps(partial);
  const serveState = deps.store.read(deps.env);
  const plan = planDisable(serveState);

  if (json) deps.out(JSON.stringify({ plan }, null, 2));

  if (!plan.hadRecord) {
    if (!json) deps.out(`forge remote tailscale disable: ${plan.note}`);
    return 0;
  }

  // Exactly one surgical removal command — never a blanket reset (AC6).
  for (const m of plan.mutations) {
    const res = deps.runner(m);
    if (!res.ok) {
      if (!json) deps.out(`forge remote tailscale disable: FAILED — \`tailscale ${m.join(" ")}\` exited ${res.code}.`);
      return 1;
    }
  }
  deps.store.clear(deps.env);
  if (!json) {
    deps.out("forge remote tailscale disable: removed the Forge Serve mapping.");
    deps.out("  Forge data and the local dashboard were NOT touched.");
  }
  return 0;
}

// =============================================================================================
// FG-784 (step 6): `forge remote cloudflare setup|doctor|disable` — the operator surface that
// fronts the SAME loopback-only Remote Board with a Cloudflare Tunnel gated by Cloudflare Access.
//
// THREAT MODEL. Unlike Tailscale Serve (a tailnet-private daemon mapping), a Cloudflare Tunnel
// terminates on the PUBLIC internet. Its safety rests entirely on a Cloudflare Access policy in
// front of it: the origin (dashboard/src/remote/cloudflare/adapter.ts) trusts NOTHING but a
// cryptographically valid Cf-Access-Jwt-Assertion. This command's job is to make that boundary
// impossible to misconfigure into a public, unauthenticated service. Its adversary set:
//   (C1) accidental host mutation — `setup --dry-run` and an unconfirmed preview MUST change
//        nothing on disk (no ingress file, no state record) (AC1). Enforced two ways: the plan
//        for a dry-run/preview carries an EMPTY state-write set, and the cloudflared runner it is
//        handed under --dry-run THROWS on any mutating cloudflared command (belt + suspenders).
//   (C2) public, UNAUTHENTICATED exposure — a public hostname fronted by a bare tunnel with NO
//        Access policy is the whole disaster this story exists to prevent (AC4). Forge cannot read
//        the operator's Access policy without API credentials it refuses to require, so it enforces
//        the boundary STRUCTURALLY: setup REFUSES unless a well-formed Access team domain AND
//        Access application AUD are supplied AND the team's JWKS certs endpoint is reachable. No
//        team/AUD ⇒ no Access ⇒ refuse. This is the "tunnel-without-Access is refused" invariant.
//   (C3) blast-radius on teardown — `disable` removes ONLY the ingress config file Forge WHOLLY
//        authored plus its own state record (via the step-3 access-state store's clear), NEVER the
//        Access application, the cloudflared tunnel, or cloudflared's credentials (AC4/AC6).
//   (C4) bind widening — the tunnel target is ALWAYS http://127.0.0.1:<remote port>. This command
//        proposes a proxy IN FRONT of the loopback board; it cannot change what the board binds.
//   (C5) credential leakage — setup NEVER requires, prints, or persists a Cloudflare API token or
//        cloudflared tunnel credentials. The team domain, AUD tag, and hostname are PUBLIC
//        identifiers (a valid Access JWT — mintable only by the Access edge — is the actual gate),
//        so they are shown; a credentials-file PATH, if supplied, is written into the owned config
//        but never echoed to output.
//
// PACKAGE BOUNDARY. Same pattern as the tailscale group above: the ONLY cross-package dependency
// is the step-3 access-state store, loaded through a VARIABLE-specifier dynamic import so `tsc`
// (rootDir: src) cannot pull dashboard/ into the program (no TS6059). Everything else is
// src-local and fully type-checked. This module never imports the JWT verifier or JWKS cache —
// setup's only network touch is a reachability PROBE of the certs endpoint via an injected fetch
// seam, so unit tests stay network-free.
// =============================================================================================

/** The non-secret Access boot config + owned-file record — mirrors dashboard access-state.ts's
 *  AccessStateRecord (see PACKAGE BOUNDARY). Holds NO credential: a public hostname, the Access
 *  team domain, the (public) Access AUD tag, a loopback target, and the path of the owned ingress
 *  file. */
export interface AccessStateRecord {
  readonly version: number;
  readonly publicHostname: string;
  readonly accessTeamDomain: string;
  readonly accessAud: string;
  readonly loopbackPort: number;
  readonly target: string;
  readonly url: string;
  readonly cloudflaredConfigPath: string;
  /** SHA-256 (hex) of the owned ingress file body — the whole-file ownership stamp (RF-1). */
  readonly cloudflaredConfigSha256?: string;
  readonly createdAt?: string;
}

/** Outcome of an atomic, ownership-checked setup apply (mirrors access-state.ts's SetupApplyResult). */
export type SetupApplyResult =
  | { readonly status: "applied" }
  | { readonly status: "refused-foreign-config"; readonly path: string };

/** Outcome of an ownership-checked disable (mirrors access-state.ts's DisableResult). */
export type DisableResult =
  | { readonly status: "nothing" }
  | { readonly status: "removed"; readonly path: string }
  | { readonly status: "refused-tampered"; readonly path: string };

/** The access-state store — mirrors dashboard access-state.ts's public functions plus the owned
 *  ingress-file lifecycle. `apply` and `disable` are the ownership-safe, atomic write paths
 *  (RF-1/RF-2); `read`/`path`/`ingressPath` are read-only helpers. */
export interface AccessStateStore {
  read(env: NodeJS.ProcessEnv): AccessStateRecord | null;
  path(env: NodeJS.ProcessEnv): string;
  ingressPath(env: NodeJS.ProcessEnv): string;
  apply(record: AccessStateRecord, ingressContents: string, env: NodeJS.ProcessEnv): SetupApplyResult;
  disable(env: NodeJS.ProcessEnv): DisableResult;
}

/** The injected reachability probe for the Access team's JWKS certs endpoint. Returns true iff the
 *  endpoint answered OK. Tests inject a fake; production uses {@link createCertsProbe}. Never
 *  throws into the caller — a thrown/timeouted probe is a `false` (unreachable ⇒ refuse). */
export type CertsProbe = (certsUrl: string) => Promise<boolean>;

// The env-var NAMES are the public boot contract, restated here (as the tailscale group restates
// FORGE_DASHBOARD_REMOTE_PORT) rather than imported across the boundary. Kept in lockstep by name.
const CF_HOSTNAME_ENV = "FORGE_REMOTE_CLOUDFLARE_HOSTNAME";
const CF_TEAM_ENV = "FORGE_REMOTE_CLOUDFLARE_TEAM";
const CF_AUD_ENV = "FORGE_REMOTE_CLOUDFLARE_AUD";
const CF_TUNNEL_ENV = "FORGE_REMOTE_CLOUDFLARE_TUNNEL";
/** Advanced/testing override for the reachability PROBE endpoint only. Does NOT affect the origin
 *  adapter's JWT verification (that derives issuer + certs from the recorded team domain) — it
 *  only redirects setup's pre-flight reachability check, so tests can point it at a local fake
 *  certs server. Absent ⇒ derived from the team domain. */
const CF_CERTS_URL_ENV = "FORGE_REMOTE_CLOUDFLARE_CERTS_URL";
/** The owned cloudflared ingress filename under FORGE_HOME — mirrors access-state.ts's
 *  OWNED_INGRESS_FILENAME by name (no cross-boundary import for the default-path computation). */
const OWNED_INGRESS_FILENAME = "remote-board-cloudflared.yml";
/** The only access-state format version this CLI authors — mirrors ACCESS_STATE_VERSION. */
const ACCESS_STATE_VERSION = 1;

/** The default owned-ingress path under FORGE_HOME, computed src-locally (mirrors access-state.ts's
 *  resolveOwnedIngressPath) so config resolution needs no dynamic import. */
function resolveOwnedIngressPathLocal(env: NodeJS.ProcessEnv): string {
  const forgeHome = env["FORGE_HOME"] ?? join(homedir(), ".forge");
  return join(forgeHome, OWNED_INGRESS_FILENAME);
}

// ---------------------------------------------------------------------------------------------
// Deployment inputs + validators (pure, type-checked, unit-tested).
// ---------------------------------------------------------------------------------------------

/** The deployment facts an operator supplies (via flags or env). All optional at parse time; the
 *  doctor decides which absences are refusals (AC4). credentialsFile is a PATH, never a secret. */
export interface CloudflareConfigInput {
  readonly publicHostname: string | null;
  readonly accessTeamDomain: string | null;
  readonly accessAud: string | null;
  readonly tunnelName: string | null;
  readonly credentialsFile: string | null;
  /** The owned ingress config path (default under FORGE_HOME, or an operator override). */
  readonly configPath: string;
}

function trimToNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** A plausible public DNS hostname (labels of a-z0-9/hyphen, at least two, total ≤ 253). Rejects
 *  schemes, ports, paths, whitespace — anything that is not a bare hostname. Not a full RFC check;
 *  enough to reject the obviously-malformed before it reaches a public tunnel. */
export function isPlausibleHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  return /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(h);
}

/** A well-formed Cloudflare Access application AUD tag — a 64-char lowercase hex string. A public
 *  identifier (not a credential); malformed ⇒ refuse (we would otherwise pin the adapter to an
 *  audience that can never match, i.e. a silent lockout, or worse a typo'd wrong app). */
export function isWellFormedAud(a: string): boolean {
  return /^[0-9a-f]{64}$/i.test(a);
}

/** A bare Cloudflare Access team SLUG — a single RFC-1123 label (lowercase alphanumerics + hyphens,
 *  no dots, 1–63 chars, not hyphen-bordered). The ONLY accepted team form (RF-5): the issuer and
 *  JWKS authority are DERIVED as `<slug>.cloudflareaccess.com`, never taken from a configured
 *  hostname, so an attacker-controlled HTTPS host can never become the trusted issuer/JWKS root.
 *  Mirrors dashboard adapter.ts/jwks.ts's `isBareTeamSlug` by contract; kept src-local. */
export function isBareTeamSlug(team: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test((team ?? "").trim());
}

/** Derive the Access team's JWKS certs endpoint from a bare team SLUG (`acme` →
 *  `https://acme.cloudflareaccess.com/cdn-cgi/access/certs`). The team MUST be a bare slug (RF-5);
 *  a dotted/host-shaped value has no derivable endpoint. Mirrors dashboard jwks.ts's buildCertsUrl
 *  by contract; kept src-local for the probe. Returns null for a non-slug team. */
export function buildCertsUrl(teamDomain: string): string | null {
  const raw = (teamDomain ?? "").trim();
  if (!isBareTeamSlug(raw)) return null;
  return `https://${raw}.cloudflareaccess.com/cdn-cgi/access/certs`;
}

/** Resolve the certs URL to PROBE: the explicit override env (testing/self-hosted) wins; otherwise
 *  derive from a bare team SLUG; otherwise null (nothing to probe — the missing/non-slug team is
 *  itself a refusal). */
export function resolveCertsUrl(config: CloudflareConfigInput, env: NodeJS.ProcessEnv): string | null {
  const override = trimToNull(env[CF_CERTS_URL_ENV]);
  if (override) return override;
  if (config.accessTeamDomain) return buildCertsUrl(config.accessTeamDomain);
  return null;
}

/** The tunnel/ingress YAML Forge WHOLLY owns. Forge authors the ENTIRE file so `disable` removes it
 *  wholesale. The service is ALWAYS the loopback board (AC2/C4). A credentials-file path, if given,
 *  is written here but never echoed. Pure. */
export function buildIngressConfig(input: {
  readonly publicHostname: string;
  readonly loopbackPort: number;
  readonly tunnelName: string | null;
  readonly credentialsFile: string | null;
}): string {
  const target = `http://${REMOTE_LOOPBACK_HOST}:${input.loopbackPort}`;
  const lines: string[] = [];
  lines.push("# Managed by Forge — `forge remote cloudflare`. Do NOT edit by hand.");
  lines.push("# `forge remote cloudflare disable` deletes this whole file. It fronts the");
  lines.push("# loopback-only Remote Board; Cloudflare Access is the authentication boundary.");
  if (input.tunnelName) lines.push(`tunnel: ${input.tunnelName}`);
  if (input.credentialsFile) lines.push(`credentials-file: ${input.credentialsFile}`);
  lines.push("ingress:");
  lines.push(`  - hostname: ${input.publicHostname}`);
  lines.push(`    service: ${target}`);
  lines.push("  - service: http_status:404");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// cloudflared command classification + a src-local `tunnel list` parser (pure).
// ---------------------------------------------------------------------------------------------

/**
 * Is this `cloudflared` argv a MUTATING command rather than a pure read? Fail-safe by construction:
 * the READ set is a CLOSED allowlist — `--version`, `tunnel list`, and `tunnel ingress …`
 * (validate/rule are inspections). ANYTHING else — `tunnel run`, `tunnel create/delete`, `access`,
 * config writes — is treated as mutating. Guards the --dry-run path (a mutation there THROWS) and
 * lets tests assert a zero-mutation stream (AC1). Note: setup's real state changes are FILE writes
 * via the owned store, not cloudflared execs — this guard is the belt against a stray exec.
 */
export function isMutatingCloudflaredCommand(args: readonly string[]): boolean {
  const [cmd, sub] = args;
  if (cmd === "--version" || cmd === "version") return false;
  if (cmd === "tunnel" && sub === "list") return false;
  if (cmd === "tunnel" && sub === "ingress") return false; // `tunnel ingress validate|rule` — reads
  return true;
}

/** PURE parser: `cloudflared tunnel list --output json` stdout → the tunnel names, or null on
 *  unparseable/empty output (fail closed — informational only). */
export function parseTunnelList(raw: string): readonly string[] | null {
  const text = raw.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const names: string[] = [];
  for (const t of parsed) {
    if (typeof t === "object" && t !== null) {
      const name = (t as Record<string, unknown>)["name"];
      if (typeof name === "string" && name.trim() !== "") names.push(name.trim());
    }
  }
  return Object.freeze(names);
}

// ---------------------------------------------------------------------------------------------
// The doctor report + setup/disable plans (pure decision logic — the unit-tested core).
// ---------------------------------------------------------------------------------------------

export interface CloudflareDoctorInput {
  readonly cliPresent: boolean;
  readonly config: CloudflareConfigInput;
  readonly loopbackPort: number;
  readonly transport: string | null;
  readonly mappingPath: string;
  /** true = certs endpoint answered OK; false = unreachable/errored; null = not probed (no team). */
  readonly jwksReachable: boolean | null;
  readonly certsUrl: string | null;
  readonly accessState: AccessStateRecord | null;
  readonly existingTunnels: readonly string[] | null;
}

export interface CloudflareDoctorReport {
  readonly prerequisites: {
    readonly cliPresent: boolean;
    readonly hostnameSupplied: boolean;
    readonly teamSupplied: boolean;
    readonly audSupplied: boolean;
    /** null = not probed (no team to derive/override). */
    readonly jwksReachable: boolean | null;
  };
  readonly proposedTarget: { readonly url: string | null; readonly loopback: string };
  readonly access: {
    readonly publicHostname: string | null;
    readonly teamDomain: string | null;
    /** The (public) AUD tag — safe to display; it is not a credential. */
    readonly aud: string | null;
    readonly certsUrl: string | null;
    readonly ownedConfigPath: string;
  };
  readonly identity: {
    readonly transport: string | null;
    readonly transportSelected: boolean;
    readonly mappingPath: string;
  };
  /** The direct-origin boundary explanation (AC4/AC7) — always stated so an operator cannot miss
   *  that a bare tunnel without Access is refused and never trusted. */
  readonly boundary: readonly string[];
  readonly requiredGrants: readonly string[];
  readonly activeDeployment: AccessStateRecord | null;
  readonly refusals: readonly string[];
  readonly ok: boolean;
}

/** The Cloudflare-side prerequisites an operator must arrange (Forge does NOT administer the
 *  Cloudflare account). Includes the explicit "Access policy required" statement (AC4/AC7). */
export function requiredCloudflareGrants(mappingPath: string): readonly string[] {
  return Object.freeze([
    "A Cloudflare Tunnel whose ingress points ONLY at this host's loopback board (Forge writes " +
      "that ingress file for you; you run `cloudflared tunnel run`).",
    "A Cloudflare Access application PROTECTING the public hostname with an identity policy — " +
      "WITHOUT it the hostname is a public, unauthenticated service and Forge refuses to set it up.",
    "The Access application's Application Audience (AUD) tag supplied to `setup --aud` (a public " +
      "identifier, not a secret).",
    `Each remote operator's verified Access email mapped to exactly one project (read-only) in ${mappingPath}.`,
  ]);
}

/** The direct-origin boundary statement (AC4/AC7). Pure. */
export function cloudflareBoundaryNotes(): readonly string[] {
  return Object.freeze([
    "The board binds 127.0.0.1 only — the tunnel is the ONLY way in, and Cloudflare Access is the " +
      "gate on that tunnel.",
    "The origin trusts NOTHING but a cryptographically valid Cf-Access-Jwt-Assertion (signature, " +
      "issuer, audience, exp/nbf verified against the team JWKS). A raw/forged header fails closed.",
    "A public hostname fronted by a bare cloudflared tunnel with NO Access policy is refused by " +
      "setup and never trusted by the origin — presence of the tunnel is not authentication.",
  ]);
}

/** Build the doctor report. Pure. Every absent/malformed Access fact and an unreachable JWKS
 *  endpoint is a NAMED refusal (AC4) — setup will not proceed while any refusal stands. */
export function buildCloudflareDoctorReport(input: CloudflareDoctorInput): CloudflareDoctorReport {
  const c = input.config;
  const hostnameSupplied = c.publicHostname !== null;
  const teamSupplied = c.accessTeamDomain !== null;
  const audSupplied = c.accessAud !== null;

  const url = c.publicHostname ? `https://${c.publicHostname}` : null;
  const loopback = `http://${REMOTE_LOOPBACK_HOST}:${input.loopbackPort}`;

  const refusals: string[] = [];
  if (!input.cliPresent) {
    refusals.push("The `cloudflared` CLI is not on PATH — install cloudflared first.");
  }
  // Hostname.
  if (!hostnameSupplied) {
    refusals.push("No public hostname supplied (--hostname) — nothing for the tunnel to front.");
  } else if (!isPlausibleHostname(c.publicHostname as string)) {
    refusals.push(`Public hostname \`${c.publicHostname}\` is malformed — expected a bare DNS hostname.`);
  }
  // Access team — the load-bearing AC4 refusal: no team ⇒ no Access ⇒ a public, unauthenticated service.
  if (!teamSupplied) {
    refusals.push(
      "No Cloudflare Access team domain supplied (--team) — a public hostname fronted by a tunnel " +
        "with NO Access policy is REFUSED (that is a public, unauthenticated service). (AC4)",
    );
  } else if (!isBareTeamSlug(c.accessTeamDomain as string)) {
    refusals.push(
      `Access team \`${c.accessTeamDomain}\` is malformed — expected a bare team SLUG (a single ` +
        "DNS label, no dots or scheme), e.g. `acme`. The issuer and JWKS are derived as " +
        "`<slug>.cloudflareaccess.com`; a configured hostname is never trusted. (RF-5)",
    );
  }
  // Access AUD — the second half of the AC4 boundary.
  if (!audSupplied) {
    refusals.push(
      "No Access application AUD supplied (--aud) — without a specific Access application the " +
        "origin cannot pin an audience, so setup is REFUSED. (AC4)",
    );
  } else if (!isWellFormedAud(c.accessAud as string)) {
    refusals.push("Access application AUD is malformed — expected the 64-hex Application Audience tag.");
  }
  // JWKS reachability — only meaningful once a well-formed team domain exists. Fail closed on
  // unreachable AND on undetermined (never assume the Access team is real).
  if (teamSupplied && isBareTeamSlug(c.accessTeamDomain as string)) {
    if (input.jwksReachable === false) {
      refusals.push(
        `The Access team JWKS certs endpoint (${input.certsUrl ?? "?"}) is unreachable — cannot ` +
          "confirm the Access team; REFUSED.",
      );
    } else if (input.jwksReachable === null) {
      refusals.push("Could not determine JWKS reachability — refusing rather than assuming the Access team is valid.");
    }
  }

  return {
    prerequisites: {
      cliPresent: input.cliPresent,
      hostnameSupplied,
      teamSupplied,
      audSupplied,
      jwksReachable: input.jwksReachable,
    },
    proposedTarget: { url, loopback },
    access: {
      publicHostname: c.publicHostname,
      teamDomain: c.accessTeamDomain,
      aud: c.accessAud,
      certsUrl: input.certsUrl,
      ownedConfigPath: c.configPath,
    },
    identity: {
      transport: input.transport,
      transportSelected: input.transport === "cloudflare",
      mappingPath: input.mappingPath,
    },
    boundary: cloudflareBoundaryNotes(),
    requiredGrants: requiredCloudflareGrants(input.mappingPath),
    activeDeployment: input.accessState,
    refusals: Object.freeze(refusals),
    ok: refusals.length === 0,
  };
}

export interface CloudflareSetupPlanInput {
  readonly report: CloudflareDoctorReport;
  readonly config: CloudflareConfigInput;
  readonly loopbackPort: number;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  readonly now?: string;
}

export interface CloudflareSetupPlan {
  /** The state-write operations that WILL execute. Empty on dry-run, preview, and refusal (AC1). */
  readonly stateWrites: readonly string[];
  /** What a confirmed apply WOULD write — for display, never executed under dry-run/preview. */
  readonly proposedWrites: readonly string[];
  readonly willApply: boolean;
  readonly refusals: readonly string[];
  /** The record to persist IF applied — also shown as the proposal under dry-run/preview. */
  readonly record: AccessStateRecord | null;
  /** The owned-ingress body to lay down IF applied. */
  readonly ingressContents: string | null;
}

/**
 * Decide what `setup` does. Pure. The state-write set is EMPTY unless the run is a confirmed,
 * non-dry-run apply with no refusals — so --dry-run (AC1), an unconfirmed preview, and any refusal
 * (AC4) all write NOTHING to disk.
 */
export function planCloudflareSetup(input: CloudflareSetupPlanInput): CloudflareSetupPlan {
  const refusals = input.report.refusals;
  const c = input.config;
  if (refusals.length > 0 || c.publicHostname === null || c.accessTeamDomain === null || c.accessAud === null) {
    return {
      stateWrites: [],
      proposedWrites: [],
      willApply: false,
      refusals: refusals.length > 0 ? refusals : ["Missing Access deployment facts — cannot build a plan."],
      record: null,
      ingressContents: null,
    };
  }

  const target = `http://${REMOTE_LOOPBACK_HOST}:${input.loopbackPort}`;
  const ingressContents = buildIngressConfig({
    publicHostname: c.publicHostname,
    loopbackPort: input.loopbackPort,
    tunnelName: c.tunnelName,
    credentialsFile: c.credentialsFile,
  });
  const record: AccessStateRecord = {
    version: ACCESS_STATE_VERSION,
    publicHostname: c.publicHostname,
    accessTeamDomain: c.accessTeamDomain,
    accessAud: c.accessAud,
    loopbackPort: input.loopbackPort,
    target,
    url: `https://${c.publicHostname}`,
    cloudflaredConfigPath: c.configPath,
    // Whole-file ownership stamp (RF-1): the hash of the EXACT ingress body we will write.
    cloudflaredConfigSha256: createHash("sha256").update(ingressContents, "utf8").digest("hex"),
    ...(input.now ? { createdAt: input.now } : {}),
  };

  const willApply = !input.dryRun && input.confirmed;
  const writes = [`write owned ingress config ${c.configPath}`, `record access-state`];
  return {
    stateWrites: willApply ? writes : [],
    proposedWrites: writes,
    willApply,
    refusals: [],
    record,
    ingressContents,
  };
}

export interface CloudflareDisablePlan {
  /** The Forge-owned paths disable will remove (the ingress file + the state record), or empty. */
  readonly removes: readonly string[];
  readonly hadRecord: boolean;
  readonly note: string;
}

/**
 * Decide what `disable` does. Pure. Removes ONLY the ingress file Forge authored plus its own
 * state record — NEVER the Access application, the tunnel, or cloudflared credentials (AC4/AC6).
 * A missing record ⇒ nothing to remove.
 */
export function planCloudflareDisable(record: AccessStateRecord | null): CloudflareDisablePlan {
  if (record === null) {
    return {
      removes: [],
      hadRecord: false,
      note: "No Forge-created Cloudflare deployment recorded — nothing to remove.",
    };
  }
  return {
    removes: [record.cloudflaredConfigPath, "access-state record"],
    hadRecord: true,
    note: `Will delete the Forge-owned ingress config ${record.cloudflaredConfigPath} and the state record for ${record.url}.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering (human). Pure functions of the report/plan.
// ---------------------------------------------------------------------------------------------

export function renderCloudflareDoctor(r: CloudflareDoctorReport): string {
  const yn = (b: boolean): string => (b ? "OK" : "MISSING");
  const lines: string[] = [];
  lines.push("forge remote cloudflare doctor");
  lines.push("");
  lines.push("Prerequisites:");
  lines.push(`  cloudflared CLI on PATH ....... ${yn(r.prerequisites.cliPresent)}`);
  lines.push(`  public hostname ............... ${r.access.publicHostname ?? "(not supplied)"}`);
  lines.push(`  Access team slug .............. ${r.access.teamDomain ?? "(not supplied)"}`);
  lines.push(`  Access application AUD ........ ${r.access.aud ?? "(not supplied)"}`);
  lines.push(
    `  team JWKS reachable ........... ${
      r.prerequisites.jwksReachable === null ? "(not probed)" : yn(r.prerequisites.jwksReachable)
    }`,
  );
  lines.push("");
  lines.push("Proposed tunnel target (Access-gated public hostname → loopback board):");
  lines.push(`  ${r.proposedTarget.url ?? "https://<your-hostname>"} → ${r.proposedTarget.loopback}`);
  lines.push(`  owned ingress config: ${r.access.ownedConfigPath}`);
  lines.push("");
  lines.push("Direct-origin boundary:");
  for (const b of r.boundary) lines.push(`  - ${b}`);
  lines.push("");
  lines.push("Identity:");
  lines.push(
    `  transport (${REMOTE_TRANSPORT_ENV}) ... ${r.identity.transport ?? "(unset — remote board refuses every request)"}`,
  );
  lines.push(`  identity mapping file ......... ${r.identity.mappingPath}`);
  lines.push("");
  lines.push("Required Cloudflare configuration (you arrange these — Forge does not):");
  for (const g of r.requiredGrants) lines.push(`  - ${g}`);
  if (r.activeDeployment) {
    lines.push("");
    lines.push(`Active Forge Cloudflare deployment: ${r.activeDeployment.url} → ${r.activeDeployment.target}`);
  }
  if (r.refusals.length > 0) {
    lines.push("");
    lines.push("NOT READY — setup would refuse:");
    for (const x of r.refusals) lines.push(`  ✗ ${x}`);
  } else {
    lines.push("");
    lines.push("READY — run `forge remote cloudflare setup --confirm` to apply.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Cross-boundary loader + production seams (see PACKAGE BOUNDARY).
// ---------------------------------------------------------------------------------------------

/** The production `cloudflared` runner: execFileSync with an ARGV array (never a shell string),
 *  fail-closed on spawn error / non-zero exit / timeout. Mirrors createTailscaleRunner. */
export function createCloudflaredRunner(bin = "cloudflared"): CliRunner {
  return (args) => {
    try {
      const stdout = execFileSync(bin, [...args], {
        timeout: 5000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, code: 0, stdout };
    } catch (err) {
      const code = (err as { status?: number | null }).status ?? -1;
      return { ok: false, code: typeof code === "number" ? code : -1, stdout: "" };
    }
  };
}

/** The production certs-reachability probe: a GET with a short timeout; any non-OK / thrown /
 *  timeouted result is `false` (unreachable ⇒ refuse). Never persists or logs the response body. */
export function createCertsProbe(): CertsProbe {
  return async (certsUrl) => {
    try {
      const res = await fetch(certsUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  };
}

/** Load the access-state store from the dashboard package at runtime (variable-specifier dynamic
 *  import — see PACKAGE BOUNDARY). */
export async function loadAccessStore(): Promise<AccessStateStore> {
  const spec = "../../../dashboard/src/remote/cloudflare/access-state.js";
  const mod = (await import(spec)) as {
    readAccessState: (env: NodeJS.ProcessEnv) => AccessStateRecord | null;
    resolveAccessStatePath: (env: NodeJS.ProcessEnv) => string;
    resolveOwnedIngressPath: (env: NodeJS.ProcessEnv) => string;
    applyCloudflareSetup: (
      record: AccessStateRecord,
      ingressContents: string,
      env: NodeJS.ProcessEnv,
    ) => SetupApplyResult;
    disableCloudflareSetup: (env: NodeJS.ProcessEnv) => DisableResult;
  };
  return {
    read: (env) => mod.readAccessState(env),
    path: (env) => mod.resolveAccessStatePath(env),
    ingressPath: (env) => mod.resolveOwnedIngressPath(env),
    apply: (record, ingressContents, env) => mod.applyCloudflareSetup(record, ingressContents, env),
    disable: (env) => mod.disableCloudflareSetup(env),
  };
}

// ---------------------------------------------------------------------------------------------
// Deps + gathering. Everything injectable so tests drive a fake cloudflared, a fake certs probe,
// and a temp FORGE_HOME without a real Cloudflare account.
// ---------------------------------------------------------------------------------------------

export interface RemoteCloudflareDeps {
  runner: CliRunner;
  env: NodeJS.ProcessEnv;
  store: AccessStateStore;
  probeCerts: CertsProbe;
  out: (line: string) => void;
  now: () => string;
}

async function resolveCloudflareDeps(partial?: Partial<RemoteCloudflareDeps>): Promise<RemoteCloudflareDeps> {
  return {
    runner: partial?.runner ?? createCloudflaredRunner(),
    env: partial?.env ?? process.env,
    store: partial?.store ?? (await loadAccessStore()),
    probeCerts: partial?.probeCerts ?? createCertsProbe(),
    out: partial?.out ?? ((line: string) => console.log(line)),
    now: partial?.now ?? (() => new Date().toISOString()),
  };
}

/** Resolve the deployment facts from flags (falling back to env). Pure. */
export function resolveCloudflareConfig(
  opts: {
    hostname?: string;
    team?: string;
    aud?: string;
    tunnel?: string;
    credentialsFile?: string;
    config?: string;
  },
  env: NodeJS.ProcessEnv,
): CloudflareConfigInput {
  return {
    publicHostname: trimToNull(opts.hostname) ?? trimToNull(env[CF_HOSTNAME_ENV]),
    accessTeamDomain: trimToNull(opts.team) ?? trimToNull(env[CF_TEAM_ENV]),
    accessAud: trimToNull(opts.aud) ?? trimToNull(env[CF_AUD_ENV]),
    tunnelName: trimToNull(opts.tunnel) ?? trimToNull(env[CF_TUNNEL_ENV]),
    credentialsFile: trimToNull(opts.credentialsFile),
    configPath: trimToNull(opts.config) ?? resolveOwnedIngressPathLocal(env),
  };
}

/** Gather the host facts the report/plans consume, using the injected runner + certs probe.
 *  Read-only: it runs only cloudflared READS and a certs-endpoint GET. */
async function gatherCloudflare(
  deps: RemoteCloudflareDeps,
  config: CloudflareConfigInput,
): Promise<CloudflareDoctorInput> {
  const cliPresent = deps.runner(["--version"]).ok;
  const listRes = cliPresent ? deps.runner(["tunnel", "list", "--output", "json"]) : { ok: false, code: -1, stdout: "" };
  const existingTunnels = listRes.ok ? parseTunnelList(listRes.stdout) : null;
  const certsUrl = resolveCertsUrl(config, deps.env);
  let jwksReachable: boolean | null = null;
  if (certsUrl) {
    try {
      jwksReachable = await deps.probeCerts(certsUrl);
    } catch {
      jwksReachable = false;
    }
  }
  return {
    cliPresent,
    config,
    loopbackPort: resolveRemotePort(deps.env),
    transport: resolveTransport(deps.env),
    mappingPath: resolveMappingPath(deps.env),
    jwksReachable,
    certsUrl,
    accessState: deps.store.read(deps.env),
    existingTunnels,
  };
}

/** Wrap a runner so any MUTATING cloudflared command throws — the belt on the --dry-run path so a
 *  bug (or a future edit) can never mutate under an inspection-only run (AC1). */
function cloudflaredReadOnlyGuardRunner(runner: CliRunner): CliRunner {
  return (args) => {
    if (isMutatingCloudflaredCommand(args)) {
      throw new Error(`dry-run refused to run a mutating cloudflared command: ${args.join(" ")}`);
    }
    return runner(args);
  };
}

// ---------------------------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------------------------

export async function runCloudflareDoctor(
  partial: Partial<RemoteCloudflareDeps>,
  opts: { json: boolean; config: CloudflareConfigInput },
): Promise<number> {
  const deps = await resolveCloudflareDeps(partial);
  const report = buildCloudflareDoctorReport(await gatherCloudflare(deps, opts.config));
  deps.out(opts.json ? JSON.stringify(report, null, 2) : renderCloudflareDoctor(report));
  return report.ok ? 0 : 1;
}

export async function runCloudflareSetup(
  partial: Partial<RemoteCloudflareDeps>,
  opts: { dryRun: boolean; confirm: boolean; json: boolean; config: CloudflareConfigInput },
): Promise<number> {
  const deps = await resolveCloudflareDeps(partial);
  // AC1 belt: on a dry-run, route EVERY cloudflared call through a guard that throws on a mutation.
  const runDeps: RemoteCloudflareDeps = opts.dryRun
    ? { ...deps, runner: cloudflaredReadOnlyGuardRunner(deps.runner) }
    : deps;
  const input = await gatherCloudflare(runDeps, opts.config);
  const report = buildCloudflareDoctorReport(input);
  const plan = planCloudflareSetup({
    report,
    config: opts.config,
    loopbackPort: input.loopbackPort,
    dryRun: opts.dryRun,
    confirmed: opts.confirm,
    now: deps.now(),
  });

  if (opts.json) {
    deps.out(JSON.stringify({ report, plan, dryRun: opts.dryRun, confirmed: opts.confirm }, null, 2));
  }

  // Refusal (AC4, missing prereqs) — write nothing, non-zero exit.
  if (plan.refusals.length > 0) {
    if (!opts.json) {
      deps.out("forge remote cloudflare setup: REFUSED — the deployment is not safe to create:");
      for (const x of plan.refusals) deps.out(`  ✗ ${x}`);
    }
    return 1;
  }

  // Dry-run (AC1): inspect only. The runner is already guarded; write nothing.
  if (opts.dryRun) {
    if (!opts.json) {
      deps.out("forge remote cloudflare setup --dry-run: NO changes made.");
      deps.out(`  Would front: ${plan.record?.url} → ${plan.record?.target}`);
      for (const w of plan.proposedWrites) deps.out(`  Would ${w}.`);
    }
    return 0;
  }

  // Preview (no --confirm): show the plan, write nothing.
  if (!opts.confirm) {
    if (!opts.json) {
      deps.out("forge remote cloudflare setup (preview — no --confirm):");
      deps.out(`  Would front: ${plan.record?.url} → ${plan.record?.target} (Cloudflare Access required).`);
      for (const w of plan.proposedWrites) deps.out(`  Would ${w}.`);
      deps.out("  Re-run with --confirm to apply.");
    }
    return 0;
  }

  // Apply: persist the record and lay down the owned ingress file ATOMICALLY and ownership-safely
  // (RF-1/RF-2 — record-first with rollback, and a refusal if the config path holds a file Forge
  // does not own). No cloudflared mutation is run — the operator runs `cloudflared tunnel run`.
  if (plan.record && plan.ingressContents !== null) {
    const applied = deps.store.apply(plan.record, plan.ingressContents, deps.env);
    if (applied.status === "refused-foreign-config") {
      // RF-1: a file Forge did not create sits at the target path — refuse, zero mutation.
      if (!opts.json) {
        deps.out("forge remote cloudflare setup: REFUSED — the ingress config path is not Forge-owned:");
        deps.out(`  ✗ ${applied.path} already exists and was not created by Forge.`);
        deps.out("  Forge will not overwrite (and later delete) a cloudflared config it did not author.");
        deps.out("  Move that file aside, or point --config at a new path Forge can own.");
      }
      return 1;
    }
    if (!opts.json) {
      deps.out("forge remote cloudflare setup: deployment recorded (Cloudflare Access required to reach the board).");
      deps.out(`  ${plan.record.url} → ${plan.record.target}`);
      deps.out(`  Owned ingress config: ${plan.record.cloudflaredConfigPath}`);
      deps.out(`  Recorded in ${deps.store.path(deps.env)} — remove it with \`forge remote cloudflare disable\`.`);
      deps.out("  Next: run `cloudflared tunnel run` against that config. Forge holds NO Cloudflare credentials.");
    }
  }
  return 0;
}

export async function runCloudflareDisable(partial: Partial<RemoteCloudflareDeps>, json: boolean): Promise<number> {
  const deps = await resolveCloudflareDeps(partial);
  const record = deps.store.read(deps.env);
  const plan = planCloudflareDisable(record);

  if (json) deps.out(JSON.stringify({ plan }, null, 2));

  if (!plan.hadRecord) {
    if (!json) deps.out(`forge remote cloudflare disable: ${plan.note}`);
    return 0;
  }

  // Remove ONLY the Forge-owned ingress file + state record, and ONLY when the file's bytes still
  // match the recorded ownership stamp (RF-1). A tampered/foreign file at the recorded path is
  // REFUSED, not deleted. NEVER the Access application, the tunnel, or cloudflared credentials.
  const result = deps.store.disable(deps.env);
  if (result.status === "refused-tampered") {
    if (!json) {
      deps.out("forge remote cloudflare disable: REFUSED — the recorded ingress config is not the file Forge wrote:");
      deps.out(`  ✗ ${result.path} no longer matches the recorded ownership hash (edited or replaced).`);
      deps.out("  Forge will not delete a file it cannot prove it authored. Remove it by hand if you intend to.");
    }
    return 1;
  }
  if (!json) {
    deps.out("forge remote cloudflare disable: removed the Forge-owned ingress config and state record.");
    deps.out("  The Cloudflare Access application, the tunnel, and cloudflared credentials were NOT touched.");
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Registration. One shared `remote` group so FG-784's Cloudflare variant slots in as a sibling
// of `tailscale`.
// ---------------------------------------------------------------------------------------------

export function registerRemote(program: Command, deps?: Partial<RemoteTailscaleDeps>): void {
  const remote = program
    .command("remote")
    .description("Manage remote access to the loopback-only Remote Board through a trusted transport proxy.");

  const tailscale = remote
    .command("tailscale")
    .description(
      "Front the Remote Board with a tailnet-private Tailscale Serve proxy (https://<host>.<tailnet>.ts.net → " +
        "http://127.0.0.1:<remote port>). Tailnet-only; Tailscale Funnel / public exposure is unsupported.",
    );

  tailscale
    .command("doctor")
    .description("Report prerequisites, the proposed Serve target, identity mode, required tailnet config, and Funnel status. Read-only.")
    .option("--json", "emit the structured report as JSON")
    .action(async (opts: { json?: boolean }) => {
      process.exitCode = await runDoctor(deps ?? {}, opts.json ?? false);
    });

  tailscale
    .command("setup")
    .description(
      "Propose (and, with --confirm, apply) the Serve mapping in front of the Remote Board. Refuses if Tailscale " +
        "Funnel is enabled; NEVER enables Funnel. Without --confirm, only previews.",
    )
    .option("--dry-run", "inspect only — perform NO host or tailnet change")
    .option("--confirm", "apply the Serve mapping (required to make any change)")
    .option("--json", "emit the structured report/plan as JSON")
    .action(async (opts: { dryRun?: boolean; confirm?: boolean; json?: boolean }) => {
      process.exitCode = await runSetup(deps ?? {}, {
        dryRun: opts.dryRun ?? false,
        confirm: opts.confirm ?? false,
        json: opts.json ?? false,
      });
    });

  tailscale
    .command("disable")
    .description(
      "Remove ONLY the Serve mapping Forge created (surgical — never `tailscale serve reset`). Does not touch Forge " +
        "data or the local dashboard.",
    )
    .option("--json", "emit the structured plan as JSON")
    .action(async (opts: { json?: boolean }) => {
      process.exitCode = await runDisable(deps ?? {}, opts.json ?? false);
    });

  // FG-784: the Cloudflare Access sibling. Production uses default seams (real cloudflared runner,
  // real certs probe, real access-state store); its actions are unit/integration-tested directly
  // with injected fakes (like the tailscale actions above), so registration wires no test deps.
  const cloudflare = remote
    .command("cloudflare")
    .description(
      "Front the Remote Board with a Cloudflare Tunnel GATED BY Cloudflare Access (https://<hostname> → " +
        "http://127.0.0.1:<remote port>). Refuses a public hostname with no Access policy; never persists " +
        "Cloudflare credentials.",
    );

  const cfConfig = (opts: {
    hostname?: string;
    team?: string;
    aud?: string;
    tunnel?: string;
    credentialsFile?: string;
    config?: string;
  }): CloudflareConfigInput => resolveCloudflareConfig(opts, process.env);

  cloudflare
    .command("doctor")
    .description(
      "Report prerequisites, the proposed Access-gated target, the direct-origin boundary, identity mode, and " +
        "required Cloudflare config. Read-only.",
    )
    .option("--hostname <host>", "the public hostname the tunnel will front")
    .option("--team <slug>", "the Cloudflare Access team SLUG, a single label with no dots (e.g. acme)")
    .option("--aud <tag>", "the Access application Audience (AUD) tag")
    .option("--json", "emit the structured report as JSON")
    .action(async (opts: { hostname?: string; team?: string; aud?: string; json?: boolean }) => {
      process.exitCode = await runCloudflareDoctor({}, { json: opts.json ?? false, config: cfConfig(opts) });
    });

  cloudflare
    .command("setup")
    .description(
      "Propose (and, with --confirm, apply) the Cloudflare Access + Tunnel deployment in front of the Remote " +
        "Board. REFUSES a public hostname without an Access policy (team + AUD). Writes only a Forge-owned " +
        "ingress config; never Cloudflare credentials. Without --confirm, only previews.",
    )
    .option("--hostname <host>", "the public hostname the tunnel will front")
    .option("--team <slug>", "the Cloudflare Access team SLUG, a single label with no dots (e.g. acme)")
    .option("--aud <tag>", "the Access application Audience (AUD) tag")
    .option("--tunnel <name>", "the cloudflared tunnel name to reference in the owned ingress config")
    .option("--credentials-file <path>", "path to cloudflared tunnel credentials (written to the owned config, never persisted here)")
    .option("--config <path>", "override the owned ingress config path (default: under FORGE_HOME)")
    .option("--dry-run", "inspect only — write NOTHING to disk")
    .option("--confirm", "apply the deployment (required to write the owned ingress config + state record)")
    .option("--json", "emit the structured report/plan as JSON")
    .action(
      async (opts: {
        hostname?: string;
        team?: string;
        aud?: string;
        tunnel?: string;
        credentialsFile?: string;
        config?: string;
        dryRun?: boolean;
        confirm?: boolean;
        json?: boolean;
      }) => {
        process.exitCode = await runCloudflareSetup(
          {},
          {
            dryRun: opts.dryRun ?? false,
            confirm: opts.confirm ?? false,
            json: opts.json ?? false,
            config: cfConfig(opts),
          },
        );
      },
    );

  cloudflare
    .command("disable")
    .description(
      "Remove ONLY the Forge-owned ingress config and state record (never the Access application, the tunnel, or " +
        "cloudflared credentials).",
    )
    .option("--json", "emit the structured plan as JSON")
    .action(async (opts: { json?: boolean }) => {
      process.exitCode = await runCloudflareDisable({}, opts.json ?? false);
    });
}
