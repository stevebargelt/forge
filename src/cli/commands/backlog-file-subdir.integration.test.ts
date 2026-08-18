// Integration tests for FG-404: forge backlog file success message prints the
// actual destination directory, not the hardcoded "stories/".

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let projectDir: string;

function runForge(args: string[]) {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
}

function setupStructured(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  mkdirSync(join(projectDir, "backlog", "done"), { recursive: true });
  mkdirSync(join(projectDir, "backlog", "epics"), { recursive: true });
  mkdirSync(join(projectDir, "backlog", "ideas"), { recursive: true });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-file-subdir-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test("integ FG-404: file --type story prints stories/ in success message", () => {
  setupStructured();
  const res = runForge(["backlog", "file", "My story ticket", "--type", "story", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /stories\//);
  assert.doesNotMatch(res.stdout, /epics\//);
  assert.doesNotMatch(res.stdout, /ideas\//);
});

test("integ FG-404: file default type prints stories/ in success message", () => {
  setupStructured();
  const res = runForge(["backlog", "file", "Default type ticket", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /stories\//);
  assert.doesNotMatch(res.stdout, /epics\//);
  assert.doesNotMatch(res.stdout, /ideas\//);
});

test("integ FG-404: file --type epic prints epics/ in success message", () => {
  setupStructured();
  const res = runForge(["backlog", "file", "My epic ticket", "--type", "epic", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /epics\//);
  assert.doesNotMatch(res.stdout, /stories\//);
  assert.doesNotMatch(res.stdout, /ideas\//);
});

test("integ FG-404: file --type idea prints ideas/ in success message", () => {
  setupStructured();
  const res = runForge(["backlog", "file", "My idea ticket", "--type", "idea", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /ideas\//);
  assert.doesNotMatch(res.stdout, /stories\//);
  assert.doesNotMatch(res.stdout, /epics\//);
});
