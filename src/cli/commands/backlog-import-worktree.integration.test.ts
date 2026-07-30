// FG-606 (FG-496 Slice A): the BINDING ARCHITECTURE CONSTRAINT, proven end to end
// against REAL git worktrees + the REAL `forge backlog import` CLI + the REAL
// shared on-disk store — not an injected GitRunner.
//
// The single greatest hazard in this slice is project-key initialization
// DIVERGING: two linked worktrees of ONE project independently minting DIFFERENT
// identities and creating two DB backlogs for what is one project. Every existing
// FG-606 test that touches worktree convergence does so with a FAKE fixedRemoteGit
// runner — so the real-world guarantee (that `repositoryCheckoutIdentity` computes
// the SAME converging evidence key for two genuinely-linked worktrees at different
// real paths) is never actually exercised. This file closes that gap:
//
//   - `git init` a real repo, `git worktree add` a real linked worktree, and drive
//     the REAL child `forge` process against each. The identity flows through the
//     production git-common-dir evidence path, not a stub.
//   - Pillar 3 (absence detection / CONVERGENCE): two config-absent linked
//     worktrees resolve to ONE project_key and ONE union backlog — never a split.
//   - Pillar 4 (CONFLICT detection): two worktrees committing DIFFERENT keys for
//     the same repository are REFUSED, not silently split into two backlogs.
//   - The FG-496 core goal: (project_key, ticket_id) coexistence — the SAME id
//     under two UNRELATED real repos lands as two distinct rows in one host DB.
//
// Markdown stays authoritative; this only proves the write-only shadow's identity
// is safe under the concurrency the shared host DB introduces.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../../store/db.js";
import { getTicket, ticketsForProject } from "../../store/tickets.js";
import { readBacklogConfig } from "../../backlog/config.js";
import { computeRepositoryEvidence, registryByEvidence } from "../../store/project-registry.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const localTsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

// A per-test scratch root that holds the real git repos/worktrees.
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg606-wt-integ-"));
});

afterEach(() => {
  // A worktree registration in the main repo can leave locks; force-remove.
  rmSync(root, { recursive: true, force: true });
});

function runGit(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
}

// A real git repo with a single initial commit (so `git worktree add` has a
// commit to branch from). Deliberately NO remote — identity then resolves via the
// git-common-dir evidence, which is exactly what groups linked worktrees.
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  mkdirSync(join(dir, "backlog"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "seed\n");
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-qm", "init"]);
}

function addWorktree(mainDir: string, wtDir: string, branch: string): void {
  runGit(mainDir, ["worktree", "add", "-q", "-b", branch, wtDir]);
  mkdirSync(join(wtDir, "backlog"), { recursive: true });
}

