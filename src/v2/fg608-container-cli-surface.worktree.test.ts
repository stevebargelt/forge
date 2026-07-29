// FG-608 reds F3 + F14: THE SHIPPED IN-CONTAINER SURFACE, exercised in the EXACT
// container buildDockerArgs produces.
//
// F3 — the claim was "run `forge backlog show` in your container". The only thing
//      that ever did was a test that bind-mounted the HOST CHECKOUT at /forge-src
//      and ran `tsx src/cli/index.ts` against it. Production creates no such mount
//      and the image shipped no forge CLI, so the surface existed nowhere but in
//      that test. These tests therefore take the mounts and env VERBATIM from
//      buildDockerArgs and add NO source mount of any kind — a mount-plan assertion
//      below fails if one ever reappears.
//
// F14 — the negative half was incomplete. It attempted byte-level writes (append,
//       delete, create) but never a SQLite INSERT/UPDATE against the mounted
//       database, which is the write an agent would actually reach for. It is
//       attempted here as ROOT (agents have NOPASSWD sudo, so a CLI refusal is not
//       an enforcement primitive), and the host artifact is compared byte-for-byte
//       afterwards.
//
// Tier: worktree — real docker. Skips with a NAMED reason when the daemon or the
// agent image is unavailable; the host-side mount-plan assertions always run.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { bumpIdSequence, ensureStorageMode, setStorageMode, upsertTicket } from "../store/tickets.js";
import { SNAPSHOT_DB_BASENAME } from "../backlog/snapshot.js";
import { AUTHORITY_MARKER_BASENAME } from "../backlog/container-authority.js";
import { clearBacklogStoreCache } from "../backlog/storage-mode.js";
import { computeRepositoryEvidence } from "../store/project-registry.js";
import { buildDockerArgs, prepareBacklogSnapshotMount } from "./spawn.js";
import type { Runtime } from "./schema.js";
import type { SpawnContext } from "./spawn.js";

const AGENT_IMAGE = process.env["FORGE_TEST_AGENT_IMAGE"] ?? "agent-dev-worker:latest";

function dockerTry(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    return {
      ok: true,
      stdout: execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }),
      stderr: "",
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

function agentImageUnavailable(): string | undefined {
  if (!dockerTry(["info", "--format", "{{.ServerVersion}}"]).ok) return "no docker daemon reachable";
  if (dockerTry(["image", "inspect", AGENT_IMAGE]).ok) return undefined;
  return `agent image ${AGENT_IMAGE} is not built on this host (set FORGE_TEST_AGENT_IMAGE)`;
}

const RUNTIME: Runtime = {
  name: "fg608-cli-surface",
  description: "FG-608 in-container reader test runtime stub",
  image: AGENT_IMAGE,
  models: { default: "test-model" },
  auth: { mode: "oauth-volume" },
  env: {},
  mounts: [
    { host: "${TASK_DIR}", container: "/task", mode: "rw", optional: false },
    { host: "${PROJECT_DIR}", container: "/project", mode: "${PROJECT_MODE:-rw}", optional: false },
  ],
  invocation: { command: "claude", args: ["--model", "${MODEL}"] },
  container: { name: "forge-${TASK_ID}", remove_on_exit: true, idle_timeout_seconds: 300 },
  result: { file: "/task/result.json", stdout_log: "container.stdout.log", stderr_log: "container.stderr.log" },
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];
const containers: string[] = [];
const KEY = "pk-cli-surface";
const TICKET = "FG-1";
const NOW = "2026-07-29T00:00:00Z";

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
});

