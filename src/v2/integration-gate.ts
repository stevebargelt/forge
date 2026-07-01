// FG-357: post-merge integration gate.
//
// Worktrees (FG-351/352/353) turn same-file textual races into detectable git
// conflicts, but semantic cross-file breakage merges CLEAN: agent A changes a
// signature in foo.ts, agent B (own worktree) still calls the old signature in
// bar.ts — `git merge` sees no overlapping lines and succeeds. Only building
// and testing the MERGED tree catches that.
//
// Runs on the host, not in a container: the merge already landed on the host
// git checkout (run.projectDir, or the integration worktree pre-HEAD-merge),
// so there is nothing container-specific left to reproduce, and reusing
// forge's own `npm run test:unit` entrypoint means no second test runner or
// config to maintain.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type IntegrationGateResult =
  | { ok: true; output: string }
  | { ok: false; output: string; error: string };

/** Mirrors forge-test's own `_pkg_has_script`: true only if package.json parses
 *  and declares the named script. A project with no test:unit script has
 *  nothing for this gate to run — that's a project-config gap, not a merge
 *  defect, so it must not block every worktree merge. */
function hasTestUnitScript(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return typeof pkg.scripts?.["test:unit"] === "string";
  } catch {
    return false;
  }
}

/** Build+test the merged tree at `dir` via the project's own test:unit entrypoint. */
export function runIntegrationGate(dir: string): IntegrationGateResult {
  if (!hasTestUnitScript(dir)) {
    return { ok: true, output: "no test:unit script in package.json — integration gate skipped" };
  }
  const envTimeout = Number(process.env.FORGE_INTEGRATION_GATE_TIMEOUT_MS);
  const timeout = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS;
  try {
    const output = execFileSync("npm", ["run", "test:unit"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout, err.stderr].filter((s): s is string => Boolean(s)).join("\n").trim();
    return { ok: false, output, error: err.message ?? String(e) };
  }
}
