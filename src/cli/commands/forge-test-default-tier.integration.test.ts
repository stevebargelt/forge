import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "..", "..", "..", "docker", "forge-test.sh");

const ALL_SCRIPTS = {
  test: "node --import tsx --test",
  "test:unit": "node --import tsx --test src/unit",
  "test:integration": "node --import tsx --test src/integration",
  "test:worktree": "node --import tsx --test src/worktree",
  "test:extended": "npm run test:integration && npm run test:worktree",
  "test:all": "npm test",
};

const tmpDirs: string[] = [];

function mkFixture(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-test-tier-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "test-fixture", scripts })
  );
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], srcDir: string): string {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, FORGE_TEST_PRINT_CMD: "1", FORGE_SRC_DIR: srcDir },
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `Script failed (exit ${result.status}): ${result.stderr}`
  );
  return result.stdout.trim();
}

test("no-args + test:unit present -> npm run test:unit", () => {
  const dir = mkFixture(ALL_SCRIPTS);
  assert.equal(run([], dir), "npm run test:unit");
});

test("no-args + no test:unit script -> npm test (generic fallback)", () => {
  const dir = mkFixture({ test: "node --import tsx --test" });
  assert.equal(run([], dir), "npm test");
});

test("--unit -> npm run test:unit", () => {
  const dir = mkFixture(ALL_SCRIPTS);
  assert.equal(run(["--unit"], dir), "npm run test:unit");
});

test("--integration -> npm run test:integration", () => {
  const dir = mkFixture(ALL_SCRIPTS);
  assert.equal(run(["--integration"], dir), "npm run test:integration");
});

test("--worktree -> npm run test:worktree", () => {
  const dir = mkFixture(ALL_SCRIPTS);
  assert.equal(run(["--worktree"], dir), "npm run test:worktree");
});

test("--extended -> npm run test:extended", () => {
  const dir = mkFixture(ALL_SCRIPTS);
  assert.equal(run(["--extended"], dir), "npm run test:extended");
});

test("--all -> npm run test:all", () => {
  const dir = mkFixture(ALL_SCRIPTS);
  assert.equal(run(["--all"], dir), "npm run test:all");
});

test("file arg does not resolve to npm run test:unit", () => {
  const dir = mkFixture(ALL_SCRIPTS);
  const output = run(["src/x.test.ts"], dir);
  assert.notEqual(output, "npm run test:unit");
  assert.ok(
    output.includes("src/x.test.ts"),
    `Expected output to contain file path, got: ${output}`
  );
});

// ── FG-695: a tier flag must never silently discard its path arguments ──────
// `forge-test --integration src/v2/foo.integration.test.ts` used to resolve to
// `npm run test:integration` and run the ENTIRE tier without a word. Hit live in
// FG-253: the run filled the container to 91% and aborted with ENOSPC, and the
// agent had every reason to report it as evidence for the one file it named.
// These cases resolve against the REAL forge layout, so the tier file sets come
// from the tiers' own selection rather than a fixture's idea of one.

const REPO_ROOT = resolve(here, "..", "..", "..");
const UNIT_FILE = "src/v2/forge-test-wrapper.test.ts";
const INTEGRATION_FILE = "src/v2/release.integration.test.ts";

function runRaw(args: string[], srcDir: string) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, FORGE_TEST_PRINT_CMD: "1", FORGE_SRC_DIR: srcDir },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

/** The runner each tier uses, taken from the tier's own definition. */
function tierRunner(tier: "unit" | "integration"): string {
  if (tier === "unit") {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    return pkg.scripts["test:unit"].split("$(find")[0].trim();
  }
  const sh = readFileSync(join(REPO_ROOT, "scripts", "run-integration-tests.sh"), "utf8");
  const bulkRunner = sh.match(
    /^\s*(node --import tsx --import \.\/src\/test-setup\.ts --test) "\$\{BULK_FILES\[@\]\}"$/m,
  )?.[1];
  assert.ok(bulkRunner, "run-integration-tests.sh must retain its explicit bulk runner");
  return bulkRunner;
}

test("FG-695: --unit <path> narrows to that file with the unit tier's own runner", () => {
  assert.ok(existsSync(join(REPO_ROOT, UNIT_FILE)), `${UNIT_FILE} must exist`);
  const out = runRaw(["--unit", UNIT_FILE], REPO_ROOT);
  assert.equal(out.status, 0, out.stderr);
  assert.notEqual(out.stdout, "npm run test:unit", "the path must not be discarded");
  assert.equal(out.stdout, `${tierRunner("unit")} ${UNIT_FILE}`);
  // Dropping the preload would point the suite at the real ~/.forge/forge.db (#199).
  assert.match(out.stdout, /--import \.\/src\/test-setup\.ts/);
});