afterEach(() => {
  for (const c of containers.splice(0)) dockerTry(["rm", "-f", c]);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  clearBacklogStoreCache();
});

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A db-mode project whose identity resolves to KEY, exactly as production does. */
function dbModeProject(body: string): string {
  const projectDir = newDir("fg608-surface-proj-");
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(projectDir, "backlog", "stories", `${TICKET}-slug.md`),
    `---\nid: ${TICKET}\ntype: story\nstatus: active\ntitle: readable\n---\n\nSTALE-MARKDOWN\n`,
  );
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `project_key: ${KEY}\n`);
  writeTransaction(() => {
    ensureStorageMode(KEY, NOW);
    bumpIdSequence(KEY, "FG", 100);
    upsertTicket({
      projectKey: KEY, ticketId: TICKET, type: "story", status: "active",
      title: "readable", body, importedAt: NOW,
    });
  });
  setStorageMode(KEY, "db", NOW);
  const evidence = computeRepositoryEvidence(projectDir);
  db.prepare(
    `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(KEY, evidence.key, evidence.source, NOW);
  clearBacklogStoreCache();
  return projectDir;
}

function ctxFor(projectDir: string, taskId: string): SpawnContext {
  return {
    TASK_ID: taskId,
    TASK_DIR: newDir("fg608-surface-task-"),
    PROJECT_DIR: projectDir,
    PROJECT_MODE: "rw",
    MODEL: "test-model",
    SYSTEM_PROMPT: "system",
    TASK_PACKAGE_MARKDOWN: "# Task\n",
    TICKET_ID: TICKET,
  } as SpawnContext;
}

function mountSpecs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-v") out.push(args[i + 1]!);
  return out;
}

/** The container buildDockerArgs described, with ONLY the container name and the
 *  agent command substituted — every mount and every -e is verbatim. */
function runProducedContainer(projectDir: string, taskId: string, command: string[]) {
  const { args, imageIndex } = buildDockerArgs(RUNTIME, ctxFor(projectDir, taskId));
  const name = `fg608-surface-${process.pid}-${taskId}`;
  dockerTry(["rm", "-f", name]);
  containers.push(name);
  const prefix = args.slice(0, imageIndex).map((a, i) => (args[i - 1] === "--name" ? name : a));
  return dockerTry([...prefix, "--rm", AGENT_IMAGE, ...command]);
}

// ─── F3, host side: the mount plan itself ───────────────────────────────────

test("FG-608 F3: buildDockerArgs mounts the READER — and no forge source tree", () => {
  const projectDir = dbModeProject("MOUNTED-BODY");
  const { args } = buildDockerArgs(RUNTIME, ctxFor(projectDir, "task-plan"));
  const specs = mountSpecs(args);

  assert.ok(
    specs.some((s) => s.endsWith(":/usr/local/lib/forge/forge-backlog-reader.mjs:ro")),
    `the reader must be a production mount, got: ${specs.join(" ")}`,
  );
  assert.ok(
    specs.some((s) => s.endsWith(":/usr/local/bin/forge:ro")),
    `\`forge\` must be on PATH in the container, got: ${specs.join(" ")}`,
  );
  assert.deepEqual(
    specs.filter((s) => s.includes("/forge-src")),
    [],
    "a test-only source mount is what made the old surface fictional — production must never create one",
  );
  assert.ok(
    specs.some((s) => s.endsWith(":/forge-backlog:ro")),
    "and the authority itself is still a read-only DIRECTORY bind",
  );
});

test("FG-608 F1/F2: EVERY dispatch carries the authority marker, markdown ones included", () => {
  const markdownProject = newDir("fg608-surface-md-");
  mkdirSync(join(markdownProject, "backlog"), { recursive: true });

  const mount = prepareBacklogSnapshotMount(markdownProject, "task-md");
  assert.equal(mount.mode, "markdown");
  assert.equal(
    existsSync(join(mount.hostDir, AUTHORITY_MARKER_BASENAME)),
    true,
    "the marker is what makes 'this is a container' unforgeable — it cannot be db-mode-only",
  );
  assert.equal(
    existsSync(join(mount.hostDir, SNAPSHOT_DB_BASENAME)),
    false,
    "but a markdown project still pays NO snapshot publication",
  );
  rmSync(mount.hostDir, { recursive: true, force: true });
});

// ─── F3, container side: the reader actually runs ───────────────────────────

