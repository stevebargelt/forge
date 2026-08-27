import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  currentAdapterStamp,
  defaultRepoSeedsDir,
  detectProjectAdapterDrift,
  detectSeedDrift,
  inspectProjectAdapters,
  isLegacyForgeSlashCommandLink,
  projectAdapterBaseline,
  renderProjectAdapterDrift,
  renderSeedDrift,
  type ProjectAdapterEntry,
  type ProjectAdapterReport,
} from "./seed-drift.js";
import { assetRoot } from "./asset-root.js";
import { isValidAdapterStamp } from "./operator-workflows.js";
import { renderClaudeCommands } from "./render-claude-commands.js";
import { renderCodexSkills } from "./render-codex-skills.js";

// Build a (repoSeeds, forgeHome) pair under a temp root and run the detector
// against them — never touches the real ~/.forge or the package seeds.
function fixture(): { repo: string; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "seed-drift-"));
  const repo = join(root, "seeds");
  const home = join(root, "forge-home");
  mkdirSync(join(repo, "runtimes"), { recursive: true });
  mkdirSync(join(repo, "workflows"), { recursive: true });
  mkdirSync(join(repo, "constraints"), { recursive: true });
  mkdirSync(join(home, "runtimes"), { recursive: true });
  mkdirSync(join(home, "workflows"), { recursive: true });
  mkdirSync(join(home, "constraints"), { recursive: true });
  return { repo, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("detectSeedDrift: identical seeds report current and ok", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "pi-apikey.yml"), "provider: ${UPSTREAM_PROVIDER}\n");
    writeFileSync(join(home, "runtimes", "pi-apikey.yml"), "provider: ${UPSTREAM_PROVIDER}\n");
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, true);
    assert.equal(r.stale.length, 0);
    assert.equal(r.entries.find((e) => e.path.endsWith("pi-apikey.yml"))?.status, "current");
  } finally {
    cleanup();
  }
});

test("detectSeedDrift: a drifted RUNTIME seed fails readiness (forge-owned + executable)", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "pi-apikey.yml"), "provider: ${UPSTREAM_PROVIDER}\n");
    writeFileSync(join(home, "runtimes", "pi-apikey.yml"), "provider: anthropic\n"); // stale
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, false);
    const e = r.stale.find((x) => x.path.endsWith("pi-apikey.yml"));
    assert.equal(e?.status, "drifted");
    assert.equal(e?.ownership, "forge-owned");
    assert.equal(e?.coupling, "executable");
  } finally {
    cleanup();
  }
});

// FG-579: workflows are forge-owned AND executable, so a stale workflow is a hard
// readiness FAIL in the same class as runtimes — the silent mis-run this ticket
// exists to stop. Before FG-579 SEED_SPECS omitted the category entirely, so this
// drift produced NO entry and readiness stayed (wrongly) ok.
test("detectSeedDrift: a drifted WORKFLOW seed fails readiness (forge-owned + executable)", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "workflows", "feature.yml"), "name: feature\nsteps: []\n");
    writeFileSync(join(home, "workflows", "feature.yml"), "name: feature\nsteps: [stale]\n"); // stale
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, false, "a stale workflow silently mis-runs → not ok");
    const e = r.stale.find((x) => x.path.endsWith("feature.yml"));
    assert.equal(e?.category, "workflows");
    assert.equal(e?.status, "drifted");
    assert.equal(e?.ownership, "forge-owned");
    assert.equal(e?.coupling, "executable");
  } finally {
    cleanup();
  }
});

