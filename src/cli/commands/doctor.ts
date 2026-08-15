// #229: `forge doctor` — read-only release-readiness diagnostics. Gathers the raw
// inputs (docker image inspect, an in-image CLI probe, model-policy load, per-
// profile auth probe, routing-policy validate) and hands them to the pure
// buildReleaseReport (src/v2/release-doctor.ts). NEVER runs an agent, never
// mutates the DB. The docker calls are harmless: one `image inspect` and one
// `run --rm --entrypoint sh -c 'command -v …'` — no mounts, no task, no agent.

import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FORGE_HOME } from "../../util/paths.js";
import { identify, type PathIdentity } from "../../util/path-identity.js";
import { resolvePolicyPath } from "../../raci/project.js";
import { assetRoot, executionMode, type ExecutionMode } from "../../v2/asset-root.js";
import { loadRuntime, loadModelPolicy, type LoadContext } from "../../v2/loader.js";
import { probeAuth } from "../../v2/provider-doctor.js";
import { detectAuthMode, type EffectiveAuth } from "../../v2/model-resolution.js";
import { validateRoutePolicyFile } from "./route.js";
import {
  currentAdapterStamp,
  detectSeedDrift,
  renderSeedDrift,
  detectProtocolDrift,
  renderProtocolDrift,
  detectProjectAdapterDrift,
  renderProjectAdapterDrift,
  type SeedDriftReport,
  type ProtocolDriftReport,
  type ProjectAdapterReport,
} from "../../v2/seed-drift.js";
import { inspectSeedInstall, type SeedInstallState } from "../../v2/seed-generation.js";
import { classifyDocsSurfaces, type DocsSurfacesClassification } from "../../v2/contract.js";
import {
  buildReleaseReport,
  renderReleaseReport,
  type ReleaseInputs,
  type ReleaseReport,
  type CliInputs,
  type AuthInputs,
  type ImageInputs,
} from "../../v2/release-doctor.js";

const DEFAULT_IMAGE = "agent-dev-worker:latest";
const MODEL_POLICY_PATH = join(FORGE_HOME, "model-policy.yml");

// The image bakes in more than the Dockerfile: it COPYs forge-test.sh and
// agent-entrypoint.sh from the build context, so editing one leaves the built
// image stale while the Dockerfile's own mtime is unchanged. Compare the image
// against the newest of the Dockerfile AND every file it COPYs.
export function newestBuildInputMtime(repoDir: string): number | undefined {
  const dockerDir = join(repoDir, "docker");
  const dockerfile = join(dockerDir, "agent-dev-worker.Dockerfile");
  let newest: number | undefined;
  const consider = (path: string): void => {
    try {
      const ms = statSync(path).mtimeMs;
      if (newest === undefined || ms > newest) newest = ms;
    } catch {
      // a build input we can't stat (optional cert, glob source) can't prove staleness
    }
  };

  consider(dockerfile);
  let body: string;
  try {
    body = readFileSync(dockerfile, "utf8");
  } catch {
    return newest;
  }
  for (const line of body.split("\n")) {
    const m = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!m || /--from=/i.test(m[1]!)) continue;
    const args = m[1]!.trim().split(/\s+/).filter((a) => !a.startsWith("--"));
    for (const src of args.slice(0, -1)) consider(join(dockerDir, src));
  }
  return newest;
}

