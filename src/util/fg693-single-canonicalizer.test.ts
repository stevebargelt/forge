// FG-693 step 12 — THERE IS ONE CANONICALIZER, AND THE MIGRATED MODULES STILL
// BEHAVE.
//
// Two jobs, deliberately in one file because they are one claim.
//
// (1) MECHANICAL (AC1). Before this ticket, "canonicalize a path" was written
//     out by hand in module after module, always as the same three lines:
//
//         try { return realpathSync(p); } catch { return resolve(p); }
//
//     That shape is the defect, not a style problem. The catch arm returns a
//     LEXICAL guess in the position a PROVEN identity is read from, so a guard
//     comparing two guesses looks exactly like a guard that works — which is how
//     FG-575, FG-576 and FG-253 each fixed one consumer and left the invariant
//     open. So the enforcement here is textual and repo-wide rather than a unit
//     test of any one consumer: a private copy that is never called from a test
//     is still a copy, and the next one gets written by somebody who never read
//     this ticket.
//
// (2) BEHAVIOURAL. Delegating to the contract must not quietly change what the
//     migrated modules decide. repository-identity must still group clones of
//     one repository by remote and still report `exists`.
//
//     The matching property for commit-msg-hook — that the enforceability
//     assertion still recognises its own hook when git names that directory by
//     another spelling — needs a REAL git repository, and src/test-tiers.test.ts
//     forbids a unit-tier file from spawning a subprocess (FG-495). It lives in
//     the integration-tier sibling, fg693-single-canonicalizer.integration.test.ts.
//
// PORTABLE BY CONSTRUCTION: every alias exercised below is one this file
// CREATES (a symlinked parent, a trailing separator, a `..` segment). No case
// depends on an alias a particular operating system happens to provide, which is
// the reason the earlier coverage was CI-green and host-red.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryCheckoutIdentity } from "./repository-identity.js";
import type { GitRunner } from "./github-url.js";

// ── the source scan ─────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The ONE module allowed to ask the filesystem to canonicalize a path. */
const CONTRACT = "src/util/path-identity.ts";

/** The modules this step migrated. These are asserted EXACTLY — no register
 *  entry, no realpath of their own, and each must actually import the contract,
 *  so "I deleted the helper and inlined it" fails too. */
const MIGRATED_BY_THIS_STEP = [
  "src/util/repository-identity.ts",
  "src/cli/commands/init.ts",
  "src/backlog/config.ts",
  "src/util/commit-msg-hook.ts",
  // The two boundaries the plan's inventory MISSED, migrated by FG-693's fix batch
  // and promoted from PENDING_FG693 (below) to this list. They are held to the same
  // standard as the rest: no realpath of their own, no lexical fallback, and an
  // import of the contract.
  "src/cli/commands/review.ts",
  "src/store/backlog-import.ts",
];

/** Production modules that call realpath for SYMLINK MECHANICS, not for project
 *  identity — the link IS the subject there (a release pointer, a git object
 *  store, an interpreter root), so routing them through an identity contract
 *  would say nothing. Listed with the reason so a reader can disagree with a
 *  specific line rather than with a blanket exemption.
 *
 *  Checked for STALENESS below: an entry that no longer calls realpath must be
 *  deleted, so this never decays into a list nobody rereads. */
const NOT_PROJECT_PATH_IDENTITY: Record<string, string> = {
  "src/v2/promote.ts": "release-tree pointer mechanics — the `current` symlink is the thing being read",
  "src/v2/seed-generation.ts": "resolves the release/home links to find the seed generation on disk",
  "src/v2/runtime-store.ts": "interpreter store roots under the forge home, not a project checkout",
  "src/v2/spawn.ts": "git object-store and worktree plumbing paths reported by git itself",
  "src/v2/dependency-provisioning.ts": "realpathSync.native on a workspace root before a native rebuild",
  "src/v2/fg571-harness.ts": "release-fixture harness: builds the temp trees the release tests run against",
  "src/v2/release.ts": "the name appears inside a GENERATED shell script, not as a call in this module",
  "src/store/schema.ts": "the name appears in a SQL comment describing how a column was produced",
};

/** Production modules a LATER FG-693 step migrates, or that no step in this plan
 *  owns. Subset semantics: when the owning step lands and the call goes away,
 *  this test keeps passing and simply gets stricter. An entry here is a promise
 *  outstanding, not an exemption granted.
 *
 *  The two UNOWNED entries are the point of writing this check as a repo-wide
 *  scan rather than as a list of the files this step happened to touch. Both are
 *  project-path boundaries in FG-693's sense and NO step in this plan lists
 *  either file, so neither can be fixed from here without writing outside this
 *  step's declared files. They are recorded, not quietly absorbed.
 *
 *  BOTH UNOWNED ENTRIES ARE NOW CLOSED — the fix batch migrated them, and they moved
 *  to MIGRATED_BY_THIS_STEP above, where they are asserted rather than excused. What
 *  remains here is only what a later step of the plan owns. */
