// forge v2 — runtime YAML → docker args translator.
//
// Replaces src/spine/spawn.ts's hardcoded buildDockerArgs with one that reads
// the runtime YAML and substitutes template variables. Same docker invocation
// shape today's spine produces, just declared in YAML instead of code.
//
// Auth modes:
//   - env-snapshot (default for bedrock): host calls `aws configure
//     export-credentials` and injects STS env vars. Implemented in
//     src/util/creds.ts:exportAwsCreds (#121). Reuse it here.
//   - mount: bind-mount ~/.aws into the container. Legacy path; opt-in.
//   - apikey: pass ANTHROPIC_API_KEY env.
//   - oauth-volume: bind-mount the named oauth volume at /home/agent.
//
// The runtime YAML declares which mode applies. The runner picks the right
// substitution context per-step (TASK_ID, MODEL, etc.) and this function
// produces the full `docker run ... claude ...` argv.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Runtime } from "./schema.js";
import { resolveRuntimeMetadata } from "./schema.js";
import {
  exportAwsCreds,
  oauthVolumeName,
  awsConfigDir,
  resolveAwsProfile,
  codexAuthFile,
  piAuthFile,
  apiKeyEnvForProvider,
  knownApiKeyProviders,
} from "../util/creds.js";
import { substitute, substituteOptional, expandTilde, type SubstContext } from "./resolve.js";
import { planDependencyVolumes, provisionerContainerName, type DependencyVolumePlan } from "./dependency-provisioning.js";

export type SpawnContext = SubstContext & {
  TASK_ID: string;
  TASK_DIR: string;
  PROJECT_DIR: string;
  PROJECT_MODE: "rw" | "ro";
  MODEL: string;
  // #265: the resolved UPSTREAM model vendor (e.g. groq, anthropic, ollama) a
  // multi-provider runtime fronts. Substituted into pi's `--provider` arg. Empty
  // in legacy mode (no policy) → the pi YAML's `${UPSTREAM_PROVIDER:-anthropic}`
  // fallback preserves the anthropic-bound Crawl behavior.
  UPSTREAM_PROVIDER?: string;
  SYSTEM_PROMPT: string;
  // Rendered task-package markdown; piped to the container as stdin per the
  // runtime YAML's `invocation.stdin` field. Mirrors v1 spine's behavior.
  TASK_PACKAGE_MARKDOWN: string;
  // DESIGN_DIR is optional — empty string when --design-dir wasn't passed.
  DESIGN_DIR?: string;
  // Host path to a captured auth-profile storageState file (#176). When set,
  // the file is mounted read-only and BROWSER_TOOLS_STORAGE_STATE points the in-container
  // browser-tools injector at it so the agent operates authenticated without
  // ever seeing the credential. Undefined = no auth profile for this task.
  AUTH_STATE_HOST_PATH?: string;
  // FG-376 FIX1: true only when this dispatch's PROJECT_DIR is a task-scoped
  // git worktree (runNext.ts sets this when a worktree was created for this
  // task). Gates the named lockfile-keyed dependency-volume path so a normal
  // (non-worktree) rw dispatch — which shares the live host project directory
  // across concurrent tasks — keeps its pre-FG-376 legacy single anonymous
  // shadow-volume behavior byte-for-byte. invoke.ts never creates worktrees
  // and never sets this, so `forge invoke` is unaffected.
  // String "1" (not boolean) — SpawnContext extends SubstContext, whose index
  // signature is Record<string, string | undefined>.
  IS_WORKTREE_DISPATCH?: string;
  // FG-376: set by the caller once it has confirmed (host-side, via
  // dependency-provisioning.ts:isDependencyCacheReady / provisionDependencyCache)
  // that this lockfile-hash cache key is populated — "1" mounts the SAME
  // lockfile-keyed volume(s) READ-ONLY for both a worktree-rw primary and a
  // ro reviewer/red dispatch. Installing is exclusively the short-lived
  // provisioner container's job (see buildProvisionerDockerArgs below) — an
  // agent/reviewer container built by buildDockerArgs NEVER installs and
  // NEVER mounts these volumes read-write, regardless of PROJECT_MODE.
  DEPENDENCY_CACHE_MOUNT_RO?: string;
};

// Fixed in-container path for the mounted auth-profile state. A top-level path
// (not under /home/agent) avoids nesting under the oauth-volume mount.
const AUTH_STATE_CONTAINER_PATH = "/forge-auth/state.json";

