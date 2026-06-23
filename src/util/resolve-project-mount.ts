import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { findGitRoot } from "./git-root.js";
import { expandTildePath } from "./paths.js";

export type ResolveMountOptions = {
  isTTY: boolean;
  json: boolean;
  allowSubproject: boolean;
};

export type ResolveMountResult = {
  projectDir: string;
  invocationCwd: string;
  resolvedFromSubdir: boolean;
  explicitSubproject: boolean;
};

// FG-374: resolve the directory to mount at /project inside the container.
//
// Replaces the previous pattern of blindly mounting cwd / --project. A subdir
// mount severs monorepo cross-workspace deps and produces bogus agent runs
// (the FG-359 incident). Resolution rules:
//
// 1. base is NOT a subdir of any git root → mount base (unchanged behavior).
// 2. Implicit invocation (no --project) and base IS a subdir:
//    - Confident root (.git + .forge or package.json): resolve UP, mount root.
//    - Otherwise: hard-fail — run from the project root.
// 3. Explicit --project <subdir>:
//    - --allow-subproject: honor the subdir mount; set explicitSubproject.
//    - interactive (isTTY && !json): warn and honor.
//    - automation (!isTTY || json): hard-fail.
//
// cwd is injectable for tests; production callers omit it (defaults to process.cwd()).
export function resolveProjectMount(
  requestedDir: string | undefined,
  opts: ResolveMountOptions,
  cwd = process.cwd()
): ResolveMountResult {
  const invocationCwd = cwd;
  const expanded = requestedDir !== undefined ? expandTildePath(requestedDir) : undefined;
  const base = resolve(expanded ?? invocationCwd);
  const root = findGitRoot(base);
  const isSubdir = root !== base;

  if (!isSubdir) {
    return { projectDir: base, invocationCwd, resolvedFromSubdir: false, explicitSubproject: false };
  }

  if (requestedDir === undefined) {
    // root always has .git when root !== base (findGitRoot guarantees it)
    const hasForge = existsSync(join(root, ".forge"));
    const hasPkg = existsSync(join(root, "package.json"));
    if (hasForge || hasPkg) {
      console.error(`forge: resolved project root: ${root} (invoked from ${base})`);
      return { projectDir: root, invocationCwd, resolvedFromSubdir: true, explicitSubproject: false };
    }
    throw new Error("run from the project root or pass --project <dir>");
  }

  // Explicit --project <subdir>
  if (opts.allowSubproject) {
    return { projectDir: base, invocationCwd, resolvedFromSubdir: false, explicitSubproject: true };
  }
  if (opts.isTTY && !opts.json) {
    console.error(
      `forge: WARNING — --project ${base} is inside repo ${root}; mounting the subdir — cross-workspace deps may be missing`
    );
    return { projectDir: base, invocationCwd, resolvedFromSubdir: false, explicitSubproject: false };
  }
  throw new Error(
    `--project ${base} is a subdirectory of ${root}; pass --allow-subproject to mount it intentionally, or --project ${root}.`
  );
}
