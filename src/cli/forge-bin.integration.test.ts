// FG-569 (FG-553 Child 2) — exec-not-spawn, EXECUTED against the LIVE control
// entry (bin/forge is the machine-wide control plane; a change to it changes the
// live `forge` the moment it lands).
//
// Per FG-551, greping bin/forge for "no spawn" is hollow. These tests RUN the
// modified bin/forge against real commands and read `process.pid` FROM the
// running CLI: with exec-not-spawn the /bin/sh execs node (same pid) which loads
// tsx in-process and runs the CLI — so the pid the CLI reports IS the pid we
// launched. The OLD spawn(tsx) shape ran the CLI in a grandchild, so its pid
// would differ from the launched pid — this asserts the difference away.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { findGitRoot } from "../util/git-root.js";
import { version as pkgVersion } from "../../package.json" with { type: "json" };

const forgeBin = join(findGitRoot(process.cwd()), "bin", "forge");

function runForge(args: string[]) {
  return spawnSync(forgeBin, args, { encoding: "utf8", env: process.env });
}

test("FG-569 exec-not-spawn: bin/forge still runs real commands identically (--version, status --json)", () => {
  assert.ok(existsSync(forgeBin), `bin/forge present at ${forgeBin}`);

  const v = runForge(["--version"]);
  assert.equal(v.status, 0, `forge --version failed: ${v.stderr}`);
  assert.equal(v.stdout.trim(), pkgVersion, "the live control entry reports the real version");

  const s = runForge(["status", "--json"]);
  assert.equal(s.status, 0, `forge status --json failed: ${s.stderr}`);
  assert.doesNotThrow(() => JSON.parse(s.stdout), "status --json emits parseable JSON — a real command ran end to end");
});

test("FG-569 exec-not-spawn (EXECUTED): the CLI runs in ONE process — its pid IS the launched pid, no spawned tsx child", () => {
  const r = runForge(["release", "provenance", "--json"]);
  assert.equal(r.status, 0, `provenance failed: ${r.stderr}`);
  const prov = JSON.parse(r.stdout);

  assert.equal(prov.pid, r.pid, "the process that loaded better-sqlite3 IS the one we launched (exec, not spawn)");
  assert.equal(prov.bindingLoads, true, "and it loaded the native binding in that same process");
  assert.equal(prov.release, null, "the dev entry is not a release — INERT, no promotion");
});
