// FG-253 step 10 — the dispatch-worktree boundary is EXEMPT from adapter
// provisioning, and that exemption is a tested property rather than an accident.
//
// WHY THIS GUARD EXISTS. Step 4 gave `forge init` the ability to materialize the
// operator adapters — `.claude/commands/*.md` and `.agents/skills/forge-*/SKILL.md`
// — as bytes in a project. Agent containers run the forge CLI, so the same
// installer is one call away from any code that provisions a task workspace. If it
// ever fires there, forge writes generated files into exactly the tree whose
// cleanliness the shipping stage reads as evidence: a dispatch that moves a path no
// result declared is refused BY NAME
// (`fix_cycle_tree_dirty_outside_declared_scope`), and the reaper treats an
// ignored-but-dirty workspace as unrecovered work rather than a tree it may drop.
// So "nothing provisions adapters into a task workspace" is a correctness property
// of the shipping pipeline, not a stylistic preference — and today it holds only
// because no code path happens to call the installer there. This file turns that
// into an assertion.
//
// BOTH DISPATCH SUBSTRATES. FG-621 split the task workspace in two: a linked
// worktree for non-mutating/red agents, a private clone for mutating ones. The
// clone is the CANDIDATE tree — the one whose dirty set the fix-cycle and capture
// paths read — so guarding only the linked worktree would leave the tree the
// motivation actually names unguarded. Both are cut here, through the real
// production entry points (`createWorktree` / `createTaskClone`).
//
// HOW IT CAN FAIL (non-vacuity — the point of the step). Three independent
// controls, each of which must fail if this guard is to mean anything:
//   1. `adapterResidue` is run against the MAIN CHECKOUT, which the fixture
//      installs the full rendered adapter set into. It must report every one of
//      them. A detector that cannot see adapter files would pass the worktree
//      assertions for free.
//   2. After a real cut, one rendered adapter is written INTO the workspace and
//      the same detector must report it — the mutation the acceptance criteria
//      asks to be demonstrated, kept permanently rather than performed once.
//   3. The dirty-set comparison is against a BASELINE workspace cut with the raw
//      git primitive, which by construction provisions nothing. "Unchanged by the
//      cut" is therefore measured against a real second tree, not against a
//      hardcoded empty set.
//
// TWO GITIGNORE VARIANTS, because the two acceptance clauses catch different
// failures. `forge init` adds `.claude/commands/` and each `.agents/skills/forge-*/`
// to the project's .gitignore, so in a post-init project an adapter written into a
// workspace is INVISIBLE to plain `git status --porcelain` — only the existence
// check and the `--ignored` dirty set see it. A project that never got (or dropped)
// those entries is the case where plain porcelain is load-bearing. Running the
// guard over both is what keeps either clause from being quietly vacuous.
//
// THE ADAPTER PATH SET IS DERIVED, never listed here: `renderedAdapterTargets`
// (step 4) walks OPERATOR_SURFACES, so a surface added later to the renderer is
// covered by this guard on the day it lands, with no edit to this file.
//
// Tier: worktree — `git worktree add` / `git clone` are the slowest operations.
// Structural precedent: fg559-worktree-git-mount.worktree.test.ts,
// fg621-clone-substrate.worktree.test.ts.
//
// DARWIN CANONICALIZATION. Every temp dir below is
// `realpathSync(mkdtempSync(join(tmpdir(), …)))`, and every workspace path handed
// back by forge is realpath'd before it is used. On macOS `os.tmpdir()` is
// `/var/folders/…`, a symlink to `/private/var/folders/…`; git, `realpathSync.native`
// (which `createDependencyMountpoints` calls on the workspace root) and any spawned
// child's cwd all report the canonical spelling. A path that reaches this file
// uncanonicalized compares unequal to itself on the gate host while passing in a
// Linux container. Precedent: src/util/repository-identity.worktree.test.ts,
// fg425-project-identity.worktree.test.ts, fg559-worktree-git-mount.worktree.test.ts.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { renderedAdapterTargets } from "../cli/commands/init.js";
import { CLAUDE_COMMANDS_DIR } from "./render-claude-commands.js";
import { CODEX_SKILLS_ROOT, FORGE_OWNED_CODEX_SKILL_DIRS, isForgeOwnedCodexSkillDir } from "./render-codex-skills.js";
import { isForgeOwnedAdapter } from "./operator-workflows.js";
import { createTaskClone, createWorktree } from "./worktree-lifecycle.js";

