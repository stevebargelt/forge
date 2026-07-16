// FG-571 — the DISPOSABLE SOURCE ROOT, shared by both FG-571 suites.
//
// buildRelease refuses a dirty source (FG-569 GAP 2), so a suite that builds releases needs
// a checkout whose HEAD describes the bytes it ships. Getting that by committing in the
// REAL checkout is not acceptable: it silently commits a developer's in-progress work, it
// makes the suite's behavior depend on whether the checkout happens to be dirty (a no-op on
// clean CI, destructive on a dev machine), and two suites doing it under one
// `npm run test:integration` race on .git/index.lock. The source repository is not
// disposable; the operator's standing containment rule for this ticket says every test that
// promotes, rolls back, or installs uses disposable isolated locations, and that covers the
// checkout the release is built FROM as much as the forge home it is promoted INTO.
//
// So: copy the commit-bound paths into a mkdtemp, `git init` it, and commit THERE. HEAD in
// the disposable root describes the shipped bytes, assertCommitDescribesTree passes, and no
// git command in either suite ever runs against the real checkout.
//
// node_modules is SYMLINKED, not copied (it is large, and copying it per suite is minutes
// of I/O). This works, verified by execution rather than by reasoning:
//   - buildRelease does cpSync(join(sourceRoot,"node_modules"), ..., {dereference:true}),
//     and `dereference` follows the TOP-LEVEL path — the release gets real bytes;
//   - assertClosureLoads uses createRequire(join(sourceRoot,"package.json")), which resolves
//     through the link;
//   - rmSync on the disposable root UNLINKS the symlink rather than following it, so
//     cleanup cannot reach the real node_modules.
//
// buildRelease is imported FROM THE DISPOSABLE ROOT, which is load-bearing rather than
// stylistic. resolveBuilderCommit (release.ts) derives the BUILDER identity from
// findGitRoot(<its own module dir>); imported from the real checkout that resolves to the
// real repo, which is dirty during development, so the builder dirty-check refuses the
// build. Importing the copy makes builder root === source root, which release.ts handles by
// reusing the source commit — and it means the release is built by the very bytes under test.
//
// Test support only: nothing here is imported by production code.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildReleaseResult } from "./release.js";

/** The paths buildRelease binds to the commit (release.ts's gitTrackedPaths): src/,
 *  package.json, the selected lockfile, and the required asset dirs. Small — copying them
 *  is cheap. node_modules is install OUTPUT, bound to the lockfile separately, and is
 *  linked rather than copied. */
const COMMIT_BOUND_PATHS = ["src", "package.json", "seeds", "scripts", "docker"] as const;
const LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json"] as const;

export type DisposableSource = {
  /** The throwaway checkout releases are built from. Never the real repo. */
  root: string;
  /** The throwaway forge home whose INTERPRETER STORE the built releases pin (FG-571:
   *  buildRelease installs its interpreter into the store and pins the store's copy, so a
   *  build with no `home` would land a node in the operator's real ~/.forge/interpreters).
   *  Deliberately NOT the home a suite promotes into: an install here must not make that
   *  suite's own `installInterpreter` assertions read as a re-install. */
  home: string;
  build: (opts: { outDir: string; rand: string }) => BuildReleaseResult;
};

/** A throwaway git checkout of `repoRoot`'s shipped source, committed in place, that
 *  releases can be built from without touching the real repository. */
export async function makeDisposableSourceRoot(repoRoot: string): Promise<DisposableSource> {
  const root = mkdtempSync(join(tmpdir(), "fg571-src-"));
  const home = mkdtempSync(join(tmpdir(), "fg571-buildhome-"));

  for (const p of COMMIT_BOUND_PATHS) {
    if (existsSync(join(repoRoot, p))) execFileSync("cp", ["-R", join(repoRoot, p), join(root, p)]);
  }
  for (const lf of LOCKFILES) {
    if (existsSync(join(repoRoot, lf))) execFileSync("cp", [join(repoRoot, lf), join(root, lf)]);
  }
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));

  // -c, never `git config --global`: configuring identity is part of building this
  // throwaway repo, not a change to the developer's machine.
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=fg571@test.invalid", "-c", "user.name=fg571", "commit", "-q", "-m", "fg571 disposable source snapshot"], {
    cwd: root,
  });

  const { buildRelease } = (await import(join(root, "src", "v2", "release.ts"))) as { buildRelease: (o: unknown) => BuildReleaseResult };
  return {
    root,
    home,
    build: ({ outDir, rand }) => buildRelease({ sourceRoot: root, outDir, rand, home }),
  };
}

/** Remove a disposable source root and its build home. Plain rmSync, deliberately: the tree
 *  holds only copied source and the node_modules SYMLINK, which rmSync unlinks rather than
 *  follows. Nothing here is frozen, so it must NOT be handed to thawReleaseTree — that walks
 *  the tree and would chmod straight through the link into the real node_modules. The build
 *  home holds only the interpreter store's copied node binary — a plain file. */
export function removeDisposableSourceRoot(src: DisposableSource): void {
  rmSync(src.root, { recursive: true, force: true });
  rmSync(src.home, { recursive: true, force: true });
}
