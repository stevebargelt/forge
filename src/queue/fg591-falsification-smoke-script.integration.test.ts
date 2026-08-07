// FG-591 D15 guard: the host-only falsification must fail closed, never turn a
// missing live prerequisite into a CI-green skip. The green proof itself is
// intentionally operator-run by scripts/fg591-falsification-smoke.sh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "fg591-falsification-smoke.sh");
const RUNNER = join(ROOT, "src", "queue", "fg591-falsification-smoke-runner.ts");
const SOURCE = readFileSync(SCRIPT, "utf8");
const BASH = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";

function run(args: string[], env: NodeJS.ProcessEnv): { status: number | null; all: string } {
  const r = spawnSync(BASH, [SCRIPT, ...args], { encoding: "utf8", env, timeout: 30_000 });
  return { status: r.status, all: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("FG-591 smoke script is executable, syntactically valid, and outside test discovery", () => {
  assert.ok(statSync(SCRIPT).mode & 0o100, "operator entry point must be executable");
  assert.equal(spawnSync(BASH, ["-n", SCRIPT], { encoding: "utf8" }).status, 0);
  assert.match(SOURCE, /outside every npm tier and outside CI/i);
  assert.match(SOURCE, /validateCredsForNewRun/);
  assert.match(SOURCE, /fg591-falsification-smoke-runner\.ts/);
  assert.ok(!readFileSync(join(ROOT, "package.json"), "utf8").includes("fg591-falsification-smoke"));
  assert.ok(!readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8").includes("fg591-falsification-smoke"));
  assert.ok(!RUNNER.endsWith(".integration.test.ts"), "the live runner must not be selected by the CI integration tier");
});

test("FG-591 smoke exits nonzero when node is absent", () => {
  const r = run([], { PATH: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.all, /no 'node' on PATH/);
  assert.match(r.all, /fails closed/);
});

test("FG-591 smoke exits nonzero when tmux is absent", () => {
  const bin = mkdtempSync(join(tmpdir(), "fg591-no-tmux-"));
  try {
    // Shadow the real tmux with a failing executable while retaining the real
    // node and git the prior prerequisites require.
    const tmux = join(bin, "tmux");
    writeFileSync(tmux, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(tmux, 0o755);
    const r = run([], { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` });
    assert.notEqual(r.status, 0);
    assert.match(r.all, /tmux is not usable/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("FG-591 smoke exits nonzero for an unusable project directory", () => {
  const r = run(["--project-dir", "/definitely/not/a/forge/project"], process.env);
  assert.notEqual(r.status, 0);
  assert.match(r.all, /does not exist/);
});

test("FG-591 smoke adjudicator can go RED: the live runner retains each D15 failure assertion", () => {
  // These are structural canned inputs to the runner's assertions: a process
  // that never starts, a run row where one must be absent, and a command-not-
  // found exit must each be read as failure, never as a quiet refusal/pass.
  const runner = readFileSync(RUNNER, "utf8");
  assert.match(runner, /NEVER STARTED/);
  assert.match(runner, /run row/);
  assert.match(runner, /assert\.notEqual\(stranger\.status, 0/);
  assert.match(runner, /assertNeverLaunchedTwice/);
  assert.match(runner, /childProcessEvidence\(\)/);
  assert.match(runner, /launchEvidence\(\)/);
  assert.match(runner, /out\.log/);
});

test("FG-591 smoke has exactly one final success exit and no skip path", () => {
  const lines = SOURCE.split("\n");
  const zeros = lines.filter((line) => line.trim() === "exit 0");
  assert.equal(zeros.length, 1);
  assert.equal(lines.map((line) => line.trim()).filter(Boolean).at(-1), "exit 0");
  assert.doesNotMatch(SOURCE, /skip-to-green|\bskip\b.*exit 0/i);
});
