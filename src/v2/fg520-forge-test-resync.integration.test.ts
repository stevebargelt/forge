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
  utimesSync,
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

// A stub npm: logs every invocation, materialises a loadable `tsx` on install so the
// script's `node --import tsx` probe passes the way a real install would, and — for
// `npm run <script>` — actually EXECUTES the fixture's script from the scratch cwd.
// That last part is what makes "the rerun tests the edited source" an observable fact:
// the fixture's tier command reads src/a.ts out of the scratch and prints it, so a
// stale mirror shows up as stale stdout rather than only as a file the test re-reads.
const STUB_NPM = `#!/usr/bin/env bash
echo "npm $*" >> "$NPM_LOG"
if [[ "$1" == "ci" || "$1" == "install" ]]; then
  mkdir -p node_modules/tsx
  printf '%s' '{"name":"tsx","version":"0.0.0","type":"module","exports":"./index.js"}' > node_modules/tsx/package.json
  : > node_modules/tsx/index.js
  exit 0
fi
if [[ "$1" == "run" ]]; then
  cmd=$(node -e 'const p = JSON.parse(require("fs").readFileSync("package.json", "utf8")); process.stdout.write((p.scripts || {})[process.argv[1]] || "")' "$2")
  [[ -n "$cmd" ]] || exit 1
  exec bash -c "$cmd"
fi
exit 0
`;

