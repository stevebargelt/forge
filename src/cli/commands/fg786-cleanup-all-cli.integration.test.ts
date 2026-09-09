// FG-786 operator-boundary regression: --all is not merely registered.  It must reach the
// real cleanup command and deliberately ignore the cwd project's retention override, because
// a host-global sweep must never apply one project's short window to another project's data.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RETENTION_POLICY } from "../../v2/retention-policy.js";
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let forgeHome: string;
let projectDir: string;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg786-all-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg786-all-project-"));
  mkdirSync(join(projectDir, ".forge"));
  // A conspicuously non-default local policy makes a leak into --all observable in its JSON.
  writeFileSync(join(projectDir, ".forge", "config.yml"), "retention:\n  successMs: 17\n  failureAmbiguousMs: 23\n");
});

afterEach(() => {
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function cleanup(args: string[]) {
  return spawnSync(tsx, [entry, "ops", "cleanup", ...args, "--dry-run", "--json"], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

test("FG-786: forge ops cleanup --all --dry-run is a host-global CLI pass and ignores the cwd project retention override", () => {
  const scoped = cleanup([]);
  assert.equal(scoped.status, 0, `project cleanup failed\nstdout: ${scoped.stdout}\nstderr: ${scoped.stderr}`);
  const scopedResult = JSON.parse(scoped.stdout) as { policy: { success: number; failureAmbiguous: number } };
  assert.deepEqual(scopedResult.policy, { success: 17, failureAmbiguous: 23 }, "the normal project-scoped command honors its local policy");

  const all = cleanup(["--all"]);
  assert.equal(all.status, 0, `host-global cleanup failed\nstdout: ${all.stdout}\nstderr: ${all.stderr}`);
  const allResult = JSON.parse(all.stdout) as {
    policy: { success: number; failureAmbiguous: number };
    report: { dryRun: boolean };
  };
  assert.deepEqual(allResult.policy, DEFAULT_RETENTION_POLICY, "--all must use the host-default policy rather than the cwd project's override");
  assert.equal(allResult.report.dryRun, true, "the real host-global command preserves dry-run at its operator boundary");
});
