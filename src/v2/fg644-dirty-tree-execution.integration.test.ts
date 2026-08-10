// FG-644: the suites that are hardest to run must actually RUN — from the tree the
// agent is editing, in the environment the agent is editing it from.
//
// Two classes of test used to fall over for reasons that had nothing to do with the
// code they cover, and both had the same tempting non-fix (turn them into skips):
//
//   1. The release-build suites refuse a dirty builder (FG-569 GAP 2). An agent with
//      work in flight always has one, so `forge-test` graded every change against a
//      suite that could not start.
//   2. The FG-612 self-host suites built fixtures NEXT TO the checkout. Mounted at
//      /project — the shape every agent container has — that parent is unwritable, so
//      the fixture died EACCES before the guard was ever exercised.
//
// A skip cannot validate a change to the code under test, so this file is the guard
// against reintroducing one. It builds an AGENT-SHAPED checkout (unwritable parent,
// uncommitted edits, node_modules alongside), runs the real suites against it, and
// asserts on WHAT EXECUTED — the named tests, by identity, as pass and never as skip.
// Exiting green is not the assertion: a runner that skipped everything exits green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { findGitRoot } from "../util/git-root.js";
import { disposeReleaseWorkspace, type ReleaseWorkspaceResidue } from "./release.js";

const repoRoot = findGitRoot(process.cwd());

/** Everything the release builder and the FG-612 CLI need from a checkout. */
const SHIPPED = ["src", "bin", "seeds", "scripts", "docker", "dashboard", "package.json", "package-lock.json", "tsconfig.json", ".gitignore"];

/** The in-flight edit. A file that exists ONLY in the working tree, so a release
 *  built from HEAD cannot carry it and a release built from the agent's source must. */
const MARKER_REL = join("src", "fg644-in-flight-marker.ts");
const MARKER_BODY = `export const FG644_IN_FLIGHT = "uncommitted at build time";\n`;

type Fixture = { base: string; parent: string; checkout: string; scratch: string; tmp: string };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

/** Byte-for-byte what docker/forge-test.sh's _deps_fingerprint computes, so the
 *  pre-seeded scratch is recognised as already installed and the script does not
 *  reach for `npm ci` (which would need a network this suite must not depend on). */
function depsFingerprint(root: string): string {
  const h = createHash("sha1");
  for (const f of ["package.json", "package-lock.json"]) h.update(readFileSync(join(root, f)));
  return h.digest("hex");
}

/** A checkout with the two properties that broke these suites: its parent is not
 *  writable (so nothing can be created BESIDE it), and its working tree is dirty.
 *
 *  FG-698 AC5: plus a `tmp` sibling that owns every inner run's temporary space. It sits
 *  under `base`, NOT under `parent` (chmod 0o555 — nothing may be created beside the
 *  checkout) and NOT inside `checkout` or `scratch` (the tests assert the scratch is a
 *  CLEAN candidate and that the checkout's only dirt is the in-flight marker). Both spawns
 *  point TMPDIR at it, so `os.tmpdir()` in every inner process — including the release
 *  suites' `mkdtempSync(join(tmpdir(), "fg569-rel-"))` — allocates INSIDE this fixture and
 *  is reclaimed by destroy(). An inner run killed by a timeout runs no teardown of its own;
 *  ownership, not the dead run's cooperation, is what frees its multi-GB workspace. */
function agentShapedFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg644-")));
  const parent = join(base, "ro");
  const checkout = join(parent, "checkout");
  const scratch = join(parent, "scratch");
  const tmp = join(base, "tmp");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  mkdirSync(tmp, { recursive: true });

  for (const rel of SHIPPED) cpSync(join(repoRoot, rel), join(checkout, rel), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(checkout, "node_modules"));

  git(checkout, ["init", "-q"]);
  writeFileSync(join(checkout, ".git", "info", "exclude"), "node_modules/\n");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-q", "-m", "fixture checkout"]);
  writeFileSync(join(checkout, MARKER_REL), MARKER_BODY);

  // The scratch's own closure: a real copy, not the symlink, because the release
  // build reads it as the shipped dependency tree.
  execFileSync("cp", ["-a", join(repoRoot, "node_modules"), join(scratch, "node_modules")]);
  writeFileSync(`${scratch}.deps`, depsFingerprint(checkout));

  chmodSync(parent, 0o555);
  return { base, parent, checkout, scratch, tmp };
}