// Fixed in-container path for the RO-mounted Codex credential (AWN-7 Walk). The
// entrypoint detects this file and copies it into a writable CODEX_HOME. A
// top-level path (not under /home/agent) keeps it off the oauth-volume mount.
const CODEX_AUTH_CONTAINER_PATH = "/forge-codex-auth/auth.json";
const PI_AUTH_CONTAINER_PATH = "/forge-pi-auth/auth.json";

export type BuildArgsResult = {
  args: string[];
  // stdin payload, if the runtime YAML declared one. Caller pipes it.
  stdin: string | undefined;
  // FG-536: index of the image in `args`. The detached executor
  // (docker-exec.ts) interposes its entry script immediately after the image
  // without re-deriving docker's [OPTIONS] IMAGE [COMMAND] boundary from flag
  // knowledge it doesn't have.
  imageIndex: number;
};

// FG-497: Linux caps a single argv/env string at MAX_ARG_STRLEN (131072 bytes,
// include/uapi/linux/binfmts.h). A composed prompt or env value that breaches
// this makes the container's exec() die with E2BIG before the agent starts —
// no result.json, no stdout, just a bare exit. Guard well under the real limit
// so an oversized embed fails loud on the host with a diagnostic instead of
// surfacing as an unexplained container crash.
const MAX_SINGLE_ARG_BYTES = 120_000;

function assertWithinArgLimit(label: string, value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_SINGLE_ARG_BYTES) {
    throw new Error(
      `FG-497: ${label} is ${bytes} bytes, exceeding MAX_SINGLE_ARG_BYTES (${MAX_SINGLE_ARG_BYTES}) — ` +
        `a single argv/env string this large risks E2BIG at container exec (Linux MAX_ARG_STRLEN is 131072 bytes). ` +
        `Move this content onto stdin instead of argv/env.`,
    );
  }
}

// FG-559: the sentinel the container entrypoint exits with when git does not
// resolve inside the project mount (docker/agent-entrypoint.sh — the two MUST
// match). Peer of DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE (123); the runner
// classifies both as verification_environment_unavailable rather than letting
// them fall into the generic container_crash branch. Not 124 — that is
// timeout(1)'s conventional code and would be ambiguous in a wrapped exec.
export const GIT_UNAVAILABLE_EXIT_CODE = 122;

