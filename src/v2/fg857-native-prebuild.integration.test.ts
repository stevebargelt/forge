// FG-857 integration coverage for the image-only native-prebuild harness. These
// cases execute its real bash script with a stubbed command PATH; Docker and the
// npm registry are deliberately not required here. The host image tier executes
// the actual container/registry check.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const check = resolve(here, "..", "..", "docker", "fg857-native-prebuild-check.sh");
const dirs: string[] = [];

after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stub(bin: string, name: string, source: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${source}\n`);
  chmodSync(path, 0o755);
}

function runCheck(glibc: string, nodeResult: "pass" | "glibc-failure") {
  const bin = mkdtempSync(join(tmpdir(), "forge-fg857-bin-"));
  dirs.push(bin);
  const work = mkdtempSync(join(tmpdir(), "forge-fg857-work-"));
  dirs.push(work);
  stub(bin, "ldd", "echo 'ldd (GNU libc) stub'");
  stub(bin, "getconf", `echo 'glibc ${glibc}'`);
  stub(bin, "npm", "exit 0");
  stub(bin, "id", "exit 0");
  stub(bin, "getent", "exit 0");
  stub(bin, "sudo", "exit 0");
  stub(bin, "node", nodeResult === "pass"
    ? "echo 'better-sqlite3 loaded shipped prebuild'; exit 0"
    : "echo \"Error: /lib/aarch64-linux-gnu/libm.so.6: version 'GLIBC_2.38' not found\" >&2; exit 1");

  return spawnSync("bash", [check, "--native-only"], {
    cwd: work,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
}

test("FG-857: version_ge accepts 2.39 and 2.40 at the 2.38 floor", () => {
  for (const glibc of ["2.39", "2.40"]) {
    const result = runCheck(glibc, "pass");
    assert.equal(result.status, 0, `${glibc}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, new RegExp(`FG857 ok glibc-floor: glibc ${glibc} >= 2\\.38`));
  }
});

test("FG-857: version_ge rejects 2.35 and 2.4 below 2.38", () => {
  for (const glibc of ["2.35", "2.4"]) {
    const result = runCheck(glibc, "pass");
    assert.notEqual(result.status, 0, `${glibc} must fail the floor`);
    assert.match(result.stdout, new RegExp(`FG857 FAIL glibc-floor: glibc ${glibc} is below 2\\.38`));
  }
  // GNU sort -V compares dot-separated numeric components: 2.4 sorts before
  // 2.38, rather than treating 2.4 as decimal 2.40.
});

test("FG-857: --native-only names both glibc failures on an old-image-shaped run", () => {
  const result = runCheck("2.35", "glibc-failure");
  assert.notEqual(result.status, 0, "the failed prebuild must fail the harness");
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /^FG857 FAIL glibc-floor:/m);
  assert.match(output, /^FG857 FAIL require-glibc:.*GLIBC_2\.38/m);
});

test("FG-857: --native-only passes when the floor and shipped prebuild both pass", () => {
  const result = runCheck("2.39", "pass");
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^FG857 ok glibc-floor:/m);
  assert.match(result.stdout, /^FG857 ok require:/m);
});
