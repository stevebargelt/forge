// FG-569 (FG-553 Child 2): the pure halves of the release builder — the entry
// script it emits (exec the pinned interpreter, tsx in-process, no PATH lookup)
// and manifest discovery from a nested module dir. The full build + EXECUTED R1
// provenance lives in release.integration.test.ts (it needs a real node_modules).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderEntry, readReleaseManifest, locateReleaseManifest, RELEASE_LOADER_NAME, RELEASE_ENTRY_SOURCE, RELEASE_MANIFEST_NAME } from "./release.js";

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

test("FG-569 entry: derives $here with a POSIX-portable cd — no `cd --` (unspecified for the cd builtin)", () => {
  const entry = renderEntry("/opt/node-24/bin/node");
  // POSIX does not define a `--` operand separator for the `cd` builtin, so a strict
  // /bin/sh reads `cd -- "$d"` as a cd into a directory literally named `--` and every
  // direct invocation fails before the pinned interpreter is reached. A leading-dash dir
  // name is instead disarmed with a `./` prefix — portable across dash/ash/bash.
  const code = entry.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.ok(!code.includes("cd -- "), "does not use `cd --` — unspecified for the cd builtin on a conforming /bin/sh");
  assert.ok(code.includes("case $d in -*) d=./$d ;; esac"), "disarms a leading-dash dir name with a `./` prefix before cd");
  assert.ok(code.includes(`here=$(CDPATH= cd "$d" && pwd)`), "resolves $here with a plain, portable cd");
});

test("FG-569 entry: canonicalizes $0 through symlinks with the pinned interpreter (a promoted release is reached via a symlink)", () => {
  const entry = renderEntry("/opt/node-24/bin/node");
  // MUST-FIX 1: $0 is the SYMLINK path when forge is on PATH as a current/PATH
  // shim; resolve it to the real release file before deriving $here. `readlink` is
  // NOT a shell builtin — it is resolved through PATH, so a symlinked entry under a
  // node-free PATH could not find it. Canonicalize with the PINNED interpreter (an
  // absolute path, no PATH lookup) instead, whose realpathSync resolves the whole
  // chain in one call.
  assert.ok(entry.includes(`if [ -L "$p" ]`), "canonicalizes only when $0 is actually a symlink");
  // Scan CODE lines only — the comment legitimately names readlink to explain its
  // absence, exactly as the R2 manifest test's comment names sed/grep.
  const code = entry.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.ok(!code.includes("readlink"), "does NOT reach for a PATH-resolved readlink — that breaks a symlinked entry under a node-free PATH");
  assert.ok(entry.includes(`realpathSync(process.argv[1])`), "resolves the symlink with the pinned interpreter's realpathSync");
  assert.ok(entry.includes(`'/opt/node-24/bin/node' -e`), "the canonicalizer runs the ABSOLUTE pinned interpreter, not a PATH lookup");
  assert.ok(entry.includes(`-e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' -- "$p"`), "passes the link path after -- so a leading-dash name is not read as a node option");
  // The canonicalization must be reached ONLY when $0 is a symlink, so a DIRECT
  // invocation stays a single node exec (no interpreter double-start on the hot path).
  const beforeExec = entry.slice(0, entry.indexOf("exec '"));
  assert.equal(beforeExec.match(/realpathSync\(process\.argv\[1\]\)/g)?.length, 1, "the interpreter is invoked for canonicalization at most once, inside the [ -L ] guard");
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
  // The EXECUTED half — running the FORGE_RELEASE_ID block under /bin/sh to prove
  // it parses the id straight out of a real manifest — lives in the integration
  // tier (release.integration.test.ts); a spawn is a fast-tier violation here.
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
    assert.deepEqual(locateReleaseManifest(base), { kind: "none" });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("FG-570 manifest discovery: a PRESENT but unparseable manifest reports malformed, not absent", () => {
  // The distinction the ABI preflight depends on: a release it cannot parse must not be
  // indistinguishable from a dev checkout, or the gate falls back to the dev ABI pin for a
  // release whose shipped binding it never verified.
  const base = mkdtempSync(join(tmpdir(), "fg570-malformed-"));
  try {
    writeFileSync(join(base, RELEASE_MANIFEST_NAME), '{ "schema": 1, "abi": "137"');
    const found = locateReleaseManifest(join(base, "src", "cli"));
    assert.equal(found.kind, "malformed");
    if (found.kind === "malformed") {
      assert.equal(found.releaseDir, base);
      assert.ok(found.error.length > 0, "the parse error is carried so the refusal can name it");
    }
    assert.equal(readReleaseManifest(base), null, "the null-returning wrapper is unchanged for its existing callers");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