// The absolute path a `.git` POINTER FILE names, or undefined when `.git` is a
// real directory / absent. What the pointer names is NOT trusted — see
// resolveVerifiedCommonGitDir.
function readGitdirPointer(projectDir: string): string | undefined {
  const dotGit = join(projectDir, ".git");
  const st = statSync(dotGit, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return undefined;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  if (!m) return undefined;
  return resolve(projectDir, m[1]!.trim());
}

function isUnder(child: string, ancestor: string): boolean {
  return child.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

/** FG-559: host absolute paths that must be bind-mounted AT THEIR OWN PATH for
 *  a linked worktree's git to resolve inside the container; [] for a plain
 *  clone or a non-git dir.
 *
 *  A linked worktree's `.git` is a FILE holding `gitdir: <absolute path>` into
 *  the PARENT repo's `.git`, which forge does not otherwise mount — so every
 *  git command in the container fails and the agent silently works from the
 *  file tree. Resolution is TWO hops and both must land on mounted storage: the
 *  absolute hop into the worktree admin dir, then the RELATIVE `commondir` hop
 *  (`../..`) into the common `.git`. Mounting the admin dir alone is verified
 *  insufficient — hence resolving commondir here rather than assuming.
 *
 *  Mounting at the host path is what makes this work with ZERO env vars:
 *  GIT_DIR/GIT_WORK_TREE are global to the container process tree and make
 *  unrelated repos report the worktree's status (a silent wrong answer, which
 *  is worse than the loud failure they'd replace). */
export function planWorktreeGitMounts(projectDir: string): string[] {
  const gitdir = readGitdirPointer(projectDir);
  if (!gitdir) return [];
  // The admin dir lives INSIDE the common .git, so the single common-dir mount
  // covers both hops.
  return [resolveVerifiedCommonGitDir(projectDir, gitdir)];
}

/** FG-559: the `gitdir:` line lives in the PROJECT TREE, which a project — or a
 *  prior writable agent — can rewrite to name any host path. Bind-mounting
 *  whatever it says would hand every later container arbitrary host data at its
 *  own path, so accept only the shape `git worktree add` writes and refuse
 *  everything else: an admin dir `<common>/worktrees/<name>` carrying git's own
 *  `commondir` + `gitdir` files, whose `commondir` resolves back to that same
 *  grandparent, and whose common dir is really a git dir. Returns the common
 *  dir — the one path that must be mounted. */
function resolveVerifiedCommonGitDir(projectDir: string, adminDir: string): string {
  const commonDir = dirname(dirname(adminDir));
  const refuse = (why: string): never => {
    throw new Error(
      `FG-559: ${projectDir}/.git is a gitdir: pointer to ${adminDir}, which ${why}. Only a linked ` +
        `worktree's admin dir (<repo>/.git/worktrees/<name>) is bind-mounted into agent containers; ` +
        `refusing to mount an unverified host path.`
    );
  };
  if (!statSync(adminDir, { throwIfNoEntry: false })?.isDirectory()) refuse("is not a directory");
  if (basename(dirname(adminDir)) !== "worktrees") refuse("does not sit under a worktrees/ parent");
  if (!existsSync(join(adminDir, "gitdir"))) refuse("has no gitdir back-pointer file");
  const commondirFile = join(adminDir, "commondir");
  if (!existsSync(commondirFile)) refuse("has no commondir file");
  if (resolve(adminDir, readFileSync(commondirFile, "utf8").trim()) !== commonDir) {
    refuse(`has a commondir that does not resolve to its own parent repo (${commonDir})`);
  }
  for (const marker of ["HEAD", "objects", "refs"]) {
    if (!existsSync(join(commonDir, marker))) refuse(`resolves to ${commonDir}, which has no ${marker}`);
  }
  return commonDir;
}

/** FG-559 piece A — the mount-plan assertion. The host CANNOT detect this by
 *  resolving the path: host-side the `gitdir:` target resolves perfectly, which
 *  is exactly why the defect stayed silent. The question is about the argv being
 *  built — "`PROJECT_DIR/.git` points OUTSIDE `PROJECT_DIR`; is that path in the
 *  mount list I am about to hand docker?"
 *
 *  Refuses rather than warns, and unconditionally: the predicate has no
 *  false-positive class. A non-git project has no `.git`; a plain clone has a
 *  `.git` directory; a correctly-mounted worktree passes. It can only fire on
 *  the exact broken state. */
export function assertWorktreeGitMountPlanned(projectDir: string, args: string[]): void {
  const required = planWorktreeGitMounts(projectDir);
  const missing = required.filter((p) => !isIdentityMountPlanned(p, args));
  if (missing.length === 0) return;
  throw new Error(
    `FG-559: ${projectDir}/.git is a gitdir: pointer into ${missing.join(", ")}, which the docker ` +
      `mount plan does not bind at its own host path. Every git command inside the container would ` +
      `fail with "fatal: not a git repository" and the agent would work history-blind. Refusing to dispatch.`,
  );
}

// True when argv already binds `hostPath` (or an ancestor of it) to the SAME
// path inside the container. Identity is the point: the `gitdir:` line is an
// absolute HOST path, so only a host-path-preserving bind makes it resolve.
function isIdentityMountPlanned(hostPath: string, args: string[]): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-v") continue;
    const [host, container] = args[i + 1]!.split(":");
    if (!host || host !== container) continue;
    if (hostPath === host || isUnder(hostPath, host)) return true;
  }
  return false;
}

