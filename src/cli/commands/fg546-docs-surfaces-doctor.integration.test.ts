/**
 * FG-546: exercise the public `forge doctor --json` CLI boundary, not merely
 * doctor.ts's registered Command. The child process enters through index.ts,
 * selects its project from cwd, and returns the classifier result that scripts
 * consume.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let projectDir: string;

beforeEach(() => {
  // Canonicalize once: on macOS os.tmpdir() is /var/folders/... where /var is a
  // symlink to /private/var, and doctor reports the realpath'd project root. Any
  // assertion comparing against projectDir must use the same canonical form.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "fg546-doctor-cli-")));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const LEGACY_TEMPLATE = [
  "surfaces:",
  "  - name: readme",
  "    kind: user-facing",
  "    path: README.md",
  "  - name: api-reference",
  "    kind: public-api",
  "    path: docs/api.md",
  "",
].join("\n");

function writeDocsSurfaces(body: string): void {
  const forgeDir = join(projectDir, ".forge");
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(join(forgeDir, "docs-surfaces.yml"), body);
}

function doctorJson(): { status: number | null; docsSurfaces: { verdict: string; path: string; detail?: string } } {
  const result = spawnSync(tsx, withAuthorityTestkit(entry, ["doctor", "--json"]), {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
  assert.equal(result.error, undefined, `forge doctor failed to start: ${result.error?.message ?? "unknown error"}`);
  assert.ok(result.stdout, `forge doctor produced no JSON: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as { docsSurfaces: { verdict: string; path: string; detail?: string } };
  return { status: result.status, docsSurfaces: payload.docsSurfaces };
}

test("FG-546 integration: doctor CLI reports all docs-surfaces states from its cwd without changing readiness", () => {
  const missing = doctorJson();
  assert.equal(missing.docsSurfaces.verdict, "missing");
  assert.equal(missing.docsSurfaces.path, join(projectDir, ".forge", "docs-surfaces.yml"));

  writeDocsSurfaces("surfaces:\n  - src/cli/\n");
  const valid = doctorJson();
  assert.equal(valid.docsSurfaces.verdict, "valid-project");

  writeDocsSurfaces(LEGACY_TEMPLATE);
  const legacy = doctorJson();
  assert.equal(legacy.docsSurfaces.verdict, "known-legacy-generated");

  writeDocsSurfaces("surfaces:\n  - label: operator-authored\n    path: README.md\n");
  const invalid = doctorJson();
  assert.equal(invalid.docsSurfaces.verdict, "customized-invalid");
  assert.match(invalid.docsSurfaces.detail ?? "", /string|invalid|expected/i);

  // Docs-surfaces is diagnostic-only: unrelated readiness findings may make
  // doctor non-zero, but switching this config state must not change that code.
  assert.equal(valid.status, missing.status);
  assert.equal(legacy.status, missing.status);
  assert.equal(invalid.status, missing.status);
});