/** node:test marks its own children with NODE_TEST_CONTEXT, and a runner that sees it
 *  refuses to run files ("run() is being called recursively"). This file's whole job
 *  is to run real suites as children, so it hands them a clean context.
 *
 *  FG-698 AC5: it also points TMPDIR at the fixture's own `tmp`, so an inner run's
 *  temporary space belongs to the outer fixture and dies with it — a killed inner run
 *  (these spawns kill on an 800s/500s timeout) never reaches its own after() hook, so
 *  nothing else would free the multi-GB release workspaces it minted. Passed per fixture
 *  rather than hardcoded: each fixture owns a different directory.
 *
 *  Deliberately NOT the same knob as src/test-setup.ts's TMUX_TMPDIR, which stays
 *  hardcoded under /tmp: a unix socket path has a ~104-char limit, so that directory has
 *  to stay short, and it holds kilobytes of sockets rather than gigabytes of release
 *  closures. It is not this ticket's problem. */
function childEnv(tmpDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmpDir, ...extra };
  delete env["NODE_TEST_CONTEXT"];
  return env;
}

/** forge-test.sh execs the `tsx` CLI by name (#299: the agent image installs tsx
 *  globally, and `node --import tsx` cannot resolve a global install). That is a
 *  property of the container this file simulates, not of the lane it runs in — a CI
 *  runner has tsx only as a local devDependency, so `command -v tsx` finds nothing and
 *  the script exits 127 before a single inner test registers. Appending the project's
 *  own .bin completes the agent-shaped environment; it never shadows a real global tsx,
 *  which stays first on PATH. A tree with neither fails HERE, naming the precondition,
 *  rather than surfacing downstream as "no result at all". */
function agentShapedPath(): string {
  const localBin = join(repoRoot, "node_modules", ".bin");
  const path = `${process.env["PATH"] ?? ""}:${localBin}`;
  const found = spawnSync("bash", ["-c", "command -v tsx"], { env: { ...process.env, PATH: path }, encoding: "utf8" });
  assert.equal(
    found.status,
    0,
    `precondition: forge-test.sh execs the \`tsx\` CLI and no tsx is resolvable — not on PATH, and none at ${localBin}`,
  );
  return path;
}

/** Tear the whole fixture down, INCLUDING whatever the inner runs left under `f.tmp`.
 *
 *  FG-698: that residue is FROZEN — a release closure's directories have no write bit, so
 *  a recursive unlink cannot traverse them and the plain rmSync this used to be would
 *  throw EACCES out of a `finally`, replacing the test's real verdict with a teardown
 *  fault AND stranding the tree it failed to remove. disposeReleaseWorkspace makes the
 *  tree removable pre-order, removes it, and REPORTS what it could not remove instead of
 *  throwing. Returns that residue so a test can assert on it; empty means fully removed. */
function destroy(f: Fixture): ReleaseWorkspaceResidue[] {
  try {
    chmodSync(f.parent, 0o755);
  } catch {
    // Not the last word, and not worth throwing over from a `finally`: the disposal below
    // chmods every directory under f.base pre-order anyway, this one included.
  }
  return disposeReleaseWorkspace(f.base, `fg644 agent-shaped fixture ${f.base}`);
}

type TapResult = "pass" | "fail" | "skip";

/** node:test's TAP output, reduced to what executed. `ok`/`not ok` with a SKIP or
 *  TODO directive is NOT an execution — that distinction is the whole point here. */
function parseTap(stdout: string): { byName: Map<string, TapResult>; summary: Record<string, number> } {
  const byName = new Map<string, TapResult>();
  const summary: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const point = /^\s*(not )?ok \d+ - (.*)$/.exec(line);
    if (point) {
      const raw = point[2] ?? "";
      const directive = / # (SKIP|TODO)\b/i.exec(raw);
      const name = (directive ? raw.slice(0, directive.index) : raw).trim();
      byName.set(name, directive ? "skip" : point[1] ? "fail" : "pass");
      continue;
    }
    const count = /^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$/.exec(line);
    if (count) summary[count[1] as string] = Number(count[2]);
  }
  return { byName, summary };
}

function tail(s: string, n: number): string {
  return s.length > n ? `…(${s.length - n} earlier bytes elided)\n${s.slice(-n)}` : s;
}

/** Why the inner run produced what it did. "no result at all" with nothing after it is
 *  unactionable, and the inner TAP can run to megabytes — so exit status and stderr come
 *  FIRST, where they survive a truncated assertion message. An inner run that never
 *  started (exit 127, a FATAL from the harness) says so on line one. */
function innerReport(r: { status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout: string; stderr: string }): string {
  return [
    `inner run: exit=${r.status ?? "null"} signal=${r.signal ?? "none"}${r.error ? ` spawn-error=${r.error.message}` : ""}`,
    `inner stderr:\n${tail(r.stderr ?? "", 8_000)}`,
    `inner stdout:\n${tail(r.stdout ?? "", 20_000)}`,
  ].join("\n");
}

