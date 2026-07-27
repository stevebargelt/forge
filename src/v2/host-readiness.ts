// FG-566: the SHARED readiness contract for Forge-owned HOST-side verification.
//
// THE DEFECT, ONE SHAPE ON TWO PATHS. A Forge-owned verification runs on the
// host inside a freshly-created workspace that has no dependencies installed,
// and the resulting failure is reported as if the reviewed CODE were broken:
// the review loop turns it into fixer findings and burns a round; the
// FG-357/FG-425 integration gate dies with ERR_MODULE_NOT_FOUND and records
// `integration_failed` — a code verdict for an environment fault.
//
// THIS MODULE IS A PRECONDITION, NEVER A POST-HOC REINTERPRETATION. It runs
// BEFORE the verification it covers and either establishes an execution-ready
// environment bound to that exact workspace, or refuses ONCE with a classified
// environment/readiness outcome. Nothing here ever inspects a verification's
// output — which is precisely what makes the inverse defect structurally
// impossible: a real test failure after a successful preparation cannot be
// laundered into an infrastructure outcome, because by then readiness has
// already returned and has no say.
//
// WHAT IS SHARED between the two consumers (and what is not): the fidelity
// checks (tree identity, lockfile digest, runtime/ABI), the durable evidence
// record, and the refusal vocabulary below are SHARED. What legitimately
// differs is the mechanics on either side of this call — a persistent review
// clone reuses a warm assertion, a disposable publication worktree materializes
// throwaway — and the PROJECTION of one classified refusal into the review
// loop's StopReason on one side and a PublishOutcome arm on the other.
//
// PROVENANCE RULE: the workspace under test supplies DATA (does it have a
// package.json, what is its lockfile digest, does it pin a Node major, is it
// dirty). The OPERATOR supplies the setup COMMAND, read ONLY from HOST-LEVEL
// configuration — ~/.forge/config.json (paths.ts's hostConfigPath) or an explicit
// env override — never from any path inside any project checkout. This module
// takes no `configDir`: there is deliberately no parameter a caller could bind to
// the workspace under test, because a workspace that could name its own setup
// command could run anything under forge's host identity, and BOTH consumers used
// to pass a project directory here. When no host-level contract exists the only
// other command that may run is the lockfile-derived `npm ci` — a fixed argv the
// reviewed tree can only enable, never choose.
//
// BOUNDARIES. FG-376 owns CONTAINER dependency provisioning; this module reuses
// its failure vocabulary (`verification_environment_unavailable`) and its
// lockfile digest helpers, and is prohibited from touching its keyspace (see
// host-readiness-store.ts). FG-627 owns container nested-volume mount mechanics
// — adjacent and separate. FG-555 owns the runtime contract for unattended
// verification: the pinned-PATH control-runtime profile below IS that contract,
// imported rather than re-invented.

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAbi } from "../cli/node-abi.js";
import { logEvent } from "../store/events.js";
import { nowIso } from "../util/ids.js";
import { hostConfigPath } from "../util/paths.js";
import { safeLockfileHash } from "./dependency-provisioning.js";
import { controlRuntimeProfile } from "./launch.js";
import { forgeSourceRoot, isSelfHostDispatch } from "./self-host-guard.js";
import {
  hostReadinessSetupTimeoutMs,
  readReadinessRecord,
  readinessMatches,
  withReadinessLock,
  workspaceHasNodeModules,
  writeReadinessRecord,
  type HostReadinessBinding,
  type HostReadinessRecord,
  type ReadinessLockDeps,
} from "./host-readiness-store.js";

/** The ONE refusal vocabulary both consumers classify against. Extending it is a
 *  deliberate act: a consumer that invents its own reason is the drift this
 *  ticket exists to prevent. */
export type HostReadinessRefusalReason =
  | "no_setup_contract"          // no operator-declared setup command and no lockfile to derive one from — forge refuses to guess
  | "self_host_workspace"        // the workspace overlaps the forge source root this process is executing from — an install there would delete forge's own live bindings
  | "runtime_unresolved"         // the intended verification interpreter could not be resolved/probed, or the workspace's ABI requirement could not be established
  | "runtime_abi_mismatch"       // it resolved, but its ABI is not the one the workspace requires (checkAbi)
  | "setup_failed"               // the setup command ran and exited non-zero
  | "setup_timed_out"            // the setup command exceeded the setup ceiling
  | "setup_contended"            // another host process holds this workspace's readiness lock and outlasted the bounded wait
  | "workspace_dirtied_by_setup"; // setup changed the workspace's git status — preparation may never move the tree under test

