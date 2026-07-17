// FG-569 (FG-553 Child 2): the pure halves of the release builder — the entry
// script it emits (exec the pinned interpreter, tsx in-process, no PATH lookup)
// and manifest discovery from a nested module dir. The full build + EXECUTED R1
// provenance lives in release.integration.test.ts (it needs a real node_modules).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderEntry, readReleaseManifest, locateReleaseManifest, parseExecDescriptor, renderExecDescriptor, RELEASE_LOADER_NAME, RELEASE_ENTRY_SOURCE, RELEASE_MANIFEST_NAME } from "./release.js";

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
  // FG-571 made this cd PHYSICAL: a release reached as `$FORGE_HOME/current/forge` has a
  // symlink COMPONENT in $0's path (so the `-L $0` branch does not fire), and a logical cd
  // would leave $here on the pointer — re-resolving it per read, which is how a mixed
  // closure gets observed (F26). `-P` is POSIX for the cd builtin (unlike the `--` operand
  // separator this test exists to keep out), so it stays portable across dash/ash/bash.
  assert.ok(code.includes(`here=$(CDPATH= cd -P "$d" && pwd)`), "resolves $here with a portable PHYSICAL cd (-P), so a symlinked path component canonicalizes");
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
  // FG-571 derives the manifest path into $__forge_m first (the fail-closed guard checks
  // its readability before reading it), so the read is `done < "$__forge_m"`. The property
  // is unchanged: the id is READ from the release's own manifest, never baked in.
  assert.ok(entry.includes(`__forge_m=$here/${RELEASE_MANIFEST_NAME}`), "the manifest path is derived from the release's OWN root");
  assert.ok(entry.includes(`done < "$__forge_m"`), "sourced by reading that manifest, not a baked-in literal");
  const exportAt = entry.indexOf("export FORGE_RELEASE_ID");
  assert.ok(exportAt < entry.indexOf("exec '"), "the export happens before exec, so the interpreter inherits it");
  // FG-571 (FG571-RI): the ambient carrier is unset BEFORE the read, and it is unset in the
  // sanitizer at the very top — so a caller-supplied value can never survive to be read
  // back as this release's provenance, whatever the manifest read yields.
  const unsetAt = entry.indexOf("unset ");
  assert.ok(unsetAt >= 0 && entry.slice(unsetAt).split("\n")[0]!.includes("FORGE_RELEASE_ID"), "the ambient FORGE_RELEASE_ID is unset");
  assert.ok(unsetAt < entry.indexOf(`done < "$__forge_m"`), "and it is unset BEFORE the manifest read, not after");
  // Parsed with parameter expansion (a builtin), not an external tool. The scan
  // for externals is over CODE lines only, since the comments legitimately name
  // sed/grep to explain their own absence.
  assert.ok(entry.includes("${__forge_ln#") && entry.includes("${__forge_v%%"), "parses the id via parameter expansion");
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

// ─────────── FG-571: the canonical execution descriptor's schema, at the Node layer ───────────
//
// The shim enforces these same rules in POSIX sh (renderDescriptorRead), and the executed
// suites prove that half by running it. These cover the Node half — the gate that decides what
// forge is willing to WRITE into a unit — so a descriptor forge authors can never be one the
// shim would then refuse. Both halves read from the same constants in release.ts.

test("FG-571 descriptor: forge authors exactly two fields, fixed order, fixed prefix", () => {
  const text = renderExecDescriptor({ interpreter: "/store/interpreters/node-v24.0.0-137/bin/node", id: "release-abc1234-xyz" });
  assert.equal(text, "interpreter /store/interpreters/node-v24.0.0-137/bin/node\nrelease release-abc1234-xyz\n");
  const parsed = parseExecDescriptor(text);
  assert.equal(parsed.ok, true, "what forge writes is what forge accepts — the two halves cannot drift");
  if (parsed.ok) assert.deepEqual(parsed.value, { interpreter: "/store/interpreters/node-v24.0.0-137/bin/node", id: "release-abc1234-xyz" });
});

test("FG-571 descriptor: refuses to AUTHOR a value the shim could not express", () => {
  // A value forge cannot write safely is refused at promotion, not discovered at the operator's
  // next `forge` invocation. Fail at the gate that creates the consequence.
  assert.throws(() => renderExecDescriptor({ interpreter: "relative/node", id: "ok" }), /non-canonical interpreter path/);
  assert.throws(() => renderExecDescriptor({ interpreter: "/tmp/$(id)/node", id: "ok" }), /non-canonical interpreter path/);
  assert.throws(() => renderExecDescriptor({ interpreter: "/tmp/a b/node", id: "ok" }), /non-canonical interpreter path/);
  assert.throws(() => renderExecDescriptor({ interpreter: "/tmp/node\nrelease evil", id: "ok" }), /non-canonical interpreter path/);
  assert.throws(() => renderExecDescriptor({ interpreter: "/ok/node", id: "release evil" }), /malformed release identity/);
  assert.throws(() => renderExecDescriptor({ interpreter: "/ok/node", id: "" }), /malformed release identity/);
});

test("FG-571 descriptor: the schema is EXACT — not 'at least'", () => {
  const good = "interpreter /a/node\nrelease rel-1\n";
  const reasons: Array<[string, string]> = [
    ["", "0 field"],
    ["interpreter /a/node\n", "1 field"],
    [`${good}extra /tmp/attacker\n`, "3 field"],
    ["interpreter /a/node\ninterpreter /b/node\n", "duplicate"],
    ["release rel-1\ninterpreter /a/node\n", "wrong order"],
    ["interpreterr /a/node\nrelease rel-1\n", "wrong prefix"],
    ["interpreter \nrelease rel-1\n", "empty value"],
    ["interpreter /a/node\nrelease rel-1", "unterminated"],
    ["interpreter a/node\nrelease rel-1\n", "non-absolute"],
    ["interpreter /a/`id`\nrelease rel-1\n", "backtick"],
    ['interpreter /a/"x"\nrelease rel-1\n', "quote"],
    ["interpreter /a/$HOME\nrelease rel-1\n", "dollar"],
    ["interpreter /a/x\\y\nrelease rel-1\n", "backslash"],
    ["interpreter /a/node\nrelease rel 1\n", "id whitespace"],
  ];
  for (const [bytes, what] of reasons) {
    const r = parseExecDescriptor(bytes);
    assert.equal(r.ok, false, `a ${what} descriptor must be refused: ${JSON.stringify(bytes)}`);
    if (!r.ok) assert.ok(r.reason.length > 0, `and the refusal must NAME what was wrong (${what})`);
  }
});

test("FG-571 descriptor: real store paths still round-trip — the character set is not an over-refusal", () => {
  // macOS's mkdtemp paths carry `_` and `+`; a set that refused them would make the check
  // untrustworthy on a real host, which is its own defect.
  for (const p of ["/var/folders/8k/a_b+c/T/fg571-home-XyZ/interpreters/node-v24.0.0-137/bin/node", "/Users/dev/.forge/interpreters/node-v24.0.0-137/bin/node"]) {
    const r = parseExecDescriptor(renderExecDescriptor({ interpreter: p, id: "release-abc1234-xyz" }));
    assert.equal(r.ok, true, `a real store path must round-trip: ${p}`);
  }
});