const PENDING_FG693: Record<string, string> = {
  "src/v2/self-host-guard.ts": "step 5 migrates the dispatch guard",
  "src/v2/adapter-stamp.ts": "step 7 deletes isSameTree",
  "src/v2/project-identity.ts": "step 8 makes it a projection over the contract",
  "src/v2/worktree-lifecycle.ts": "step 11 migrates the reaper",
};

/** The lexical-fallback shape specifically, kept as its OWN register: a module
 *  may legitimately call realpath for symlink mechanics (above) and still have no
 *  business handing back a guess when it fails. Subset semantics, same as
 *  PENDING_FG693. */
const LEXICAL_FALLBACK_PENDING: Record<string, string> = {
  "src/v2/adapter-stamp.ts": "step 7 deletes isSameTree",
  "src/v2/project-identity.ts": "step 8 makes it a projection over the contract",
  "src/v2/promote.ts":
    "UNOWNED — realpathContains() falls back to a lexical path on BOTH sides of a containment " +
    "check that decides whether a release write escapes the forge home; release-scoped rather " +
    "than project-scoped, and no plan step lists this file",
};

/** Every production `.ts` under the source trees. Tests are excluded on purpose:
 *  a test may legitimately realpath a fixture root to compute the expected
 *  answer, and path-identity.test.ts does exactly that. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full);
    }
  };
  for (const root of ["src", join("dashboard", "src")]) walk(join(REPO_ROOT, root));
  return out;
}

function repoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

/** The lexical-fallback SHAPE: a catch arm that hands back `resolve(...)` as
 *  though it were a resolved path. A secondary net only — a fallback can be
 *  spelled any number of ways (`catch { return abs }` is the same defect and
 *  this misses it), which is why the realpath register above is the primary
 *  check and this one is the readable name for what we are hunting. */
