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
 *  matching config.ts). */
export function resolveTransport(env: NodeJS.ProcessEnv): string | null {
  const raw = env[REMOTE_TRANSPORT_ENV];
  if (raw === undefined) return null;
  const token = raw.trim().toLowerCase();
  return token === "tailscale" ? token : null;
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
}
