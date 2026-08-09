// FG-253 (absorbing FG-347) — the PROSE-OWNERSHIP regression, driven through the
// real `forge init` / `forge upgrade` / renderer code paths in disposable roots.
//
// ─── WHAT FG-347 ACTUALLY WAS ────────────────────────────────────────────────
// Repo-specific prose sat in `CLAUDE.md` alongside the Forge-rendered block. The
// documentation-maintainer declines that file (because of the block), and
// upgrade only ever re-renders BETWEEN the markers — so the prose had no owner
// and drifted for months, with every correction falling to the orchestrator's
// manual fallback. FG-253 answers it by RELOCATION: the volatile prose moves to a
// document the maintainer already owns and routes to, and every rendered adapter
// links there.
//
// ─── WHY THIS FILE EXISTS, AND WHY IT IS NOT MOCKED ──────────────────────────
// Installer refusal alone does NOT prove the ticket. "Forge declined to overwrite
// your file" says nothing about whether a correction to the prose has a routed,
// COMMIT-CAPABLE owner — which is the half FG-347 was opened about. So each test
// below drives the real commands in a throwaway git repo and asserts against the
// filesystem and against git objects, never against a plan object:
//
//   (a) a maintainer correction to the maintained document survives a full
//       init → upgrade cycle byte-for-byte, is a normal tracked file, and lands
//       in a REAL commit (asserted by reading the commit, not the worktree);
//   (b) an edit inside a Forge-generated region is refused — by the mechanism
//       that region actually uses, and the two mechanisms are NOT the same:
//         · an adapter file whose ownership marker is gone is FOREIGN: the bytes
//           are preserved and reported as an override;
//         · an adapter file edited WITH its marker intact is still Forge-owned,
//           so the next upgrade REFRESHES it and the edit is gone;
//         · an edit inside the `CLAUDE.md` marker block is DESTROYED by the next
//           deterministic re-render, while prose outside the block survives.
//       Each is asserted separately; one loose "the edit didn't stick" assertion
//       would pass for the wrong reason on two of the three.
//   (c) the adapter still points at the maintained prose afterwards — the link
//       survives install, refresh, override and re-render.
//
// ─── NON-VACUITY ─────────────────────────────────────────────────────────────
// Each property is expressed as a PREDICATE that is exercised in both directions
// in this file: reverting the relocation makes (a) false, an edit outside the
// block makes (b)'s destruction assertion false, and stripping the link off an
// installed adapter makes (c) false — each restored immediately after.
//
// ─── DARWIN CANONICALIZATION ─────────────────────────────────────────────────
// Every disposable root is realpathSync(mkdtempSync(join(tmpdir(), …))). On macOS
// os.tmpdir() is /var/folders/…, a symlink to /private/var/folders/…, and this
// file both process.chdir()s into its roots (runUpgrade reads process.cwd()) and
// runs git in them. An un-canonicalized root passes on Linux and fails on darwin.
// Precedent: fg253-adapter-lifecycle.integration.test.ts, doctor.test.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { Command } from "commander";
import { currentAdapterStamp, registerInit, renderedAdapterTargets } from "./init.js";
import { runUpgrade, type UpgradeResult } from "./upgrade.js";
import { assetRoot, executionMode } from "../../v2/asset-root.js";
import {
  MAINTAINED_PROSE,
  isForgeOwnedAdapter,
  regionsOwning,
  renderAdapterMarker,
} from "../../v2/operator-workflows.js";

// The orchestrator block's fence. Duplicated from init.ts the way every other
// consumer of it in this tree duplicates it (claude.ts, launch.ts,
// find-forge-projects.ts) — and asserted present in a freshly-initialized
// CLAUDE.md below, so a marker rename fails loudly here instead of quietly
// making the block tests vacuous.
const START_MARKER = "<!-- forge:orchestrator-start -->";
const END_MARKER = "<!-- forge:orchestrator-end -->";

const REAL_HOME = realpathSync(homedir());
const TMP_ROOT = realpathSync(tmpdir());

let savedHome: string | undefined;
let fakeHome = "";
const disposables: string[] = [];

function disposable(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  disposables.push(d);
  return d;
}

before(() => {
  // $HOME is pinned for the whole file: os.homedir() reads it on POSIX, so every
  // homedir()-derived path inside the commands under test resolves inside a
  // throwaway tree and the operator's real ~/.claude and ~/.codex are unreachable
  // BY CONSTRUCTION.
  savedHome = process.env["HOME"];
  fakeHome = disposable("fg253-prose-home-");
  mkdirSync(join(fakeHome, ".codex"), { recursive: true });
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "fg253-fake" }));
  process.env["HOME"] = fakeHome;
});