export type HostReadinessEvidence = {
  workspace: string;
  treeSha: string;
  lockfileDigest: string;
  nodeVersion: string;
  abi: string;
  /** What `abi` was CHECKED AGAINST, and where that requirement came from — the
   *  two must never share a source (see resolveRuntimeRequirement). "(none)" when
   *  the workspace states no runtime contract at all. */
  requiredAbi: string;
  /** The interpreter resolved off the PINNED PATH — the one the covered
   *  verification will actually execute under, not forge's own process.execPath. */
  interpreter: string;
  setupCommand: string;
  /** Evidence ONLY. The verification command set records what this assertion
   *  covered; it is never a reuse or invalidation key (see HostReadinessBinding). */
  coveredCommandSet: string[];
  reused: boolean;
};

export type HostReadinessRefusal = {
  reason: HostReadinessRefusalReason;
  workspace: string;
  command: string;
  exitStatus: number | null;
  stderrTail: string;
  /** Operator-facing, prefixed with the shared `verification_environment_unavailable`
   *  token so every surface that renders it carries the classification. */
  message: string;
};

export type HostReadinessOutcome =
  | { kind: "ready"; evidence: HostReadinessEvidence }
  /** Nothing to establish: no verification commands to cover, no npm-shaped
   *  project, nothing declared to install, or a workspace forge did not
   *  provision and must not touch. NEVER a refusal — readiness must not newly
   *  block a path that was already runnable. */
  | { kind: "not_required"; workspace: string; why: string }
  | { kind: "refused"; refusal: HostReadinessRefusal };

export type HostReadinessRequest = {
  /** The directory the verification will run in. */
  workspace: string;
  /** The candidate identity readiness is asserted FOR — HEAD for a review clone,
   *  the already-captured candidateSha for a publication worktree. */
  treeSha: string;
  /** The verification commands this readiness covers. Empty ⇒ not_required. */
  coveredCommandSet: string[];
  /** Operator-facing label for events/messages, e.g. "review-loop". */
  label: string;
  runId?: string;
  taskId?: string;
};

export type SetupRun = {
  ok: boolean;
  status: number | null;
  timedOut: boolean;
  stderrTail: string;
};

export type HostReadinessDeps = {
  /** Runs the resolved setup command. Injectable so a test can force every
   *  failure arm without a real install. */
  runSetup?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => SetupRun;
  probeAbi?: (nodeExec: string) => string | undefined;
  probeNodeVersion?: (nodeExec: string) => string | undefined;
  /** `git status --porcelain` in a directory; "" when git cannot answer. */
  porcelain?: (dir: string) => string;
  lock?: ReadinessLockDeps;
  /** The forge source root the self-host refusal compares against. Injectable so a
   *  test can stage an overlapping workspace without running from one. */
  sourceRoot?: string;
};

const STDERR_TAIL_CHARS = 2000;

/** The LAST bytes of an output stream — the tail is what names the failure
 *  (`ERR_MODULE_NOT_FOUND`, npm's error summary), and a head slice is what left
 *  the FG-566 findings reporting a bare colon. */
export function tailOf(output: string, chars: number = STDERR_TAIL_CHARS): string {
  const trimmed = output.trim();
  return trimmed.length <= chars ? trimmed : `…${trimmed.slice(trimmed.length - chars)}`;
}

function defaultRunSetup(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): SetupRun {
  try {
    execFileSync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, status: 0, timedOut: false, stderrTail: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; status?: number | null; code?: string };
    const combined = [err.stdout, err.stderr].filter((s): s is string => Boolean(s)).join("\n") || err.message || String(e);
    return {
      ok: false,
      status: err.status ?? null,
      // execFileSync sets code === "ETIMEDOUT" only when ITS OWN timeout fired.
      timedOut: err.code === "ETIMEDOUT",
      stderrTail: tailOf(combined),
    };
  }
}

