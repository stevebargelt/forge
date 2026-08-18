// FG-608 (acceptance 11): `forge backlog reidentify --confirm` — a CUTOVER
// PRECONDITION, not a follow-up.
//
// The registry's repo_evidence_key is SOURCE-DEPENDENT: repository-identity.ts
// prefers a normalized remote and falls back to the git common dir. SSH and HTTPS
// spellings of one remote converge; remote-ABSENT and remote-PRESENT do not. So a
// repository registered while it had no remote gets a DIFFERENT evidence key the
// instant `git remote add origin` runs — after which the read-side identity guard
// refuses EVERY `forge backlog` command and the project's db tickets are stranded
// with no in-tool repair.
//
// This could not fire before FG-608 because no project had a committed
// project_key. `forge backlog migrate` commits one. Hence: precondition.
//
// Driven through a REAL child `forge` process against real git repositories,
// because the whole failure is about what `git remote add` does to computed
// evidence — a stubbed git runner would reproduce the fix, not the bug.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "../store/db.js";
import { registryByKey } from "../store/project-registry.js";
import { computeRepositoryEvidence } from "../store/project-registry.js";
import { readBacklogConfig } from "./config.js";
import { SNAPSHOT_DIR_ENV } from "./container-authority.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";

let projectDir: string;
let home: string;
let prevHome: string | undefined;
let prevDbPath: string | undefined;

function runForge(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: home,
      FORGE_DB_PATH: join(home, "forge.db"),
      ...authorityTestkitEnv(),
      ...extraEnv,
    },
  });
}

function git(args: string[], cwd = projectDir): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
}

