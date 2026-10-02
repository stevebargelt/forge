// FG-857 regression guard (unit tier): the agent image's base must carry glibc
// >= 2.38, or better-sqlite3@13's linux prebuild fails to load in every agent
// container. Docker builds cannot run here, so this pins the image spec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(join(root, "docker", "agent-dev-worker.Dockerfile"), "utf8");
const check = readFileSync(join(root, "docker", "fg857-native-prebuild-check.sh"), "utf8");
const harness = readFileSync(join(root, "docker", "verify-native-prebuild-in-image.sh"), "utf8");

function instructions(source: string): string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function fg857DockerfileFailures(source: string): string[] {
  const failures: string[] = [];
  const parsed = instructions(source);
  const froms = parsed.filter((line) => /^FROM\s/i.test(line));
  if (froms.length === 0) failures.push("missing FROM instruction");
  for (const from of froms) {
    const match = /^FROM\s+ubuntu:(\d+)\.(\d+)\b/i.exec(from);
    if (!match) failures.push("unknown Ubuntu base: " + from);
    else if (Number(match[1]) < 24) failures.push("glibc floor not met: " + from);
  }

  const agentLayer = parsed.find((line) => /\buseradd\b[^&]*-u 1000 agent\b/.test(line));
  if (!agentLayer) {
    failures.push("missing agent uid 1000 layer");
    return failures;
  }
  const userdel = agentLayer.search(/\buserdel -r ubuntu\b/);
  if (userdel < 0) failures.push("ubuntu uid 1000 owner is not removed");
  else if (userdel >= agentLayer.search(/\buseradd\b/)) failures.push("ubuntu is removed after agent creation");
  if (!/test "\$\(id -u agent\):\$\(id -g agent\)" = "1000:1000"/.test(agentLayer)) {
    failures.push("agent 1000:1000 is not asserted");
  }
  return failures;
}

test("FG-857: every FROM is ubuntu 24.04 or newer (glibc >= 2.38)", () => {
  const froms = instructions(dockerfile).filter((line) => /^FROM\s/i.test(line));
  assert.ok(froms.length > 0, "the Dockerfile must have a FROM instruction");
  for (const from of froms) {
    const match = /^FROM\s+ubuntu:(\d+)\.(\d+)\b/i.exec(from);
    assert.ok(match, "FG-857 requires a known Ubuntu base; got " + from);
    assert.ok(Number(match[1]) >= 24, from + ": Ubuntu < 24.04 ships glibc < 2.38");
  }
});

test("FG-857: ubuntu is removed before agent takes uid 1000 and the build asserts 1000:1000", () => {
  const agentLayer = instructions(dockerfile).find((line) => /\buseradd\b[^&]*-u 1000 agent\b/.test(line));
  assert.ok(agentLayer, "a RUN layer must useradd agent at uid 1000 (DEC-009)");
  const userdel = agentLayer.search(/\buserdel -r ubuntu\b/);
  assert.ok(userdel >= 0, "the agent-user layer must remove ubuntu's uid 1000 owner");
  assert.ok(userdel < agentLayer.search(/\buseradd\b/), "ubuntu must be removed before agent is created");
  assert.match(agentLayer, /test "\$\(id -u agent\):\$\(id -g agent\)" = "1000:1000"/);
});

test("FG-857: the old ubuntu:22.04 Dockerfile shape fails every new image guard", () => {
  // This is the pre-FG-857 layer applied to the current Dockerfile text: it has
  // the old base and neither the ubuntu removal nor the uid/gid build assertion.
  const oldDockerfile = dockerfile
    .replace("FROM ubuntu:24.04", "FROM ubuntu:22.04")
    .replace(/RUN if id -u ubuntu >\/dev\/null 2>&1; then userdel -r ubuntu; fi \\\n    && /, "RUN ")
    .replace(/    && test "\$\(id -u agent\):\$\(id -g agent\)" = "1000:1000" \\\n/, "\n");
  const failures = fg857DockerfileFailures(oldDockerfile);

  assert.ok(failures.includes("glibc floor not met: FROM ubuntu:22.04"), failures.join("\n"));
  assert.ok(failures.includes("ubuntu uid 1000 owner is not removed"), failures.join("\n"));
  assert.ok(failures.includes("agent 1000:1000 is not asserted"), failures.join("\n"));
});

test("FG-857: the system-scope /project safe.directory (FG-856) survives the rebase", () => {
  assert.ok(instructions(dockerfile).includes("RUN git config --system --add safe.directory /project"));
});

test("FG-857: the in-image check asserts the 2.38 floor and refuses a source-build fallback", () => {
  assert.match(check, /^GLIBC_FLOOR=2\.38$/m);
  assert.match(check, /^BETTER_SQLITE3_VERSION=13\.0\.1$/m);
  assert.match(check, /npm install --ignore-scripts\b/);
  assert.match(check, /\/prebuilds\/linux-/);
});

test("FG-857: the falsification runs on ubuntu:22.04 and requires both named glibc failures", () => {
  assert.match(harness, /^FROM ubuntu:22\.04$/m);
  assert.match(harness, /\^FG857 FAIL glibc-floor:/);
  assert.match(harness, /\^FG857 FAIL require-glibc:\.\*GLIBC_2\.38/);
});
