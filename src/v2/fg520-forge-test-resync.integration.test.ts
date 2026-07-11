// FG-520 regression guard: docker/forge-test.sh must re-sync /project into its
// scratch dir on EVERY invocation and repair a scratch whose node_modules is
// missing or empty. The old copy-once guard meant an agent that edited source and
// re-ran forge-test was graded against the first snapshot (silent false green), and
// a scratch that inherited an empty node_modules failed every test with
// ERR_MODULE_NOT_FOUND: 'tsx' — an environment fault reported as red tests.
//
// The script is driven for real: FORGE_SRC_DIR/FORGE_WORK_DIR point at temp dirs
// and a stub `npm` on PATH stands in for the (minute-long) install, so the sync and
// repair logic under test is the live code, not a copy of it. Integration tier: it
// shells bash and touches the real filesystem.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "docker", "forge-test.sh");

interface Fixture {
  src: string;
  work: string;
  npmLog: string;
  base: string;
}

// A stub npm: logs every invocation, and materialises a loadable `tsx` on install
// so the script's `node --import tsx` probe passes the way a real install would.
const STUB_NPM = `#!/usr/bin/env bash
echo "npm $*" >> "$NPM_LOG"
if [[ "\$1" == "ci" || "\$1" == "install" ]]; then
  mkdir -p node_modules/tsx
  printf '%s' '{"name":"tsx","version":"0.0.0","type":"module","exports":"./index.js"}' > node_modules/tsx/package.json
  : > node_modules/tsx/index.js
fi
exit 0
`;

function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "fg520-"));
  const src = join(base, "project");
  const bin = join(base, "bin");
  mkdirSync(join(src, "src"), { recursive: true });
  mkdirSync(bin);

  writeFileSync(
    join(src, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { "test:unit": "echo ran" },
      devDependencies: { tsx: "*" },
    })
  );
  writeFileSync(join(src, "package-lock.json"), "{}");
  writeFileSync(join(src, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(src, "src", "doomed.ts"), "export const doomed = true;\n");

  writeFileSync(join(bin, "npm"), STUB_NPM);
  chmodSync(join(bin, "npm"), 0o755);

  return { src, work: join(base, "scratch"), npmLog: join(base, "npm.log"), base };
}

function runForgeTest(f: Fixture, args: string[] = []) {
  const binDir = join(f.base, "bin");
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FORGE_SRC_DIR: f.src,
      FORGE_WORK_DIR: f.work,
      NPM_LOG: f.npmLog,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function npmCalls(f: Fixture): string[] {
  if (!existsSync(f.npmLog)) return [];
  return readFileSync(f.npmLog, "utf8").trim().split("\n").filter(Boolean);
}

test("FG-520: forge-test re-syncs source and repairs a broken scratch on every run", async (t) => {
  const f = makeFixture();
  try {
    await t.test("cold run installs deps and runs the tier", () => {
      const r = runForgeTest(f);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
      assert.ok(
        npmCalls(f).some((c) => c.startsWith("npm ci")),
        "an absent node_modules must trigger an install"
      );
      assert.ok(
        npmCalls(f).includes("npm run test:unit"),
        "the tier UX must be unchanged — no args still runs test:unit"
      );
      assert.equal(readFileSync(join(f.work, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    });

    await t.test("an edited source file is what the NEXT run tests", () => {
      writeFileSync(join(f.src, "src", "a.ts"), "export const a = 2; // edited\n");
      const r = runForgeTest(f);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        readFileSync(join(f.work, "src", "a.ts"), "utf8"),
        "export const a = 2; // edited\n",
        "the scratch must hold the EDITED source — this is the false-green the ticket is about"
      );
    });

    await t.test("a deleted source file disappears from the scratch", () => {
      rmSync(join(f.src, "src", "doomed.ts"));
      const r = runForgeTest(f);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        existsSync(join(f.work, "src", "doomed.ts")),
        false,
        "deletions must propagate, or a deleted test keeps running"
      );
    });

    await t.test("an unchanged tree re-syncs without touching node_modules", () => {
      const sentinel = join(f.work, "node_modules", "sentinel");
      writeFileSync(sentinel, "native-build-artifact");
      const before = statSync(sentinel).mtimeMs;
      const callsBefore = npmCalls(f).length;

      const started = Date.now();
      const r = runForgeTest(f);
      const elapsed = Date.now() - started;

      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        readFileSync(sentinel, "utf8"),
        "native-build-artifact",
        "the scratch's node_modules must survive the sync — it holds the native rebuild"
      );
      assert.equal(statSync(sentinel).mtimeMs, before, "node_modules must not be rewritten");
      assert.equal(
        npmCalls(f).filter((c) => c.startsWith("npm ci")).length,
        npmCalls(f).slice(0, callsBefore).filter((c) => c.startsWith("npm ci")).length,
        "a healthy scratch must not be reinstalled"
      );
      assert.ok(elapsed < 10_000, `no-change re-sync should be fast, took ${elapsed}ms`);
      assert.match(r.stderr, /re-synced source/, "the sync must say what it did");
    });

    await t.test("an empty node_modules is repaired, not run against", () => {
      // The live failure: /project's node_modules is an empty container volume, the
      // scratch inherits the emptiness, and every test dies ERR_MODULE_NOT_FOUND.
      rmSync(join(f.work, "node_modules"), { recursive: true, force: true });
      mkdirSync(join(f.work, "node_modules"));
      const callsBefore = npmCalls(f).length;

      const r = runForgeTest(f);
      assert.equal(r.status, 0, r.stderr);
      const fresh = npmCalls(f).slice(callsBefore);
      assert.ok(
        fresh.some((c) => c.startsWith("npm ci")),
        "an empty node_modules must trigger a reinstall"
      );
      assert.match(r.stderr, /missing or empty/, "the repair must say WHY it is installing");
      assert.ok(existsSync(join(f.work, "node_modules", "tsx")), "tsx must be back");
    });

    await t.test("a dependency change in source forces a reinstall", () => {
      writeFileSync(
        join(f.src, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: { "test:unit": "echo ran" },
          devDependencies: { tsx: "*", zod: "^3" },
        })
      );
      const callsBefore = npmCalls(f).length;
      const r = runForgeTest(f);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        npmCalls(f).slice(callsBefore).some((c) => c.startsWith("npm ci")),
        "a package.json change must invalidate the scratch's node_modules"
      );
      assert.match(r.stderr, /package\.json\/package-lock\.json changed/, "must say why");
    });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("FG-520: a scratch that cannot load tsx fails as an ENVIRONMENT error, not red tests", () => {
  const f = makeFixture();
  try {
    // An npm that installs nothing: the repair runs, the probe still fails, and the
    // script must say so loudly rather than handing the runner a broken scratch.
    writeFileSync(join(f.base, "bin", "npm"), `#!/usr/bin/env bash\necho "npm $*" >> "$NPM_LOG"\nexit 0\n`);
    chmodSync(join(f.base, "bin", "npm"), 0o755);

    const r = runForgeTest(f);
    assert.equal(r.status, 2, "an unrepairable scratch must exit 2, not run the tests");
    assert.match(r.stderr, /ENVIRONMENT failure, not a test failure/);
    assert.ok(
      !npmCalls(f).includes("npm run test:unit"),
      "the tier must never run against a scratch that cannot load its runner"
    );
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