export function buildDockerArgs(runtime: Runtime, ctx: SpawnContext): BuildArgsResult {
  // FG-492: deliberately NO --rm for a task/reviewer agent container. Capturing
  // causal evidence (docker inspect: exit code, signal, OOMKilled, State.Error)
  // requires the container still exist after its process exits — --rm races
  // the daemon's own removal against docker-exec.ts's capture-at-close read.
  // docker-exec.ts (the shared executor) now owns the reap/retain decision
  // instead: it removes a clean exit immediately and retains a failed one
  // (FORGE_CONTAINER_RETENTION=off disables retention entirely). The
  // short-lived dependency provisioner below (buildProvisionerDockerArgs) is
  // NOT in scope for this — it's a different, always-short-lived container and
  // keeps its own --rm.
  const args: string[] = ["run", "-i"];

  // --name
  args.push("--name", substitute(runtime.container.name, ctx));

  // Auth → env / mounts. FORGE_AUTH_MODE=mount override sidesteps env-snapshot
  // when the user wants the legacy behavior.
  const effectiveAuth =
    process.env.FORGE_AUTH_MODE === "mount" && runtime.auth.mode === "env-snapshot"
      ? "mount"
      : runtime.auth.mode;

  switch (effectiveAuth) {
    case "env-snapshot": {
      // STS env vars from host.
      const creds = exportAwsCreds(resolveAwsProfile());
      args.push("-e", `AWS_ACCESS_KEY_ID=${creds.AWS_ACCESS_KEY_ID}`);
      args.push("-e", `AWS_SECRET_ACCESS_KEY=${creds.AWS_SECRET_ACCESS_KEY}`);
      args.push("-e", `AWS_SESSION_TOKEN=${creds.AWS_SESSION_TOKEN}`);
      break;
    }
    case "mount": {
      args.push("-e", `AWS_PROFILE=${resolveAwsProfile()}`);
      args.push("-v", `${awsConfigDir()}:/home/agent/.aws:ro`);
      break;
    }
    case "apikey": {
      // #303: inject the RESOLVED upstream provider's API key, not always
      // ANTHROPIC_API_KEY. Empty UPSTREAM_PROVIDER (legacy / no-policy invoke)
      // → anthropic, so existing pi-apikey and claude-apikey behavior is
      // unchanged. The env-var map is shared with provider-doctor so a key the
      // doctor reports available is the same one injected here.
      const provider = ctx.UPSTREAM_PROVIDER || "anthropic";
      const envVar = apiKeyEnvForProvider(provider);
      if (!envVar) {
        throw new Error(
          `auth.mode=apikey: no API-key binding for upstream provider '${provider}' ` +
            `(known: ${knownApiKeyProviders().join(", ")})`,
        );
      }
      const key = process.env[envVar];
      if (!key) throw new Error(`auth.mode=apikey but ${envVar} env is unset (upstream provider '${provider}')`);
      args.push("-e", `${envVar}=${key}`);
      break;
    }
    case "oauth-volume": {
      args.push("-v", `${oauthVolumeName()}:/home/agent`);
      break;
    }
    case "codex-auth": {
      // AWN-7 Walk: RO-mount ONLY the Codex subscription credential file (never
      // the whole ~/.codex dir). Fail loud if it's absent — bind-mounting a
      // missing source would make docker create a phantom dir at the host path.
      // The entrypoint copies it into a writable CODEX_HOME for token refresh.
      const authFile = codexAuthFile();
      if (!existsSync(authFile)) {
        throw new Error(
          `auth.mode=codex-auth but ${authFile} is missing — run \`codex login\` on the host`,
        );
      }
      args.push("-v", `${authFile}:${CODEX_AUTH_CONTAINER_PATH}:ro`);
      break;
    }
    case "pi-auth": {
      // #266: RO-mount ONLY pi's OAuth credential (forge-managed, minted by
      // `forge pi login`). Fail loud if absent — a missing bind source would make
      // docker create a phantom dir. The entrypoint copies it into a writable
      // PI_CODING_AGENT_DIR so in-container token refresh works.
      const authFile = piAuthFile();
      if (!existsSync(authFile)) {
        throw new Error(
          `auth.mode=pi-auth but ${authFile} is missing — run \`forge pi login\` once to authenticate pi (OAuth).`,
        );
      }
      args.push("-v", `${authFile}:${PI_AUTH_CONTAINER_PATH}:ro`);
      break;
    }
  }

  // Static env from runtime.env, with substitution.
  for (const [k, v] of Object.entries(runtime.env)) {
    args.push("-e", `${k}=${substitute(v, ctx)}`);
  }

  // Mounts.
  let browserToolsHostPath: string | undefined;
  // Container path the project bind mount lands at (e.g. /project). Captured so
  // we can set it as the working directory below — the image's WORKDIR is the
  // ephemeral /workspace, so without an explicit -w any cwd-relative write
  // (scaffolders: `pnpm create`, `npm init`, generated node_modules/dist) lands
  // in a non-persisted path and is silently discarded on container removal.
  // Identified by the mount whose host template is the project dir.
  let projectContainerPath: string | undefined;
  let projectMode: string | undefined;
  for (const mount of runtime.mounts) {
    if (mount.host === "${PROJECT_DIR}") projectContainerPath = mount.container;
    const hostResolved = mount.optional
      ? substituteOptional(mount.host, ctx)
      : substitute(mount.host, ctx);

    // A skipped optional *skill* mount (e.g. browser-tools) silently strips a
    // capability the agent seeds assume — visual verification above all — which
    // surfaces downstream as a confusing "no browser" report. Warn so it's
    // diagnosable rather than invisible.
    const warnIfSkill = (reason: string): void => {
      if (!mount.container.includes("/.claude/skills/")) return;
      const skill = mount.container.split("/").pop() ?? "skill";
      const extra = skill === "browser-tools" ? " — no browser-tools means no visual UI verification" : "";
      console.error(
        `forge: WARNING — skill mount '${skill}' skipped (${reason})${extra}. ` +
          `Set FORGE_BROWSER_TOOLS_DIR or create the host path so agents can verify.`,
      );
    };

    if (hostResolved === undefined) {
      warnIfSkill(`host '${mount.host}' unresolved`);
      continue; // optional + unresolved
    }
    const hostPath = expandTilde(hostResolved);

    if (mount.optional && !existsSync(hostPath)) {
      warnIfSkill(`host '${hostPath}' not found`);
      continue;
    }

    const mode = substitute(mount.mode, ctx);
    if (mount.host === "${PROJECT_DIR}") projectMode = mode;
    args.push("-v", `${hostPath}:${mount.container}:${mode}`);
    if (mount.container.includes("/skills/browser-tools")) browserToolsHostPath = hostPath;
  }

  // #176 auth profile: mount the captured session read-only and point the
  // browser-tools injector at it via BROWSER_TOOLS_STORAGE_STATE (a generic
  // browser-tools env var, not forge-branded — #182). The token never enters
  // argv / prompts / logs — only this single read-only file, never the project
  // mount. The injector lives in the browser-tools skill, so a skipped skill
  // mount would silently no-op auth; fail fast instead.
  if (ctx.AUTH_STATE_HOST_PATH) {
    if (!browserToolsHostPath) {
      throw new Error(
        "--auth-profile needs the browser-tools skill (it carries the auth injector), " +
          "but that mount was skipped. Set FORGE_BROWSER_TOOLS_DIR or create the host path.",
      );
    }
    // #181 pin: the mount existing isn't enough — an old/upstream browser-tools
    // checkout has no injector, so auth would silently no-op. Require the
    // injector file. Pinned dependency: pi-skills fork branch
    // feat/preload-storage-state (github.com/stevebargelt/pi-skills, >= cac695b).
    if (!existsSync(join(browserToolsHostPath, "auth-inject.js"))) {
      throw new Error(
        `--auth-profile requires the browser-tools auth injector, but ${browserToolsHostPath}/auth-inject.js ` +
          "is missing. Point FORGE_BROWSER_TOOLS_DIR at a pi-skills checkout on the " +
          "feat/preload-storage-state branch (github.com/stevebargelt/pi-skills, >= cac695b).",
      );
    }
    args.push("-v", `${ctx.AUTH_STATE_HOST_PATH}:${AUTH_STATE_CONTAINER_PATH}:ro`);
    args.push("-e", `BROWSER_TOOLS_STORAGE_STATE=${AUTH_STATE_CONTAINER_PATH}`);
  }

  // #245/FG-376: shadow the project's node_modules with container-local named
  // volumes on macOS rw mounts (supersedes FORGE-DEC-011). Docker Desktop's
  // grpcfuse stamps a `com.docker.grpcfuse.ownership` xattr on native binaries
  // the container writes (e.g. better-sqlite3.node); CyberArk-class EDR then
  // silently SIGKILLs the HOST node processes that load them. The volumes keep
  // every node_modules write inside the container (never written back through
  // grpcfuse) AND hide the host's wrong-platform (macOS-arm64) modules so the
  // agent gets correct linux ones instead of hand-patching. Scoped to:
  //   - darwin only: Linux hosts have no grpcfuse and matching-arch modules.
  //   - escape hatch FORGE_NO_NM_SHADOW=1 to disable without a code change.
  //
  // FG-376: one NAMED volume per workspace member (repo root + every npm
  // `workspaces` entry), keyed by a hash of package-lock.json, instead of a
  // single anonymous volume — so a task with an unchanged lockfile reuses an
  // already-populated volume instead of reinstalling (e.g. the Shipping
  // Reviewer reusing the engineer's install, FG-372). A project with no
  // package-lock.json (non-npm project, bare test fixture) falls back to the
  // original anonymous single-volume shadow — still correct, just not reusable.
  //
  // buildDockerArgs builds AGENT/reviewer containers ONLY — it never installs
  // and never mounts a named dependency volume read-write. Installing is
  // exclusively buildProvisionerDockerArgs's short-lived container's job
  // (below); by the time this function runs, the caller (runNext.ts) has
  // already confirmed the cache key is populated and sets
  // DEPENDENCY_CACHE_MOUNT_RO accordingly. FORGE_NM_INSTALL_ROOT is never
  // emitted here — an agent/reviewer container has no reason to write into
  // the shared cache, ever.
  if (
    projectContainerPath &&
    process.platform === "darwin" &&
    process.env.FORGE_NO_NM_SHADOW !== "1"
  ) {
    const legacyShadowPath = `${projectContainerPath}/node_modules`;

    if (projectMode === "rw" && ctx.IS_WORKTREE_DISPATCH === "1" && ctx.DEPENDENCY_CACHE_MOUNT_RO === "1") {
      // Worktree-mode primary, cache already provisioned host-side (the
      // caller never sets DEPENDENCY_CACHE_MOUNT_RO otherwise) — mount the
      // named lockfile-keyed volumes READ-ONLY, same as a reviewer below.
      let plan;
      try {
        plan = planDependencyVolumes(ctx.PROJECT_DIR, projectContainerPath);
      } catch {
        plan = undefined;
      }
      if (plan) {
        for (const v of plan.volumes) {
          args.push("-v", `${v.name}:${v.containerPath}:ro`);
        }
        // Diagnostic env only (no chown/install trigger here — the
        // provisioner already chowned + installed these volumes). Kept for
        // parity with the legacy single-path var and for `forge show`/manifest
        // visibility into which cache key this dispatch used.
        args.push("-e", `FORGE_NM_SHADOW=${legacyShadowPath}`);
        args.push("-e", `FORGE_NM_SHADOW_PATHS=${plan.volumes.map((v) => v.containerPath).join(":")}`);
        args.push("-e", `FORGE_NM_LOCKFILE_HASH=${plan.lockfileHash}`);
      } else {
        args.push("-v", legacyShadowPath);
        args.push("-e", `FORGE_NM_SHADOW=${legacyShadowPath}`);
      }
    } else if (projectMode === "rw") {
      // FIX1 (FG-376 review): the named, lockfile-keyed multi-volume path is
      // worktree-mode ONLY. A normal rw bind-mount dispatch shares the live
      // host project directory across concurrent tasks — a container-local
      // shared-cache mount here would BE the race this review exists to fix.
      // Also covers the (should-not-happen) case of a worktree dispatch whose
      // caller never resolved a cache key (no lockfile) — same legacy fallback.
      args.push("-v", legacyShadowPath);
      args.push("-e", `FORGE_NM_SHADOW=${legacyShadowPath}`);
    } else if (projectMode === "ro" && ctx.DEPENDENCY_CACHE_MOUNT_RO === "1") {
      // Reviewers/reds (including the Shipping-Reviewer) never provision —
      // they only reuse an ALREADY-populated cache, mounted read-only, so
      // review containers never race an install and never write into it.
      let plan;
      try {
        plan = planDependencyVolumes(ctx.PROJECT_DIR, projectContainerPath);
      } catch {
        plan = undefined;
      }
      if (plan) {
        for (const v of plan.volumes) {
          args.push("-v", `${v.name}:${v.containerPath}:ro`);
        }
      }
    }
    // projectMode === "ro" without DEPENDENCY_CACHE_MOUNT_RO: cache isn't
    // ready yet — proceed with no dependency-cache mount at all (never block,
    // never install; matches pre-existing reviewer behavior).
  }

  // FG-559 piece B: when PROJECT_DIR is a linked git worktree, bind the parent
  // repo's .git READ-ONLY at its own host absolute path so the worktree's
  // `gitdir:` pointer resolves in the container. `:ro` for EVERY agent class,
  // blue and red alike — PROJECT_MODE (rw-for-blue / ro-for-red) is unrelated
  // and unchanged. Computed here, NOT declared in runtime YAML: the mount set
  // is spread across six seeds/runtimes/*.yml resolved from a versioned seed
  // generation, so a YAML-declared mount would silently keep the broken
  // behavior on any generation that wasn't regenerated. Same shape as the
  // FG-376 dependency volumes above — a dynamic, conditional mount in code.
  if (projectContainerPath) {
    for (const gitPath of planWorktreeGitMounts(ctx.PROJECT_DIR)) {
      args.push("-v", `${gitPath}:${gitPath}:ro`);
    }
  }

  // Working directory = the persistent project bind mount (not the image's
  // ephemeral /workspace WORKDIR). Aligns Claude runtimes with codex (which
  // already targets /project) and with every agent seed's /project contract,
  // so cwd-relative writes persist to the host instead of vanishing on exit.
  if (projectContainerPath) {
    args.push("-w", projectContainerPath);
  }

  // Image.
  const imageIndex = args.length;
  args.push(runtime.image);

  // Invocation command + args (each arg substituted).
  args.push(substitute(runtime.invocation.command, ctx));
  for (const arg of runtime.invocation.args) {
    args.push(substitute(arg, ctx));
  }

  // Agent-container isolation: claude-code auto-discovers settings from cwd
  // (`<cwd>/.claude/settings*.json`). Since cwd is the project bind mount, the
  // orchestrator's own host-side project settings would otherwise leak into
  // the agent — its `env.CLAUDE_CODE_USE_BEDROCK`, `model`, and `hooks` blocks
  // can flip auth, swap models, and crash on host-only hook paths. Suppress
  // all on-disk discovery (user + project + local) so agents are driven only
  // by what forge passes explicitly via env + --model + --append-system-prompt.
  // Gated on claude-code runtimes — codex/pi CLIs would reject the flag.
  if (resolveRuntimeMetadata(runtime).runtimeKind === "claude-code") {
    args.push("--setting-sources", "");
  }

  const stdin = runtime.invocation.stdin
    ? substitute(runtime.invocation.stdin, ctx)
    : undefined;

  // FG-559 piece A: refuse to hand docker an argv that mounts a linked
  // worktree without the parent .git it points into. Gated on the project
  // actually being mounted — a runtime that mounts no project has no
  // in-container git to be blind about.
  if (projectContainerPath) assertWorktreeGitMountPlanned(ctx.PROJECT_DIR, args);

  // FG-497: fail fast, on the host, before exec — not with a bare E2BIG death
  // inside the container. Checks every argv string, including each "-e
  // KEY=VALUE" env pair (labeled by KEY for a useful diagnostic).
  for (let i = 0; i < args.length; i++) {
    const label = args[i - 1] === "-e" ? `env ${args[i]!.split("=")[0]}` : `argv[${i}] ("${args[i - 1] ?? ""}")`;
    assertWithinArgLimit(label, args[i]!);
  }

  return { args, stdin, imageIndex };
}

