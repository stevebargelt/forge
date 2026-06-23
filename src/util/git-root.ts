import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

// Walk up from `startDir` to the nearest ancestor containing a `.git` entry
// (a dir for normal repos; a file for worktrees/submodules). Returns that repo
// root, or `startDir` unchanged when none is found (a non-git dir is its own
// project).
//
// Project IDENTITY is the repo root: a monorepo subdir like
// `.../wnba-led-scoreboard/web-admin` takes the repo's name, and runs dispatched
// against subdirs roll up under one project.
//
// FG-374 (was FG-359): this root IS now also the mount target (projectDir) for
// implicit invocations from a subdir. resolveProjectMount() in
// src/util/resolve-project-mount.ts owns that decision; this function is the
// pure filesystem walk it calls.
export function findGitRoot(startDir: string): string {
  let dir = startDir;
  const fsRoot = parse(dir).root;
  // Bounded walk: stop at the filesystem root.
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === fsRoot) return startDir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}