function writeTicketFile(fm: Record<string, unknown>, body: string): void {
  const d = join(projectDir, "backlog", "stories");
  mkdirSync(d, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(d, `${fm["id"]}-slug.md`), `---\n${lines.join("\n")}\n---\n\n${body}\n`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fg608-reid-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "fg608-reid-proj-"));
  mkdirSync(join(projectDir, "backlog"), { recursive: true });
  // A REAL repository with NO remote — the exact starting state that makes the
  // evidence key move later.
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  prevHome = process.env["FORGE_HOME"];
  prevDbPath = process.env["FORGE_DB_PATH"];
  process.env["FORGE_HOME"] = home;
  process.env["FORGE_DB_PATH"] = join(home, "forge.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  if (prevHome === undefined) delete process.env["FORGE_HOME"];
  else process.env["FORGE_HOME"] = prevHome;
  if (prevDbPath === undefined) delete process.env["FORGE_DB_PATH"];
  else process.env["FORGE_DB_PATH"] = prevDbPath;
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

test("FG-608: adding a remote after the cutover STRANDS the project — and reidentify repairs it", () => {
  writeTicketFile({ id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  assert.equal(runForge(["backlog", "migrate"]).status, 0, "cut over while the repo has no remote");
  const key = readBacklogConfig(projectDir).projectKey!;
  assert.ok(key, "migrate committed a project_key — this is what makes the hazard reachable");

  closeDb();
  const evidenceBefore = registryByKey(key)!.repoEvidenceKey;

  // The operator does the most ordinary thing imaginable.
  git(["remote", "add", "origin", "git@github.com:acme/reid.git"]);
  closeDb();
  const evidenceAfter = computeRepositoryEvidence(projectDir).key;
  assert.notEqual(
    evidenceAfter,
    evidenceBefore,
    "precondition: remote-absent and remote-present do NOT converge — the evidence really moved",
  );

  // Every backlog command now refuses. The tickets are stranded.
  const stranded = runForge(["backlog", "list"]);
  assert.notEqual(stranded.status, 0);
  assert.match(stranded.stderr, /refusing to read the backlog/);

  // The CORRECTED refusal message names the EVIDENCE side and points at the fix.
  // The pre-FG-608 text said to reconcile config to the registered key, which is
  // wrong for this case: config is right; the evidence moved.
  assert.match(stranded.stderr, /The EVIDENCE moved/);
  assert.match(stranded.stderr, /git remote add origin/);
  assert.match(stranded.stderr, /forge backlog reidentify --confirm/);

  // The repair.
  const repaired = runForge(["backlog", "reidentify", "--confirm"]);
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(repaired.stdout, /Re-identified/);

  closeDb();
  assert.equal(registryByKey(key)!.repoEvidenceKey, evidenceAfter, "the registry now names this checkout");

  const recovered = runForge(["backlog", "list"]);
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  assert.match(recovered.stdout, /FG-1/);
});

test("FG-608 reidentify: --confirm is REQUIRED — identity is asserted, never inferred", () => {
  writeTicketFile({ id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  assert.equal(runForge(["backlog", "migrate"]).status, 0);
  git(["remote", "add", "origin", "git@github.com:acme/reid.git"]);

  const res = runForge(["backlog", "reidentify"]);
  assert.notEqual(res.status, 0, "without --confirm it must not run");
  assert.match(res.stderr, /required option/i);
});

test("FG-608 reidentify: REFUSES to merge two projects' backlogs", () => {
  // This checkout's evidence already belongs to ANOTHER project_key. Re-pointing
  // would silently merge two backlogs — the operator's assertion covers "this repo
  // is that project", not "and the other project should cease to exist".
  writeTicketFile({ id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  assert.equal(runForge(["backlog", "import"]).status, 0);
  const ownKey = readBacklogConfig(projectDir).projectKey!;

  // Register a SECOND project_key in the store, then assert it from here.
  closeDb();
  const other = mkdtempSync(join(tmpdir(), "fg608-reid-other-"));
  try {
    mkdirSync(join(other, "backlog"), { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: other });
    const r = spawnSync(tsx, withAuthorityTestkit(entry, ["backlog", "import", "--project", other, "--json"]), {
      cwd: other,
      encoding: "utf8",
      env: {
        ...process.env,
        FORGE_HOME: home,
        FORGE_DB_PATH: join(home, "forge.db"),
        ...authorityTestkitEnv(),
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const otherKey = (JSON.parse(r.stdout) as { projectKey: string }).projectKey;
    assert.notEqual(otherKey, ownKey);

    const res = runForge(["backlog", "reidentify", "--confirm", "--key", otherKey]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Re-pointing would merge two/);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("FG-608 reidentify: REFUSES an unregistered project_key rather than minting one", () => {
  const res = runForge(["backlog", "reidentify", "--confirm", "--key", "pk-never-registered"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /is not registered on this host/);
});

test("FG-608 reidentify: is unreachable from a READ path", () => {
  // storage-mode.ts is a pure identity READER on purpose: a read that healed
  // config would dirty git status and mint identity rows for every throwaway
  // directory forge is ever pointed at. Assert at the source level that the read
  // module never reaches the claim/repair functions.
  // Comment lines stripped first: the module's own header names these functions
  // precisely to say it must never call them, and a naive substring or call-shape
  // match would flag that comment and make the guard unusable.
  const src = readFileSync(resolve(here, "storage-mode.ts"), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
  // Matched as a CALL (`name(`), not a bare mention: the module's own header
  // comment names these functions precisely to say it must never call them, and a
  // substring check would flag that comment and make the guard unusable.
  for (const forbidden of ["reidentifyProject", "resolveAndClaimProjectKey", "writeProjectKey"]) {
    assert.equal(
      new RegExp(`(?<![\\w.])${forbidden}\\s*\\(`).test(src),
      false,
      `storage-mode.ts must never call ${forbidden} — identity is claimed only where an operator is present`,
    );
  }
});

test("FG-608 reidentify: is unreachable from a CONTAINER", () => {
  writeTicketFile({ id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  assert.equal(runForge(["backlog", "migrate"]).status, 0);

  // A mounted authority makes every identity-claiming verb refuse before it can
  // touch the registry. A container-derived evidence key becoming the registered
  // owner for unrelated projects is exactly what this prevents.
  const snapshotDir = mkdtempSync(join(tmpdir(), "fg608-reid-mount-"));
  try {
    for (const verb of [
      ["backlog", "reidentify", "--confirm"],
      ["backlog", "migrate"],
      ["backlog", "import"],
      ["backlog", "mode", "--set", "markdown"],
    ]) {
      const res = runForge(verb, { [SNAPSHOT_DIR_ENV]: snapshotDir });
      assert.notEqual(res.status, 0, `${verb.join(" ")} must refuse under a mounted authority`);
      assert.match(res.stderr, /READ-ONLY mounted/, `${verb.join(" ")} refusal text`);
    }
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});