// FG-579: forge-* skills install OUTSIDE $FORGE_HOME (into the Claude Code skills
// dir), so before this ticket SEED_SPECS could not see them and a drifted skill
// produced NO entry — the exact coverage gap the finding names. They are
// forge-owned (upgrade converges them) but PROSE, so drift is a reported warning,
// not a hard readiness fail.
test("detectSeedDrift: a drifted forge-* SKILL is reported (forge-owned + prose), keeps ok=true", () => {
  const root = mkdtempSync(join(tmpdir(), "seed-drift-skills-"));
  const repo = join(root, "seeds");
  const home = join(root, "forge-home");
  const skills = join(root, "claude-skills");
  try {
    mkdirSync(join(repo, "skills", "forge-review-loop"), { recursive: true });
    mkdirSync(join(skills, "forge-review-loop"), { recursive: true });
    writeFileSync(join(repo, "skills", "forge-review-loop", "SKILL.md"), "v2 guidance\n");
    writeFileSync(join(skills, "forge-review-loop", "SKILL.md"), "v1 guidance\n"); // stale

    const r = detectSeedDrift(repo, home, skills);
    assert.equal(r.ok, true, "prose skill drift is a warning, not a readiness fail");
    const e = r.stale.find((x) => x.path.endsWith("forge-review-loop/SKILL.md"));
    assert.equal(e?.category, "skills");
    assert.equal(e?.status, "drifted");
    assert.equal(e?.ownership, "forge-owned");
    assert.equal(e?.coupling, "prose");

    // forge-owned drift names forge upgrade as the converging remedy even though
    // it is prose — the [warn]/[FAIL] mark is coupling, the remedy is ownership.
    const section = renderSeedDrift(r);
    assert.match(section, /\[warn\]/);
    assert.match(section, /Forge-owned seeds \(skills\)/);
    assert.match(section, /forge upgrade/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectSeedDrift: a missing installed runtime is reported missing", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "pi-oauth.yml"), "kind: pi\n");
    const r = detectSeedDrift(repo, home); // not installed in home
    assert.equal(r.ok, false);
    assert.equal(r.stale.find((x) => x.path.endsWith("pi-oauth.yml"))?.status, "missing");
  } finally {
    cleanup();
  }
});

test("detectSeedDrift: drifted PROSE seed warns but keeps ok=true", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "constraints", "no-ai-attribution.md"), "rule v2\n");
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "rule v1\n"); // local/old
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, true); // prose drift alone is a warning, not a fail
    assert.equal(r.stale.length, 1);
    // FG-777: constraints flipped to forge-owned (always-upgraded). Coupling stays
    // PROSE, so drift is still a warning — but the ownership, and thus the remedy
    // (forge upgrade converges it), is now forge's.
    assert.equal(r.stale[0]?.ownership, "forge-owned");
    assert.equal(r.stale[0]?.coupling, "prose");
  } finally {
    cleanup();
  }
});

test("renderSeedDrift: empty when nothing is stale; FAIL marker on runtime drift", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "a.yml"), "x\n");
    writeFileSync(join(home, "runtimes", "a.yml"), "x\n");
    assert.equal(renderSeedDrift(detectSeedDrift(repo, home)), "");

    writeFileSync(join(home, "runtimes", "a.yml"), "y\n"); // now drifted
    const section = renderSeedDrift(detectSeedDrift(repo, home));
    assert.match(section, /Seed drift/);
    assert.match(section, /\[FAIL\]/);
    assert.match(section, /forge upgrade/);
  } finally {
    cleanup();
  }
});

// ─────────── FG-577 (criterion 4): the DETECTOR's baseline is release-owned ───────────
//
// seed-drift.ts:56 used to short-circuit on FORGE_REPO_DIR BEFORE the
// module-relative resolution, so a divergent or hostile ambient environment
// re-pointed the detector's own evidence and drift reported "current" against
// caller-chosen bytes — silently. The bytes are the evidence (FG-571), so the
// bytes compared AGAINST must be the executing release's own.