test("FG-695: --integration <path> narrows to that file, not the whole tier", () => {
  assert.ok(existsSync(join(REPO_ROOT, INTEGRATION_FILE)), `${INTEGRATION_FILE} must exist`);
  const out = runRaw(["--integration", INTEGRATION_FILE], REPO_ROOT);
  assert.equal(out.status, 0, out.stderr);
  assert.notEqual(out.stdout, "npm run test:integration", "the path must not be discarded");
  assert.equal(out.stdout, `${tierRunner("integration")} ${INTEGRATION_FILE}`);
});

test("FG-695: leading ./ and absolute paths narrow the same way", () => {
  // PRINT-CMD resolves against SRC_DIR, so the source/scratch divergence that broke
  // absolute paths in production cannot be expressed here — the production fixture
  // below is what actually guards it. This case only covers the argument forms.
  const expected = `${tierRunner("unit")} ${UNIT_FILE}`;
  assert.equal(runRaw(["--unit", `./${UNIT_FILE}`], REPO_ROOT).stdout, expected);
  assert.equal(runRaw(["--unit", join(REPO_ROOT, UNIT_FILE)], REPO_ROOT).stdout, expected);
});

test("FG-695: a path outside the named tier is refused, never run as a member of it", () => {
  const cases: [string, string][] = [
    ["--unit", INTEGRATION_FILE],
    ["--worktree", UNIT_FILE],
    ["--integration", UNIT_FILE],
  ];
  for (const [flag, file] of cases) {
    const out = runRaw([flag, file], REPO_ROOT);
    assert.notEqual(out.status, 0, `${flag} ${file} must refuse`);
    assert.match(out.stderr, /is not part of the \w+ tier/);
    assert.equal(out.stdout, "", "a refused combination must resolve to no command at all");
  }
});

test("FG-695: the compound tiers refuse paths and name what to run instead", () => {
  for (const flag of ["--extended", "--all"]) {
    const out = runRaw([flag, UNIT_FILE], REPO_ROOT);
    assert.notEqual(out.status, 0, `${flag} <path> must refuse`);
    assert.match(out.stderr, /does not accept file paths/);
    assert.match(out.stderr, /chains other tiers/);
    assert.match(out.stderr, /--unit\|--integration\|--worktree <path>/);
    assert.equal(out.stdout, "");
  }
});

test("FG-695: a tier flag combined with another flag is refused, not silently dropped", () => {
  const out = runRaw(["--integration", "--test", "pattern"], REPO_ROOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /takes file paths, not other flags/);
  assert.equal(out.stdout, "");
});

test("FG-695: mixed, missing, directory, and outside-repo paths refuse the entire narrow run", () => {
  const cases: [string, string[]][] = [
    ["a valid path mixed with a different tier", [UNIT_FILE, INTEGRATION_FILE]],
    ["a missing path", ["src/v2/does-not-exist.test.ts"]],
    ["a directory", ["src/v2"]],
    ["a path outside the repository", ["/tmp/forge-test-not-a-member.test.ts"]],
  ];
  for (const [description, paths] of cases) {
    const out = runRaw(["--unit", ...paths], REPO_ROOT);
    assert.notEqual(out.status, 0, `${description} must refuse`);
    assert.match(out.stderr, /is not part of the unit tier/);
    assert.equal(out.stdout, "", `${description} must not resolve a partial command`);
  }
});

interface ProductionFixture {
  base: string;
  src: string;
  work: string;
  requested: string;
}