const LEXICAL_FALLBACK = /catch\s*(?:\([^)]*\))?\s*\{[^{}]*\b(?:path\.)?resolve\(/;

const CALLS_REALPATH = /realpathSync\s*(?:\.native\s*)?\(/;

test("FG-693 AC1: realpathSync appears only in the contract, or in a module named with its reason", () => {
  const unregistered: string[] = [];
  for (const file of productionSources()) {
    const rel = repoRelative(file);
    if (rel === CONTRACT) continue;
    if (!CALLS_REALPATH.test(readFileSync(file, "utf8"))) continue;
    if (rel in NOT_PROJECT_PATH_IDENTITY || rel in PENDING_FG693) continue;
    unregistered.push(rel);
  }
  assert.deepEqual(
    unregistered,
    [],
    `these production modules canonicalize a path themselves instead of calling ${CONTRACT}: ` +
      `${unregistered.join(", ")}. Route the path through util/path-identity.ts, or — if the ` +
      `symlink itself is the subject rather than a project's identity — add the file to ` +
      `NOT_PROJECT_PATH_IDENTITY in this test WITH the reason.`
  );
});

test("FG-693 AC1: the exemption register does not rot — every entry still calls realpath", () => {
  // PENDING_FG693 is deliberately NOT checked for staleness: those entries go
  // away as their own steps land, and this test must not go red when they do.
  const stale = Object.keys(NOT_PROJECT_PATH_IDENTITY).filter(
    (rel) => !CALLS_REALPATH.test(readFileSync(join(REPO_ROOT, rel), "utf8"))
  );
  assert.deepEqual(
    stale,
    [],
    `these files are exempted from the one-canonicalizer rule but no longer canonicalize ` +
      `anything: ${stale.join(", ")}. Delete the entries — a blanket nobody rereads is how the ` +
      `fifth private copy got written.`
  );
});

test("FG-693 AC1: no production module outside the contract keeps a lexical fallback in a resolved path's shape", () => {
  const offenders: string[] = [];
  for (const file of productionSources()) {
    const rel = repoRelative(file);
    if (rel === CONTRACT) continue;
    if (!LEXICAL_FALLBACK.test(readFileSync(file, "utf8"))) continue;
    // Only the modules named in the fallback register may still carry it —
    // deliberately NOT the realpath-mechanics register: calling realpath for a
    // legitimate reason never licenses returning a guess when it fails.
    if (rel in LEXICAL_FALLBACK_PENDING) continue;
    offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `catch-arm returning resolve(...) as a path in: ${offenders.join(", ")}. An unresolvable ` +
      `spelling is UNRESOLVED — a value the caller must handle — never a path that looks proven.`
  );
});

test("FG-693 AC1: the modules this step migrated hold no canonicalizer of their own", () => {
  for (const rel of MIGRATED_BY_THIS_STEP) {
    const source = readFileSync(join(REPO_ROOT, rel), "utf8");
    assert.ok(!CALLS_REALPATH.test(source), `${rel} still calls realpath directly`);
    assert.ok(!LEXICAL_FALLBACK.test(source), `${rel} still carries a lexical fallback`);
    assert.ok(
      /from "[^"]*path-identity\.js"/.test(source),
      `${rel} must reach the filesystem's answer through util/path-identity.ts`
    );
    assert.ok(
      !(rel in NOT_PROJECT_PATH_IDENTITY) &&
        !(rel in PENDING_FG693) &&
        !(rel in LEXICAL_FALLBACK_PENDING),
      `${rel} was migrated by this step and must not be registered as an exemption`
    );
  }
});

// ── repository-identity: behaviour preserved ────────────────────────────────

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureRoot(prefix: string): string {
  // realpath the temp root itself: on some hosts it sits under a symlinked
  // parent, and the expectations below compare against physical spellings.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

/** A checkout shaped enough for findGitRoot: a `.git` entry at the root. */
function checkout(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** A git stub, so this stays in the unit tier. Remotes are keyed by the `-C`
 *  argument, which is how the production call passes the checkout root. */
function gitStub(remotes: Record<string, string>): GitRunner {
  return (args: string[]): string => {
    const dir = args[0] === "-C" ? args[1]! : "";
    if (args.includes("remote")) {
      const url = remotes[dir];
      if (!url) throw new Error("no remotes");
      return `origin\t${url} (fetch)\norigin\t${url} (push)\n`;
    }
    if (args.includes("symbolic-ref")) return "main\n";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

test("FG-693: repository-identity still groups two clones of ONE repository by remote", () => {
  const root = fixtureRoot("forge-fg693-repo-");
  const a = checkout(root, "clone-a");
  const b = checkout(root, "clone-b");
  const git = gitStub({
    [a]: "git@github.com:stevebargelt/forge.git",
    [b]: "https://github.com/stevebargelt/forge",
  });

  const left = repositoryCheckoutIdentity(a, git);
  const right = repositoryCheckoutIdentity(b, git);
  assert.equal(left.source, "remote");
  assert.equal(left.key, right.key, "clones of one repository must share repository identity");
  // ...and path identity is NOT repository identity: they are still two checkouts.
  assert.notEqual(left.checkoutRoot, right.checkoutRoot);
  assert.equal(left.exists, true);
  assert.equal(right.exists, true);
});

test("FG-693: repository-identity still reports `exists`, and a gone checkout claims no branch", () => {
  const root = fixtureRoot("forge-fg693-gone-");
  const gone = join(root, "deleted-clone");
  const git = gitStub({});

  const identity = repositoryCheckoutIdentity(gone, git);
  assert.equal(identity.exists, false, "a path the filesystem will not resolve does not exist");
  assert.equal(identity.branch, undefined, "an unresolved checkout never claims a branch");
  assert.equal(identity.source, "path");
  // The spelling is still reported so a read model can label the row — but it is
  // reported UNDER `exists: false`, which is the discriminator that says nothing
  // about this path was proven.
  assert.equal(identity.checkoutRoot, gone);
});

test("FG-693: one checkout addressed through an alias is ONE checkout, at the physical spelling", () => {
  const root = fixtureRoot("forge-fg693-alias-");
  mkdirSync(join(root, "real"), { recursive: true });
  const physical = checkout(join(root, "real"), "checkout");
  symlinkSync(join(root, "real"), join(root, "link"), "dir");
  const git = gitStub({});

  const spellings = [
    physical,
    physical + sep, // trailing separator
    join(root, "link", "checkout"), // symlinked parent
    `${physical}${sep}..${sep}checkout`, // a `..` segment, kept uncollapsed on purpose
  ];
  const identities = spellings.map((s) => repositoryCheckoutIdentity(s, git));
  for (const identity of identities) {
    assert.equal(identity.checkoutRoot, physical, "every alias resolves to the physical spelling");
    assert.equal(identity.key, identities[0]!.key, "every alias is ONE repository identity");
    assert.equal(identity.exists, true);
  }
});

test("FG-693 negative control: distinct physical checkouts sharing a lexical prefix stay distinct", () => {
  const root = fixtureRoot("forge-fg693-distinct-");
  const a = checkout(root, "project");
  const b = checkout(root, "project-two"); // `a` is a strict string prefix of `b`
  const git = gitStub({});

  const left = repositoryCheckoutIdentity(a, git);
  const right = repositoryCheckoutIdentity(b, git);
  assert.notEqual(left.key, right.key);
  assert.notEqual(left.checkoutRoot, right.checkoutRoot);
});