test("FG-577: a divergent FORGE_REPO_DIR does not redirect the detector's baseline", () => {
  const hostile = mkdtempSync(join(tmpdir(), "fg577-hostile-seeds-"));
  const home = mkdtempSync(join(tmpdir(), "fg577-forge-home-"));
  const before = process.env.FORGE_REPO_DIR;
  try {
    // A tree the caller controls, and an installed ~/.forge that matches it
    // exactly. Under the old short-circuit this pair is self-consistent, so the
    // detector declares the install "current" while never having compared it
    // against a single byte the running code actually ships.
    mkdirSync(join(hostile, "seeds", "runtimes"), { recursive: true });
    writeFileSync(join(hostile, "seeds", "runtimes", "planted.yml"), "provider: attacker\n");
    mkdirSync(join(home, "runtimes"), { recursive: true });
    writeFileSync(join(home, "runtimes", "planted.yml"), "provider: attacker\n");

    process.env.FORGE_REPO_DIR = hostile;
    assert.notEqual(defaultRepoSeedsDir(), join(hostile, "seeds"), "the baseline must not follow the ambient env");
    assert.equal(defaultRepoSeedsDir(), join(assetRoot(), "seeds"), "the baseline is the executing tree's own seeds");

    const report = detectSeedDrift(defaultRepoSeedsDir(), home);
    const planted = report.entries.find((e) => e.path === join("runtimes", "planted.yml"));
    assert.equal(planted, undefined, "the caller-chosen tree contributes no entries at all");
    assert.equal(
      report.ok,
      false,
      "a ~/.forge holding only planted bytes is stale against the real seeds — reporting it clean is the silent failure",
    );
  } finally {
    if (before === undefined) delete process.env.FORGE_REPO_DIR;
    else process.env.FORGE_REPO_DIR = before;
    rmSync(hostile, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ─────────── FG-253: project-scoped orientation/handoff adapters ───────────
//
// Every test here builds its own disposable project root under tmpdir and never
// reads or writes the developer's real project, $FORGE_HOME, ~/.codex or ~/.claude.
// The baseline is the RENDERED bytes (there is no seeds/ source for an adapter), so
// each fixture writes what a given stamp renders rather than a copied blob — a rule
// added to the provider-neutral definition changes these bytes, and the assertions
// follow it without being edited.

function projectRoot(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fg253-adapters-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const STAMP = "release-abc1234-deadbeef";
const OTHER_STAMP = "release-9999999-cafef00d";

/** Materialize what `stamp` renders, exactly as an installer would. */
function installRendered(dir: string, stamp: string): void {
  for (const base of projectAdapterBaseline(stamp)) {
    const abs = join(dir, ...base.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, base.bytes);
  }
}

function entryFor(report: ProjectAdapterReport, path: string): ProjectAdapterEntry {
  const e = report.entries.find((x) => x.path === path);
  assert.ok(e, `no entry for ${path}; entries: ${report.entries.map((x) => x.path).join(", ")}`);
  return e;
}

// The set under inspection is DERIVED from the two renderers, so a surface added
// there is inspected here without this test being edited — and a doc or installer
// naming a path forge does not render has nowhere to hide.
test("FG-253 detectProjectAdapterDrift: inspects exactly the paths the renderers export", () => {
  const { dir, cleanup } = projectRoot();
  try {
    const expected = [
      ...renderClaudeCommands(STAMP).map((c) => c.path),
      ...renderCodexSkills(STAMP).map((s) => s.path),
    ].sort();
    const r = detectProjectAdapterDrift(dir, STAMP);
    assert.deepEqual(r.entries.map((e) => e.path).sort(), expected);
    assert.equal(r.projectDir, dir);
    assert.equal(r.expectedStamp, STAMP);
  } finally {
    cleanup();
  }
});

test("FG-253: absent adapters report missing — forge-owned, prose, readiness unmoved", () => {
  const { dir, cleanup } = projectRoot();
  try {
    const r = detectProjectAdapterDrift(dir, STAMP);
    assert.equal(r.stale.length, r.entries.length);
    for (const e of r.entries) {
      assert.equal(e.status, "missing", e.path);
      assert.equal(e.ownership, "forge-owned", e.path);
      assert.equal(e.coupling, "prose", e.path);
      assert.equal(e.stamp, null, e.path);
    }
    assert.equal(r.ok, true, "a missing prose adapter is misleading guidance, not a silent mis-run");

    const section = renderProjectAdapterDrift(r);
    assert.match(section, /\[warn\] missing/);
    assert.match(section, /forge upgrade/);
    for (const e of r.entries) assert.ok(section.includes(e.path), `${e.path} is named in the remedy`);
  } finally {
    cleanup();
  }
});

test("FG-253: adapters rendered from the running release report current, and the section is silent", () => {
  const { dir, cleanup } = projectRoot();
  try {
    installRendered(dir, STAMP);
    const r = detectProjectAdapterDrift(dir, STAMP);
    assert.deepEqual(r.stale, []);
    for (const e of r.entries) {
      assert.equal(e.status, "current", e.path);
      assert.equal(e.stamp, STAMP, e.path);
    }
    assert.equal(r.ok, true);
    assert.equal(renderProjectAdapterDrift(r), "", "nothing to say → no section at all");
  } finally {
    cleanup();
  }
});

// Two ways to be forge-owned-but-not-current, and both must read the same: bytes
// carrying the marker are forge's to converge whatever release minted them.
test("FG-253: marked bytes from ANOTHER release report drifted with the installed stamp named", () => {
  const { dir, cleanup } = projectRoot();
  try {
    installRendered(dir, OTHER_STAMP);
    const r = detectProjectAdapterDrift(dir, STAMP);
    assert.equal(r.stale.length, r.entries.length);
    for (const e of r.entries) {
      assert.equal(e.status, "drifted", e.path);
      assert.equal(e.ownership, "forge-owned", e.path);
      assert.equal(e.coupling, "prose", e.path);
      assert.equal(e.stamp, OTHER_STAMP, "the OTHER release's stamp is read back, so mismatch is detectable");
    }
    assert.equal(r.ok, true, "prose drift never moves readiness");

    const section = renderProjectAdapterDrift(r);
    assert.match(section, /\[warn\] drifted/);
    assert.ok(section.includes(OTHER_STAMP), "the installed stamp is named");
    assert.ok(section.includes(STAMP), "so is the stamp this release renders");
  } finally {
    cleanup();
  }
});

test("FG-253: marked bytes hand-edited under the CURRENT stamp still report drifted", () => {
  const { dir, cleanup } = projectRoot();
  try {
    installRendered(dir, STAMP);
    const target = renderClaudeCommands(STAMP)[0]!.path;
    const abs = join(dir, ...target.split("/"));
    writeFileSync(abs, `${readFileSync(abs, "utf8")}\nhand-edited line\n`);

    const e = entryFor(detectProjectAdapterDrift(dir, STAMP), target);
    assert.equal(e.status, "drifted");
    assert.equal(e.stamp, STAMP, "the marker still says this release — the BYTES are what disagree");
    assert.equal(e.ownership, "forge-owned");
  } finally {
    cleanup();
  }
});

// The ownership boundary this ticket exists to protect: an unmarked file at an
// adapter path is the operator's. It is reported, and it is NOT named under the
// remedy line — `forge upgrade` will never touch it, so promising otherwise would
// be a remedy that converges nothing.
test("FG-253: an UNMARKED file at an adapter path is operator-owned and stays out of the remedy", () => {
  const { dir, cleanup } = projectRoot();
  try {
    installRendered(dir, STAMP);
    const mine = renderClaudeCommands(STAMP)[0]!.path;
    const abs = join(dir, ...mine.split("/"));
    writeFileSync(abs, "# my own orient command\nrun whatever I like\n");

    const r = detectProjectAdapterDrift(dir, STAMP);
    const e = entryFor(r, mine);
    assert.equal(e.status, "operator-owned");
    assert.equal(e.ownership, "operator-authored");
    assert.equal(e.coupling, "prose");
    assert.equal(e.stamp, null);
    assert.equal(r.ok, true);

    const section = renderProjectAdapterDrift(r);
    const remedy = section.split("\n").filter((l) => l.includes("forge upgrade"));
    assert.ok(remedy.length > 0, "the section still names a remedy for the rest");
    for (const line of remedy) {
      assert.ok(!line.includes(mine), `the operator's file must not appear in a remedy line: ${line}`);
    }
    assert.match(section, /they are YOURS/);
  } finally {
    cleanup();
  }
});

test("FG-253: a Codex skill directory the operator wrote is reported, never claimed", () => {
  const { dir, cleanup } = projectRoot();
  try {
    const mine = renderCodexSkills(STAMP)[0]!.path;
    const abs = join(dir, ...mine.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "---\nname: forge-orient\n---\nmy own skill\n");

    const e = entryFor(detectProjectAdapterDrift(dir, STAMP), mine);
    assert.equal(e.status, "operator-owned");
    assert.equal(e.ownership, "operator-authored");
    assert.equal(e.detail, "no forge ownership marker");
  } finally {
    cleanup();
  }
});

// Forge's OWN pre-FG-253 artifact. Reporting this as the operator's would hide a
// remedy that genuinely converges it, so the link tail is recognized — by the same
// predicate the installer's migration uses.
test("FG-253: a legacy forge slash-command symlink is forge's own, not an operator override", () => {
  const { dir, cleanup } = projectRoot();
  try {
    const target = renderClaudeCommands(STAMP).find((c) => c.workflow === "handoff")!.path;
    const abs = join(dir, ...target.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    symlinkSync("/somewhere/else/scripts/claude-commands/handoff.md", abs);

    const r = detectProjectAdapterDrift(dir, STAMP);
    const e = entryFor(r, target);
    assert.equal(e.status, "legacy-symlink");
    assert.equal(e.ownership, "forge-owned");
    assert.match(e.detail ?? "", /symlink → /);
    assert.ok(renderProjectAdapterDrift(r).includes(`converges: `));

    // ... while ANY other symlink is somebody else's and is never overwritten.
    const other = renderClaudeCommands(STAMP).find((c) => c.workflow === "orient")!.path;
    const otherAbs = join(dir, ...other.split("/"));
    symlinkSync("/somewhere/else/my-commands/orient.md", otherAbs);
    assert.equal(entryFor(detectProjectAdapterDrift(dir, STAMP), other).ownership, "operator-authored");
  } finally {
    cleanup();
  }
});

test("FG-253 isLegacyForgeSlashCommandLink: matches the tail, not the install prefix", () => {
  // The prefix cannot be checked — it is whatever path forge was installed at when
  // the link was made — so the tail is what identifies the shape. All of these are
  // dangling: `scripts/claude-commands/` exists in no forge tree any more.
  assert.equal(isLegacyForgeSlashCommandLink("/a/b/forge/scripts/claude-commands/orient.md", "orient.md"), true);
  assert.equal(isLegacyForgeSlashCommandLink("/opt/other/scripts/claude-commands/orient.md", "orient.md"), true);
  assert.equal(isLegacyForgeSlashCommandLink("/a/b/scripts/claude-commands/handoff.md", "orient.md"), false);
  assert.equal(isLegacyForgeSlashCommandLink("/a/b/my-commands/orient.md", "orient.md"), false);
});

// RF-3 / RF-4: the tail alone is not ownership. Forge's legacy artifact is dangling
// (its source was deleted when this ticket replaced the symlinks with bytes) and
// absolute (the pre-FG-253 installer resolved its source and linked the result). A
// link that resolves is somebody's live file; forge replacing that directory entry
// would take their link away on a normal `forge init`, no attacker required.
test("FG-253 isLegacyForgeSlashCommandLink: a link that RESOLVES, or is relative, is not forge's", () => {
  const tree = mkdtempSync(join(tmpdir(), "fg253-not-forge-"));
  try {
    const live = join(tree, "scripts", "claude-commands", "orient.md");
    mkdirSync(dirname(live), { recursive: true });
    writeFileSync(live, "# somebody's own orient\n");

    assert.equal(isLegacyForgeSlashCommandLink(live, "orient.md"), false, "a live target is not forge's dead artifact");
    assert.equal(isLegacyForgeSlashCommandLink(`${live}.gone`, "orient.md"), false, "…and the tail still has to match");
    assert.equal(
      isLegacyForgeSlashCommandLink("../elsewhere/scripts/claude-commands/orient.md", "orient.md"),
      false,
      "forge only ever wrote absolute links",
    );
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("FG-253: a resolving link with forge's legacy tail is reported as the operator's, with no converging remedy", () => {
  const { dir, cleanup } = projectRoot();
  const tree = mkdtempSync(join(tmpdir(), "fg253-not-forge-drift-"));
  try {
    const live = join(tree, "scripts", "claude-commands", "handoff.md");
    mkdirSync(dirname(live), { recursive: true });
    writeFileSync(live, "# somebody's own handoff\n");

    const target = renderClaudeCommands(STAMP).find((c) => c.workflow === "handoff")!.path;
    const abs = join(dir, ...target.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    symlinkSync(live, abs);

    const report = detectProjectAdapterDrift(dir, STAMP);
    const e = entryFor(report, target);
    assert.equal(e.status, "operator-owned");
    assert.equal(e.ownership, "operator-authored");
    // The remedy names only what forge converges, and forge will not touch this —
    // it belongs on the "these are YOURS" line instead.
    const rendered = renderProjectAdapterDrift(report).split("\n");
    assert.ok(!rendered.find((l) => l.includes("converges:"))?.includes(target));
    assert.ok(rendered.find((l) => l.includes("they are YOURS:"))?.includes(target));
  } finally {
    rmSync(tree, { recursive: true, force: true });
    cleanup();
  }
});

test("FG-253 renderProjectAdapterDrift: names the ONE project inspected and refuses to claim activation", () => {
  const { dir, cleanup } = projectRoot();
  try {
    const section = renderProjectAdapterDrift(detectProjectAdapterDrift(dir, STAMP));
    assert.ok(section.includes(dir), "the project path doctor actually inspected is named");
    assert.match(section, /this project only/);
    assert.match(section, /no other checkout on this host was read/);
    assert.match(section, /Installed is not active/);
  } finally {
    cleanup();
  }
});

test("FG-253 currentAdapterStamp: a usable stamp that is never a bare constant", () => {
  const stamp = currentAdapterStamp();
  assert.equal(isValidAdapterStamp(stamp), true, `${stamp} must survive the marker's HTML comment`);
  assert.equal(currentAdapterStamp(), stamp, "stable within a release");
  assert.notEqual(stamp, "dev", "a bare fallback would make two unrelated trees compare EQUAL");
  // The dev fallback is a CONTENT identity, so it tracks the definition it renders.
  if (stamp.startsWith("dev.")) assert.match(stamp, /^dev\.[0-9a-f]{12}$/);
});

// inspectProjectAdapters is the shared face the launch boundary reads: it must
// answer against a caller-supplied stamp (the generation a launch resolved), not
// against the running release it happens to be linked into.
test("FG-253 inspectProjectAdapters: judges against the stamp it is HANDED", () => {
  const { dir, cleanup } = projectRoot();
  try {
    installRendered(dir, STAMP);
    assert.ok(inspectProjectAdapters(dir, STAMP).every((e) => e.status === "current"));
    assert.ok(inspectProjectAdapters(dir, OTHER_STAMP).every((e) => e.status === "drifted"));
    assert.ok(inspectProjectAdapters(dir, OTHER_STAMP).every((e) => e.stamp === STAMP));
  } finally {
    cleanup();
  }
});
