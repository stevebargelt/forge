// FG-792 negative control: the fg543 fixture must keep docker/build.sh's
// transient certificate staging out of the checkout. This is a source guard on
// purpose: spawning the fixture would reintroduce the concurrent tree race it
// protects against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TARGET = join(REPO_ROOT, "src/v2/fg543-image-staleness-digest.integration.test.ts");

function integrationTests(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return integrationTests(path, root);
    return entry.isFile() && entry.name.endsWith(".integration.test.ts") ? [relative(root, path)] : [];
  });
}

test("FG-792: fg543 runs build.sh from a copied docker context, never repoRoot/docker", () => {
  const source = readFileSync(TARGET, "utf8");
  assert.match(source, /cpSync\(join\(repoRoot, "docker"\), dockerCopy, \{ recursive: true \}\)/);
  assert.doesNotMatch(source, /cwd:\s*join\(repoRoot, "docker"\)/);
  assert.doesNotMatch(source, /\[join\(repoRoot, "docker", "build\.sh"\)\]/);
});

test("FG-792: no integration test invokes docker/build.sh against repoRoot", () => {
  const roots = [join(REPO_ROOT, "src"), join(REPO_ROOT, "dashboard", "src")];
  const offenders = roots.flatMap((root) =>
    integrationTests(root).flatMap((file) => {
      const source = readFileSync(join(root, file), "utf8");
      const invokesBuild = /(?:execFileSync|execFile|spawnSync|spawn)\([\s\S]{0,300}?(?:join\(repoRoot, "docker", "build\.sh"\)|docker\/build\.sh)/.test(source);
      const repoDockerCwd = /cwd:\s*join\(repoRoot, "docker"\)/.test(source);
      return invokesBuild && repoDockerCwd ? [`${relative(REPO_ROOT, root)}/${file}`] : [];
    }),
  );
  assert.deepEqual(offenders, [], `integration tests must not run docker/build.sh in repoRoot/docker:\n${offenders.join("\n")}`);
});