/** The in-container path the runtime's project mount lands at (e.g.
 *  "/project"). Shared by buildDockerArgs's own mount loop and by
 *  buildProvisionerDockerArgs below, which needs the SAME path so a
 *  DependencyVolumePlan computed against it lines up between the provisioner
 *  and the agent container that reuses it read-only. */
export function resolveProjectContainerPath(runtime: Runtime): string | undefined {
  return runtime.mounts.find((m) => m.host === "${PROJECT_DIR}")?.container;
}

/** Docker args for the FG-376 short-lived dependency-cache provisioner: a
 *  DEDICATED install container, not the agent. Mounts the repo READ-ONLY
 *  (npm ci never writes to project source — planDependencyVolumes only
 *  produces a plan when a package-lock.json exists, so the entrypoint's
 *  install branch always runs `npm ci`, never `npm install`) plus every
 *  plan volume READ-WRITE (the only place these volumes are ever writable),
 *  runs the SAME agent-entrypoint.sh install contract
 *  (FORGE_NM_INSTALL_ROOT / FORGE_NM_SHADOW_PATHS / exit
 *  DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE on failure) against a trivial
 *  no-op command, and exits — no agent invocation, no auth, no browser-tools.
 *  Caller (runNext.ts, via dependency-provisioning.ts:provisionDependencyCache)
 *  runs this under the short cache-key lock and is responsible for the exit
 *  code / marker decision; this function only builds the argv.
 *
 *  Named via provisionerContainerName(plan.lockfileHash) — by CACHE KEY, not
 *  ctx.TASK_ID (FG-376 FIX1). That matches the provisioning lock's own grain
 *  (one provisioner per lockfile hash) so dependency-provisioning.ts's
 *  onDeadHolder can identify/kill the exact orphaned container from LockInfo
 *  alone, without needing a taskId. It also gets a free second guard:
 *  `docker run --name` refuses to start a second container under a name
 *  that's still running. */
