// #299 regression guard (runs in `npm test`, unlike the docker smoke at
// scripts/forge-test-smoke.sh): the agent image must ship tsx, and forge-test
// must drive the `tsx` CLI — not `node --import tsx`, which can't resolve a global
// tsx. forge-site #12: agents hit "Cannot find package 'tsx'" and improvised with
// ad hoc globals, reintroducing the native-module mismatch forge-test prevents.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(join(root, "docker", "agent-dev-worker.Dockerfile"), "utf8");
const wrapper = readFileSync(join(root, "docker", "forge-test.sh"), "utf8");

test("#299: the agent image installs tsx globally with a build-time smoke", () => {
  assert.match(dockerfile, /npm install -g tsx/, "Dockerfile must install tsx globally");
  assert.match(dockerfile, /tsx --version/, "Dockerfile must smoke-check tsx at build time");
});

test("#299: forge-test drives the tsx CLI, not `node --import tsx` (unresolvable for a global tsx)", () => {
  assert.match(wrapper, /exec tsx --test/, "forge-test must exec the tsx CLI");
  assert.doesNotMatch(wrapper, /exec node --import tsx/, "must NOT exec `node --import tsx` — global tsx isn't on node's import path");
});

test("#299: forge-test loads forge's test-setup only when present (generic tsx projects too)", () => {
  assert.match(wrapper, /-f \.\/src\/test-setup\.ts/, "test-setup.ts load must be conditional on its existence");
});

test("#299: forge-test fails loud with a useful diagnostic when the runner is absent", () => {
  assert.match(wrapper, /command -v tsx/, "must guard on tsx availability");
  assert.match(wrapper, /Do NOT 'npm i -g tsx' ad hoc/, "diagnostic must steer away from ad hoc globals");
  assert.match(wrapper, /no test runner to invoke/, "must explain a project with no test script");
});
