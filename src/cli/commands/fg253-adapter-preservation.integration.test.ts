// FG-253 step 9 — the PRESERVATION invariants, as tests rather than as comments.
//
// Every other step states somewhere in prose that forge does not touch what it
// does not own. Prose is not a guard: the whole adapter installer writes into
// directories an operator also writes into (`.claude/commands/`,
// `.agents/skills/`, `CLAUDE.md`), and the failure mode — one clobbered file in
// somebody's repo — is not recoverable from a report. So the protected set is
// hashed BEFORE a full init + upgrade + dry-run + doctor cycle and asserted
// byte-identical AFTER it.
//
// The set, from the ticket: AGENTS.md, Codex config, unrelated `.agents/skills/*`
// entries, foreign files sitting at forge's OWN adapter paths, and the CLAUDE.md
// prose OUTSIDE the orchestrator marker block.
//
// NON-VACUITY IS PART OF THE POINT. A cycle that did nothing would preserve
// everything, so each test also asserts the work forge DID do: the adapters it
// owns were installed, and the orchestrator block itself was replaced (the
// fixture's block is deliberately stale). Preservation is only meaningful beside
// a real write.
//
// DARWIN CANONICALIZATION. Every disposable root is
// realpathSync(mkdtempSync(join(tmpdir(), …))): os.tmpdir() on macOS is
// /var/folders/…, a symlink to /private/var/folders/…, and `forge upgrade` and
// `forge doctor` read process.cwd(), which is always canonical. Comparing an
// un-canonicalized root against a cwd-derived path passes on Linux and fails on
// the darwin gate host. Precedent: doctor.test.ts (adapterProject),
// fg612-self-host-cli.integration, fg583-promoted-layout.integration.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Command } from "commander";
import { currentAdapterStamp, registerInit, renderedAdapterTargets } from "./init.js";
import { runUpgrade, type UpgradeResult } from "./upgrade.js";
import { registerDoctor } from "./doctor.js";
import { assetRoot, executionMode } from "../../v2/asset-root.js";
import { CODEX_SKILLS_ROOT, isForgeOwnedCodexSkillDir } from "../../v2/render-codex-skills.js";
import { isForgeOwnedAdapter } from "../../v2/operator-workflows.js";

// ─────────────────────────────────────────────────────────────────────────────
// Host isolation — asserted, not intended
// ─────────────────────────────────────────────────────────────────────────────

// Captured at module load, BEFORE $HOME is pinned: the developer's real home.
// The only thing this file does with it is prove it did not change.
const REAL_HOME = realpathSync(homedir());
const TMP_ROOT = realpathSync(tmpdir());

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fingerprint(p: string): string {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) return `symlink:${readlinkSync(p)}`;
  if (st.isDirectory()) return `dir:${readdirSync(p).sort().join(",")}`;
  if (!st.isFile()) return "other";
  return `file:${sha256(readFileSync(p, "utf8"))}`;
}

/** The real-home paths a preservation bug would reach: the provider surfaces
 *  forge renders into (derived from the renderers, so a renamed target stays
 *  guarded), the Codex credential/config files `forge upgrade`'s release check
 *  stats, and forge's own home. Not a recursive walk of ~/.claude — on the gate
 *  host an operator's session may be writing under it concurrently, and a guard
 *  that trips on somebody else's write is a flake, not a proof. */
function guardedHostPaths(): string[] {
  return [
    ...renderedAdapterTargets(currentAdapterStamp()).map((t) => join(REAL_HOME, ...t.relPath.split("/"))),
    join(REAL_HOME, "AGENTS.md"),
    join(REAL_HOME, ".codex", "config.toml"),
    join(REAL_HOME, ".codex", "auth.json"),
    join(REAL_HOME, ".claude", "settings.json"),
    join(REAL_HOME, ".claude", "settings.local.json"),
    join(REAL_HOME, ".forge"),
  ];
}

function hostSnapshot(): string {
  return guardedHostPaths().map((p) => `${p}\t${fingerprint(p)}`).join("\n");
}

let hostBaseline = "";
let savedHome: string | undefined;
let fakeHome = "";
let fakeHomeBaseline = "";
const disposables: string[] = [];

function disposable(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  disposables.push(d);
  return d;
}