after(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  for (const d of disposables) rmSync(d, { recursive: true, force: true });
});

function assertHostIsolated(): void {
  assert.equal(process.env["HOME"], fakeHome, "$HOME must stay pinned to the disposable home");
  assert.equal(realpathSync(homedir()), fakeHome);
  const forgeHome = process.env["FORGE_HOME"];
  assert.ok(forgeHome, "FORGE_HOME must be set (src/test-setup.ts)");
  assert.ok(realpathSync(forgeHome).startsWith(TMP_ROOT + sep), `FORGE_HOME must be disposable, got ${forgeHome}`);
  assert.notEqual(realpathSync(forgeHome), join(REAL_HOME, ".forge"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Driving the real commands, and the real git
// ─────────────────────────────────────────────────────────────────────────────

function capture(fn: () => unknown): string {
  const lines: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    fn();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  return lines.join("\n");
}

async function captureAsync(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  return lines.join("\n");
}

/** The REAL `forge init` action, through its registered command. */
async function forgeInit(root: string): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerInit(program);
  return captureAsync(() => program.parseAsync(["node", "forge", "init", "--project", root]));
}

/** The REAL `forge upgrade` action. Reads process.cwd(), so the root must be
 *  canonical; cwd and exitCode are restored on every path. */
function forgeUpgrade(root: string): UpgradeResult {
  const savedCwd = process.cwd();
  const savedExit = process.exitCode;
  let result!: UpgradeResult;
  process.exitCode = undefined;
  process.chdir(root);
  try {
    capture(() => {
      result = runUpgrade(
        { skipGit: true, skipNpm: true },
        { mode: executionMode(), assetsDir: assetRoot(), devDir: join(root, ".no-dev-checkout") },
      );
    });
    return result;
  } finally {
    process.chdir(savedCwd);
    process.exitCode = savedExit;
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** True when git ignores `rel` — the difference between "the maintainer can
 *  commit this correction" and "this file is per-developer scratch". */
function isIgnored(root: string, rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

function isTracked(root: string, rel: string): boolean {
  return git(root, "ls-files", "--", rel).trim().length > 0;
}

/** The bytes in the COMMIT, not the worktree. "The file on disk changed" is not
 *  evidence a correction is committable; reading it back out of HEAD is. */
function committedContent(root: string, rel: string): string {
  try {
    return git(root, "show", `HEAD:${rel}`);
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The project fixture
// ─────────────────────────────────────────────────────────────────────────────

const GUIDE = MAINTAINED_PROSE.path;

const GUIDE_V1 = [
  "# Repo guide",
  "",
  "Volatile, repo-specific prose with an explicit maintenance owner.",
  "",
  "## File layout",
  "",
  "```",
  "src/",
  "├── spine/     STALE — this directory no longer exists",
  "```",
  "",
].join("\n");

/** The documentation-maintainer's correction: the FG-347 shape exactly — a stale
 *  layout tree, fixed in the document that has an owner. */
const CORRECTION = "├── v2/        YAML-driven runner — CORRECTED-BY-MAINTAINER";
const GUIDE_V2 = GUIDE_V1.replace("├── spine/     STALE — this directory no longer exists", CORRECTION);

function abs(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

function read(root: string, rel: string): string {
  return readFileSync(abs(root, rel), "utf8");
}

function write(root: string, rel: string, bytes: string): void {
  mkdirSync(dirname(abs(root, rel)), { recursive: true });
  writeFileSync(abs(root, rel), bytes);
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

/** A disposable project: a real git repo, really `forge init`'d, carrying the
 *  maintainer-owned document, with everything committed. */
async function freshProject(prefix: string): Promise<string> {
  const root = disposable(prefix);
  git(root, "init", "-q");
  git(root, "config", "user.email", "maintainer@example.invalid");
  git(root, "config", "user.name", "documentation-maintainer");
  await forgeInit(root);
  write(root, GUIDE, GUIDE_V1);
  commitAll(root, "chore: initialize forge and relocate the repo prose to a maintained document");

  const claudeMd = read(root, "CLAUDE.md");
  assert.ok(claudeMd.includes(START_MARKER), "forge init wrote no start marker — this file's block tests need one");
  assert.ok(claudeMd.includes(END_MARKER), "forge init wrote no end marker");
  return root;
}

function adapterRelPaths(): readonly string[] {
  return renderedAdapterTargets(currentAdapterStamp()).map((t) => t.relPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// The three properties, as predicates — each exercised true AND false below
// ─────────────────────────────────────────────────────────────────────────────

/** (a) The correction is durable AND committed: still on disk after the cycle,
 *  not ignored, tracked, and present in the commit object. */
function correctionIsDurableAndCommitted(root: string, rel: string, needle: string): boolean {
  const path = abs(root, rel);
  if (!existsSync(path) || !readFileSync(path, "utf8").includes(needle)) return false;
  if (isIgnored(root, rel) || !isTracked(root, rel)) return false;
  return committedContent(root, rel).includes(needle);
}

/** (b) Survival of a deterministic re-render, for content in `CLAUDE.md`. */
function survivesReRender(root: string, needle: string): boolean {
  return read(root, "CLAUDE.md").includes(needle);
}

/** (c) Every Forge-OWNED adapter on disk names the maintained document. Files an
 *  operator has taken over are excluded by ownership, not by path: forge does not
 *  get to claim a link inside somebody else's file. */
function forgeOwnedAdaptersLinkingProse(root: string): { owned: string[]; linking: string[] } {
  const owned: string[] = [];
  const linking: string[] = [];
  for (const rel of adapterRelPaths()) {
    const path = abs(root, rel);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path, "utf8");
    if (!isForgeOwnedAdapter(bytes)) continue;
    owned.push(rel);
    if (bytes.includes(MAINTAINED_PROSE.path)) linking.push(rel);
  }
  return { owned, linking };
}

function everyForgeOwnedAdapterLinksProse(root: string): boolean {
  const { owned, linking } = forgeOwnedAdaptersLinkingProse(root);
  return owned.length > 0 && owned.length === linking.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) The maintainer's correction has a routed, commit-capable path
// ─────────────────────────────────────────────────────────────────────────────

test("FG-253 (a): a maintainer correction to the maintained prose survives init → upgrade and lands in a real commit", async () => {
  const root = await freshProject("fg253-prose-correction-");

  // The document's owner is not asserted from this test's opinion — it comes from
  // the inventory the product ships, so a re-labelled region fails here too.
  const owning = regionsOwning(GUIDE);
  assert.equal(owning.length, 1, `${GUIDE} is owned by ${owning.length} regions`);
  assert.equal(owning[0]!.owner, "documentation-maintainer");
  assert.equal(owning[0]!.discipline, "owner-edits-directly");
  assert.ok(
    !adapterRelPaths().includes(GUIDE),
    "the maintained document must not be one of the files the renderers own",
  );

  // The correction itself.
  write(root, GUIDE, GUIDE_V2);
  commitAll(root, "docs: correct the stale layout tree in the repo guide");
  assert.ok(correctionIsDurableAndCommitted(root, GUIDE, CORRECTION), "the correction did not commit");

  // A full cycle of the REAL commands, in the order an operator runs them.
  const upgrade = forgeUpgrade(root);
  assert.ok(
    upgrade.projectInit === "refreshed" || upgrade.projectInit === "already-current",
    `the orchestrator block was not re-rendered (projectInit: ${upgrade.projectInit}) — this cycle proves nothing`,
  );
  await forgeInit(root);

  // Byte-for-byte, not merely "still contains the correction": a re-render that
  // reformatted the maintainer's file would be a defect too.
  assert.equal(read(root, GUIDE), GUIDE_V2, "the maintained document was modified by init/upgrade");
  assert.ok(correctionIsDurableAndCommitted(root, GUIDE, CORRECTION));
  assert.equal(
    git(root, "status", "--porcelain", "--", GUIDE).trim(),
    "",
    "the cycle left the maintained document dirty — the commit no longer describes what is on disk",
  );

  // The contrast that makes "commit-capable" mean something: the generated
  // adapters are per-developer and gitignored, so they are NOT a place a
  // correction could have been committed.
  for (const rel of adapterRelPaths()) {
    assert.ok(isIgnored(root, rel), `${rel} is not gitignored — generated adapters are per-developer`);
  }
  assert.ok(!isIgnored(root, GUIDE), `${GUIDE} is gitignored — the maintainer could not commit a correction`);
  assertHostIsolated();
});

test("FG-253 (a) non-vacuity: reverting the relocation makes the very same check FAIL", async () => {
  const root = await freshProject("fg253-prose-reverted-");

  // Revert to the FG-347 world: no maintained document, the prose back inside the
  // Forge-generated block of CLAUDE.md.
  rmSync(abs(root, GUIDE));
  const claudeMd = read(root, "CLAUDE.md");
  const at = claudeMd.indexOf(START_MARKER) + START_MARKER.length;
  write(root, "CLAUDE.md", `${claudeMd.slice(0, at)}\n\n${CORRECTION}\n${claudeMd.slice(at)}`);
  commitAll(root, "chore: revert the relocation — repo prose back inside the forge block");

  // It really was committed: this is not a test that forgot to commit.
  assert.ok(committedContent(root, "CLAUDE.md").includes(CORRECTION));
  assert.ok(isTracked(root, "CLAUDE.md") && !isIgnored(root, "CLAUDE.md"));

  forgeUpgrade(root);

  // …and the deterministic re-render destroyed it, so the property (a) asserts is
  // false here — which is what makes its success in the test above evidence.
  assert.equal(
    correctionIsDurableAndCommitted(root, "CLAUDE.md", CORRECTION),
    false,
    "prose inside the generated block survived a re-render — the relocation arm would be unnecessary",
  );
  assert.equal(correctionIsDurableAndCommitted(root, GUIDE, CORRECTION), false, "the relocation was not reverted");

  // Restore the relocation, and the property holds again in the same repo.
  write(root, GUIDE, GUIDE_V2);
  commitAll(root, "docs: relocate the repo prose back to the maintained document");
  forgeUpgrade(root);
  assert.ok(correctionIsDurableAndCommitted(root, GUIDE, CORRECTION), "restoring the relocation did not restore (a)");
  assertHostIsolated();
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) An edit inside a Forge-generated region is refused — by which mechanism
// ─────────────────────────────────────────────────────────────────────────────

test("FG-253 (b): an edit inside the CLAUDE.md marker block is DESTROYED by the re-render; prose outside it survives", async () => {
  const root = await freshProject("fg253-prose-block-edit-");

  const IN_BLOCK = "HAND EDIT INSIDE THE FORGE BLOCK";
  const OUTSIDE = "ORCHESTRATOR POLICY OUTSIDE THE FORGE BLOCK";
  const claudeMd = read(root, "CLAUDE.md");
  const at = claudeMd.indexOf(START_MARKER) + START_MARKER.length;
  write(root, "CLAUDE.md", `${claudeMd.slice(0, at)}\n\n${IN_BLOCK}\n${claudeMd.slice(at)}\n\n${OUTSIDE}\n`);
  commitAll(root, "chore: edit both regions of CLAUDE.md by hand");

  assert.ok(survivesReRender(root, IN_BLOCK), "the fixture did not land");
  assert.ok(survivesReRender(root, OUTSIDE));

  const upgrade = forgeUpgrade(root);
  assert.equal(upgrade.projectInit, "refreshed", "the block was not re-rendered, so nothing was tested");

  // The two directions of one predicate, in one state of the world: this is the
  // non-vacuity proof for (b)'s CLAUDE.md half.
  assert.equal(survivesReRender(root, IN_BLOCK), false, "an edit inside the marker block survived the re-render");
  assert.equal(survivesReRender(root, OUTSIDE), true, "the re-render destroyed prose OUTSIDE the block");

  // And the inventory says exactly this, region by region.
  const regions = regionsOwning("CLAUDE.md");
  assert.equal(regions.length, 2);
  assert.equal(regions.find((r) => r.scope === "forge-region")!.discipline, "deterministic-re-render");
  assert.equal(regions.find((r) => r.scope === "outside-forge-region")!.owner, "orchestrator");
  assertHostIsolated();
});

test("FG-253 (b): an adapter edit that keeps the marker is REFRESHED away; one that loses it is preserved as a reported override", async () => {
  const root = await freshProject("fg253-prose-adapter-edit-");
  const rel = adapterRelPaths()[0]!;
  const rendered = renderedAdapterTargets(currentAdapterStamp()).find((t) => t.relPath === rel)!.bytes;
  assert.equal(read(root, rel), rendered, "the fixture is not a clean install");

  // Mechanism 1 — the file still carries the ownership marker, so it is still
  // forge's: the next upgrade rewrites it and the edit is GONE. It is not
  // "preserved and reported"; conflating the two would be the loose assertion
  // this test exists to avoid.
  const EDIT_KEEPING_MARKER = "\nHAND EDIT WITH THE MARKER LEFT IN PLACE\n";
  write(root, rel, rendered + EDIT_KEEPING_MARKER);
  assert.ok(isForgeOwnedAdapter(read(root, rel)), "the edit must leave the file forge-owned for this half");

  const refresh = forgeUpgrade(root);
  assert.equal(refresh.adapterSurfaces, "installed");
  assert.deepEqual(refresh.adapterOverrides, [], "a marked file is not an override — it is forge's to refresh");
  assert.equal(read(root, rel), rendered, "the hand edit survived a refresh of a forge-owned adapter");

  // Mechanism 2 — the marker is gone, so the file is FOREIGN: forge declines to
  // clobber it, preserves the bytes, and reports the override.
  const MINE = "# my own orient\n\nI own this file now.\n";
  write(root, rel, MINE);
  assert.ok(!isForgeOwnedAdapter(read(root, rel)));

  const override = forgeUpgrade(root);
  assert.equal(override.adapterSurfaces, "user-override");
  assert.ok(
    override.adapterOverrides.some((line) => line.includes(rel)),
    `the override of ${rel} was not reported: ${JSON.stringify(override.adapterOverrides)}`,
  );
  assert.equal(read(root, rel), MINE, "forge overwrote a file it does not own");

  // Non-vacuity for the refusal: the same command DOES write this path when the
  // file is forge's — proved by removing it and letting the installer restore it.
  rmSync(abs(root, rel));
  assert.equal(forgeUpgrade(root).adapterSurfaces, "installed");
  assert.equal(read(root, rel), rendered, "the installer never rewrites this path, so the refusal proved nothing");
  assertHostIsolated();
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) The link to the maintained prose survives the whole cycle
// ─────────────────────────────────────────────────────────────────────────────

test("FG-253 (c): the adapters still point at the maintained prose after install, refresh, override and re-render", async () => {
  const root = await freshProject("fg253-prose-link-");

  // Install.
  const installed = forgeOwnedAdaptersLinkingProse(root);
  assert.ok(installed.owned.length >= 4, `only ${installed.owned.length} adapters installed — expected both surfaces`);
  assert.deepEqual(installed.linking, installed.owned, "a freshly installed adapter does not name the maintained doc");
  assert.ok(existsSync(abs(root, MAINTAINED_PROSE.path)), "the link points at a document that is not in the project");

  // Non-vacuity: strip the link out of one installed adapter, leaving the marker
  // in place. The check MUST fail here, or it is checking nothing.
  const rel = adapterRelPaths()[0]!;
  write(root, rel, read(root, rel).split(MAINTAINED_PROSE.path).join("docs/nowhere.md"));
  assert.equal(everyForgeOwnedAdapterLinksProse(root), false, "the link check cannot distinguish a broken link");

  // Refresh restores it — the link is not something an edit can quietly remove.
  assert.equal(forgeUpgrade(root).adapterSurfaces, "installed");
  assert.ok(everyForgeOwnedAdapterLinksProse(root), "a refresh did not restore the link");

  // Override: one adapter becomes the operator's. Forge keeps its hands off that
  // file — and every adapter forge still owns keeps the link.
  const marker = renderAdapterMarker(currentAdapterStamp());
  write(root, rel, `# my own orient\n\nNo forge marker here.\n`);
  const overrode = forgeUpgrade(root);
  assert.equal(overrode.adapterSurfaces, "user-override");
  assert.ok(!read(root, rel).includes(marker), "the override file must stay the operator's");
  const afterOverride = forgeOwnedAdaptersLinkingProse(root);
  assert.ok(!afterOverride.owned.includes(rel), "the overridden file is not forge-owned");
  assert.deepEqual(afterOverride.linking, afterOverride.owned, "an override cost the OTHER adapters their link");

  // Re-render of CLAUDE.md, and a second upgrade: still linked.
  write(root, "CLAUDE.md", read(root, "CLAUDE.md").replace(START_MARKER, `${START_MARKER}\n\nscratch\n`));
  assert.equal(forgeUpgrade(root).projectInit, "refreshed");
  assert.deepEqual(
    forgeOwnedAdaptersLinkingProse(root).linking,
    forgeOwnedAdaptersLinkingProse(root).owned,
    "a CLAUDE.md re-render cost an adapter its link",
  );

  // Give the overridden path back to forge, and the whole set links again.
  rmSync(abs(root, rel));
  forgeUpgrade(root);
  assert.ok(everyForgeOwnedAdapterLinksProse(root));
  assert.deepEqual(forgeOwnedAdaptersLinkingProse(root).owned.sort(), [...adapterRelPaths()].sort());
  assertHostIsolated();
});