function defaultProbe(flag: string): (nodeExec: string) => string | undefined {
  return (nodeExec) => {
    try {
      return execFileSync(nodeExec, ["-p", flag], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
}

function defaultPorcelain(dir: string): string {
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "-z"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return "";
  }
}

function readPackageJson(dir: string): { scripts?: Record<string, unknown>; [k: string]: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when the project declares anything to install. A package.json with only
 *  `scripts` (the shape most test fixtures use, and a legitimate real shape) has
 *  no dependency graph to establish, so readiness is not_required rather than a
 *  new refusal for a project that ran fine before. */
function declaresDependencies(pkg: Record<string, unknown>): boolean {
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const section = pkg[key];
    if (section && typeof section === "object" && Object.keys(section as object).length > 0) return true;
  }
  return false;
}

/** HOST-LEVEL operator config only (paths.ts's hostConfigPath). Deliberately takes
 *  no directory argument: there is no seam here a caller could point at a project
 *  checkout, which is what made the workspace under test able to name the command
 *  that runs on the host. */
function readHostConfigString(key: string): string | undefined {
  try {
    const config = JSON.parse(readFileSync(hostConfigPath(), "utf8")) as Record<string, unknown>;
    const value = config[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The fixed argv the lockfile-detected default resolves to. A literal, never
 *  assembled from anything the workspace supplies: the reviewed tree's only
 *  influence over it is whether a package-lock.json exists. */
const DEFAULT_SETUP_COMMAND = "npm ci";

/** The OPERATOR-owned setup contract, in precedence order:
 *   1. FORGE_HOST_VERIFICATION_SETUP — an explicit per-invocation operator override;
 *   2. `hostVerificationSetup` in HOST-LEVEL ~/.forge/config.json;
 *   3. the derived default `npm ci`, and ONLY when the workspace actually has a
 *      package-lock.json to install from.
 *  Both trusted sources live OUTSIDE every project checkout. A
 *  `<project>/.forge/config.json` is never consulted — it is inside the workspace
 *  under test, and this command is handed to execFileSync on the HOST with no
 *  container boundary (compare dependency-provisioning.ts's isSafeWorkspacePath:
 *  same class of sink, and that one already refuses workspace-supplied values).
 *  Returns undefined when none applies — the caller refuses `no_setup_contract`
 *  rather than guessing (`npm install` without a lockfile is a guess: it may
 *  resolve a different graph than the one under review, and it rewrites the
 *  lockfile in the tree under test). */
export function resolveSetupCommand(workspace: string): string | undefined {
  const override = process.env["FORGE_HOST_VERIFICATION_SETUP"];
  if (override && override.trim().length > 0) return override.trim();
  const configured = readHostConfigString("hostVerificationSetup");
  if (configured) return configured;
  if (existsSync(join(workspace, "package-lock.json"))) return DEFAULT_SETUP_COMMAND;
  return undefined;
}

/** NODE_MODULE_VERSION per Node major. Only majors whose ABI is a published fact
 *  are listed; an unlisted major falls back to a MAJOR-vs-MAJOR comparison against
 *  the resolved interpreter rather than being guessed at. */
const NODE_ABI_BY_MAJOR: Record<string, string> = {
  "16": "93", "18": "108", "19": "111", "20": "115",
  "21": "120", "22": "127", "23": "131", "24": "137",
};

function firstMajor(raw: string): number | undefined {
  const m = /(\d+)/.exec(raw.trim());
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

/** An inclusive interval of acceptable Node MAJORS. `max` is Infinity for an
 *  open upper bound (">=18"). */
type MajorRange = { min: number; max: number };

/** The set of majors a declaration accepts — or undefined for anything this
 *  parser does not recognize, which means NO requirement rather than a refusal.
 *
 *  A RANGE IS NOT A PIN. Taking the first digit run out of the declaration and
 *  handing it to checkAbi (equality by design, FG-570) turns `">=18"` on a host
 *  legitimately running Node 24 into a permanent runtime_abi_mismatch: no
 *  interpreter can ever satisfy an ABI derived that way. Forge's own tree escapes
 *  it only because its `.nvmrc` pins an exact "24" and is read first — its
 *  `engines.node` is `"^24"`.
 *
 *  FAILS OPEN BY CONSTRUCTION: one unrecognized token abandons the whole
 *  declaration, so unparseable syntax ends at "no requirement established" and
 *  never at a refusal. The comparators are widened to major granularity in the
 *  permissive direction (`<24.0.0` admits major 24) for the same reason — a
 *  missed refusal is recoverable, a false one blocks the path forever. */
function declaredMajorRanges(raw: string): MajorRange[] | undefined {
  const declaration = raw.trim();
  if (!declaration) return undefined;
  const union: MajorRange[] = [];
  for (const clause of declaration.split("||")) {
    const comparators = clause.trim().split(/[\s,]+/).filter(Boolean);
    if (comparators.length === 0) return undefined;
    let range: MajorRange = { min: 0, max: Number.POSITIVE_INFINITY };
    for (const comparator of comparators) {
      const m = /^(>=|<=|>|<|\^|~|=)?v?(\d+)(?:\.(?:\d+|[xX*])){0,2}$/.exec(comparator);
      if (!m?.[2]) return undefined;
      const n = Number.parseInt(m[2], 10);
      if (!Number.isFinite(n)) return undefined;
      const bound: MajorRange =
        m[1] === ">=" || m[1] === ">" ? { min: n, max: Number.POSITIVE_INFINITY }
          : m[1] === "<=" || m[1] === "<" ? { min: 0, max: n }
            : { min: n, max: n };
      range = { min: Math.max(range.min, bound.min), max: Math.min(range.max, bound.max) };
    }
    if (range.min > range.max) return undefined;
    union.push(range);
  }
  return union.length > 0 ? union : undefined;
}

/** The one major a declaration admits, when it admits exactly one — `.nvmrc`
 *  "24", `engines.node` "24", "24.x" and "^24" all pin Node 24 and nothing else,
 *  so they keep the exact-ABI treatment. ">=18" and "^22 || ^24" do not. */
function exactPin(ranges: MajorRange[]): number | undefined {
  const only = ranges.length === 1 ? ranges[0] : undefined;
  return only && only.min === only.max ? only.min : undefined;
}

/** The runtime contract the WORKSPACE declares, from its own files — `.nvmrc`
 *  first (what `nvm use` in that checkout resolves), then `engines.node`. A file
 *  whose declaration this parser cannot read is not a refusal: it falls through
 *  to the next source, ending at "no requirement established". Workspace DATA,
 *  per the provenance rule: it selects nothing executable, it only states what
 *  the tree's native bindings are built for. */
function declaredNodeRuntime(
  workspace: string,
  pkg: Record<string, unknown>,
): { ranges: MajorRange[]; declaration: string; source: string } | undefined {
  try {
    const nvmrc = (readFileSync(join(workspace, ".nvmrc"), "utf8").split("\n")[0] ?? "").trim();
    if (!/^lts/i.test(nvmrc)) {
      const ranges = declaredMajorRanges(nvmrc);
      if (ranges) return { ranges, declaration: nvmrc, source: ".nvmrc" };
    }
  } catch {
    // no .nvmrc — fall through to engines
  }
  const engines = pkg["engines"];
  const node = engines && typeof engines === "object" ? (engines as Record<string, unknown>)["node"] : undefined;
  if (typeof node === "string") {
    const ranges = declaredMajorRanges(node);
    if (ranges) return { ranges, declaration: node.trim(), source: "package.json engines.node" };
  }
  return undefined;
}

/** What the resolved runtime must satisfy, and WHERE THAT CAME FROM. Every source
 *  here is independent of the interpreter being checked — that independence is the
 *  whole point. The pre-fix code took `requireAbi` from `process.versions.modules`
 *  and `abi` from probing `process.execPath`, so checkAbi compared a value to
 *  itself and returned ok on every real invocation; the FG-555 false-red class it
 *  exists to eliminate went untested.
 *
 *  `none` is NOT a silent ok: it is the honest answer for a workspace that pins no
 *  Node and has never been prepared, which has no native-binding ABI to satisfy
 *  because nothing in it was built against one. It is the only arm that skips the
 *  comparison, and it is unreachable for any workspace forge has installed into
 *  (that one carries a record, arm 4). */
type RuntimeRequirement =
  | { kind: "abi"; abi: string; source: string }
  | { kind: "major"; major: number; source: string }
  /** A declaration that admits MORE THAN ONE major (">=18", "^22 || ^24"). It has
   *  no single ABI to compare against, so it is satisfied by membership. */
  | { kind: "majorRange"; ranges: MajorRange[]; declaration: string; source: string }
  | { kind: "none" };

function resolveRuntimeRequirement(
  workspace: string,
  pkg: Record<string, unknown>,
  record: HostReadinessRecord | null,
): RuntimeRequirement {
  const override = process.env["FORGE_HOST_READINESS_REQUIRE_ABI"]?.trim();
  if (override) return { kind: "abi", abi: override, source: "FORGE_HOST_READINESS_REQUIRE_ABI" };
  const configured = readHostConfigString("hostVerificationRequireAbi");
  if (configured) return { kind: "abi", abi: configured, source: `hostVerificationRequireAbi in ${hostConfigPath()}` };
  const declared = declaredNodeRuntime(workspace, pkg);
  const pinned = declared ? exactPin(declared.ranges) : undefined;
  if (declared && pinned !== undefined) {
    const abi = NODE_ABI_BY_MAJOR[String(pinned)];
    return abi
      ? { kind: "abi", abi, source: `${declared.source} (Node ${pinned})` }
      : { kind: "major", major: pinned, source: declared.source };
  }
  // The ABI this workspace's INSTALLED bindings were actually built under. A
  // workspace prepared under one interpreter and verified under another is the
  // native-loader crash this contract exists to preempt. It outranks a non-exact
  // declaration deliberately: a tree installed under Node 22 crashes its native
  // loader under Node 24 no matter how happily ">=18" admits both.
  //
  // ONLY a `ready` record, for the same reason readinessMatches requires one: a
  // `preparing` record is an install that did NOT complete, so there may be no
  // bindings built under its ABI at all. Trusted irrespective of state, the record
  // a FAILED attempt left behind becomes the requirement the NEXT attempt is
  // checked against — so an operator who corrects the interpreter is refused
  // `runtime_abi_mismatch` citing the very interpreter that failed, identically
  // forever, and the setup command never runs again. A non-ready record supplies
  // nothing; the requirement falls through as if no record existed.
  if (record?.state === "ready" && record.abi) {
    return { kind: "abi", abi: record.abi, source: "the workspace's prior readiness record" };
  }
  if (declared) {
    return { kind: "majorRange", ranges: declared.ranges, declaration: declared.declaration, source: declared.source };
  }
  return { kind: "none" };
}

/** The interpreter the covered verification will ACTUALLY run under: the first
 *  executable `node` on the PINNED PATH — resolved exactly the way the setup
 *  child and the verification child will resolve it, rather than assuming
 *  process.execPath and then probing process.execPath back. */
export function resolveVerificationInterpreter(pinnedPath: string): string | undefined {
  for (const dir of pinnedPath.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "node");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here — keep walking the pinned PATH
    }
  }
  return undefined;
}

/** Environment variables the package manager genuinely needs. Everything else in
 *  forge's process environment (credentials, tokens, auth profiles, FORGE_*) is
 *  withheld: the publication candidate is a tree with agent branches merged into
 *  it, so its package lifecycle scripts are attacker-controlled code and this is
 *  the env they would run with. */
const SETUP_ENV_PASSTHROUGH = [
  "HOME", "TMPDIR", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  "npm_config_registry", "npm_config_cache", "NPM_CONFIG_USERCONFIG",
];

/** The setup child's environment: EXPLICITLY CONSTRUCTED, never `...process.env`.
 *  Pins the FG-555 PATH (so the install and the verification it certifies resolve
 *  the same interpreter) and suppresses package lifecycle scripts —
 *  preinstall/install/postinstall out of merged agent content must not execute on
 *  the host. Applied on BOTH consumers: the publication candidate carries merged
 *  agent branches, and the review-loop workspace carries the very diff under
 *  review, so neither tree's lifecycle scripts are operator-authored. */
function setupEnv(pinnedPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: pinnedPath,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  for (const key of SETUP_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The environment a COVERED verification must run under. Same pinned PATH the
 *  readiness assertion was made against — without this the assertion covers a
 *  different interpreter than the one that runs, which makes it meaningless.
 *  Unlike setupEnv this inherits process.env: a verification legitimately needs
 *  the operator's environment (it is running the operator's own test suite), and
 *  it runs AFTER preparation, not as an install-time lifecycle hook. */
export function pinnedVerificationEnv(label: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: controlRuntimeProfile({ label: `host-verification:${label}` }).path };
}

/** The verification command set the FG-357 integration gate will actually run
 *  against a candidate. Mirrors integration-gate.ts's own skip (a project with no
 *  test:unit script has nothing for the gate to run) WITHOUT modifying it, so
 *  readiness inherits that skip instead of newly blocking such a project. */
export function integrationGateCommandSet(dir: string): string[] {
  const pkg = readPackageJson(dir);
  return typeof pkg?.scripts?.["test:unit"] === "string" ? ["npm run test:unit"] : [];
}

function refuse(
  req: HostReadinessRequest,
  reason: HostReadinessRefusalReason,
  command: string,
  detail: string,
  extra: { exitStatus?: number | null; stderrTail?: string } = {},
): HostReadinessOutcome {
  const refusal: HostReadinessRefusal = {
    reason,
    workspace: req.workspace,
    command,
    exitStatus: extra.exitStatus ?? null,
    stderrTail: extra.stderrTail ?? "",
    message:
      `verification_environment_unavailable: ${req.label} could not establish an execution-ready verification ` +
      `environment in ${req.workspace} (${reason}). ${detail}`,
  };
  logEvent("host_readiness.refused", {
    ...(req.runId ? { runId: req.runId } : {}),
    ...(req.taskId ? { taskId: req.taskId } : {}),
    payload: {
      reason: refusal.reason,
      workspace: refusal.workspace,
      command: refusal.command,
      exitStatus: refusal.exitStatus,
      stderrTail: refusal.stderrTail,
      label: req.label,
      treeSha: req.treeSha,
    },
  });
  return { kind: "refused", refusal };
}

function ready(req: HostReadinessRequest, evidence: HostReadinessEvidence): HostReadinessOutcome {
  logEvent("host_readiness.ready", {
    ...(req.runId ? { runId: req.runId } : {}),
    ...(req.taskId ? { taskId: req.taskId } : {}),
    payload: {
      workspace: evidence.workspace,
      treeSha: evidence.treeSha,
      lockfileDigest: evidence.lockfileDigest,
      nodeVersion: evidence.nodeVersion,
      abi: evidence.abi,
      requiredAbi: evidence.requiredAbi,
      interpreter: evidence.interpreter,
      setupCommand: evidence.setupCommand,
      reused: evidence.reused,
      coveredCommandSet: evidence.coveredCommandSet,
      label: req.label,
    },
  });
  return { kind: "ready", evidence };
}

/** Prepare-or-refuse. Establishes an execution-ready verification environment
 *  bound to EXACTLY this workspace/tree/lockfile/runtime, or returns one
 *  classified refusal. Never mutates the reviewed source or lockfile, never
 *  touches another workspace, and never proceeds when setup moved the tree under
 *  test. */
export async function prepareHostVerification(
  req: HostReadinessRequest,
  deps: HostReadinessDeps = {},
): Promise<HostReadinessOutcome> {
  const { workspace } = req;

  // SELF-HOST DESTRUCTION — EVALUATED FIRST, BEFORE EVERY OTHER ARM INCLUDING THE
  // not_required ONES. Anything below can end in `npm ci` running in `workspace`,
  // and `npm ci` DELETES node_modules before rebuilding it. When the workspace
  // overlaps the forge source root THIS process is executing from, that deletes the
  // better-sqlite3 binding out from under the running orchestrator (bin/forge runs
  // src/ in-process via tsx — FG-569) and every concurrent forge on the host.
  // `forge review-loop --project` defaults to process.cwd(), so the live checkout is
  // the DEFAULT target.
  //
  // ORDER IS THE GUARD. Ordered behind the not_required arms it was unreachable in
  // the common case: a live checkout that already has node_modules and no readiness
  // record short-circuits to not_required, so the destructive outcome was avoided
  // only incidentally (not_required happens to install nothing) and a STALE
  // self-host tree was certified as needing nothing rather than refused — the
  // FG-555 false-red class this binding exists to prevent. A refusal that a branch
  // never reaches is not a guard.
  //
  // Evaluated INDEPENDENTLY of isWorktreeModeEnabled() and FORGE_NO_WORKTREES:
  // FG-612's dispatch guard returns early under worktree mode (self-host-guard.ts)
  // because it is protecting AGENT writes, which a worktree does isolate — but
  // readiness installs into the workspace it was handed, and no worktree setting
  // makes an rm -rf of forge's live bindings safe. There is deliberately NO
  // acknowledged-override escape hatch here for the same reason.
  const sourceRoot = deps.sourceRoot ?? forgeSourceRoot();
  if (isSelfHostDispatch(workspace, sourceRoot)) {
    return refuse(
      req, "self_host_workspace", "(none)",
      `The workspace overlaps the forge source root this process is executing from (${sourceRoot}). Preparing it ` +
        `would run an install that deletes and rebuilds the node_modules this forge — and every concurrent forge on ` +
        `this host — is loading its native bindings from. Prepare a workspace outside the forge checkout, or install ` +
        `dependencies there yourself before running verification.`,
    );
  }

  if (req.coveredCommandSet.length === 0) {
    return { kind: "not_required", workspace, why: "no verification commands to cover" };
  }
  const pkg = readPackageJson(workspace);
  if (!pkg) {
    return { kind: "not_required", workspace, why: "no readable package.json — nothing npm-shaped to establish" };
  }
  if (!declaresDependencies(pkg)) {
    return { kind: "not_required", workspace, why: "package.json declares no dependencies to install" };
  }

  const record = readReadinessRecord(workspace);
  const hasModules = workspaceHasNodeModules(workspace);
  if (hasModules && !record) {
    // A dependency tree forge did not put there — the operator's live checkout is
    // the canonical case. Preparing it would mean `npm ci` DELETING and rebuilding
    // the operator's node_modules (and its shared native bindings) as remediation,
    // which FG-566 forbids outright. It was already runnable; leave it exactly as
    // it is.
    //
    // "forge did not put there" is decided by the ABSENCE OF ANY RECORD, not by the
    // absence of a MATCHING one: a record in state `preparing` (a failed or crashed
    // install that left a half-populated tree behind) means this workspace IS
    // forge's to re-prepare, and must never be mistaken for a foreign tree.
    return { kind: "not_required", workspace, why: "workspace already carries a dependency tree forge did not provision" };
  }

  // THE RUNTIME CONTRACT, checked against TWO INDEPENDENT SOURCES.
  //   actual:   the first executable `node` on the PINNED PATH (FG-555) — the
  //             interpreter the setup child and the covered verification will both
  //             resolve — probed for its ABI and version.
  //   required: what the WORKSPACE states it needs (operator override → host-level
  //             config → its own .nvmrc/engines → the ABI its installed tree was
  //             built under). Never forge's own process.versions.modules, which is
  //             where the tautology came from.
  const profile = controlRuntimeProfile({ label: `host-readiness:${req.label}` });
  const interpreter = resolveVerificationInterpreter(profile.path);
  if (!interpreter) {
    return refuse(
      req, "runtime_unresolved", "(none)",
      `No executable \`node\` on the pinned verification PATH (${profile.path}). The covered verification would ` +
        `resolve an interpreter forge cannot identify, so there is nothing to assert readiness against.`,
    );
  }
  const probeAbi = deps.probeAbi ?? defaultProbe("process.versions.modules");
  const probeVersion = deps.probeNodeVersion ?? defaultProbe("process.version");
  const abi = probeAbi(interpreter);
  const nodeVersion = probeVersion(interpreter);
  if (!abi || !nodeVersion) {
    return refuse(
      req, "runtime_unresolved", interpreter,
      `The intended verification interpreter could not be probed (abi=${abi ?? "(unreadable)"}, version=${nodeVersion ?? "(unreadable)"}). ` +
        `Forge will not prepare or verify under an interpreter it cannot identify.`,
    );
  }

  const requirement = resolveRuntimeRequirement(workspace, pkg, record);
  if (requirement.kind === "abi") {
    // ONE ABI checker, FG-570's — equality, never a floor, because a native binding
    // built for one ABI loads under that ABI only.
    const abiCheck = checkAbi(abi, requirement.abi, nodeVersion);
    if (!abiCheck.ok) {
      return refuse(
        req, "runtime_abi_mismatch", interpreter,
        `${abiCheck.message}\nrequired ABI ${requirement.abi} comes from ${requirement.source}; the verification would run under ${interpreter}.`,
        { stderrTail: tailOf(abiCheck.message) },
      );
    }
  } else if (requirement.kind === "major") {
    const actualMajor = firstMajor(nodeVersion.replace(/^v/, ""));
    if (actualMajor === undefined) {
      return refuse(
        req, "runtime_unresolved", interpreter,
        `${interpreter} reported an unparseable version (${nodeVersion}), so it cannot be checked against the Node ` +
          `${requirement.major} this workspace pins in its ${requirement.source}.`,
      );
    }
    if (actualMajor !== requirement.major) {
      return refuse(
        req, "runtime_abi_mismatch", interpreter,
        `This workspace pins Node ${requirement.major} (${requirement.source}) but the verification would run under ` +
          `${interpreter} — Node ${nodeVersion}. A native binding built for one Node major's ABI loads under that ABI only.`,
      );
    }
  } else if (requirement.kind === "majorRange") {
    // Satisfaction, not equality: any major the declaration admits is acceptable.
    const actualMajor = firstMajor(nodeVersion.replace(/^v/, ""));
    if (actualMajor === undefined) {
      return refuse(
        req, "runtime_unresolved", interpreter,
        `${interpreter} reported an unparseable version (${nodeVersion}), so it cannot be checked against the ` +
          `\`${requirement.declaration}\` this workspace declares in its ${requirement.source}.`,
      );
    }
    if (!requirement.ranges.some((r) => actualMajor >= r.min && actualMajor <= r.max)) {
      return refuse(
        req, "runtime_abi_mismatch", interpreter,
        `This workspace declares Node \`${requirement.declaration}\` (${requirement.source}) but the verification ` +
          `would run under ${interpreter} — Node ${nodeVersion}, which that declaration does not admit.`,
      );
    }
  }
  const requiredAbi = requirement.kind === "abi" ? `${requirement.abi} (${requirement.source})`
    : requirement.kind === "major" ? `Node ${requirement.major} (${requirement.source})`
      : requirement.kind === "majorRange" ? `Node ${requirement.declaration} (${requirement.source})`
        : "(none)";

  const binding: HostReadinessBinding = {
    workspace,
    treeSha: req.treeSha,
    lockfileDigest: safeLockfileHash(workspace) ?? "(no-lockfile)",
    nodeVersion,
    abi,
  };

  if (hasModules && readinessMatches(record, binding)) {
    return ready(req, {
      ...binding,
      requiredAbi,
      interpreter,
      setupCommand: record!.setupCommand,
      coveredCommandSet: req.coveredCommandSet,
      reused: true,
    });
  }

  const porcelain = deps.porcelain ?? defaultPorcelain;
  const runSetup = deps.runSetup ?? defaultRunSetup;

  const locked = await withReadinessLock(workspace, async (): Promise<HostReadinessOutcome> => {
    // Re-check under the lock: another host process may have prepared this exact
    // binding while we were waiting for it.
    const current = readReadinessRecord(workspace);
    if (workspaceHasNodeModules(workspace) && readinessMatches(current, binding)) {
      return ready(req, {
        ...binding,
        requiredAbi,
        interpreter,
        setupCommand: current!.setupCommand,
        coveredCommandSet: req.coveredCommandSet,
        reused: true,
      });
    }

    const setupCommand = resolveSetupCommand(workspace);
    if (!setupCommand) {
      return refuse(
        req, "no_setup_contract", "(none)",
        `No operator-declared setup contract for this project: ${hostConfigPath()} names no ` +
          `\`hostVerificationSetup\`, FORGE_HOST_VERIFICATION_SETUP is unset, and ${workspace} has no package-lock.json to ` +
          `derive \`npm ci\` from. Forge fails BEFORE verification rather than guessing an install command.`,
      );
    }
    const [cmd, ...args] = setupCommand.split(/\s+/).filter(Boolean);
    if (!cmd) {
      return refuse(req, "no_setup_contract", setupCommand, `The declared setup contract "${setupCommand}" is empty.`);
    }

    // Compared BEFORE/AFTER rather than asserted absolutely clean: the review-loop
    // dirty-tree arm legitimately starts dirty, and what FG-621 AC 6 requires is
    // that preparation does not MOVE the tree — not that the tree was clean to
    // begin with. For an already-clean workspace (every publication candidate)
    // "unchanged" IS "still porcelain-clean".
    const before = porcelain(workspace);

    // Claim the workspace BEFORE the install so a failed or crashed setup leaves a
    // `preparing` record rather than an unexplained half-populated node_modules that
    // the next attempt would read as a foreign, already-provisioned tree.
    writeReadinessRecord({
      ...binding,
      state: "preparing",
      setupCommand,
      coveredCommandSet: req.coveredCommandSet,
      assertedAt: nowIso(),
    });

    const run = runSetup(cmd, args, {
      cwd: workspace,
      // The FG-555 contract (an explicit interpreter directory pinned at the front
      // of PATH, never whichever node an ambient login shell resolves) PLUS the
      // minimal-env / no-lifecycle-scripts contract — see setupEnv. Never
      // `...process.env`: this child's code comes from the tree under test.
      env: setupEnv(profile.path),
      timeoutMs: hostReadinessSetupTimeoutMs(),
    });
    if (!run.ok) {
      return refuse(
        req,
        run.timedOut ? "setup_timed_out" : "setup_failed",
        setupCommand,
        run.timedOut
          ? `The setup command exceeded the ${Math.round(hostReadinessSetupTimeoutMs() / 1000)}s setup ceiling.`
          : `The setup command exited ${run.status ?? "(signal)"} — no verification was run, so this is NOT a verdict on the code.`,
        { exitStatus: run.status, stderrTail: run.stderrTail },
      );
    }

    const after = porcelain(workspace);
    if (after !== before) {
      // Fail closed. The tree forge publishes must be byte-for-byte the tree that
      // passed the gate (FG-621 AC 6); a setup that moved it has broken that, and
      // the honest report is a refusal, not a verification run over a moved tree.
      return refuse(
        req, "workspace_dirtied_by_setup", setupCommand,
        `The setup command changed the workspace's git status. Preparation may never move the tree under test.`,
        { stderrTail: tailOf(after.split("\0").filter(Boolean).join("\n")) },
      );
    }

    writeReadinessRecord({
      ...binding,
      state: "ready",
      setupCommand,
      coveredCommandSet: req.coveredCommandSet,
      assertedAt: nowIso(),
    });
    return ready(req, { ...binding, requiredAbi, interpreter, setupCommand, coveredCommandSet: req.coveredCommandSet, reused: false });
  }, deps.lock);

  if (locked === "contended") {
    return refuse(
      req, "setup_contended", "(lock)",
      `Another host process holds this workspace's readiness lock and did not release it within the bounded wait. ` +
        `Forge will not run a second concurrent setup into the same tree.`,
    );
  }
  return locked;
}

/** The projection shared by both consumers' operator surfaces: which of the four
 *  readiness outcomes happened, and (for a refusal) why. */
export type ReadinessNote = { outcome: "prepared" | "reused" | "refused" | "not_required"; reason?: string };

export function readinessNote(outcome: HostReadinessOutcome): ReadinessNote {
  if (outcome.kind === "refused") return { outcome: "refused", reason: outcome.refusal.reason };
  if (outcome.kind === "not_required") return { outcome: "not_required" };
  return { outcome: outcome.evidence.reused ? "reused" : "prepared" };
}