function inspectImage(name: string, repoDirOverride?: string, mtimeProbe?: (dir: string) => number | undefined): ImageInputs {
  let createdMs: number | undefined;
  let present = false;
  let dockerError: string | undefined;
  // Presence is probed with `docker image ls <name>`, NOT `docker image inspect
  // <name>`: on Docker Desktop's containerd image store, inspect-by-name is
  // unreliable (returns empty / "No such image" for an image that `docker images`
  // clearly lists), while `image ls` is consistent. ls exits 0 with empty output
  // for a genuine absence, and errors only when the daemon is unreachable. Retry
  // the daemon-error case (transient); empty output is a real absence.
  let imageId = "";
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = execFileSync("docker", ["image", "ls", name, "--format", "{{.ID}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      imageId = out.split("\n")[0]?.trim() ?? "";
      present = imageId.length > 0;
      lastErr = "";
      break;
    } catch (e) {
      const err = e as Error & { stderr?: Buffer | string };
      lastErr = `${typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? ""}\n${err.message ?? ""}`;
      // retry transient daemon errors
    }
  }
  // ls errored across retries → docker unreachable → skip (not a false rebuild).
  if (!present && lastErr) {
    dockerError = (lastErr.split("\n").find((l) => l.trim().length > 0) ?? "docker unavailable").trim();
  }
  // Created date (best-effort) by ID — inspect-by-ID is reliable even when
  // inspect-by-name is not. A failure here just drops the staleness comparison.
  if (present && imageId) {
    try {
      const created = execFileSync("docker", ["image", "inspect", imageId, "--format", "{{.Created}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const ms = Date.parse(created);
      if (!Number.isNaN(ms)) createdMs = ms;
    } catch {
      createdMs = undefined;
    }
  }

  // FG-577: the staleness PROBE is a read, so it judges the running image against
  // the EXECUTING release's bundled docker/ (a REQUIRED asset dir). The rebuild
  // ACTION is dev-advancement and refuses in release mode (upgrade.ts). Whether
  // the mtime is MEANINGFUL is the pure layer's call (release-doctor.ts): a
  // release's inputs are cpSync-stamped, so it ignores them.
  const repoDir = repoDirOverride ?? assetRoot();
  const buildInputMtimeMs = mtimeProbe ? mtimeProbe(repoDir) : newestBuildInputMtime(repoDir);
  return { name, present, createdMs, buildInputMtimeMs, ...(dockerError ? { dockerError } : {}) };
}

// command -> runtime names that need it. Collects from workspace seeds
// (~/.forge/runtimes/), project-local overrides (<projectDir>/.forge/runtimes/),
// and runtimes explicitly named via profile.runtime in the active model-policy.
function expectedClis(ctx: LoadContext = {}): Map<string, string[]> {
  const byCommand = new Map<string, string[]>();
  const names = new Set<string>();

  try {
    for (const f of readdirSync(join(FORGE_HOME, "runtimes")).filter((f) => f.endsWith(".yml"))) {
      names.add(f.replace(/\.yml$/, ""));
    }
  } catch { /* no workspace runtimes dir */ }

  if (ctx.projectDir) {
    try {
      for (const f of readdirSync(join(ctx.projectDir, ".forge", "runtimes")).filter((f) => f.endsWith(".yml"))) {
        names.add(f.replace(/\.yml$/, ""));
      }
    } catch { /* no project runtimes dir */ }

    // Model-policy profiles may name a runtime explicitly (profile.runtime).
    // That name drives dispatch regardless of whether a .yml file appears in
    // either runtimes dir scan above, so include it to avoid a silent gap.
    try {
      const policy = loadModelPolicy(ctx);
      if (policy) {
        for (const profile of Object.values(policy.model_profiles)) {
          if (profile.runtime) names.add(profile.runtime);
        }
      }
    } catch { /* invalid policy is reported by the policy check; skip here */ }
  }

  for (const name of names) {
    try {
      const rt = loadRuntime(name, ctx);
      const cmd = rt.invocation.command;
      const list = byCommand.get(cmd) ?? [];
      list.push(name);
      byCommand.set(cmd, list);
    } catch {
      // a malformed or missing runtime shouldn't crash the doctor
    }
  }
  return byCommand;
}

// Probe whether each command exists on PATH inside the image. Returns present:
// null for every command when the image is absent or docker can't run (so the
// pure report renders "skip", not a false fail).
function probeClisInImage(image: string, commands: string[], imagePresent: boolean): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  if (!imagePresent || commands.length === 0) {
    for (const c of commands) out[c] = null;
    return out;
  }
  try {
    const script = commands.map((c) => `if command -v ${c} >/dev/null 2>&1; then echo "OK ${c}"; fi`).join("; ");
    const res = execFileSync("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const c of commands) out[c] = res.includes(`OK ${c}`);
  } catch {
    for (const c of commands) out[c] = null;
  }
  return out;
}

type CliProbe = (image: string, commands: string[], imagePresent: boolean) => Record<string, boolean | null>;

function gatherClis(image: ImageInputs, probe: CliProbe = probeClisInImage, ctx: LoadContext = {}): CliInputs[] {
  const byCommand = expectedClis(ctx);
  const commands = [...byCommand.keys()];
  const present = probe(image.name, commands, image.present);
  return commands.map((command) => ({
    command,
    present: present[command] ?? null,
    neededBy: byCommand.get(command) ?? [],
  }));
}

export function gatherProfileAuth(ctx: LoadContext = {}): AuthInputs[] {
  let policy;
  try {
    policy = loadModelPolicy(ctx);
  } catch {
    return []; // invalid policy is reported by the policy check; skip auth probing
  }
  if (!policy) return [];
  // Default-reachable profiles run without an explicit --profile: the default,
  // any activity default, and any agent override. A missing cred on one of these
  // blocks; an opt-in-only profile (defined but only selectable via --profile)
  // only warns.
  const reachable = new Set<string>([
    policy.defaults.profile,
    ...Object.values(policy.defaults.activity ?? {}),
    ...Object.values(policy.overrides?.agents ?? {}),
  ]);
  const rows: AuthInputs[] = [];
  for (const [name, profile] of Object.entries(policy.model_profiles)) {
    const auth: EffectiveAuth = profile.auth === "auto" ? detectAuthMode() : profile.auth;
    const probe = probeAuth(profile.provider, auth);
    rows.push({ profile: name, provider: profile.provider, auth, status: probe.status, detail: probe.detail, reachable: reachable.has(name) });
  }
  return rows;
}

export function gatherPolicy(ctx: LoadContext = {}): ReleaseInputs["policy"] {
  const projectPath = ctx.projectDir ? join(ctx.projectDir, ".forge", "model-policy.yml") : undefined;
  const present = (projectPath !== undefined && existsSync(projectPath)) || existsSync(MODEL_POLICY_PATH);
  if (!present) return { present: false, valid: false };
  try {
    loadModelPolicy(ctx);
    return { present: true, valid: true };
  } catch (e) {
    return { present: true, valid: false, error: (e as Error).message };
  }
}

function gatherRouting(): ReleaseInputs["routing"] {
  // FG-583: read the routing policy from the anchored seed generation (the same
  // anchor that yields workflows/runtimes), falling back to the flat file only when
  // no generation is selected. resolvePolicyPath() with no projectDir resolves the
  // HOST policy, which is the generation's compiled routing-policy.yml when one is
  // published.
  const resolved = resolvePolicyPath();
  // FG-583 (finding 2): a torn/tampered generation policy (bytes ≠ its own manifest,
  // or an unmanifested extra file) is Zod-valid but must NOT read as "present and
  // validates" — name the incomplete/tampered state so doctor surfaces it, mirroring
  // the loader's workflow/runtime closed-set refusal.
  if (resolved.incompletePolicy) {
    return { present: true, ok: false, detail: `incomplete/tampered seed generation policy: ${resolved.incompletePolicy}` };
  }
  if (!resolved.exists) return { present: false, ok: false, detail: "" };
  const v = validateRoutePolicyFile(resolved.path);
  return {
    present: true,
    ok: v.ok,
    detail: v.ok ? `present and validates (${v.mode})` : `${v.findings.length} finding(s): ${v.findings.map((f) => f.code).join(", ")}`,
  };
}

// Docker-probing seams are injectable so the CLI/upgrade wiring is testable
// without docker (the policy/auth/routing reads are file/env-based and run real).
export type DoctorProbes = {
  inspectImage?: (name: string) => ImageInputs;
  probeClisInImage?: CliProbe;
  /** Override the build-input mtime lookup — lets tests verify the repo dir is forwarded correctly without needing a real build context. */
  buildInputMtime?: (repoDir: string) => number | undefined;
};

export function gatherReleaseInputs(
  imageName = DEFAULT_IMAGE,
  ctx: LoadContext = {},
  probes: DoctorProbes = {},
  mode: ExecutionMode = executionMode(),
): ReleaseInputs {
  const image = probes.inspectImage
    ? probes.inspectImage(imageName)
    : inspectImage(imageName, ctx.forgeRepoDir, probes.buildInputMtime);
  return {
    image,
    clis: gatherClis(image, probes.probeClisInImage ?? probeClisInImage, ctx),
    policy: gatherPolicy(ctx),
    profileAuth: gatherProfileAuth(ctx),
    routing: gatherRouting(),
    mode,
  };
}

/** Everything `forge doctor` gathered, before it is rendered. Split out so the
 *  human section, the --json payload and the exit code are three pure functions of
 *  ONE value — a doctor whose JSON and prose could report different things is a
 *  doctor a script and an operator can disagree about. */
export type DoctorFindings = {
  report: ReleaseReport;
  seedDrift: SeedDriftReport;
  protocolDrift: ProtocolDriftReport;
  seedInstall: SeedInstallState;
  /** FG-253: the orientation/handoff adapters in the project doctor was invoked in. */
  projectAdapters: ProjectAdapterReport;
  /** FG-546: the four-way state of this project's .forge/docs-surfaces.yml, as
   *  the ONE shared classifier (src/v2/contract.ts) adjudicated it — the same
   *  verdict init/upgrade key their write side-effect off. A reported diagnostic:
   *  read/dispatch is fail-soft (warn + fall back to OPERATOR_SURFACES), so this
   *  never moves the exit code, but doctor names invalid/legacy config and its
   *  repair action so an operator can see and fix it. */
  docsSurfaces: DocsSurfacesClassification;
  /** FG-693: WHICH TREE doctor read, as the one contract (util/path-identity.ts)
   *  proved it — not as the ambient spelling doctor happened to be handed.
   *
   *  This is the field a caller compares. `forge doctor` takes its project from
   *  process.cwd(), and cwd is one of several spellings of a checkout on any host with
   *  a symlinked parent anywhere in the chain; a reader comparing the raw spelling
   *  against the checkout it asked about calls one tree two trees. That is the exact
   *  shape FG-253 hit — a doctor assertion comparing two spellings of ONE fixture as
   *  different — and the reason the coverage it added had to canonicalize by hand at
   *  the call site. Doctor resolves ONCE, here, and every consumer below shares that
   *  answer rather than resolving again and possibly differently. */
  project: PathIdentity;
};

export function gatherDoctorFindings(projectDir: string = process.cwd(), imageName = DEFAULT_IMAGE): DoctorFindings {
  const project = identify(projectDir);
  return {
    project,
    report: buildReleaseReport(gatherReleaseInputs(imageName, { projectDir })),
    seedDrift: detectSeedDrift(), // FG-335: installed ~/.forge seeds vs running code
    // FG-654: the Forge-owned protocol, read out of the published seed generation.
    // Separate from `seedDrift` on purpose — the operator's own agent prose stays a warn
    // while an unresolvable protocol is a readiness fail, because dispatch refuses on it.
    protocolDrift: detectProtocolDrift(),
    // FG-583: dispatch reads ONLY a published seed generation — there is no flat
    // dispatch fallback. So ONLY `healthy` (a complete generation is published) is
    // ready. `incomplete` (torn/mid-publish) AND `no-generation` (nothing published
    // — a fresh/pre-migration host) are both NAMED not-ready readiness findings with
    // the `forge upgrade` remedy: on either, dispatch refuses at the loader.
    seedInstall: inspectSeedInstall(),
    // FG-253: doctor already runs with projectDir: cwd(), so this is honestly ONE
    // project's adapters — the rendered section says so rather than reading as a
    // host-wide inventory.
    // FG-693: the identity resolved above is HANDED IN, so doctor's findings and the
    // adapter report cannot disagree about which tree was read.
    projectAdapters: detectProjectAdapterDrift(projectDir, currentAdapterStamp(), project),
    // FG-546: one classifier owns the four-way docs-surfaces decision; doctor
    // consumes the verdict rather than re-deriving it, so it can never disagree
    // with the write side (init/upgrade) about whether a file is the migratable
    // legacy template, a customized file, valid, or missing.
    docsSurfaces: classifyDocsSurfaces(projectDir),
  };
}

export function doctorJson(f: DoctorFindings): unknown {
  return {
    ...f.report,
    seedDrift: f.seedDrift,
    protocolDrift: f.protocolDrift,
    seedInstall: f.seedInstall,
    projectAdapters: f.projectAdapters,
    // FG-546: the docs-surfaces verdict a script can branch on — same value the
    // human section renders, so the two renderings can never disagree.
    docsSurfaces: f.docsSurfaces,
    // FG-693: the proven identity of the tree doctor read, for a script that must
    // decide whether two doctor runs describe the same checkout. The as-written
    // spelling stays on projectAdapters.projectDir for display.
    project: f.project,
  };
}

/** FG-546: render the docs-surfaces verdict as a distinct, human-readable line
 *  per state. Valid/missing report cleanly (no scary framing); the two broken
 *  states each name the file, the problem, and the repair action — legacy is
 *  operator-safe to auto-repair (`forge upgrade`), customized-invalid is NOT
 *  (forge never clobbers operator-authored config, so the operator fixes it). */
export function renderDocsSurfaces(c: DocsSurfacesClassification): string {
  switch (c.verdict) {
    case "valid-project":
      return `Docs-surfaces config: OK — valid project config (${c.path}).`;
    case "missing":
      return `Docs-surfaces config: default — no project config; forge's built-in operator surfaces are in effect (write ${c.path} to override).`;
    case "known-legacy-generated":
      return (
        `Docs-surfaces config: LEGACY (repairable) — ${c.path} matches forge's old generated template, which the runtime rejects.\n` +
        `  This is a forge-generated file (safe to regenerate).\n` +
        `  Fix: forge upgrade (migrates it in place to the corrected docs-surfaces.yml).`
      );
    case "customized-invalid":
      return (
        `Docs-surfaces config: INVALID — ${c.path} is not valid and is NOT forge's generated template, so forge will not overwrite it.\n` +
        `  Validation error: ${c.detail ?? "does not conform to { surfaces: [<path-prefix>, ...] }"}\n` +
        `  Fix: edit ${c.path} to \`{ surfaces: [<path-prefix>, ...] }\`, or delete it to restore forge's built-in defaults.`
      );
  }
}

export function renderDoctor(f: DoctorFindings): string {
  const out: string[] = [renderReleaseReport(f.report)];
  const push = (section: string): void => {
    if (section) out.push(`\n${section}`);
  };
  push(renderSeedDrift(f.seedDrift));
  push(renderProtocolDrift(f.protocolDrift));
  push(renderProjectAdapterDrift(f.projectAdapters));
  push(renderDocsSurfaces(f.docsSurfaces));
  if (f.seedInstall.kind === "incomplete") {
    out.push(
      `\nSeed install: INCOMPLETE (repairable) — ${f.seedInstall.reason}\n` +
        `  A partial host-seed install can expose a mixed/torn workflow set — dispatch refuses.\n` +
        `  Fix: forge upgrade (republishes a complete atomic seed generation).`,
    );
  } else if (f.seedInstall.kind === "no-generation") {
    out.push(
      `\nSeed install: NOT INSTALLED — no complete seed generation is published for this $FORGE_HOME.\n` +
        `  Dispatch refuses until a generation is published; the flat pre-migration layout is never dispatched.\n` +
        `  Fix: forge upgrade (publishes a complete atomic seed generation).`,
    );
  }
  return out.join("\n");
}

/** FG-654: protocolDrift.ok joins the readiness conjunction. A covered role whose
 *  protocol does not resolve is a host that cannot review, so it goes red here even
 *  though the operator's own agent prose stays a warn via seedDrift.ok.
 *  FG-253: projectAdapters.ok is keyed on COUPLING like every other member — adapters
 *  are prose, so adapter drift alone never moves the exit code. It is in the
 *  conjunction structurally rather than omitted, so the day an adapter becomes
 *  executable the readiness follows without anyone remembering to add it. */
export function doctorReady(f: DoctorFindings): boolean {
  return (
    f.report.ok && f.seedDrift.ok && f.protocolDrift.ok && f.projectAdapters.ok && f.seedInstall.kind === "healthy"
  );
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Read-only release-readiness check: agent image, in-image runtime CLIs, provider auth, model/routing policy")
    .option("--json", "emit JSON instead of a human summary")
    .action((opts: { json?: boolean }) => {
      const findings = gatherDoctorFindings(process.cwd());
      console.log(opts.json ? JSON.stringify(doctorJson(findings), null, 2) : renderDoctor(findings));
      process.exitCode = doctorReady(findings) ? 0 : 1;
    });
}
