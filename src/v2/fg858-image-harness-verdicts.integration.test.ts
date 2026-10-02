// FG-858 behavioural guards for the image harnesses' verdicts. Each harness runs for real
// against a stub `docker` on PATH that replays a canned TAP log, so the pass/fail decision is
// exercised end to end without a Docker daemon.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "fg858-harness-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const STUB_DOCKER = `#!/usr/bin/env bash
case "$1" in
  run) echo stub-cid ;;
  image) echo sha256:stub ;;
  build) cat >/dev/null ;;
  exec)
    if [[ " $* " == *" node "* ]]; then cat "$FAKE_TAP"; exit "$FAKE_RC"; fi
    if [[ " $* " == *" -i "* ]]; then cat >/dev/null; fi
    ;;
esac
exit 0
`;

function harnessTree(script: string): string {
  const repo = mkdtempSync(join(scratch, "repo-"));
  const docker = join(repo, "docker");
  mkdirSync(docker);
  copyFileSync(join(root, "docker", script), join(docker, script));
  writeFileSync(join(docker, "build.sh"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(docker, "build.sh"), 0o755);
  writeFileSync(join(docker, "fg857-native-prebuild-check.sh"), "exit 0\n");
  const bin = join(repo, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), STUB_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  return repo;
}

function runHarness(script: string, mode: string, tap: string, rc = 0) {
  const repo = harnessTree(script);
  const tapFile = join(repo, "fake.tap");
  writeFileSync(tapFile, tap);
  const res = spawnSync("bash", [join(repo, "docker", script), mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(repo, "bin")}:${process.env.PATH}`,
      FAKE_TAP: tapFile,
      FAKE_RC: String(rc),
      FG857_SKIP_BUILD: "1",
    },
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function totals(t: Partial<Record<"tests" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>>): string {
  return Object.entries(t)
    .map(([k, v]) => `# ${k} ${v}\n`)
    .join("");
}

function okLines(from: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `ok ${from + i} - green ${from + i}\n  ---\n  duration_ms: 1\n  ...\n`).join("");
}

function tmuxFailures(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `not ok ${i + 1} - tmux test ${i + 1}\n  ---\n  error: 'these tests require tmux — install it'\n  ...\n`
  ).join("");
}

const unattributedFailure = "not ok 15 - unrelated breakage\n  ---\n  error: 'ECONNREFUSED'\n  ...\n";

test("FG-858 RF-1: the pre-fix falsification passes with exactly the 14 tmux-attributed failures and nothing else", () => {
  const tap = `TAP version 13\n${tmuxFailures(14)}${okLines(15, 3)}1..17\n${totals({ tests: 17, pass: 3, fail: 14, cancelled: 0, skipped: 0, todo: 0 })}`;
  const r = runHarness("verify-launch-tier-in-image.sh", "--pre-fix", tap, 1);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS \(pre-fix falsification\)/);
});

test("FG-858 RF-1: an unattributed failure beside the 14 tmux failures FAILS the pre-fix falsification", () => {
  const tap = `TAP version 13\n${tmuxFailures(14)}${unattributedFailure}${okLines(16, 2)}1..17\n${totals({ tests: 17, pass: 2, fail: 15, cancelled: 0, skipped: 0, todo: 0 })}`;
  const r = runHarness("verify-launch-tier-in-image.sh", "--pre-fix", tap, 1);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAILED FALSIFICATION: 15 failing test\(s\), only 14 attributed to the missing tmux/);
  assert.match(r.out, /not ok 15 - unrelated breakage/);
  assert.doesNotMatch(r.out, /PASS \(pre-fix falsification\)/);
});

const cleanLaunchTap = `TAP version 13\n${okLines(1, 4)}1..4\n`;
const postFixHarnesses = [
  ["launch tier", "verify-launch-tier-in-image.sh"],
  ["native prebuild", "verify-native-prebuild-in-image.sh"],
] as const;

for (const [name, script] of postFixHarnesses) {
  test(`FG-858 RF-2: the ${name} post-fix arm passes when all six TAP totals parse clean`, () => {
    const r = runHarness(script, "--post-fix", cleanLaunchTap + totals({ tests: 4, pass: 4, fail: 0, cancelled: 0, skipped: 0, todo: 0 }));
    assert.match(r.out, /PASS \(post-fix\)/, r.out);
    assert.match(r.out, /^post-fix .*: PASS$/m, r.out);
  });

  for (const missing of ["pass", "todo", "cancelled"] as const) {
    test(`FG-858 RF-2: the ${name} post-fix arm FAILS when the '# ${missing}' TAP total is absent`, () => {
      const all = { tests: 4, pass: 4, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
      delete (all as Partial<typeof all>)[missing];
      const r = runHarness(script, "--post-fix", cleanLaunchTap + totals(all));
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /no parseable TAP totals/);
      assert.match(r.out, /^post-fix .*: FAIL$/m);
      assert.doesNotMatch(r.out, /PASS \(post-fix\)/);
    });
  }

  test(`FG-858 RF-2: the ${name} post-fix arm FAILS on a non-zero cancelled total`, () => {
    const r = runHarness(script, "--post-fix", cleanLaunchTap + totals({ tests: 4, pass: 3, fail: 0, cancelled: 1, skipped: 0, todo: 0 }));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /not clean/);
    assert.match(r.out, /^post-fix .*: FAIL$/m);
  });
}