function withProductionFixture<T>(runFixture: (fixture: ProductionFixture) => T): T {
  // This deliberately does not use PRINT-CMD.  The work directory must be ours:
  // forge-test replaces an unmarked WORK_DIR/.git when it creates its scratch repo,
  // so pointing it at a developer checkout would be unsafe.
  const base = mkdtempSync(join(tmpdir(), "forge-test-production-narrow-"));
  const src = join(base, "source");
  const work = join(base, "scratch");
  const requested = "src/requested.test.ts";
  const unrelated = "src/unrelated.test.ts";
  try {
    mkdirSync(join(src, "src"), { recursive: true });
    mkdirSync(join(work, "node_modules"), { recursive: true });
    const pkg = JSON.stringify({
      name: "production-narrowing-fixture",
      scripts: { "test:unit": "bash ./src/run-unit.sh $(find src -name '*.test.ts' -type f)" },
    });
    writeFileSync(join(src, "package.json"), pkg);
    writeFileSync(join(src, "src", "run-unit.sh"), "#!/usr/bin/env bash\nset -euo pipefail\nfor file in \"$@\"; do bash \"$file\"; done\n");
    writeFileSync(join(src, requested), "echo REQUESTED_UNIT_TEST_DID_RUN\n");
    writeFileSync(join(src, unrelated), "echo UNRELATED_UNIT_TEST_DID_RUN\n");
    // Keep the disposable scratch on forge-test's healthy fast path: it has no
    // dependencies, but its non-empty node_modules and matching fingerprint mean
    // this real production invocation cannot trigger npm install.
    writeFileSync(join(work, "node_modules", ".keep"), "");
    writeFileSync(
      `${work}.deps`,
      createHash("sha1").update(pkg).update("absent").digest("hex"),
    );
    return runFixture({ base, src, work, requested });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runProduction(fixture: ProductionFixture, path: string) {
  return spawnSync("bash", [SCRIPT, "--unit", path], {
    cwd: fixture.src,
    // node:test marks child processes as recursive; remove that marker because
    // this is intentionally a second, real test execution.
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      FORGE_SRC_DIR: fixture.src,
      FORGE_WORK_DIR: fixture.work,
    },
    encoding: "utf8",
  });
}

// Every form names the SAME file, so every form must narrow to it. The absolute
// ones are the regression: production resolves the tier against the SCRATCH, and
// the membership check used to strip only that root — so a path under the source
// checkout (what an agent editing /project naturally types) stayed absolute, missed
// the tier's relative file list, and was refused with "is not part of the unit
// tier". It was part of it. Fail-safe, but a false statement about a valid path.
//
// This only bites where SRC_DIR and WORK_DIR genuinely DIFFER, which is exactly
// production and exactly what PRINT-CMD (SRC_DIR for both) cannot express.
const PATH_FORMS: [string, (f: ProductionFixture) => string][] = [
  ["relative to the project root", (f) => f.requested],
  ["with a leading ./", (f) => `./${f.requested}`],
  ["absolute under the source checkout", (f) => join(f.src, f.requested)],
  ["absolute under the scratch", (f) => join(f.work, f.requested)],
];

test("FG-695: the production path executes only the requested unit test file", () => {
  let base = "";
  withProductionFixture((fixture) => {
    base = fixture.base;
    for (const [description, form] of PATH_FORMS) {
      const path = form(fixture);
      const result = runProduction(fixture, path);
      assert.equal(result.status, 0, `${description} (${path}) must narrow, not refuse: ${result.stderr}`);
      const output = `${result.stdout}${result.stderr}`;
      assert.match(output, /REQUESTED_UNIT_TEST_DID_RUN/, `${description} must run the requested file`);
      assert.doesNotMatch(
        output,
        /UNRELATED_UNIT_TEST_DID_RUN/,
        `${description}: a production narrowed run must not execute an unrelated test or the whole tier`,
      );
    }
  });
  assert.equal(existsSync(base), false, "the disposable source and scratch must be removed");
});

test("FG-695: the production path still refuses a path under neither root, naming both", () => {
  withProductionFixture((fixture) => {
    const result = runProduction(fixture, join(fixture.base, "elsewhere", "requested.test.ts"));
    assert.notEqual(result.status, 0, "a path outside both roots must refuse");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DID_RUN/, "and must run nothing at all");
    // The old refusal named only the tier, which misdirects when the real problem is
    // which root the path was resolved against.
    assert.ok(
      result.stderr.includes(fixture.src) && result.stderr.includes(fixture.work),
      `the refusal must name both roots, got: ${result.stderr}`,
    );
  });
});

test("FG-695: the production fixture is removed when an assertion fails", () => {
  let base = "";
  assert.throws(() =>
    withProductionFixture((fixture) => {
      base = fixture.base;
      assert.fail("intentional cleanup probe");
    }),
  );
  assert.equal(existsSync(base), false, "finally must remove the fixture after a failed assertion");
});

test("FG-695: a tier whose file set cannot be reproduced refuses rather than running it all", () => {
  const dir = mkFixture(ALL_SCRIPTS); // scripts with no `$(find ...)` to reproduce
  const out = runRaw(["--unit", "src/unit/a.test.ts"], dir);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /cannot narrow --unit/);
  assert.match(out.stderr, /will not run the whole tier/);
  assert.equal(out.stdout, "");
  // ...and the bare flag is unaffected.
  assert.equal(run(["--unit"], dir), "npm run test:unit");
});