// ─── Harness ─────────────────────────────────────────────────────────────────

const STAMP = "fg253-step10";
const RUN_ID = "run-fg253-step10";

/** Everything forge would write into a project for STAMP, derived from the step-4
 *  installer rather than restated. Non-empty by assertion below: an empty target
 *  set would make every "no adapter in the workspace" claim vacuous. */
const ADAPTER_TARGETS = renderedAdapterTargets(STAMP);

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** `git status --porcelain` entries as a comparable set. `--ignored` is the second
 *  reading because it is the one the reaper and the fix-cycle dirty check actually
 *  use (statusPorcelainIgnored, worktree-lifecycle.ts) — and, in a post-init
 *  project, the only one an adapter file would show up in at all. */
function dirtySet(treePath: string, opts: { ignored: boolean }): string[] {
  const args = opts.ignored ? ["status", "--porcelain", "--ignored"] : ["status", "--porcelain"];
  return git(treePath, ...args)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

function trackedPaths(treePath: string): Set<string> {
  return new Set(
    git(treePath, "ls-files")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

type Residue = { path: string; reason: string };

/** Every forge-owned adapter artifact present in `treePath` that the tree's own git
 *  does not account for — i.e. that something provisioned into it.
 *
 *  Tracked content is exempt on purpose: a project that deliberately COMMITS an
 *  adapter file has a worktree that legitimately carries it, and calling that a
 *  violation would make this guard fire on a state forge never produced. Ownership
 *  is decided from the bytes (`isForgeOwnedAdapter`) and from the renderer's own
 *  directory-name predicate (`isForgeOwnedCodexSkillDir`), never from a path list
 *  written down here. */
function adapterResidue(treePath: string): Residue[] {
  const tracked = trackedPaths(treePath);
  const found = new Map<string, Residue>();
  const add = (path: string, reason: string): void => {
    if (!found.has(path)) found.set(path, { path, reason });
  };

  for (const target of ADAPTER_TARGETS) {
    if (tracked.has(target.relPath)) continue;
    if (existsSync(join(treePath, ...target.relPath.split("/")))) {
      add(target.relPath, `rendered ${target.surface} target present but untracked`);
    }
  }

  const skillsRoot = join(treePath, ...CODEX_SKILLS_ROOT.split("/"));
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot)) {
      if (isForgeOwnedCodexSkillDir(entry)) add(`${CODEX_SKILLS_ROOT}/${entry}`, "forge-owned Codex skill directory");
    }
  }

  const commandsDir = join(treePath, ...CLAUDE_COMMANDS_DIR.split("/"));
  if (existsSync(commandsDir)) {
    for (const entry of readdirSync(commandsDir)) {
      const rel = `${CLAUDE_COMMANDS_DIR}/${entry}`;
      if (!entry.endsWith(".md") || tracked.has(rel)) continue;
      if (isForgeOwnedAdapter(readFileSync(join(commandsDir, entry), "utf8"))) {
        add(rel, "Forge-marked Claude command the workspace itself carries");
      }
    }
  }

  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

type Fixture = { repo: string; head: string; base: string };

/** A project in the state `forge init` leaves behind: adapters materialized as
 *  bytes in the MAIN checkout. `gitignored` selects whether the project carries the
 *  installer's .gitignore entries — see the header on why both variants run. */
function makeProject(variant: "gitignored" | "unignored"): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `fg253-${variant}-`)));
  cleanupDirs.push(base);
  const repo = join(base, "project");
  mkdirSync(repo, { recursive: true });

  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@forge.test");
  git(repo, "config", "user.name", "Forge Test");
  writeFileSync(join(repo, "README.md"), "# fg253 step 10 fixture\n");
  if (variant === "gitignored") {
    // Derived from the same exports the installer's entry list is derived from.
    writeFileSync(
      join(repo, ".gitignore"),
      [`${CLAUDE_COMMANDS_DIR}/`, ...FORGE_OWNED_CODEX_SKILL_DIRS.map((d) => `${CODEX_SKILLS_ROOT}/${d}/`), ""].join("\n"),
    );
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "initial");

  for (const target of ADAPTER_TARGETS) writeAdapter(repo, target.relPath, target.bytes);

  return { repo, head: git(repo, "rev-parse", "HEAD").trim(), base };
}