export function buildProvisionerDockerArgs(
  runtime: Runtime,
  ctx: { TASK_ID: string; PROJECT_DIR: string },
  plan: DependencyVolumePlan,
): string[] {
  const projectContainerPath = resolveProjectContainerPath(runtime) ?? "/project";
  const args: string[] = ["run", "--rm", "-i"];
  args.push("--name", provisionerContainerName(plan.lockfileHash));
  args.push("-e", "FORGE_NO_BROWSER=1");
  args.push("-v", `${ctx.PROJECT_DIR}:${projectContainerPath}:ro`);
  // FG-559: same read-only parent-.git bind as the agent container gets. The
  // provisioner runs the shared entrypoint, whose git probe would otherwise
  // refuse a worktree project.
  for (const gitPath of planWorktreeGitMounts(ctx.PROJECT_DIR)) {
    args.push("-v", `${gitPath}:${gitPath}:ro`);
  }
  for (const v of plan.volumes) {
    args.push("-v", `${v.name}:${v.containerPath}`); // rw — the ONLY container allowed to write here
  }
  args.push("-e", `FORGE_NM_SHADOW_PATHS=${plan.volumes.map((v) => v.containerPath).join(":")}`);
  args.push("-e", `FORGE_NM_INSTALL_ROOT=${plan.installRoot}`);
  args.push("-w", projectContainerPath);
  args.push(runtime.image);
  args.push("true"); // entrypoint installs, then execs this trivial no-op and exits 0
  // FG-559 piece A: the provisioner is a container too, and on a worktree
  // dispatch it starts BEFORE the agent container — so the same refusal has to
  // hold here, not only in buildDockerArgs. A git bind the argv cannot express
  // (a host path holding a `:`) is emitted above and caught here.
  assertWorktreeGitMountPlanned(ctx.PROJECT_DIR, args);
  return args;
}

