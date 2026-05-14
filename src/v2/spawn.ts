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
import type { Runtime } from "./schema.js";
import {
  exportAwsCreds,
  oauthVolumeName,
  awsConfigDir,
  resolveAwsProfile,
} from "../util/creds.js";
import { substitute, substituteOptional, expandTilde, type SubstContext } from "./resolve.js";

export type SpawnContext = SubstContext & {
  TASK_ID: string;
  TASK_DIR: string;
  PROJECT_DIR: string;
  PROJECT_MODE: "rw" | "ro";
  MODEL: string;
  SYSTEM_PROMPT: string;
  // Rendered task-package markdown; piped to the container as stdin per the
  // runtime YAML's `invocation.stdin` field. Mirrors v1 spine's behavior.
  TASK_PACKAGE_MARKDOWN: string;
  // DESIGN_DIR is optional — empty string when --design-dir wasn't passed.
  DESIGN_DIR?: string;
};

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
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("auth.mode=apikey but ANTHROPIC_API_KEY env is unset");
      args.push("-e", `ANTHROPIC_API_KEY=${key}`);
      break;
    }
    case "oauth-volume": {
      args.push("-v", `${oauthVolumeName()}:/home/agent`);
      break;
    }
  }

  // Static env from runtime.env, with substitution.
  for (const [k, v] of Object.entries(runtime.env)) {
    args.push("-e", `${k}=${substitute(v, ctx)}`);
  }

  // Mounts.
  for (const mount of runtime.mounts) {
    const hostResolved = mount.optional
      ? substituteOptional(mount.host, ctx)
      : substitute(mount.host, ctx);

    if (hostResolved === undefined) continue; // optional + unresolved
    const hostPath = expandTilde(hostResolved);

    if (mount.optional && !existsSync(hostPath)) continue;

    const mode = substitute(mount.mode, ctx);
    args.push("-v", `${hostPath}:${mount.container}:${mode}`);
  }

  // Image.
  args.push(runtime.image);

  // Invocation command + args (each arg substituted).
  args.push(substitute(runtime.invocation.command, ctx));
  for (const arg of runtime.invocation.args) {
    args.push(substitute(arg, ctx));
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
