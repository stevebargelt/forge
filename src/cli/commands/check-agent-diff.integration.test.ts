/**
 * CLI-boundary integration tests for `forge check-agent-diff` (FG-375).
 *
 * Exercises the full Commander action → detectEnvFabrication → JSON/human
 * output path. Does NOT duplicate the 18 unit tests in anti-shim.test.ts that
 * cover detectEnvFabrication internals directly.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let projectDir: string;

function runCheckAgentDiff(args: string[], cwd?: string) {
  return spawnSync(tsx, [entry, "check-agent-diff", ...args], {
    cwd: cwd ?? projectDir,
    encoding: "utf8",
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-cad-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ── dirty fixture ─────────────────────────────────────────────────────────────

test("integ check-agent-diff: dirty fixture → --json output is { clean: false } with forge_shim + dependency_surgery flags", () => {
  // git init so that git status --porcelain works inside detectEnvFabrication
  execSync("git init -q", { cwd: projectDir, stdio: "pipe" });

  // Stage package.json without committing — git status shows "A  package.json"
  // which the dependency_surgery checker flags (any XY except ?? or !!)
  writeFileSync(join(projectDir, "package.json"), '{"name":"test-fixture"}');
  execSync("git add package.json", { cwd: projectDir, stdio: "pipe" });

  // Plant a forge shim — triggers forge_shim
  mkdirSync(join(projectDir, "node_modules", "@forge", "fake"), { recursive: true });

  const result = runCheckAgentDiff(["--json", "--project", projectDir]);
  assert.equal(result.status, 1, `CLI must exit 1 for dirty scan: ${result.stderr}`);

  // JSON must parse cleanly
  let parsed: { clean: boolean; flags: Array<{ kind: string; path: string; detail: string }> };
  assert.doesNotThrow(() => {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  }, "output must be valid JSON");

  assert.equal(parsed!.clean, false, "clean must be false for a dirty fixture");
  assert.ok(Array.isArray(parsed!.flags), "flags must be an array");

  const kinds = new Set(parsed!.flags.map((f) => f.kind));
  assert.ok(kinds.has("forge_shim"), `expected forge_shim in ${JSON.stringify([...kinds])}`);
  assert.ok(kinds.has("dependency_surgery"), `expected dependency_surgery in ${JSON.stringify([...kinds])}`);

  // Each flag must carry all three required fields with string values
  for (const flag of parsed!.flags) {
    assert.equal(typeof flag.kind, "string", "flag.kind must be a string");
    assert.equal(typeof flag.path, "string", "flag.path must be a string");
    assert.equal(typeof flag.detail, "string", "flag.detail must be a string");
  }

  // The forge_shim flag path should reference the planted entry
  const shimFlag = parsed!.flags.find((f) => f.kind === "forge_shim");
  assert.ok(shimFlag!.path.includes("@forge"), `forge_shim path must reference @forge, got: ${shimFlag!.path}`);
});

// ── clean fixture ─────────────────────────────────────────────────────────────

test("integ check-agent-diff: clean fixture → --json output is { clean: true, flags: [] }", () => {
  // Empty tmpdir: no node_modules/@forge, no git repo → no flags from any detector
  const result = runCheckAgentDiff(["--json", "--project", projectDir]);
  assert.equal(result.status, 0, `CLI exited non-zero: ${result.stderr}`);

  let parsed: { clean: boolean; flags: unknown[] };
  assert.doesNotThrow(() => {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  }, "output must be valid JSON");

  assert.equal(parsed!.clean, true, "clean must be true for an empty project dir");
  assert.deepEqual(parsed!.flags, [], "flags must be empty for a clean fixture");
});

// ── --no-fail advisory mode ───────────────────────────────────────────────────

test("integ check-agent-diff: dirty fixture + --no-fail → exit 0 but flags still reported in JSON", () => {
  execSync("git init -q", { cwd: projectDir, stdio: "pipe" });
  writeFileSync(join(projectDir, "package.json"), '{"name":"test-fixture"}');
  execSync("git add package.json", { cwd: projectDir, stdio: "pipe" });
  mkdirSync(join(projectDir, "node_modules", "@forge", "fake"), { recursive: true });

  const result = runCheckAgentDiff(["--json", "--no-fail", "--project", projectDir]);
  assert.equal(result.status, 0, `--no-fail must force exit 0: ${result.stderr}`);

  let parsed: { clean: boolean; flags: Array<{ kind: string; path: string; detail: string }> };
  assert.doesNotThrow(() => {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  }, "output must be valid JSON even in advisory mode");

  assert.equal(parsed!.clean, false, "clean must still be false in advisory mode");
  assert.ok(parsed!.flags.length > 0, "flags must still be reported in advisory mode");
});

// ── --project scoping ─────────────────────────────────────────────────────────

test("integ check-agent-diff: --project <dir> scopes the scan to the named directory, not cwd", () => {
  // dirtyDir has a planted shim; projectDir (cwd) is clean
  const dirtyDir = mkdtempSync(join(tmpdir(), "forge-cad-dirty-"));
  try {
    mkdirSync(join(dirtyDir, "node_modules", "@forge", "planted"), { recursive: true });

    // Run FROM the clean projectDir but point --project at dirtyDir → dirty result
    const dirtyResult = runCheckAgentDiff(["--json", "--project", dirtyDir], projectDir);
    assert.equal(dirtyResult.status, 1, `CLI must exit 1 for dirty dir: ${dirtyResult.stderr}`);
    const dirtyParsed = JSON.parse(dirtyResult.stdout) as { clean: boolean; flags: Array<{ kind: string }> };
    assert.equal(dirtyParsed.clean, false, "--project must scope scan to dirtyDir, which has a shim");
    assert.ok(
      dirtyParsed.flags.some((f) => f.kind === "forge_shim"),
      "forge_shim flag expected when scanning dirtyDir",
    );

    // Run pointing --project at the clean projectDir → clean result
    const cleanResult = runCheckAgentDiff(["--json", "--project", projectDir], projectDir);
    assert.equal(cleanResult.status, 0, `CLI failed for clean dir: ${cleanResult.stderr}`);
    const cleanParsed = JSON.parse(cleanResult.stdout) as { clean: boolean; flags: unknown[] };
    assert.equal(cleanParsed.clean, true, "--project must scope scan to projectDir, which is clean");
    assert.deepEqual(cleanParsed.flags, []);
  } finally {
    rmSync(dirtyDir, { recursive: true, force: true });
  }
});