/** The provider state a real host carries, faked in a disposable home. It exists
 *  so the probes these commands run resolve against something host-shaped — and
 *  so "forge does not edit the operator's Codex credentials" is checkable here
 *  too, not only at the project level. */
function fakeProviderHome(): { home: string; files: string[] } {
  const home = disposable("fg253-preserve-home-");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: "fg253-fake" }, null, 2));
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "fg253-fake"\napproval_policy = "never"\n');
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "fg253-fake" }, null, 2));
  return {
    home,
    files: [
      join(home, ".codex", "auth.json"),
      join(home, ".codex", "config.toml"),
      join(home, ".claude", "settings.json"),
    ],
  };
}

before(() => {
  // $HOME is PINNED for the whole file: os.homedir() reads $HOME on POSIX, so
  // every homedir()-derived path inside the commands under test resolves inside a
  // throwaway tree and the operator's real ~/.codex and ~/.claude are unreachable
  // BY CONSTRUCTION. The snapshots then prove it held.
  savedHome = process.env["HOME"];
  const fake = fakeProviderHome();
  fakeHome = fake.home;
  process.env["HOME"] = fakeHome;
  hostBaseline = hostSnapshot();
  fakeHomeBaseline = fake.files.map((p) => `${p}\t${fingerprint(p)}`).join("\n");
});

after(() => {
  try {
    assertHostIsolated();
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    for (const d of disposables) rmSync(d, { recursive: true, force: true });
  }
});

/** The hard requirement, as an assertion. Called at the end of every test. */
function assertHostIsolated(): void {
  assert.equal(process.env["HOME"], fakeHome, "$HOME must stay pinned to the disposable home");
  assert.equal(realpathSync(homedir()), fakeHome, "homedir() must resolve inside the disposable home");
  const forgeHome = process.env["FORGE_HOME"];
  assert.ok(forgeHome, "FORGE_HOME must be set (src/test-setup.ts)");
  assert.ok(realpathSync(forgeHome).startsWith(TMP_ROOT + sep), `FORGE_HOME must be disposable, got ${forgeHome}`);
  assert.notEqual(realpathSync(forgeHome), join(REAL_HOME, ".forge"));
  assert.equal(hostSnapshot(), hostBaseline, "a real-home path guarded by this suite changed");
}

// ─────────────────────────────────────────────────────────────────────────────
// Driving the real commands
// ─────────────────────────────────────────────────────────────────────────────

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

async function forgeInit(root: string, args: string[] = []): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerInit(program);
  return captureAsync(() => program.parseAsync(["node", "forge", "init", "--project", root, ...args]));
}

function forgeUpgrade(root: string, options: { dryRun?: boolean } = {}): UpgradeResult {
  const savedCwd = process.cwd();
  const savedExit = process.exitCode;
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  process.exitCode = undefined;
  process.chdir(root);
  try {
    return runUpgrade(
      { skipGit: true, skipNpm: true, ...options },
      { mode: executionMode(), assetsDir: assetRoot(), devDir: join(root, ".no-dev-checkout") },
    );
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    process.chdir(savedCwd);
    process.exitCode = savedExit;
  }
}

