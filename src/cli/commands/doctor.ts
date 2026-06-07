// #229: `forge doctor` — read-only release-readiness diagnostics. Gathers the raw
// inputs (docker image inspect, an in-image CLI probe, model-policy load, per-
// profile auth probe, routing-policy validate) and hands them to the pure
// buildReleaseReport (src/v2/release-doctor.ts). NEVER runs an agent, never
// mutates the DB. The docker calls are harmless: one `image inspect` and one
// `run --rm --entrypoint sh -c 'command -v …'` — no mounts, no task, no agent.

import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { FORGE_HOME, ROUTING_POLICY_PATH } from "../../util/paths.js";
import { loadRuntime, loadModelPolicy, type LoadContext } from "../../v2/loader.js";
import { probeAuth } from "../../v2/provider-doctor.js";
import { detectAuthMode, type EffectiveAuth } from "../../v2/model-resolution.js";
import { validateRoutePolicyFile } from "./route.js";
import {
  buildReleaseReport,
  renderReleaseReport,
  type ReleaseInputs,
  type CliInputs,
  type AuthInputs,
  type ImageInputs,
} from "../../v2/release-doctor.js";

const DEFAULT_IMAGE = "agent-dev-worker:latest";
const MODEL_POLICY_PATH = join(FORGE_HOME, "model-policy.yml");

function forgeRepoDir(): string {
  return process.env.FORGE_REPO_DIR ? resolve(process.env.FORGE_REPO_DIR) : join(homedir(), "code", "forge");
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

  let dockerfileMtimeMs: number | undefined;
  try {
    const repoDir = repoDirOverride ?? forgeRepoDir();
    dockerfileMtimeMs = mtimeProbe
      ? mtimeProbe(repoDir)
      : statSync(join(repoDir, "docker", "agent-dev-worker.Dockerfile")).mtimeMs;
  } catch {
    dockerfileMtimeMs = undefined;
  }
  return { name, present, createdMs, dockerfileMtimeMs, ...(dockerError ? { dockerError } : {}) };
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
  if (!existsSync(ROUTING_POLICY_PATH)) return { present: false, ok: false, detail: "" };
  const v = validateRoutePolicyFile(ROUTING_POLICY_PATH);
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
  /** Override Dockerfile mtime lookup — lets tests verify the repo dir is forwarded correctly without needing a real Dockerfile. */
  dockerfileMtime?: (repoDir: string) => number | undefined;
};

export function gatherReleaseInputs(
  imageName = DEFAULT_IMAGE,
  ctx: LoadContext = {},
  probes: DoctorProbes = {},
): ReleaseInputs {
  const image = probes.inspectImage
    ? probes.inspectImage(imageName)
    : inspectImage(imageName, ctx.forgeRepoDir, probes.dockerfileMtime);
  return {
    image,
    clis: gatherClis(image, probes.probeClisInImage ?? probeClisInImage, ctx),
    policy: gatherPolicy(ctx),
    profileAuth: gatherProfileAuth(ctx),
    routing: gatherRouting(),
  };
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Read-only release-readiness check: agent image, in-image runtime CLIs, provider auth, model/routing policy")
    .option("--json", "emit JSON instead of a human summary")
    .action((opts: { json?: boolean }) => {
      const report = buildReleaseReport(gatherReleaseInputs(DEFAULT_IMAGE, { projectDir: process.cwd() }));
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderReleaseReport(report));
      }
      process.exitCode = report.ok ? 0 : 1;
    });
}