function writeTicketFile(projectDir: string, subdir: string, fm: Record<string, unknown>, body: string): void {
  const dir = join(projectDir, "backlog", subdir);
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${v}`,
  );
  writeFileSync(join(dir, `${fm["id"]}-slug.md`), `---\n${lines.join("\n")}\n---\n\n${body}\n`);
}

function seedCommittedKey(projectDir: string, projectKey: string): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), `project_key: ${projectKey}\nbacklog:\n  prefix: FG\n`);
}

type ImportJson = { projectKey: string; ticketCount: number; rung: number; persistedConfig: boolean };
type ConflictJson = {
  status: string;
  error: string;
  reason: string;
  detail: { evidenceKey: string; configKey?: string; registeredKey?: string; registeredEvidenceKey?: string };
};

function runImport(projectDir: string) {
  return spawnSync(tsx, withAuthorityTestkit(entry, ["backlog", "import", "--project", projectDir, "--json"]), {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
}

// Pillars 1-3: two config-absent LINKED worktrees at different real paths must
// converge on ONE project_key and ONE union backlog. The first mints (and heals
// its config); the second, still config-absent, ADOPTS the registered key via the
// converging real git-common-dir evidence — never mints a second identity.
test("integ FG-606: two real linked worktrees converge on ONE backlog (never split)", () => {
  const main = join(root, "main");
  const wtB = join(root, "wtB");
  initRepo(main);
  addWorktree(main, wtB, "sibling");

  // Disjoint Markdown sets per worktree (both untracked; listTickets reads the FS).
  writeTicketFile(main, "stories", { id: "FG-40", type: "story", status: "active", title: "from main" }, "a");
  writeTicketFile(wtB, "stories", { id: "FG-41", type: "story", status: "blocked", title: "from wtB" }, "b");

  const first = runImport(main);
  assert.equal(first.status, 0, `main import failed: ${first.stderr}`);
  const a = JSON.parse(first.stdout) as ImportJson;
  assert.equal(a.rung, 4, "the first worktree MINTS (both config + registry absent)");
  assert.equal(a.persistedConfig, true, "first import heals main's .forge/config.yml");

  const second = runImport(wtB);
  assert.equal(second.status, 0, `wtB import failed: ${second.stderr}`);
  const b = JSON.parse(second.stdout) as ImportJson;
  assert.equal(b.rung, 2, "the second worktree ADOPTS the registered key (config absent, registry exists)");

  // The crux: ONE identity, not two. The split-truth failure FG-496 exists to kill.
  assert.equal(a.projectKey, b.projectKey, "linked worktrees resolve to the SAME project_key");

  getDb();
  const key = a.projectKey;
  // ONE union backlog holding BOTH worktrees' tickets — proof there is no second
  // backlog hiding under a divergent key.
  assert.ok(getTicket(key, "FG-40"), "main's ticket present in the shared backlog");
  assert.ok(getTicket(key, "FG-41"), "wtB's ticket present in the SAME backlog");
  assert.equal(ticketsForProject(key).length, 2, "exactly one union backlog, both worktrees' tickets");
  // Legacy blocked survived the cutover as active (FG-41 was status: blocked).
  assert.equal(getTicket(key, "FG-41")!.status, "active");

  // Exactly ONE registry row for the shared converging evidence.
  const ev = computeRepositoryEvidence(main);
  assert.notEqual(ev.source, "path", "linked worktrees must resolve via shared git evidence, not raw path");
  assert.equal(registryByEvidence(ev.key)!.projectKey, key, "single registry mapping for the shared evidence");

  // Both configs healed to the SAME committed key — the next worktree reads it.
  assert.equal(readBacklogConfig(main).projectKey, key);
  assert.equal(readBacklogConfig(wtB).projectKey, key);
});

// Pillar 4: CONFLICT detection through real git worktrees. Two worktrees of ONE
// repository committing DIFFERENT project_keys must be REFUSED (stop-and-surface),
// never silently maintained as two DB backlogs. The refusal is machine-readable on
// --json and carries a non-zero exit.
test("integ FG-606: real linked worktrees with divergent committed keys are REFUSED", () => {
  const main = join(root, "main");
  const wtB = join(root, "wtB");
  initRepo(main);
  addWorktree(main, wtB, "sibling");

  seedCommittedKey(main, "pk-alpha");
  seedCommittedKey(wtB, "pk-beta");
  writeTicketFile(main, "stories", { id: "FG-50", type: "story", status: "active", title: "A" }, "a");
  writeTicketFile(wtB, "stories", { id: "FG-51", type: "story", status: "active", title: "B" }, "b");

  const okMain = runImport(main);
  assert.equal(okMain.status, 0, `main import failed: ${okMain.stderr}`);
  assert.equal((JSON.parse(okMain.stdout) as ImportJson).projectKey, "pk-alpha", "main claims its committed key");

  // wtB shares main's git evidence (now registered to pk-alpha) but commits a
  // DIFFERENT key -> divergent-committed-keys REFUSE (rung 5, forward direction).
  const res = runImport(wtB);
  assert.equal(res.status, 1, `expected a non-zero refusal exit; stdout: ${res.stdout} stderr: ${res.stderr}`);
  const obj = JSON.parse(res.stdout) as ConflictJson;
  assert.equal(obj.status, "conflict");
  assert.equal(obj.error, "ProjectIdentityConflict");
  assert.equal(obj.detail.registeredKey, "pk-alpha", "surfaces the already-registered owner");
  assert.equal(obj.detail.configKey, "pk-beta", "surfaces the divergent committed key");
  assert.match(obj.reason, /pk-alpha/);
  assert.match(obj.reason, /pk-beta/);

  // No second backlog: wtB wrote ZERO tickets under its divergent key.
  getDb();
  assert.equal(ticketsForProject("pk-beta").length, 0, "the refused worktree created no split backlog");
  assert.equal(getTicket("pk-alpha", "FG-50")!.title, "A", "main's backlog is intact");
});

// FG-496 core goal, through the real CLI + real shared host DB: the SAME ticket id
// under two UNRELATED repositories coexists as two distinct rows keyed by
// (project_key, ticket_id) — the (project_key, ticket_id) primary key, not a bare
// ticket_id, is what makes the shared host DB hold many projects without collision.
test("integ FG-606: FG-123 under two unrelated repos coexists in one host DB", () => {
  const repoA = join(root, "repoA");
  const repoB = join(root, "repoB");
  initRepo(repoA);
  initRepo(repoB);
  writeTicketFile(repoA, "stories", { id: "FG-123", type: "story", status: "active", title: "A's 123" }, "a");
  writeTicketFile(repoB, "stories", { id: "FG-123", type: "story", status: "active", title: "B's 123" }, "b");

  const a = runImport(repoA);
  const b = runImport(repoB);
  assert.equal(a.status, 0, `repoA import failed: ${a.stderr}`);
  assert.equal(b.status, 0, `repoB import failed: ${b.stderr}`);
  const ka = (JSON.parse(a.stdout) as ImportJson).projectKey;
  const kb = (JSON.parse(b.stdout) as ImportJson).projectKey;

  assert.notEqual(ka, kb, "unrelated repos resolve to distinct project_keys");

  getDb();
  assert.equal(getTicket(ka, "FG-123")!.title, "A's 123");
  assert.equal(getTicket(kb, "FG-123")!.title, "B's 123");
  assert.equal(ticketsForProject(ka).length, 1);
  assert.equal(ticketsForProject(kb).length, 1);
});
