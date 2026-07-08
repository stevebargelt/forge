import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