// FG-374: verify that the resolved projectDir is mountable before exec'ing.
// Hard-fails only for genuinely broken mounts: missing path or non-directory.
// Empty dirs and marker-less dirs are valid (tests use bare mkdtemp dirs;
// forge supports non-git/non-npm project layouts) — they emit a warning only.
// Call this just before exec — after buildDockerArgs succeeds.
export function preflightProjectMount(projectDir: string): void {
  const stat = statSync(projectDir, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(
      `project mount preflight failed: ${projectDir} does not exist — ` +
        `verify the correct project directory is mounted at /project`
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `project mount preflight failed: ${projectDir} is not a directory — ` +
        `verify the correct project directory is mounted at /project`
    );
  }
  const entries = readdirSync(projectDir);
  if (entries.length === 0) {
    console.warn(
      `forge: project mount preflight: ${projectDir} is empty — ` +
        `verify the correct project directory is mounted at /project`
    );
    return;
  }
  const dotGit = statSync(join(projectDir, ".git"), { throwIfNoEntry: false });
  const hasPkg = existsSync(join(projectDir, "package.json"));
  if (!dotGit && !hasPkg) {
    console.warn(
      `forge: project mount preflight: ${projectDir} has no .git or package.json — ` +
        `proceeding; verify this is the intended project root`
    );
  }
  // FG-559: `.git` existing is NOT evidence of a usable repo. For a linked
  // worktree it is a `gitdir:` pointer FILE, and the bare existsSync this
  // replaced read that as a healthy marker — the seam the whole defect walked
  // through. A pointer whose target is gone is broken on the HOST too, so
  // refuse rather than dispatch an agent that cannot run git. (A pointer that
  // resolves host-side but is not MOUNTED is a different failure, caught by
  // assertWorktreeGitMountPlanned against the argv, not by a filesystem stat.)
  if (dotGit?.isFile()) {
    const target = readGitdirPointer(projectDir);
    if (!target || !existsSync(target)) {
      throw new Error(
        `project mount preflight failed: ${projectDir}/.git is a gitdir: pointer to ` +
          `${target ?? "an unparseable path"}, which does not exist on the host — ` +
          `the worktree's parent repo is missing or the worktree was pruned`
      );
    }
  }
}

// Exported for tests so we can assert env-pairs and mount-pairs.
export const _internal = {
  buildDockerArgs,
};
