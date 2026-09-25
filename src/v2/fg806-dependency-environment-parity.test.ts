// FG-806: the pipeline (runNext) and invoke task packages tell the agent about its
// dependency environment from ONE renderer, gated on the same input — a resolved
// DependencyEnvironmentReceipt — so the two lanes agree byte-for-byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTaskPackage } from "./runNext.js";
import { renderInvokeTaskPackage } from "./invoke.js";
import { renderDependencyEnvironmentSection, type DependencyEnvironmentReceipt } from "./dependency-provisioning.js";
import type { TaskPackage } from "../types/index.js";

const receipt: DependencyEnvironmentReceipt = {
  cacheKey: "d8c84b595c672274",
  probeImage: "test-image:latest",
  nodeVersion: "v24.21.0",
  abi: "137",
  packages: [{ name: "better-sqlite3", version: "11.0.0", loaded: true }],
};

const tp: TaskPackage = {
  taskId: "task-fg806",
  runId: "run-fg806",
  phase: "build",
  role: "engineer",
  inputs: {},
  composedSystemPrompt: "",
};

function section(pkg: string): string | undefined {
  const start = pkg.indexOf("## Dependency environment");
  if (start < 0) return undefined;
  return pkg.slice(start, pkg.indexOf("## Output contract", start));
}

test("fg806: runNext's package emits ## Dependency environment when a receipt resolved", () => {
  const pkg = renderTaskPackage(tp, receipt);
  const s = section(pkg);
  assert.ok(s, "a resolved receipt must put the section in the pipeline package");
  assert.match(s, /cacheKey d8c84b595c672274, node v24\.21\.0, ABI 137/);
  assert.match(s, /Do not run `npm ci` \/ `npm install`/);
  assert.ok(pkg.indexOf("## Dependency environment") < pkg.indexOf("## Output contract"));
});

test("fg806: runNext's package omits ## Dependency environment when no receipt resolved", () => {
  const pkg = renderTaskPackage(tp);
  assert.doesNotMatch(pkg, /## Dependency environment/);
  assert.doesNotMatch(pkg, /npm install/);
});

test("fg806: invoke and runNext render the identical section from the shared renderer", () => {
  const fromRunNext = section(renderTaskPackage(tp, receipt));
  const fromInvoke = section(renderInvokeTaskPackage(tp, "do the thing", receipt));
  assert.ok(fromRunNext && fromInvoke);
  assert.equal(fromRunNext, fromInvoke);
  assert.equal(fromRunNext, renderDependencyEnvironmentSection(receipt).join("\n") + "\n");

  assert.equal(section(renderTaskPackage(tp)), undefined);
  assert.equal(section(renderInvokeTaskPackage(tp, "do the thing")), undefined);
});