function writeAdapter(treePath: string, relPath: string, bytes: string): string {
  const abs = join(treePath, ...relPath.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  return abs;
}

type Substrate = {
  label: string;
  /** The production entry point a dispatch takes. */
  cut(f: Fixture, taskId: string): string;
  /** The same tree cut with the raw git primitive and nothing else — the "before
   *  the cut" dirty set, realized rather than assumed. */
  baseline(f: Fixture, taskId: string): string;
};

const SUBSTRATES: readonly Substrate[] = [
  {
    label: "linked worktree (createWorktree — red / non-mutating dispatch)",
    cut(f, taskId) {
      const { worktreePath } = createWorktree(f.repo, RUN_ID, taskId);
      cleanupDirs.push(worktreePath);
      return realpathSync(worktreePath);
    },
    baseline(f, taskId) {
      const path = join(f.base, `baseline-wt-${taskId}`);
      git(f.repo, "worktree", "add", "-q", path, "-b", `baseline/${taskId}`);
      return realpathSync(path);
    },
  },
  {
    label: "private clone (createTaskClone — mutating dispatch, the candidate tree)",
    cut(f, taskId) {
      const { clonePath } = createTaskClone(f.repo, RUN_ID, taskId, f.head);
      cleanupDirs.push(clonePath);
      return realpathSync(clonePath);
    },
    baseline(f, taskId) {
      const path = join(f.base, `baseline-clone-${taskId}`);
      execFileSync("git", ["clone", "--quiet", "--shared", f.repo, path], { stdio: ["ignore", "ignore", "pipe"] });
      return realpathSync(path);
    },
  },
];

const VARIANTS = ["gitignored", "unignored"] as const;

// ─── Control 1: the detector can see adapter files ───────────────────────────

test("fg253 step 10 (control): the rendered adapter set is non-empty and the detector reports ALL of it in the main checkout", () => {
  assert.ok(
    ADAPTER_TARGETS.length > 0,
    "renderedAdapterTargets must render at least one file — an empty set would make every assertion in this file vacuous",
  );
  assert.ok(
    ADAPTER_TARGETS.some((t) => t.relPath.startsWith(`${CODEX_SKILLS_ROOT}/`)),
    "the rendered set must include a Codex skill — the .agents/skills/forge-* clause has nothing to bite on otherwise",
  );
  assert.ok(
    ADAPTER_TARGETS.some((t) => t.relPath.startsWith(`${CLAUDE_COMMANDS_DIR}/`)),
    "the rendered set must include a Claude command — the .claude/commands clause has nothing to bite on otherwise",
  );

  for (const variant of VARIANTS) {
    const f = makeProject(variant);
    const residue = adapterResidue(f.repo).map((r) => r.path);
    for (const target of ADAPTER_TARGETS) {
      assert.ok(
        residue.includes(target.relPath),
        `[${variant}] the detector must report ${target.relPath} in a checkout that HAS it — a detector that cannot see an installed adapter would pass the workspace assertions for free. Reported: ${JSON.stringify(residue)}`,
      );
    }
  }
});

// ─── The guard ───────────────────────────────────────────────────────────────

for (const substrate of SUBSTRATES) {
  for (const variant of VARIANTS) {
    test(`fg253 step 10 [${variant}]: cutting a ${substrate.label} provisions NO adapter files`, () => {
      const f = makeProject(variant);
      const workspace = substrate.cut(f, `t-guard-${variant}`);

      assert.deepEqual(
        adapterResidue(workspace),
        [],
        `the cut must provision no forge-owned adapter artifact — agent containers run the forge CLI, and an adapter written here dirties the very tree the shipping stage reads as evidence`,
      );

      const skillsRoot = join(workspace, ...CODEX_SKILLS_ROOT.split("/"));
      assert.deepEqual(
        existsSync(skillsRoot) ? readdirSync(skillsRoot).filter(isForgeOwnedCodexSkillDir) : [],
        [],
        "the workspace must contain no .agents/skills/forge-* directory",
      );

      const commandsDir = join(workspace, ...CLAUDE_COMMANDS_DIR.split("/"));
      const marked = existsSync(commandsDir)
        ? readdirSync(commandsDir).filter(
            (e) => e.endsWith(".md") && isForgeOwnedAdapter(readFileSync(join(commandsDir, e), "utf8")),
          )
        : [];
      assert.deepEqual(marked, [], "the workspace must contain no Forge-marked .claude/commands/*.md it created itself");
    });

    test(`fg253 step 10 [${variant}]: cutting a ${substrate.label} leaves the dirty-file set unchanged`, () => {
      const f = makeProject(variant);
      const sourceBefore = { plain: dirtySet(f.repo, { ignored: false }), ignored: dirtySet(f.repo, { ignored: true }) };
      const baseline = substrate.baseline(f, `t-base-${variant}`);
      const baselineDirty = { plain: dirtySet(baseline, { ignored: false }), ignored: dirtySet(baseline, { ignored: true }) };

      const workspace = substrate.cut(f, `t-dirty-${variant}`);

      assert.deepEqual(
        dirtySet(workspace, { ignored: false }),
        baselineDirty.plain,
        "git status --porcelain in the dispatch workspace must match the tree the raw git primitive produces — the cut may add no dirty entry of its own",
      );
      assert.deepEqual(
        dirtySet(workspace, { ignored: true }),
        baselineDirty.ignored,
        "…and the same holds for the --ignored set, which is the one the reaper and the fix-cycle dirty check read (an adapter file in a post-init project is IGNORED, so plain porcelain alone would not see it)",
      );
      assert.deepEqual(
        { plain: dirtySet(f.repo, { ignored: false }), ignored: dirtySet(f.repo, { ignored: true }) },
        sourceBefore,
        "the cut must not dirty the SOURCE checkout either",
      );
    });

    // ─── Control 2: the mutation this guard exists to catch ──────────────────
    test(`fg253 step 10 [${variant}] (mutation control): a ${substrate.label} that DID provision an adapter fails both clauses`, () => {
      const f = makeProject(variant);
      const baseline = substrate.baseline(f, `t-mut-base-${variant}`);
      const baselineIgnored = dirtySet(baseline, { ignored: true });
      const workspace = substrate.cut(f, `t-mut-${variant}`);

      // Simulate the wiring this step forbids: the installer firing on the
      // workspace. Every rendered target, one at a time — so a future surface is
      // proven catchable too, not just the two that exist today.
      for (const target of ADAPTER_TARGETS) {
        const abs = writeAdapter(workspace, target.relPath, target.bytes);

        assert.notDeepEqual(
          adapterResidue(workspace),
          [],
          `provisioning ${target.relPath} into the workspace MUST be detected — a guard that cannot fail is worthless`,
        );
        assert.ok(
          adapterResidue(workspace).some((r) => r.path === target.relPath || target.relPath.startsWith(`${r.path}/`)),
          `the detector must name ${target.relPath} (or its forge-owned skill directory), got ${JSON.stringify(adapterResidue(workspace))}`,
        );
        assert.notDeepEqual(
          dirtySet(workspace, { ignored: true }),
          baselineIgnored,
          `provisioning ${target.relPath} MUST move the --ignored dirty set away from the baseline cut`,
        );

        rmSync(abs);
        rmSync(join(workspace, ...target.relPath.split("/").slice(0, -1)), { recursive: true, force: true });
      }

      // Restored — the same workspace is clean again, so the failures above came
      // from the written file and from nothing else about this workspace.
      assert.deepEqual(adapterResidue(workspace), [], "removing the provisioned files must restore the guard to green");
      assert.deepEqual(
        dirtySet(workspace, { ignored: true }),
        baselineIgnored,
        "…and must restore the workspace's dirty set to the baseline cut's",
      );
    });
  }
}
