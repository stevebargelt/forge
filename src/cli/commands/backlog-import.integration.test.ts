// FG-606 (FG-496 Slice A): integration coverage for `forge backlog import` — the
// CLI-spawn boundary end to end. A real child `forge` process reads a real temp
// backlog/ tree and populates the real on-disk store (the per-process temp
// FORGE_HOME the harness installs); the parent then opens that same store through
// the production read path and asserts the shadow landed.
//
// Markdown stays authoritative — this only proves the write-only shadow is
// populated idempotently and that the durable project_key is committed to config.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../../store/db.js";
import {
  getTicket,
  ticketsForProject,
  blockerEvidenceForTicket,
} from "../../store/tickets.js";
import { readBacklogConfig } from "../../backlog/config.js";
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

function writeTicketFile(subdir: string, fm: Record<string, unknown>, body: string): void {
  const dir = join(projectDir, "backlog", subdir);
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${v}`,
  );
  writeFileSync(join(dir, `${fm["id"]}-slug.md`), `---\n${lines.join("\n")}\n---\n\n${body}\n`);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg606-import-integ-"));
  mkdirSync(join(projectDir, "backlog"), { recursive: true });
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test("integ FG-606: `forge backlog import` populates the DB shadow and commits project_key", () => {
  writeTicketFile("stories", { id: "FG-1", type: "story", status: "active", title: "first" }, "body one");
  writeTicketFile("stories", { id: "FG-2", type: "story", status: "blocked", title: "blocked one" }, "body two");
  writeTicketFile(
    "done",
    { id: "FG-3", type: "story", status: "done", title: "done one", closed: "2026-02-02" },
    "body three",
  );

  const res = runForge(["backlog", "import", "--project", projectDir, "--json"]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const result = JSON.parse(res.stdout) as { projectKey: string; ticketCount: number; persistedConfig: boolean };
  assert.equal(result.ticketCount, 3);
  assert.ok(result.projectKey.startsWith("pk-"), `unexpected projectKey: ${result.projectKey}`);

  // The durable key must be committed to .forge/config.yml (read via the store
  // read path in the parent process).
  assert.equal(readBacklogConfig(projectDir).projectKey, result.projectKey);

  // Open the same on-disk store the child wrote and assert the shadow landed.
  getDb();
  const key = result.projectKey;
  assert.equal(ticketsForProject(key).length, 3);
  assert.equal(getTicket(key, "FG-1")!.status, "active");
  // Legacy blocked -> active + a blocker_evidence row.
  assert.equal(getTicket(key, "FG-2")!.status, "active");
  assert.equal(blockerEvidenceForTicket(key, "FG-2").length, 1);
  assert.equal(getTicket(key, "FG-3")!.status, "done");
  assert.equal(getTicket(key, "FG-3")!.closed, "2026-02-02");
});

test("integ FG-606: re-import is idempotent (no duplicate rows) and adopts the committed key", () => {
  writeTicketFile("stories", { id: "FG-1", type: "story", status: "active", title: "first" }, "body one");

  const first = runForge(["backlog", "import", "--project", projectDir, "--json"]);
  assert.equal(first.status, 0, `stderr: ${first.stderr}`);
  const firstResult = JSON.parse(first.stdout) as { projectKey: string; persistedConfig: boolean };
  assert.equal(firstResult.persistedConfig, true, "first import mints + commits the key");

  const second = runForge(["backlog", "import", "--project", projectDir, "--json"]);
  assert.equal(second.status, 0, `stderr: ${second.stderr}`);
  const secondResult = JSON.parse(second.stdout) as { projectKey: string; persistedConfig: boolean };
  assert.equal(secondResult.projectKey, firstResult.projectKey, "adopts the committed key");
  assert.equal(secondResult.persistedConfig, false, "already committed — no re-heal");

  getDb();
  assert.equal(ticketsForProject(firstResult.projectKey).length, 1, "no duplicate rows on re-import");
});

// Must-fix #5: a ProjectIdentityConflict refusal on the --json path emits a
// structured, machine-readable conflict object (both identities + the reason) with
// the existing non-zero exit — the refusal is load-bearing operator-visible output.
test("integ FG-606: --json conflict emits a structured conflict object with non-zero exit", () => {
  // Project A commits pk-shared and claims it (evidence = A's path).
  writeFileSync(join(projectDir, ".forge", "config.yml"), "project_key: pk-shared\nbacklog:\n  prefix: FG\n");
  writeTicketFile("stories", { id: "FG-1", type: "story", status: "active", title: "a" }, "body");
  const a = runForge(["backlog", "import", "--project", projectDir, "--json"]);
  assert.equal(a.status, 0, `stderr: ${a.stderr}`);

  // Project B commits the SAME key but is a DIFFERENT repository (different path
  // evidence). Reverse-direction conflict -> REFUSE.
  const projB = mkdtempSync(join(tmpdir(), "fg606-conflict-b-"));
  mkdirSync(join(projB, "backlog", "stories"), { recursive: true });
  mkdirSync(join(projB, ".forge"), { recursive: true });
  writeFileSync(join(projB, ".forge", "config.yml"), "project_key: pk-shared\nbacklog:\n  prefix: FG\n");
  writeFileSync(
    join(projB, "backlog", "stories", "FG-9-slug.md"),
    "---\nid: FG-9\ntype: story\nstatus: active\ntitle: b\n---\n\nbody\n",
  );

  const res = spawnSync(tsx, withAuthorityTestkit(entry, ["backlog", "import", "--project", projB, "--json"]), {
    cwd: projB,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
  assert.equal(res.status, 1, `expected non-zero exit; stdout: ${res.stdout} stderr: ${res.stderr}`);
  const obj = JSON.parse(res.stdout) as {
    status: string;
    error: string;
    reason: string;
    detail: { evidenceKey: string; configKey?: string; registeredEvidenceKey?: string };
  };
  assert.equal(obj.status, "conflict");
  assert.equal(obj.error, "ProjectIdentityConflict");
  assert.equal(obj.detail.configKey, "pk-shared");
  assert.ok(obj.detail.registeredEvidenceKey, "surfaces the other conflicting identity");
  assert.notEqual(obj.detail.evidenceKey, obj.detail.registeredEvidenceKey);
  assert.ok(obj.reason.includes("pk-shared"));

  rmSync(projB, { recursive: true, force: true });
});

// Must-fix #6: a malformed backlog file (missing a required frontmatter field)
// fails with a precise, file-identified error on the --json path.
test("integ FG-606: a malformed backlog file fails with a precise file+field error", () => {
  writeTicketFile("stories", { id: "FG-1", type: "story", status: "active", title: "good" }, "ok");
  // Missing `type`.
  writeFileSync(
    join(projectDir, "backlog", "stories", "FG-2-bad.md"),
    "---\nid: FG-2\nstatus: active\ntitle: bad\n---\n\nx\n",
  );

  const res = runForge(["backlog", "import", "--project", projectDir, "--json"]);
  assert.equal(res.status, 1, `expected non-zero exit; stdout: ${res.stdout} stderr: ${res.stderr}`);
  const obj = JSON.parse(res.stdout) as {
    error: string;
    detail: { file: string; field: string };
  };
  assert.equal(obj.error, "BacklogImport");
  assert.equal(obj.detail.field, "type");
  assert.ok(obj.detail.file.includes("FG-2"), `file should name the offending file: ${obj.detail.file}`);
});
