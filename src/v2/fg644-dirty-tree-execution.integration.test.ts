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
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findGitRoot } from "../util/git-root.js";

const repoRoot = findGitRoot(process.cwd());

/** Everything the release builder and the FG-612 CLI need from a checkout. */
const SHIPPED = ["src", "bin", "seeds", "scripts", "docker", "dashboard", "package.json", "package-lock.json", "tsconfig.json", ".gitignore"];

/** The in-flight edit. A file that exists ONLY in the working tree, so a release
 *  built from HEAD cannot carry it and a release built from the agent's source must. */
const MARKER_REL = join("src", "fg644-in-flight-marker.ts");
const MARKER_BODY = `export const FG644_IN_FLIGHT = "uncommitted at build time";\n`;

type Fixture = { base: string; parent: string; checkout: string; scratch: string };

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
 *  writable (so nothing can be created BESIDE it), and its working tree is dirty. */
function agentShapedFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg644-")));
  const parent = join(base, "ro");
  const checkout = join(parent, "checkout");
  const scratch = join(parent, "scratch");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(scratch, { recursive: true });

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
  return { base, parent, checkout, scratch };
}

/** node:test marks its own children with NODE_TEST_CONTEXT, and a runner that sees it
 *  refuses to run files ("run() is being called recursively"). This file's whole job
 *  is to run real suites as children, so it hands them a clean context. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
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

function destroy(f: Fixture): void {
  chmodSync(f.parent, 0o755);
  rmSync(f.base, { recursive: true, force: true });
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
        env: childEnv({ FORGE_SRC_DIR: f.checkout, FORGE_WORK_DIR: f.scratch, PATH: agentShapedPath() }),
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
      { cwd: f.checkout, encoding: "utf8", env: childEnv(), timeout: 500_000, maxBuffer: 64 * 1024 * 1024 },
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