test("FG-608 F3: `forge backlog show` works in the EXACT produced container (no source mount)", (t) => {
  const unavailable = agentImageUnavailable();
  if (unavailable) {
    t.skip(`the shipped in-container surface is NOT verified here — ${unavailable}`);
    return;
  }
  const projectDir = dbModeProject("MOUNTED-BODY");

  const shown = runProducedContainer(projectDir, "task-show", ["forge", "backlog", "show", TICKET]);
  assert.equal(shown.ok, true, `forge backlog show must succeed in the container: ${shown.stderr}`);
  assert.match(shown.stdout, /MOUNTED-BODY/, "the body comes over the mount, not from the stale checkout");
  assert.doesNotMatch(shown.stdout, /STALE-MARKDOWN/);

  const listed = runProducedContainer(projectDir, "task-list", ["forge", "backlog", "list", "--json"]);
  assert.equal(listed.ok, true, listed.stderr);
  assert.deepEqual(
    (JSON.parse(listed.stdout) as { id: string }[]).map((t2) => t2.id),
    [TICKET],
  );
});

test("FG-608 F3: a mutating verb refuses in the produced container, with a non-zero exit", (t) => {
  const unavailable = agentImageUnavailable();
  if (unavailable) {
    t.skip(`the CLI refusal half is NOT verified here — ${unavailable}`);
    return;
  }
  const projectDir = dbModeProject("MOUNTED-BODY");

  for (const verb of [["file", "new"], ["edit", TICKET], ["close", TICKET], ["import"]]) {
    const res = runProducedContainer(projectDir, `task-${verb[0]}`, ["forge", "backlog", ...verb]);
    assert.equal(res.ok, false, `backlog ${verb.join(" ")} must exit non-zero`);
    assert.match(res.stderr, /refusing/, `backlog ${verb.join(" ")} must refuse EXPLICITLY`);
  }
});

// ─── F14: the DIRECT SQLITE WRITE, as root ──────────────────────────────────

test("FG-608 F14: a ROOT sqlite INSERT/UPDATE against the mounted DB fails, host state unchanged", (t) => {
  const unavailable = agentImageUnavailable();
  if (unavailable) {
    t.skip(`the direct-SQLite-write rejection is NOT verified here — ${unavailable}`);
    return;
  }
  const projectDir = dbModeProject("MOUNTED-BODY");
  const mount = prepareBacklogSnapshotMount(projectDir, "task-sqlite-write", TICKET);
  const artifact = join(mount.hostDir, SNAPSHOT_DB_BASENAME);
  const before = readFileSync(artifact);

  // node:sqlite is in the image (it is what the reader uses), so this is the write
  // an agent would actually reach for — distinct from the CLI refusal (a policy an
  // agent can route around) and from the raw fs writes already covered.
  const writeScript = (sql: string) =>
    `const { DatabaseSync } = require("node:sqlite");` +
    `const db = new DatabaseSync("/forge-backlog/${SNAPSHOT_DB_BASENAME}");` +
    `db.prepare(${JSON.stringify(sql)}).run();`;

  for (const [label, sql] of [
    ["UPDATE", `UPDATE tickets SET body = 'CORRUPTED' WHERE ticket_id = '${TICKET}'`],
    ["INSERT", `INSERT INTO tickets (ticket_id, type, status, title, body, revision) VALUES ('FG-999','story','active','forged','forged',1)`],
  ] as const) {
    const res = runProducedContainer(projectDir, `task-sql-${label}`, [
      "sudo", "node", "--no-warnings", "-e", writeScript(sql),
    ]);
    assert.equal(
      res.ok,
      false,
      `a root SQLite ${label} against the :ro mount must FAIL — this is the enforcement half, ` +
        `and NOPASSWD sudo is exactly why a CLI refusal cannot stand in for it`,
    );
    assert.match(
      `${res.stderr}${res.stdout}`,
      /readonly|read-only|SQLITE_(READONLY|CANTOPEN)|attempt to write/i,
      `the failure must come from the kernel/SQLite, not from something incidental: ${res.stderr}`,
    );
  }

  assert.deepEqual(readFileSync(artifact), before, "the host artifact is byte-identical");
  rmSync(mount.hostDir, { recursive: true, force: true });
});