/** The assertion this file exists to make: these named tests EXECUTED and passed.
 *  Matching is by identity — a renamed or deleted test fails here rather than
 *  quietly reducing coverage. */
function assertExecuted(label: string, tap: ReturnType<typeof parseTap>, names: string[], report: string): void {
  const bad = names.some((n) => tap.byName.get(n) !== "pass") || tap.summary["skipped"] !== 0 || tap.summary["fail"] !== 0 || !(tap.summary["pass"] ?? 0);
  // Straight to stderr as well as into the message: a reporter that elides a long
  // assertion message would otherwise leave the CI log with the verdict and no cause.
  if (bad) process.stderr.write(`\n${label}: inner run did not satisfy execution identity\n${report}\n`);

  for (const name of names) {
    const verdict = tap.byName.get(name);
    assert.equal(verdict, "pass", `${label}: "${name}" must EXECUTE and pass, got ${verdict ?? "no result at all"}\n${report}`);
  }
  assert.equal(tap.summary["skipped"], 0, `${label}: nothing may be skipped — a skip is not validation\n${report}`);
  assert.equal(tap.summary["fail"], 0, `${label}: no failures\n${report}`);
  assert.ok((tap.summary["pass"] ?? 0) > 0, `${label}: something must have run\n${report}`);
}

const RELEASE_TESTS = [
  "FG-569 GAP 2 (dirty source, RED pre-fix / GREEN after): an uncommitted change under src/ is REFUSED so the manifest commit can never lie about the shipped bytes",
  "FG-569 GAP 2 (builder identity): builderCommit is recorded and EQUALS commit on a normal self-build (builder and source are one checkout)",
  "FG-575: a DIRTY invoking checkout is NEVER committed into — the build runs off an isolated copy that carries the uncommitted work, and the checkout's git state is untouched",
];

const FG612_TESTS = [
  "a sibling directory that merely shares a string prefix with the checkout is NOT refused",
  "a project spelled through a symlinked parent still refuses (the /var → /private/var shape)",
  "a sibling directory that merely shares a string prefix with the forge root dispatches normally",
  "a project path spelled through a symlinked parent still refuses (the /var → /private/var shape)",
];

test("FG-644: the release suite EXECUTES from a dirty checkout, against a candidate that carries the in-flight source", { timeout: 900_000 }, () => {
  const f = agentShapedFixture();
  try {
    const headBefore = git(f.checkout, ["rev-parse", "HEAD"]).trim();

    const r = spawnSync(
      "bash",
      [join(repoRoot, "docker", "forge-test.sh"), "--test-reporter=tap", "src/v2/release.integration.test.ts"],
      {
        encoding: "utf8",
        env: childEnv(f.tmp, { FORGE_SRC_DIR: f.checkout, FORGE_WORK_DIR: f.scratch, PATH: agentShapedPath() }),
        timeout: 800_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const report = innerReport(r);

    // The mechanism: the scratch is a CLEAN release candidate whose HEAD describes
    // the agent's uncommitted work. Both halves matter — clean alone is satisfiable
    // by building last-committed code, which validates nothing about the change.
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd: f.scratch, encoding: "utf8" }),
      "",
      `the scratch must be a clean build candidate\n${report}`,
    );
    assert.equal(
      execFileSync("git", ["show", `HEAD:${MARKER_REL}`], { cwd: f.scratch, encoding: "utf8" }),
      MARKER_BODY,
      `the candidate's HEAD must carry the in-flight edit, not just last-committed code\n${report}`,
    );

    // And the source checkout was never written into (FG-575's invariant, one layer out).
    assert.equal(git(f.checkout, ["rev-parse", "HEAD"]).trim(), headBefore, "forge-test must not commit into the source");
    assert.match(
      git(f.checkout, ["status", "--porcelain"]),
      /fg644-in-flight-marker/,
      "the source's uncommitted work must still be uncommitted",
    );

    assertExecuted("release suite from a dirty tree", parseTap(r.stdout ?? ""), RELEASE_TESTS, report);
  } finally {
    destroy(f);
  }
});