async function forgeDoctor(root: string): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerDoctor(program);
  const savedCwd = process.cwd();
  const savedExit = process.exitCode;
  process.exitCode = undefined;
  process.chdir(root);
  try {
    return await captureAsync(() => program.parseAsync(["node", "forge", "doctor"]));
  } finally {
    process.chdir(savedCwd);
    process.exitCode = savedExit;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The fixture: a project that already belongs to somebody
// ─────────────────────────────────────────────────────────────────────────────

// Prose either side of the orchestrator block. The head ends with a blank line
// and the tail starts with one so `applyOrchestratorBlock`'s join logic has
// nothing to normalize — anything it DID normalize would be a change to the
// operator's bytes, which is the thing under test.
const HEAD_PROSE = "# Acme Platform\n\nOur own instructions live above forge's block.\n\n";
const TAIL_PROSE = "\n## Acme deploy runbook\n\nNever touched by forge.\n";
const STALE_BLOCK_LINE = "STALE-BLOCK-LINE-THAT-MUST-BE-REPLACED";

/** The orchestrator template, read from the executing tree — the same bytes
 *  `forge init` splices in. Used to build a CLAUDE.md whose block is genuinely
 *  forge's (so the markers are real) but STALE (so the cycle must replace it). */
function orchestratorTemplate(): string {
  return readFileSync(join(assetRoot(), "seeds", "orchestrator-template.md"), "utf8");
}

type Protected = { rel: string; bytes: string; note: string };

/** Everything this suite refuses to let forge touch, written into `root`. */
function plantProtectedFiles(root: string): Protected[] {
  const rendered = renderedAdapterTargets(currentAdapterStamp());
  const claudeForeign = rendered.find((t) => t.surface === "claude-command" && t.workflow === "handoff");
  const codexForeign = rendered.find((t) => t.surface === "codex-skill" && t.workflow === "handoff");
  assert.ok(claudeForeign && codexForeign, "fixture precondition: both surfaces render a handoff target");

  // The unrelated skill must be one forge does not own — asserted against the
  // renderer's own predicate rather than assumed from the name.
  const unrelatedSkill = "acme-release-checklist";
  assert.ok(!isForgeOwnedCodexSkillDir(unrelatedSkill), "fixture precondition: the neighbour skill is not forge's");

  const files: Protected[] = [
    { rel: "AGENTS.md", bytes: "# Acme agent instructions\n\nProvider-neutral, ours, not forge's.\n", note: "AGENTS.md" },
    { rel: ".codex/config.toml", bytes: 'model = "acme"\nsandbox_mode = "workspace-write"\n', note: "project Codex config" },
    {
      rel: `${CODEX_SKILLS_ROOT}/${unrelatedSkill}/SKILL.md`,
      bytes: "---\nname: acme-release-checklist\ndescription: 'ours'\n---\n\nOur skill.\n",
      note: "an unrelated Codex skill",
    },
    {
      rel: `${CODEX_SKILLS_ROOT}/README.md`,
      bytes: "Skills in this directory are owned by the Acme team.\n",
      note: "a file directly under the skills root",
    },
    { rel: claudeForeign.relPath, bytes: "# our own /handoff\n\nNo forge marker anywhere in here.\n", note: "a foreign file at a forge Claude-command path" },
    { rel: codexForeign.relPath, bytes: "---\nname: forge-handoff\ndescription: 'ours'\n---\n\nOurs.\n", note: "a foreign file at a forge Codex-skill path" },
    {
      rel: "CLAUDE.md",
      bytes: HEAD_PROSE + orchestratorTemplate().replace("# forge orchestrator", `# forge orchestrator\n\n${STALE_BLOCK_LINE}`) + TAIL_PROSE,
      note: "CLAUDE.md",
    },
  ];

  for (const f of files) {
    const abs = join(root, ...f.rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.bytes);
    assert.ok(!isForgeOwnedAdapter(f.bytes), `fixture precondition: ${f.rel} carries no forge ownership marker`);
  }
  return files;
}

function hashOf(root: string, rel: string): string {
  return sha256(readFileSync(join(root, ...rel.split("/")), "utf8"));
}

/** The whole operator-facing cycle, in the order an operator runs it. */
async function fullCycle(root: string): Promise<{ init: string; upgrade: UpgradeResult; doctor: string }> {
  const init = await forgeInit(root);
  const upgrade = forgeUpgrade(root);
  await forgeInit(root, ["--dry-run"]);
  forgeUpgrade(root, { dryRun: true });
  const doctor = await forgeDoctor(root);
  return { init, upgrade, doctor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("FG-253 preservation: a full init + upgrade cycle leaves every protected operator file byte-identical", async () => {
  const root = disposable("fg253-preserve-cycle-");
  const planted = plantProtectedFiles(root);
  const before = new Map(planted.filter((f) => f.rel !== "CLAUDE.md").map((f) => [f.rel, hashOf(root, f.rel)]));

  const { upgrade } = await fullCycle(root);

  for (const [rel, hash] of before) {
    const note = planted.find((f) => f.rel === rel)!.note;
    assert.equal(hashOf(root, rel), hash, `${note} (${rel}) was modified by the cycle`);
  }

  // Non-vacuity: the cycle DID work. The two adapter paths nobody claimed were
  // installed with this release's bytes, so the preservation above is a statement
  // about a run that wrote files, not about a no-op.
  const rendered = renderedAdapterTargets(currentAdapterStamp());
  const foreign = new Set(planted.map((f) => f.rel));
  const installed = rendered.filter((t) => !foreign.has(t.relPath));
  assert.ok(installed.length > 0, "the cycle must have had adapters to install");
  for (const t of installed) {
    assert.equal(readFileSync(join(root, ...t.relPath.split("/")), "utf8"), t.bytes, `${t.relPath} should have been installed`);
  }
  assert.equal(upgrade.adapterSurfaces, "user-override");
  assertHostIsolated();
});

test("FG-253 preservation: forge REPORTS the files it left alone rather than silently skipping them", async () => {
  const root = disposable("fg253-preserve-report-");
  const planted = plantProtectedFiles(root);
  const foreignAdapters = planted
    .filter((f) => renderedAdapterTargets(currentAdapterStamp()).some((t) => t.relPath === f.rel))
    .map((f) => f.rel);
  assert.equal(foreignAdapters.length, 2, "fixture precondition: one foreign file on each provider surface");

  const { init, upgrade, doctor } = await fullCycle(root);

  for (const rel of foreignAdapters) {
    assert.ok(init.includes(rel), `forge init must name ${rel} as left alone`);
    assert.ok(
      upgrade.adapterOverrides.some((o) => o.includes(rel)),
      `forge upgrade --json must carry ${rel} in adapterOverrides`,
    );
    assert.ok(doctor.includes(rel), `forge doctor must name ${rel}`);
    // …and never under a remedy that claims forge would converge it.
    for (const line of doctor.split("\n").filter((l) => l.includes("forge upgrade"))) {
      assert.ok(!line.includes(rel), `an operator-owned file appeared under a forge remedy: ${line}`);
    }
  }
  assertHostIsolated();
});

test("FG-253 preservation: CLAUDE.md prose OUTSIDE the marker block survives a block replacement byte-for-byte", async () => {
  const root = disposable("fg253-preserve-claudemd-");
  plantProtectedFiles(root);
  const original = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.ok(original.includes(STALE_BLOCK_LINE), "fixture precondition: the block starts stale");

  await fullCycle(root);
  const after = readFileSync(join(root, "CLAUDE.md"), "utf8");

  // Non-vacuity first: the block really was replaced. Without this, "the prose
  // survived" would also pass on a cycle that did nothing to CLAUDE.md at all.
  assert.ok(!after.includes(STALE_BLOCK_LINE), "the stale orchestrator block should have been replaced");
  assert.notEqual(after, original);

  assert.ok(after.startsWith(HEAD_PROSE), "prose above the start marker must survive verbatim");
  assert.ok(after.endsWith(TAIL_PROSE), "prose below the end marker must survive verbatim");
  assert.equal(sha256(after.slice(0, HEAD_PROSE.length)), sha256(HEAD_PROSE));
  assert.equal(sha256(after.slice(after.length - TAIL_PROSE.length)), sha256(TAIL_PROSE));
  assert.equal(after.split(HEAD_PROSE).length - 1, 1, "the head prose must not be duplicated");
  assert.equal(after.split(TAIL_PROSE).length - 1, 1, "the tail prose must not be duplicated");
  assertHostIsolated();
});

test("FG-253 preservation: the operator's `.agents/skills/` neighbours are untouched, and only forge's own dirs are gitignored", async () => {
  const root = disposable("fg253-preserve-skills-");
  const planted = plantProtectedFiles(root);
  const skillsRoot = join(root, ...CODEX_SKILLS_ROOT.split("/"));
  const before = readdirSync(skillsRoot).sort();

  await fullCycle(root);

  const after = readdirSync(skillsRoot).sort();
  // Forge ADDED its own directories and removed none of the operator's.
  for (const name of before) assert.ok(after.includes(name), `forge removed ${name} from ${CODEX_SKILLS_ROOT}`);
  for (const name of after.filter((n) => !before.includes(n))) {
    assert.ok(isForgeOwnedCodexSkillDir(name), `forge created ${name}, which it does not own`);
  }

  for (const f of planted.filter((p) => p.rel.startsWith(CODEX_SKILLS_ROOT))) {
    assert.equal(readFileSync(join(root, ...f.rel.split("/")), "utf8"), f.bytes, `${f.rel} was modified`);
  }

  // The .gitignore entries are PER-DIRECTORY: ignoring the shared parent would
  // silently un-commit the operator's own skills.
  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.ok(!gitignore.split("\n").some((l) => l.trim() === `${CODEX_SKILLS_ROOT}/`), "the skills root must never be ignored wholesale");
  for (const t of renderedAdapterTargets(currentAdapterStamp()).filter((x) => x.surface === "codex-skill")) {
    const dir = t.relPath.slice(0, t.relPath.lastIndexOf("/"));
    assert.ok(gitignore.includes(`${dir}/`), `${dir}/ should be gitignored`);
  }
  assertHostIsolated();
});

test("FG-550: init and upgrade deliver the handoff memory-drift guard, repair Forge bytes, and retain a project override", async () => {
  const root = disposable("fg550-handoff-adapter-");
  const target = renderedAdapterTargets(currentAdapterStamp()).find(
    (entry) =>
      entry.surface === "claude-command" && entry.workflow === "handoff",
  );
  assert.ok(
    target,
    "fixture precondition: Forge renders a /handoff Claude command",
  );
  const handoffPath = join(root, ...target.relPath.split("/"));

  // A fresh real `forge init` must expose the current canonical workflow through
  // its project adapter. This is intentionally an end-to-end assertion over the
  // provisioned bytes rather than a second assertion about the source definition.
  await forgeInit(root);
  assert.equal(readFileSync(handoffPath, "utf8"), target.bytes);
  const installed = readFileSync(handoffPath, "utf8");
  assert.match(installed, /Memories this session may have invalidated/);
  assert.match(installed, /specific file/i);
  assert.match(installed, /one-line proposed correction/i);
  assert.match(installed, /OWN changes or decisions contradict/);
  assert.match(installed, /do not scan or re-review the whole memory corpus/i);
  assert.match(installed, /Do not write or refresh a `reviewed:` stamp/);

  // A stale Forge-owned adapter is safe for upgrade to repair. Keep the ownership
  // marker intact while removing the new contract, so this proves ownership-based
  // refresh rather than an install into an absent path.
  const stale = installed.replace(
    "**Memories this session may have invalidated:**",
    "**Memory notes:**",
  );
  assert.notEqual(
    stale,
    installed,
    "fixture precondition: the rendered handoff contains the FG-550 section",
  );
  writeFileSync(handoffPath, stale);
  const repaired = forgeUpgrade(root);
  assert.equal(
    readFileSync(handoffPath, "utf8"),
    target.bytes,
    "forge upgrade must refresh Forge-owned handoff bytes",
  );
  assert.notEqual(
    repaired.adapterSurfaces,
    "user-override",
    "a repaired Forge adapter is not a project override",
  );

  // Once the project deliberately replaces the regular file, both provisioning
  // paths must retain it. This is the modern equivalent of preserving an
  // intentional project-local command override; Forge no longer installs command
  // symlinks, so the adapter is materialized and ownership-marked instead.
  const projectOverride =
    "# Project handoff override\n\nKeep this command local.\n";
  writeFileSync(handoffPath, projectOverride);
  const initOutput = await forgeInit(root);
  const overrideResult = forgeUpgrade(root);
  assert.equal(readFileSync(handoffPath, "utf8"), projectOverride);
  assert.ok(
    initOutput.includes(target.relPath),
    "forge init must report the retained project-local handoff override",
  );
  assert.ok(
    overrideResult.adapterOverrides.some((entry) =>
      entry.includes(target.relPath),
    ),
    "forge upgrade must report the retained project-local handoff override",
  );
  assert.equal(overrideResult.adapterSurfaces, "user-override");
  assertHostIsolated();
});

test("FG-253 preservation: the cycle never writes provider state into the home directory", async () => {
  const root = disposable("fg253-preserve-home-");
  plantProtectedFiles(root);

  await fullCycle(root);

  // The FAKE home stands in for the operator's: forge renders adapters into the
  // PROJECT, so a home-directory write is a bug wherever the home points.
  const now = [join(fakeHome, ".codex", "auth.json"), join(fakeHome, ".codex", "config.toml"), join(fakeHome, ".claude", "settings.json")]
    .map((p) => `${p}\t${fingerprint(p)}`)
    .join("\n");
  assert.equal(now, fakeHomeBaseline, "the cycle modified provider state in the home directory");

  for (const t of renderedAdapterTargets(currentAdapterStamp())) {
    assert.equal(fingerprint(join(fakeHome, ...t.relPath.split("/"))), "absent", `${t.relPath} was rendered into the home directory`);
  }
  assertHostIsolated();
});