// The fixture's tier command. Executed by the stub npm from inside the scratch, it
// reports the source it actually ran against — and it must be executable to run at
// all, which is what makes a mode-only edit observable end to end.
const RUN_TESTS_SH = `#!/usr/bin/env bash
echo "RAN-AGAINST: $(cat src/a.ts)"
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
      scripts: { "test:unit": "./src/run-tests.sh" },
      devDependencies: { tsx: "*" },
    })
  );
  writeFileSync(join(src, "package-lock.json"), "{}");
  writeFileSync(join(src, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(src, "src", "doomed.ts"), "export const doomed = true;\n");
  writeFileSync(join(src, "src", "run-tests.sh"), RUN_TESTS_SH);
  chmodSync(join(src, "src", "run-tests.sh"), 0o755);

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
      assert.match(r.stdout, /RAN-AGAINST: export const a = 1;/, "the tier must actually execute");
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
      // The end-to-end half: the tier command RAN and saw the edit. A copied file the
      // test re-reads itself proves the mirror; this proves the runner.
      assert.match(
        r.stdout,
        /RAN-AGAINST: export const a = 2; \/\/ edited/,
        "the executed tier must observe the edited source, not the first snapshot"
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

test("FG-520: the mirror handles the tree-shape edits an agent actually makes", async (t) => {
  const f = makeFixture();
  try {
    runForgeTest(f); // cold: populate the scratch

    await t.test("a same-size content edit still propagates", () => {
      // The mirror's skip predicate is content equality. Size alone is not a safe
      // signal — a one-character fix ("=== 1" -> "=== 2", a flipped boolean) keeps
      // the byte count identical. If anyone ever relaxes the predicate to size-only,
      // this is the false green FG-520 exists to kill.
      const a = join(f.src, "src", "a.ts");
      const before = statSync(a).size;
      writeFileSync(a, "export const a = 9;\n");
      assert.equal(statSync(a).size, before, "fixture must actually hold size constant");

      const r = runForgeTest(f);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        readFileSync(join(f.work, "src", "a.ts"), "utf8"),
        "export const a = 9;\n",
        "a same-size edit must reach the scratch — size is not a content check"
      );
    });

    await t.test("a same-size edit that PRESERVES mtime still propagates", () => {
      // The stat-only trap: a bind-mounted /project can hand back coarse or
      // host-clock mtimes, so an edit can carry the same size AND the same mtime the
      // scratch already recorded. Under a (size && mtime) predicate the mirror skips
      // it and the agent is graded against stale source. Content is the only signal
      // that survives an unreliable clock.
      const a = join(f.src, "src", "a.ts");
      const s = statSync(a);
      writeFileSync(a, "export const a = 7;\n");
      utimesSync(a, s.atime, s.mtime);

      const after = statSync(a);
      assert.equal(after.size, s.size, "fixture must hold size constant");
      assert.equal(
        after.mtimeMs,
        statSync(join(f.work, "src", "a.ts")).mtimeMs,
        "the edited source must carry the mtime the scratch copy already has — otherwise this proves nothing"
      );

      const r = runForgeTest(f);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        readFileSync(join(f.work, "src", "a.ts"), "utf8"),
        "export const a = 7;\n",
        "same size + same mtime + different bytes must still reach the scratch"
      );
    });

    await t.test("a new file in a NEW directory is created, parent dirs and all", () => {
      mkdirSync(join(f.src, "src", "deep", "nested"), { recursive: true });
      writeFileSync(join(f.src, "src", "deep", "nested", "new.ts"), "export const n = 1;\n");

      const r = runForgeTest(f);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        readFileSync(join(f.work, "src", "deep", "nested", "new.ts"), "utf8"),
        "export const n = 1;\n",
        "a brand-new test file in a brand-new dir must be runnable on the next invocation"
      );
    });

    await t.test("deleting a whole directory removes it from the scratch", () => {
      rmSync(join(f.src, "src", "deep"), { recursive: true });

      const r = runForgeTest(f);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        existsSync(join(f.work, "src", "deep")),
        false,
        "a deleted directory must not survive — its tests would keep running forever"
      );
      assert.equal(
        existsSync(join(f.work, "src", "a.ts")),
        true,
        "the delete pass must take the dead directory and nothing else"
      );
    });

    await t.test("a chmod-only change propagates — same bytes, different mode", () => {
      // The other half of a stale scratch: an agent flips a helper/test script's
      // executable bit and re-runs. The bytes are identical, so a content-only skip
      // predicate leaves the OLD mode in the scratch and the rerun is graded against a
      // materially different runnable input than the one in source.
      const helper = join(f.src, "src", "run-tests.sh");
      const scratchHelper = join(f.work, "src", "run-tests.sh");
      const bytes = readFileSync(helper);

      chmodSync(helper, 0o644);
      const deExecuted = runForgeTest(f);
      assert.deepEqual(readFileSync(helper), bytes, "the fixture must change ONLY the mode");
      assert.equal(
        statSync(scratchHelper).mode & 0o777,
        0o644,
        "a mode change must reach the scratch even when the content matches"
      );
      assert.notEqual(
        deExecuted.status,
        0,
        "a de-executed runner must actually fail the run — a stale executable copy would pass"
      );

      chmodSync(helper, 0o755);
      const restored = runForgeTest(f);
      assert.equal(statSync(scratchHelper).mode & 0o777, 0o755, "and the mode must come back");
      assert.equal(restored.status, 0, restored.stderr);
      assert.match(restored.stdout, /RAN-AGAINST:/, "the re-executable runner must run again");
    });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// The script runs under `set -e`: a bare `npm ci` that fails would terminate it right
// there with npm's exit code, so the FATAL line and the documented exit 2 never happen
// and a broken environment reaches the caller looking like an ordinary test failure.
test("FG-520: npm failing on the repair path is a FATAL/exit-2 ENVIRONMENT error", async (t) => {
  function stubNpm(f: Fixture, body: string) {
    writeFileSync(join(f.base, "bin", "npm"), `#!/usr/bin/env bash\necho "npm $*" >> "$NPM_LOG"\n${body}\n`);
    chmodSync(join(f.base, "bin", "npm"), 0o755);
  }

  await t.test("a failing `npm ci` exits 2 with FATAL, not npm's raw code", () => {
    const f = makeFixture();
    try {
      stubNpm(f, `if [[ "$1" == "ci" ]]; then echo "npm ERR! network unreachable" >&2; exit 254; fi\nexit 0`);

      const r = runForgeTest(f);
      assert.equal(r.status, 2, `a failed install must exit 2, got ${r.status}`);
      assert.match(r.stderr, /FATAL: `npm ci` failed with exit 254/);
      assert.match(r.stderr, /ENVIRONMENT failure, not a test failure/);
      assert.match(r.stderr, /npm ERR! network unreachable/, "npm's own stderr must survive");
      assert.ok(
        !npmCalls(f).includes("npm run test:unit"),
        "the tier must never run against a scratch whose install failed"
      );
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  await t.test("a failing `npm install` (no lockfile) exits 2 with FATAL", () => {
    const f = makeFixture();
    try {
      rmSync(join(f.src, "package-lock.json"));
      stubNpm(f, `if [[ "$1" == "install" ]]; then echo "npm ERR! EACCES" >&2; exit 1; fi\nexit 0`);

      const r = runForgeTest(f);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /FATAL: `npm install` failed with exit 1/);
      assert.match(r.stderr, /ENVIRONMENT failure, not a test failure/);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  await t.test("a failing `npm rebuild esbuild` exits 2 with FATAL", () => {
    const f = makeFixture();
    try {
      // Install "succeeds" but materialises no tsx, so the script reaches the esbuild
      // rebuild — which is where the compile blows up.
      stubNpm(f, `if [[ "$1" == "rebuild" ]]; then echo "npm ERR! esbuild postinstall failed" >&2; exit 7; fi\nexit 0`);

      const r = runForgeTest(f);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /FATAL: `npm rebuild esbuild` failed with exit 7/);
      assert.match(r.stderr, /ENVIRONMENT failure, not a test failure/);
      assert.match(r.stderr, /npm ERR! esbuild postinstall failed/);
      assert.ok(!npmCalls(f).includes("npm run test:unit"));
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  await t.test("a failing `npm rebuild better-sqlite3` exits 2 with FATAL", () => {
    const f = makeFixture();
    try {
      writeFileSync(
        join(f.src, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: { "test:unit": "echo ran" },
          devDependencies: { tsx: "*", "better-sqlite3": "*" },
        })
      );
      // ci installs a loadable tsx (so the run gets past the tsx probe) but no
      // better-sqlite3 — the native rebuild that would fix that is what fails.
      stubNpm(
        f,
        `if [[ "$1" == "ci" ]]; then
  mkdir -p node_modules/tsx
  printf '%s' '{"name":"tsx","version":"0.0.0","type":"module","exports":"./index.js"}' > node_modules/tsx/package.json
  : > node_modules/tsx/index.js
  exit 0
fi
if [[ "$1" == "rebuild" ]]; then echo "npm ERR! gyp ERR! build error" >&2; exit 1; fi
exit 0`
      );

      const r = runForgeTest(f);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /FATAL: `npm rebuild better-sqlite3 --build-from-source` failed with exit 1/);
      assert.match(r.stderr, /ENVIRONMENT failure, not a test failure/);
      assert.match(r.stderr, /gyp ERR! build error/);
      assert.ok(!npmCalls(f).includes("npm run test:unit"));
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });
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
