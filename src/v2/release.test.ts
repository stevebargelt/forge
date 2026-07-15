// FG-569 (FG-553 Child 2): the pure halves of the release builder — the entry
// script it emits (exec the pinned interpreter, tsx in-process, no PATH lookup)
// and manifest discovery from a nested module dir. The full build + EXECUTED R1
// provenance lives in release.integration.test.ts (it needs a real node_modules).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderEntry, readReleaseManifest, RELEASE_LOADER_NAME, RELEASE_ENTRY_SOURCE, RELEASE_MANIFEST_NAME } from "./release.js";

test("FG-569 entry: execs the PINNED absolute interpreter with tsx loaded in-process", () => {
  const entry = renderEntry("/opt/node-24/bin/node");
  assert.ok(entry.startsWith("#!/bin/sh\n"), "a /bin/sh script — the only interpreter whose absolute path needs no PATH");
  assert.ok(entry.includes("exec '/opt/node-24/bin/node' --import"), "execs the absolute interpreter, not a PATH lookup");
  assert.ok(entry.includes(`"$here/${RELEASE_LOADER_NAME}"`), "loads tsx in-process via the release's own loader shim");
  assert.ok(entry.includes(`"$here/${RELEASE_ENTRY_SOURCE}"`), "runs the source entry in the SAME process");
  // No external command may be invoked to resolve the dir for a DIRECT invocation,
  // or a node-free / minimal PATH breaks the bootstrap before the absolute
  // interpreter is reached. Dir + link-relative joins use parameter expansion.
  assert.ok(!entry.includes("$(dirname"), "the dir is resolved with shell builtins (case/parameter expansion), not dirname(1)");
  assert.ok(entry.includes("d=${p%/*}"), "dir is derived with parameter expansion, not an external");
});

test("FG-569 entry: canonicalizes $0 through symlinks (a promoted release is reached via a symlink)", () => {
  const entry = renderEntry("/opt/node-24/bin/node");
  // MUST-FIX 1: $0 is the SYMLINK path when forge is on PATH as a current/PATH
  // shim; resolve the chain to the real release file before deriving $here.
  assert.ok(entry.includes("while [ -L \"$p\" ]"), "follows a symlink chain to the real path");
  assert.ok(entry.includes("readlink -- \"$p\""), "uses readlink to canonicalize each hop");
  // readlink must be reached ONLY inside the symlink loop, so a DIRECT invocation
  // under a node-free PATH never runs an external before the pinned interpreter.
  const beforeExec = entry.slice(0, entry.indexOf("exec '"));
  assert.equal(beforeExec.match(/readlink -- /g)?.length, 1, "the readlink invocation appears once, guarded by the [ -L ] loop");
});

test("FG-569 entry: a space in the interpreter path cannot split the exec argv", () => {
  const entry = renderEntry("/opt/my node/bin/node");
  assert.ok(entry.includes(`exec '/opt/my node/bin/node' --import`), entry);
});

test("FG-569 R2 entry: exports FORGE_RELEASE_ID sourced from the release's OWN manifest, before exec, with shell builtins only", () => {
  const entry = renderEntry("/opt/node-24/bin/node");
  // The export must (1) read the release's own manifest, (2) land BEFORE exec so
  // the pinned interpreter — and every process it starts — inherits it, and
  // (3) use no external command (a node-free PATH must still reach the export).
  assert.ok(entry.includes(`export FORGE_RELEASE_ID`), "the entry exports FORGE_RELEASE_ID");
  assert.ok(entry.includes(`done < "$here/${RELEASE_MANIFEST_NAME}"`), "sourced by reading the release's own manifest, not a baked-in literal");
  const exportAt = entry.indexOf("export FORGE_RELEASE_ID");
  assert.ok(exportAt < entry.indexOf("exec '"), "the export happens before exec, so the interpreter inherits it");
  // Parsed with parameter expansion (a builtin), not an external tool. The scan
  // for externals is over CODE lines only, since the comments legitimately name
  // sed/grep to explain their own absence.
  assert.ok(entry.includes("${ln#") && entry.includes("${ln%%"), "parses the id via parameter expansion");
  const codeBeforeExec = entry.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n").split("exec '")[0]!;
  for (const ext of ["$(sed", "$(grep", "$(awk", "$(jq", "$(dirname", "$(node"]) {
    assert.ok(!codeBeforeExec.includes(ext), `the manifest is parsed with shell builtins, not ${ext}`);
  }

  // EXECUTE it: an sh that reads a real manifest must set the id (the release's
  // own id), and no-manifest sh (bin/forge shape) must leave it unset. Rip out
  // just the FORGE_RELEASE_ID block and run it — no interpreter/loader needed.
  const block = entry.slice(entry.indexOf("while IFS="), entry.indexOf("\n\nexec"));
  const dir = mkdtempSync(join(tmpdir(), "fg569-r2entry-"));
  try {
    writeFileSync(join(dir, RELEASE_MANIFEST_NAME), JSON.stringify({ schema: 1, id: "release-feedb0d-9xk2z", commit: "feedb0d" }, null, 2) + "\n");
    const run = spawnSync("/bin/sh", ["-c", `here=${dir}\n${block}\nprintf '%s' "$FORGE_RELEASE_ID"`], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "release-feedb0d-9xk2z", "the entry's shell parses the id straight out of its manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-569 manifest discovery: walks up from a nested module dir to the release root", () => {
  const base = mkdtempSync(join(tmpdir(), "fg569-manifest-"));
  try {
    const manifest = { schema: 1, id: "release-abc1234-xyz", commit: "abc1234", interpreter: "/usr/bin/node", abi: "137", nodeVersion: "v24.0.0", lockfile: { name: "package-lock.json", sha256: "deadbeef" }, builtAt: "2026-07-15T00:00:00.000Z", entry: RELEASE_ENTRY_SOURCE, binding: "node_modules/better-sqlite3/build/Release/better_sqlite3.node" };
    writeFileSync(join(base, RELEASE_MANIFEST_NAME), JSON.stringify(manifest));
    const nested = join(base, "src", "cli");
    mkdirSync(nested, { recursive: true });

    const found = readReleaseManifest(nested);
    assert.ok(found, "found the manifest by walking up");
    assert.equal(found!.manifest.id, "release-abc1234-xyz");
    assert.equal(found!.releaseDir, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("FG-569 manifest discovery: a dir that is NOT inside a release returns null — dev is not a release", () => {
  const base = mkdtempSync(join(tmpdir(), "fg569-norelease-"));
  try {
    assert.equal(readReleaseManifest(base), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