test("FG-644: the FG-612 self-host suites EXECUTE from a checkout whose parent is unwritable", { timeout: 600_000 }, () => {
  const f = agentShapedFixture();
  try {
    // Straight at the runner, cwd inside the checkout: the suites derive their source
    // root from the module they were loaded from, so this IS the /project shape.
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(join(f.checkout, "src", "test-setup.ts")).href,
        "--test",
        "--test-reporter=tap",
        "src/cli/fg612-self-host-cli.integration.test.ts",
        "src/v2/fg612-self-host-dispatch.integration.test.ts",
      ],
      { cwd: f.checkout, encoding: "utf8", env: childEnv(f.tmp), timeout: 500_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const report = innerReport(r);

    assert.throws(
      () => mkdirSync(`${f.checkout}-fg612-sibling-cli`),
      /EACCES|EPERM/,
      "fixture: the point of this environment is that nothing can be created beside the checkout",
    );
    assertExecuted("FG-612 suites beside an unwritable parent", parseTap(r.stdout ?? ""), FG612_TESTS, report);
  } finally {
    destroy(f);
  }
});

/** An inner run shaped like the release suites' worst case: it mints a workspace under its
 *  OWN os.tmpdir(), FREEZES it the way a release closure is frozen (file read-only, then
 *  the directory's write bit cleared — post-order, root last), reports where it put it,
 *  and then sleeps forever. It registers no cleanup at all, which is the honest simulation:
 *  the two heavy tests above kill their inner run on an 800s/500s timeout, and a SIGKILLed
 *  process runs no after() hook, no exit handler and no signal handler. writeSync(1, …)
 *  rather than console.log because a SIGKILL flushes nothing that is still buffered. */
const KILLED_INNER_RUN = [
  `const { chmodSync, mkdtempSync, writeFileSync, writeSync } = require("node:fs");`,
  `const { tmpdir } = require("node:os");`,
  `const { join } = require("node:path");`,
  `const d = mkdtempSync(join(tmpdir(), "fg569-rel-"));`,
  `writeFileSync(join(d, "closure.txt"), "release bytes");`,
  `chmodSync(join(d, "closure.txt"), 0o444);`,
  `chmodSync(d, 0o555);`,
  `writeSync(1, d + "\\n");`,
  `setInterval(() => {}, 1000);`,
].join("\n");

test("FG-698 (AC5): a KILLED inner run's release workspace lands INSIDE the outer fixture, and the outer teardown removes it", { timeout: 300_000 }, () => {
  const f = agentShapedFixture();
  let inner: string | undefined;
  let destroyed = false;
  try {
    // .cjs so the child's module system is decided by the extension, not by whichever
    // package.json happens to be above it.
    const script = join(f.base, "fg698-inner-run.cjs");
    writeFileSync(script, KILLED_INNER_RUN);

    const r = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: childEnv(f.tmp),
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    // The premise, proven rather than assumed: the child died where it stood, so nothing
    // inside the inner run can be responsible for what happens to what it left behind.
    assert.equal(r.signal, "SIGKILL", `the inner run must be KILLED, not exit on its own\n${innerReport(r)}`);

    inner = (r.stdout ?? "").trim();
    assert.match(inner, /fg569-rel-/, `the inner run must report the workspace it minted\n${innerReport(r)}`);

    // AC5 itself: os.tmpdir() inside the inner process resolved INSIDE the outer fixture.
    // Asserted on the path the child actually chose — snapshotting /tmp for strays would be
    // racy, since sibling integration files mint /tmp/fg569-rel-* concurrently under one
    // `node --test` and fg644 spawns further inner runs of its own.
    assert.ok(
      inner.startsWith(f.tmp + sep),
      `a killed inner run's temporary space must be OWNED by the outer fixture (${f.tmp}), got ${inner} — TMPDIR is not reaching the inner process, so this residue is outside anything the fixture can free`,
    );
    assert.ok(
      existsSync(join(inner, "closure.txt")),
      "fixture: the residue must really be on disk before teardown is asked to remove it",
    );

    const residue = destroy(f);
    destroyed = true;
    // And the outer teardown owns it: a FROZEN inner tree is exactly what the old
    // chmod-parent-then-rmSync destroy() was never written for — it would have thrown
    // EACCES out of a `finally` and stranded the tree it failed to remove.
    assert.deepEqual(residue, [], "the outer teardown must fully remove a killed inner run's FROZEN workspace");
    assert.equal(existsSync(inner), false, "the killed run's workspace must be gone");
    assert.equal(existsSync(f.base), false, "and so must the fixture that owned it");
  } finally {
    if (!destroyed) destroy(f);
    // Red path: with the TMPDIR wiring removed the workspace is outside the fixture, where
    // destroy() cannot reach it. This test must not strand the thing it proves gets
    // stranded — narrowly, only a path this run was told about that still looks like one.
    if (inner !== undefined && !inner.startsWith(f.base + sep) && dirname(inner) === tmpdir() && basename(inner).startsWith("fg569-rel-")) {
      disposeReleaseWorkspace(inner, "fg644 killed-inner-run workspace that landed OUTSIDE the fixture");
    }
  }
});
