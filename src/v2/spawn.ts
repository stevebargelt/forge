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

import { existsSync } from "node:fs";
import { join } from "node:path";
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
};

export function buildDockerArgs(runtime: Runtime, ctx: SpawnContext): BuildArgsResult {
  const args: string[] = ["run", "--rm", "-i"];

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

  // #245: shadow the project's node_modules with a container-local anonymous
  // volume on macOS rw mounts (supersedes FORGE-DEC-011). Docker Desktop's
  // grpcfuse stamps a `com.docker.grpcfuse.ownership` xattr on native binaries
  // the container writes (e.g. better-sqlite3.node); CyberArk-class EDR then
  // silently SIGKILLs the HOST node processes that load them. The anonymous
  // volume keeps every node_modules write inside the container (never written
  // back through grpcfuse) AND hides the host's wrong-platform (macOS-arm64)
  // modules so the agent installs correct linux ones instead of hand-patching.
  // --rm auto-removes the volume on exit. Scoped to:
  //   - darwin only: Linux hosts have no grpcfuse and matching-arch modules.
  //   - rw mounts only: reds (ro) never write, so they can't corrupt anything.
  //   - escape hatch FORGE_NO_NM_SHADOW=1 to disable without a code change.
  if (
    projectContainerPath &&
    projectMode === "rw" &&
    process.platform === "darwin" &&
    process.env.FORGE_NO_NM_SHADOW !== "1"
  ) {
    const shadowPath = `${projectContainerPath}/node_modules`;
    args.push("-v", shadowPath);
    // Docker creates the anonymous volume root-owned, but the agent runs as
    // UID 1000 and must `npm install` into it. Signal the path so the entrypoint
    // chowns it to agent (NOPASSWD sudo) before exec'ing the agent command.
    args.push("-e", `FORGE_NM_SHADOW=${shadowPath}`);
  }

  // Working directory = the persistent project bind mount (not the image's
  // ephemeral /workspace WORKDIR). Aligns Claude runtimes with codex (which
  // already targets /project) and with every agent seed's /project contract,
  // so cwd-relative writes persist to the host instead of vanishing on exit.
  if (projectContainerPath) {
    args.push("-w", projectContainerPath);
  }

  // Image.
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

  return { args, stdin };
}

// Exported for tests so we can assert env-pairs and mount-pairs.
export const _internal = {
  buildDockerArgs,
};
