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
import { existsSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("FG-569 MUST-FIX 1 (EXECUTED THROUGH A SYMLINK): forge on PATH as a symlink still resolves its source root", () => {
  // npm-link installs the machine-wide `forge` as a SYMLINK on PATH (e.g.
  // ~/.nvm/.../bin/forge → repo/bin/forge). A $0-relative source root would then
  // resolve NEXT TO THE SYMLINK and die with ERR_MODULE_NOT_FOUND. bin/forge must
  // canonicalize $0 through the symlink FIRST. Proven by running THROUGH a symlink.
  const linkDir = mkdtempSync(join(tmpdir(), "fg569-symlink-"));
  const link = join(linkDir, "forge");
  try {
    symlinkSync(forgeBin, link);

    const v = spawnSync(link, ["--version"], { encoding: "utf8", env: process.env });
    assert.equal(v.status, 0, `forge via symlink failed to run: ${v.stderr}`);
    assert.equal(v.stdout.trim(), pkgVersion, "the symlinked entry resolved the repo and ran the real CLI");

    // And a real command that loads the native binding runs end to end through the symlink.
    const p = spawnSync(link, ["release", "provenance", "--json"], { encoding: "utf8", env: process.env });
    assert.equal(p.status, 0, `provenance via symlink failed: ${p.stderr}`);
    assert.equal(JSON.parse(p.stdout).bindingLoads, true, "the binding loaded — source root resolved through the symlink");
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
});
