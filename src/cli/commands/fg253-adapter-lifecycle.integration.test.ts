// FG-253 step 9 — the operator-adapter LIFECYCLE, end to end, in disposable roots.
//
// Steps 4-8 each proved their own half against its own fixture. What no test held
// was the SEQUENCE an operator actually runs — `forge init`, then `forge upgrade`,
// then `forge upgrade --dry-run`, then `forge doctor` — and the invariants that
// only exist BETWEEN those commands: that a second run converges instead of
// rewriting, that a pre-FG-253 symlink install migrates to bytes, that a stamp
// bump refreshes the bytes AND clears the doctor entry it caused, and that what a
// dry run PRINTS is what the next real run DOES.
//
// Two rules this file obeys, because they are the ones that make it evidence:
//
//   1. NOTHING is hardcoded that the product derives. Every adapter path, every
//      expected byte, comes from renderedAdapterTargets()/projectAdapterBaseline()
//      — the same producers the installer and the drift detector read. A test
//      carrying its own copy of the path list would keep passing after the
//      renderers moved a file, which is precisely the drift it exists to catch.
//
//   2. The dry-run assertions compare the PRINTED PLAN against the filesystem
//      DELTA of the subsequent real run. Not against a hardcoded expectation, and
//      not against the plan object the printer also read — that would prove the
//      printer self-consistent and nothing about what the run then did.
//
// DARWIN CANONICALIZATION. Every disposable root here is
// realpathSync(mkdtempSync(join(tmpdir(), …))). On macOS os.tmpdir() is
// /var/folders/…, a symlink to /private/var/folders/…, and this file both
// process.chdir()s into its roots (runUpgrade and the doctor action read
// process.cwd()) and compares paths that came back out of cwd/realpath. An
// un-canonicalized root passes on Linux and fails on the darwin gate host.
// Precedent: doctor.test.ts (adapterProject), fg612-self-host-cli.integration,
// fg583-promoted-layout.integration, fg566-host-readiness-contract.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { Command } from "commander";
import {
  adapterDecisions,
  currentAdapterStamp,
  executeOperatorAdapters,
  planOperatorAdapters,
  registerInit,
  renderedAdapterTargets,
} from "./init.js";
import { runUpgrade, type UpgradeOptions, type UpgradeResult } from "./upgrade.js";
import { registerDoctor } from "./doctor.js";
import { assetRoot, executionMode } from "../../v2/asset-root.js";
import {
  currentAdapterStamp as doctorAdapterStamp,
  detectProjectAdapterDrift,
  projectAdapterBaseline,
  renderProjectAdapterDrift,
} from "../../v2/seed-drift.js";
import { isForgeOwnedAdapter, parseAdapterMarker } from "../../v2/operator-workflows.js";

// ─────────────────────────────────────────────────────────────────────────────
// Host isolation — asserted, not intended
// ─────────────────────────────────────────────────────────────────────────────

// Captured at module load, BEFORE $HOME is pinned below: this is the developer's
// real home, and the only thing this file ever does with it is prove it did not
// change.
const REAL_HOME = realpathSync(homedir());
const TMP_ROOT = realpathSync(tmpdir());

/** The paths under the REAL home that a lifecycle bug would write to — the
 *  provider surfaces forge renders into, plus forge's own home. Derived from the
 *  renderers for the adapter half so a renamed target is still guarded.
 *
 *  Deliberately NOT a recursive walk of ~/.claude: on the gate host an operator's
 *  Claude session may be writing under it concurrently, and a guard that fails on
 *  somebody else's unrelated write is a flake, not a proof. */
function guardedHostPaths(): string[] {
  const rendered = renderedAdapterTargets(currentAdapterStamp()).map((t) => join(REAL_HOME, ...t.relPath.split("/")));
  return [
    ...rendered,
    join(REAL_HOME, ".codex", "config.toml"),
    join(REAL_HOME, ".codex", "auth.json"),
    join(REAL_HOME, ".claude", "settings.json"),
    join(REAL_HOME, ".claude", "settings.local.json"),
    join(REAL_HOME, ".forge"),
  ];
}

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Identity of a path as a comparable string: absent, a directory's ENTRY NAMES,
 *  a link's target, or a file's hash. Directory contents by name (not mtime) so a
 *  concurrent unrelated `forge` run on the gate host cannot flip it. */
function hostFingerprint(p: string): string {
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

function hostSnapshot(): string {
  return guardedHostPaths()
    .map((p) => `${p}\t${hostFingerprint(p)}`)
    .join("\n");
}

let hostBaseline = "";
let savedHome: string | undefined;
let fakeHome = "";
const disposables: string[] = [];

/** A disposable root, canonicalized. See the darwin note in the file header. */
function disposable(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  disposables.push(d);
  return d;
}

before(() => {
  // $HOME is PINNED to a disposable home for the whole file. This is structural,
  // not hygienic: os.homedir() reads $HOME on POSIX, so every homedir()-derived
  // path inside the commands under test — including `forge upgrade`'s release
  // check, which stats ~/.codex/auth.json and ~/.aws — resolves inside a
  // throwaway tree. The operator's real ~/.codex and ~/.claude are then
  // unreachable BY CONSTRUCTION, and the snapshot below proves it held.
  savedHome = process.env["HOME"];
  fakeHome = disposable("fg253-lifecycle-home-");
  // Fake provider state, so the probes those commands run resolve against
  // something shaped like a real host instead of an empty dir.
  mkdirSync(join(fakeHome, ".codex"), { recursive: true });
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "fg253-fake" }));
  writeFileSync(join(fakeHome, ".codex", "config.toml"), 'model = "fg253-fake"\n');
  process.env["HOME"] = fakeHome;
  hostBaseline = hostSnapshot();
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
  assert.ok(
    realpathSync(forgeHome).startsWith(TMP_ROOT + sep),
    `FORGE_HOME must be disposable, got ${forgeHome}`,
  );
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

/** The REAL `forge init` action, via its registered command — `--project` rather
 *  than a chdir, so init is exercised on the path an operator's shell would give
 *  it. */
async function forgeInit(root: string, args: string[] = []): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerInit(program);
  return captureAsync(() => program.parseAsync(["node", "forge", "init", "--project", root, ...args]));
}

/** The REAL `forge upgrade` action. It reads process.cwd(), so the root must be
 *  canonical (darwin note in the header) and the cwd is restored on every path.
 *  runUpgrade reports failure through process.exitCode; captured so a refusal in
 *  an unrelated step cannot fail this whole file. */
function forgeUpgrade(root: string, options: UpgradeOptions = {}): { result: UpgradeResult; out: string } {
  const savedCwd = process.cwd();
  const savedExit = process.exitCode;
  let result!: UpgradeResult;
  process.exitCode = undefined;
  process.chdir(root);
  try {
    const out = capture(() => {
      result = runUpgrade(
        { skipGit: true, skipNpm: true, ...options },
        { mode: executionMode(), assetsDir: assetRoot(), devDir: join(root, ".no-dev-checkout") },
      );
    });
    return { result, out };
  } finally {
    process.chdir(savedCwd);
    process.exitCode = savedExit;
  }
}

async function forgeDoctor(root: string, args: string[] = []): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerDoctor(program);
  const savedCwd = process.cwd();
  const savedExit = process.exitCode;
  process.exitCode = undefined;
  process.chdir(root);
  try {
    return await captureAsync(() => program.parseAsync(["node", "forge", "doctor", ...args]));
  } finally {
    process.chdir(savedCwd);
    process.exitCode = savedExit;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem observation
// ─────────────────────────────────────────────────────────────────────────────

type FsEntry =
  | { kind: "absent" }
  | { kind: "file"; hash: string }
  | { kind: "symlink"; linkTarget: string }
  | { kind: "other" };

function inspect(abs: string): FsEntry {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { kind: "absent" };
  }
  if (st.isSymbolicLink()) return { kind: "symlink", linkTarget: readlinkSync(abs) };
  if (!st.isFile()) return { kind: "other" };
  return { kind: "file", hash: sha256(readFileSync(abs, "utf8")) };
}

const same = (a: FsEntry, b: FsEntry): boolean => JSON.stringify(a) === JSON.stringify(b);
const fileOf = (bytes: string): FsEntry => ({ kind: "file", hash: sha256(bytes) });

/** relPath → the bytes THIS release renders there. The single source both the
 *  installer and every assertion below read. */
function renderedBytes(stamp = currentAdapterStamp()): Map<string, string> {
  return new Map(renderedAdapterTargets(stamp).map((t) => [t.relPath, t.bytes]));
}

function adapterSnapshot(root: string): Map<string, FsEntry> {
  return new Map([...renderedBytes().keys()].map((rel) => [rel, inspect(join(root, ...rel.split("/")))]));
}

/** Every path under `root`, so "the dry run wrote nothing" is a claim about the
 *  whole tree rather than about the four files we happened to look at. */
function treeSnapshot(root: string): string {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, e.name);
      const here = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${here}/`);
        walk(abs, here);
      } else {
        out.push(`${here}\t${JSON.stringify(inspect(abs))}`);
      }
    }
  };
  walk(root, "");
  return out.join("\n");
}

function target(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

function relPathFor(surface: "claude-command" | "codex-skill", workflow: "orient" | "handoff"): string {
  const t = renderedAdapterTargets(currentAdapterStamp()).find((x) => x.surface === surface && x.workflow === workflow);
  assert.ok(t, `no rendered target for ${surface}/${workflow}`);
  return t.relPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fresh init
// ─────────────────────────────────────────────────────────────────────────────

test("FG-253 lifecycle: a fresh `forge init` installs every rendered adapter as marked, byte-exact REGULAR files", async () => {
  const root = disposable("fg253-lifecycle-init-");
  await forgeInit(root);

  const stamp = currentAdapterStamp();
  const rendered = renderedAdapterTargets(stamp);

  // The installer's target set and the drift detector's baseline are the same set
  // of paths. Two lists here would mean forge could install a file doctor never
  // looks at — the exact shape of "installed, and still reported missing".
  assert.deepEqual(
    rendered.map((t) => t.relPath).sort(),
    projectAdapterBaseline(stamp).map((b) => b.path).sort(),
  );
  // Both provider surfaces are actually present, so a renderer that silently
  // stopped emitting one cannot pass this file.
  assert.ok(rendered.some((t) => t.surface === "claude-command"));
  assert.ok(rendered.some((t) => t.surface === "codex-skill"));

  for (const t of rendered) {
    const abs = target(root, t.relPath);
    const st = lstatSync(abs);
    assert.ok(st.isFile(), `${t.relPath} must be a regular file, never a symlink`);
    const bytes = readFileSync(abs, "utf8");
    assert.equal(bytes, t.bytes);
    assert.ok(isForgeOwnedAdapter(bytes), `${t.relPath} must carry the ownership marker`);
    assert.equal(parseAdapterMarker(bytes), stamp);
  }
  assertHostIsolated();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 + 3. Convergence: re-init and re-upgrade are no-ops
// ─────────────────────────────────────────────────────────────────────────────

test("FG-253 lifecycle: re-running `forge init` converges — every decision already-current, not one byte rewritten", async () => {
  const root = disposable("fg253-lifecycle-reinit-");
  await forgeInit(root);
  const first = adapterSnapshot(root);

  const plan = planOperatorAdapters(root);
  assert.equal(plan.action, "already-current");
  assert.deepEqual(
    adapterDecisions(plan).map((d) => d.decision),
    adapterDecisions(plan).map(() => "already-current"),
  );

  await forgeInit(root);
  const second = adapterSnapshot(root);
  for (const [rel, before] of first) assert.ok(same(before, second.get(rel)!), `${rel} was rewritten by a re-init`);
  assertHostIsolated();
});

test("FG-253 lifecycle: `forge upgrade` after `forge init` reports already-current and rewrites nothing", async () => {
  const root = disposable("fg253-lifecycle-reupgrade-");
  await forgeInit(root);
  const before = adapterSnapshot(root);

  const { result } = forgeUpgrade(root);
  assert.equal(result.adapterSurfaces, "already-current");
  assert.equal(result.slashCommands, "already-current");
  assert.deepEqual(result.adapterOverrides, []);

  const after = adapterSnapshot(root);
  for (const [rel, b] of before) assert.ok(same(b, after.get(rel)!), `${rel} was rewritten by an upgrade`);

  // Idempotent twice, not merely once: the second upgrade sees the state the
  // first one left, which is where a rewrite-every-time bug would show.
  assert.equal(forgeUpgrade(root).result.adapterSurfaces, "already-current");
  assertHostIsolated();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The legacy install
// ─────────────────────────────────────────────────────────────────────────────

/** A pre-FG-253 project: the Claude commands are DANGLING absolute symlinks into
 *  a forge checkout's scripts/claude-commands/ (those sources no longer exist on
 *  any host), and Codex has nothing at all. */
function plantLegacyInstall(root: string): { links: string[]; deadCheckout: string } {
  const deadCheckout = join(root, ".gone", "forge");
  const links: string[] = [];
  for (const t of renderedAdapterTargets(currentAdapterStamp())) {
    const abs = target(root, t.relPath);
    rmSync(abs, { force: true });
    if (t.surface !== "claude-command") continue;
    mkdirSync(dirname(abs), { recursive: true });
    symlinkSync(join(deadCheckout, "scripts", "claude-commands", `${t.workflow}.md`), abs);
    links.push(t.relPath);
  }
  return { links, deadCheckout };
}

test("FG-253 lifecycle: `forge upgrade` migrates a legacy dangling-symlink install to bytes", async () => {
  const root = disposable("fg253-lifecycle-legacy-");
  await forgeInit(root);
  const { links, deadCheckout } = plantLegacyInstall(root);
  assert.ok(links.length > 0, "fixture precondition: the legacy install has Claude command links");
  assert.ok(!existsSync(deadCheckout), "fixture precondition: the links dangle");

  const plan = planOperatorAdapters(root);
  const decisions = new Map(adapterDecisions(plan).map((d) => [d.relPath, d.decision]));
  for (const rel of links) assert.equal(decisions.get(rel), "migrate", `${rel} must be recognised as forge's own legacy link`);
  for (const [rel, d] of decisions) if (!links.includes(rel)) assert.equal(d, "install");

  const { result } = forgeUpgrade(root);
  assert.equal(result.adapterSurfaces, "installed");

  const rendered = renderedBytes();
  for (const [rel, bytes] of rendered) {
    const abs = target(root, rel);
    assert.ok(lstatSync(abs).isFile(), `${rel} must be a regular file after migration, not a link`);
    assert.equal(readFileSync(abs, "utf8"), bytes);
  }
  // The migration REPLACED the directory entry; it did not write through the link
  // into the (absent) checkout.
  assert.ok(!existsSync(deadCheckout));
  assertHostIsolated();
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. A stamp bump: refresh the bytes AND clear the doctor entry
// ─────────────────────────────────────────────────────────────────────────────

// The stamp is a PARAMETER of both the planner and the detector, which is what
// lets one test drive two releases without promoting this host. Two distinct
// release identities, both valid per ADAPTER_STAMP_PATTERN.
const STAMP_A = "release-fg253-lifecycle-a";
const STAMP_B = "release-fg253-lifecycle-b";

function installAt(root: string, stamp: string): void {
  const plan = planOperatorAdapters(root, stamp);
  const applied = executeOperatorAdapters(plan);
  for (const o of applied.outcomes) assert.ok(o.applied === "written" || o.applied === "unchanged", `${o.relPath}: ${o.applied}`);
}

test("FG-253 lifecycle: a stamp-bumped release refreshes the bytes AND clears the doctor drift entry", () => {
  const root = disposable("fg253-lifecycle-stamp-");
  installAt(root, STAMP_A);

  const atA = new Map(renderedAdapterTargets(STAMP_A).map((t) => [t.relPath, t.bytes]));
  const atB = new Map(renderedAdapterTargets(STAMP_B).map((t) => [t.relPath, t.bytes]));

  // The release that installed them sees nothing to say.
  assert.deepEqual(detectProjectAdapterDrift(root, STAMP_A).stale, []);
  assert.equal(renderProjectAdapterDrift(detectProjectAdapterDrift(root, STAMP_A)), "");

  // The NEXT release sees every one of them as drifted — forge-owned, so its
  // remedy is one forge actually converges.
  const stale = detectProjectAdapterDrift(root, STAMP_B);
  assert.deepEqual(stale.stale.map((e) => e.path).sort(), [...atB.keys()].sort());
  for (const e of stale.stale) {
    assert.equal(e.status, "drifted");
    assert.equal(e.ownership, "forge-owned");
    assert.equal(e.stamp, STAMP_A);
  }
  assert.match(renderProjectAdapterDrift(stale), /Fix: forge upgrade/);

  // The refresh: every decision is `refresh`, and every file's bytes MOVE.
  const plan = planOperatorAdapters(root, STAMP_B);
  assert.equal(plan.action, "install");
  for (const d of adapterDecisions(plan)) assert.equal(d.decision, "refresh");
  for (const o of executeOperatorAdapters(plan).outcomes) assert.equal(o.applied, "written");

  for (const [rel, bytesB] of atB) {
    const now = readFileSync(target(root, rel), "utf8");
    assert.equal(now, bytesB);
    assert.notEqual(now, atA.get(rel), `${rel} must actually change across a stamp bump`);
    assert.equal(parseAdapterMarker(now), STAMP_B);
  }

  // …and the entry that drift reported is GONE. This is the assertion the
  // non-vacuity mutation targets (see the step 9 result notes).
  const after = detectProjectAdapterDrift(root, STAMP_B);
  assert.deepEqual(after.stale, []);
  assert.equal(renderProjectAdapterDrift(after), "");
  assertHostIsolated();
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The real `forge doctor`
// ─────────────────────────────────────────────────────────────────────────────

test("FG-253 lifecycle: `forge doctor` prints no adapter section for a converged project, and names the file when one is edited", async () => {
  const root = disposable("fg253-lifecycle-doctor-");
  // Installed through the planner rather than `forge init`, because what this test
  // is about is what doctor SAYS about an edited file. That init and doctor resolve
  // the same stamp in the first place is section 6a's job, below.
  installAt(root, doctorAdapterStamp());

  const clean = await forgeDoctor(root);
  assert.ok(
    !clean.includes("Project orientation/handoff adapters"),
    "a converged project must produce no adapter section",
  );

  // Non-vacuity, inline: one edited byte and doctor names that exact file.
  const edited = [...renderedBytes(doctorAdapterStamp()).keys()].sort()[0]!;
  const abs = target(root, edited);
  writeFileSync(abs, readFileSync(abs, "utf8") + "\nhand-edited\n");

  const dirty = await forgeDoctor(root);
  assert.match(dirty, /Project orientation\/handoff adapters/);
  assert.ok(dirty.includes(edited), `doctor must name ${edited}`);
  assert.ok(dirty.includes(root), "the section names the project doctor was invoked in");

  const json = JSON.parse(await forgeDoctor(root, ["--json"])) as {
    projectAdapters: { projectDir: string; stale: Array<{ path: string; status: string }> };
  };
  assert.equal(json.projectAdapters.projectDir, root);
  assert.deepEqual(json.projectAdapters.stale.map((e) => e.path), [edited]);
  assertHostIsolated();
});

// ─────────────────────────────────────────────────────────────────────────────
// 6a. init and doctor agree about WHICH FORGE rendered the bytes (FG-253-step9-F1)
// ─────────────────────────────────────────────────────────────────────────────

// The regression. `currentAdapterStamp()` was implemented twice: the installer
// derived a dev stamp from realpath(assetRoot()) — a PATH identity — and the drift
// detector derived one from the rendered bytes — a CONTENT identity. They did not
// even share a separator (`dev-` vs `dev.`). Under a release both read the manifest
// id and agreed, so every test above passed; on a dev checkout, which is how this
// repo is normally run, `forge init` wrote one identity and `forge doctor`
// immediately judged it against the other, reported all four adapters drifted, and
// named `forge upgrade` as the remedy — which rewrote the same bytes with the same
// disagreeing stamp, so the report was permanent.
//
// This asserts CONVERGENCE, not a single clean read: a resolver that disagreed
// would still be caught by the first doctor call, but the fixed point is what the
// operator experiences, so the sequence is run to a fixed point and every pass is
// asserted.
test("FG-253 lifecycle: on a dev checkout, `forge init` → `forge doctor` reports NO drift and `forge upgrade` converges", async () => {
  assert.equal(
    currentAdapterStamp,
    doctorAdapterStamp,
    "the installer and the drift detector must be calling ONE function, not two that agree",
  );
  if (executionMode() === "dev") {
    // The identity a dev tree resolves is the identity of its rendered BYTES.
    assert.match(currentAdapterStamp(), /^dev\.[0-9a-f]{12}$/, currentAdapterStamp());
  }

  const root = disposable("fg253-lifecycle-devstamp-");
  await forgeInit(root);

  // What init wrote is what doctor expects — checked at the marker, so a stamp
  // disagreement fails here as a stamp disagreement rather than as a byte diff.
  const installed = detectProjectAdapterDrift(root);
  assert.equal(installed.expectedStamp, currentAdapterStamp());
  for (const e of installed.entries) {
    assert.equal(e.status, "current", `${e.path}: ${e.status} (stamp on disk ${e.stamp})`);
    assert.equal(e.stamp, currentAdapterStamp(), `${e.path} carries a stamp doctor does not expect`);
  }
  assert.deepEqual(installed.stale, []);

  const clean = await forgeDoctor(root);
  assert.ok(
    !clean.includes("Project orientation/handoff adapters"),
    `a freshly initialized project must produce no adapter section:\n${clean}`,
  );

  // The remedy doctor would name has to CONVERGE. Twice, because a rewrite-every-run
  // resolver reaches a fixed point on pass two if it is going to reach one at all.
  const before = adapterSnapshot(root);
  for (const pass of [1, 2]) {
    const { result } = forgeUpgrade(root);
    assert.equal(result.adapterSurfaces, "already-current", `upgrade pass ${pass} found work to do`);
    const after = adapterSnapshot(root);
    for (const [rel, b] of before) assert.ok(same(b, after.get(rel)!), `${rel} rewritten by upgrade pass ${pass}`);
    assert.deepEqual(detectProjectAdapterDrift(root).stale, [], `drift reported after upgrade pass ${pass}`);
  }

  const afterUpgrades = await forgeDoctor(root);
  assert.ok(
    !afterUpgrades.includes("Project orientation/handoff adapters"),
    `doctor must stay silent after upgrade converges:\n${afterUpgrades}`,
  );
  assertHostIsolated();
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. --dry-run predicts the real run
// ─────────────────────────────────────────────────────────────────────────────

// The five verbs adapterReportLines can print. A printed verb is matched against
// this table exactly (optionally followed by its detail parenthetical); anything
// else fails the comparison rather than being silently ignored, because an
// unrecognized prediction is an unproven one.
const VERBS = [
  "WOULD install",
  "WOULD refresh",
  "WOULD migrate legacy symlink → bytes",
  "already current (no change)",
  "project override — LEFT ALONE",
] as const;
const WOULD_CHANGE: readonly string[] = VERBS.filter((v) => v.startsWith("WOULD"));

function canonicalVerb(raw: string): string | null {
  return VERBS.find((v) => raw === v || raw.startsWith(`${v} (`)) ?? null;
}

/** Parse the PRINTED plan. Only lines whose path is a known adapter target are
 *  taken, so the documented-absence line ("generic: no files — …") and every
 *  other `key: value` line in the report are ignored by construction. */
function printedPlan(out: string, known: ReadonlySet<string>): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^\s+(\S+):\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const path = m[1]!;
    if (!known.has(path)) continue;
    const verb = canonicalVerb(m[2]!);
    assert.ok(verb, `unrecognized planned verb for ${path}: ${JSON.stringify(m[2])}`);
    found.set(path, verb);
  }
  return found;
}

/** The heart of the dry-run contract: every printed prediction is checked against
 *  the transition the REAL run produced on disk. */
function assertPlanPredictedDelta(
  predicted: Map<string, string>,
  before: Map<string, FsEntry>,
  after: Map<string, FsEntry>,
  rendered: Map<string, string>,
): void {
  assert.deepEqual([...predicted.keys()].sort(), [...rendered.keys()].sort(), "the plan must name every adapter target");

  for (const [rel, verb] of predicted) {
    const b = before.get(rel)!;
    const a = after.get(rel)!;
    const want = fileOf(rendered.get(rel)!);
    switch (verb) {
      case "WOULD install":
        assert.equal(b.kind, "absent", `${rel}: predicted install, but something was there`);
        assert.ok(same(a, want), `${rel}: predicted install, but the bytes are not this release's`);
        break;
      case "WOULD refresh":
        assert.equal(b.kind, "file");
        assert.ok(!same(b, want), `${rel}: predicted refresh, but it was already current`);
        assert.ok(same(a, want), `${rel}: predicted refresh, but the bytes are not this release's`);
        break;
      case "WOULD migrate legacy symlink → bytes":
        assert.equal(b.kind, "symlink", `${rel}: predicted migrate, but it was not a symlink`);
        assert.ok(same(a, want), `${rel}: predicted migrate, but the bytes are not this release's`);
        break;
      case "already current (no change)":
        assert.ok(same(b, want), `${rel}: predicted already-current, but it did not hold this release's bytes`);
        assert.ok(same(a, b), `${rel}: predicted no change, but it changed`);
        break;
      case "project override — LEFT ALONE":
        assert.ok(same(a, b), `${rel}: predicted LEFT ALONE, but it changed`);
        assert.ok(!same(a, want), `${rel}: an override must not hold forge's bytes`);
        break;
      default:
        assert.fail(`unrecognized planned verb for ${rel}: ${JSON.stringify(verb)}`);
    }
  }

  // The converse, and the one that catches a plan that under-reports: the set of
  // adapter files that MOVED is exactly the set the plan said would move.
  const moved = [...before.keys()].filter((rel) => !same(before.get(rel)!, after.get(rel)!)).sort();
  const saidWouldMove = [...predicted].filter(([, v]) => WOULD_CHANGE.includes(v)).map(([rel]) => rel).sort();
  assert.deepEqual(moved, saidWouldMove, "the files that changed are exactly the files the plan predicted changing");
}

/** One root exercising ALL FIVE decisions at once: refresh (forge-owned bytes
 *  from another release), migrate (dangling legacy link), install (absent),
 *  override (an operator's own unmarked file). already-current is covered by the
 *  SECOND cycle each dry-run test runs, once these have converged. */
async function mixedStateRoot(prefix: string): Promise<string> {
  const root = disposable(prefix);
  await forgeInit(root);

  const stale = new Map(renderedAdapterTargets("release-fg253-previous").map((t) => [t.relPath, t.bytes]));
  const refresh = relPathFor("claude-command", "orient");
  const migrate = relPathFor("claude-command", "handoff");
  const install = relPathFor("codex-skill", "orient");
  const override = relPathFor("codex-skill", "handoff");

  writeFileSync(target(root, refresh), stale.get(refresh)!);
  rmSync(target(root, migrate), { force: true });
  symlinkSync(join(root, ".gone", "forge", "scripts", "claude-commands", "handoff.md"), target(root, migrate));
  rmSync(target(root, install), { force: true });
  writeFileSync(target(root, override), "# my own handoff skill\n");

  const decisions = new Map(adapterDecisions(planOperatorAdapters(root)).map((d) => [d.relPath, d.decision]));
  assert.deepEqual(
    [decisions.get(refresh), decisions.get(migrate), decisions.get(install), decisions.get(override)],
    ["refresh", "migrate", "install", "override"],
    "fixture precondition: the mixed root exercises four distinct decisions",
  );
  return root;
}

test("FG-253 lifecycle: `forge init --dry-run` writes nothing, and its printed plan is exactly what the real init then does", async () => {
  const root = await mixedStateRoot("fg253-lifecycle-dry-init-");
  const rendered = renderedBytes();
  const known = new Set(rendered.keys());

  const treeBefore = treeSnapshot(root);
  const before = adapterSnapshot(root);
  const predicted = printedPlan(await forgeInit(root, ["--dry-run"]), known);
  assert.equal(treeSnapshot(root), treeBefore, "a dry run must not write anything, anywhere under the project");

  await forgeInit(root);
  assertPlanPredictedDelta(predicted, before, adapterSnapshot(root), rendered);

  // Second cycle: now that it has converged, the plan predicts stasis — and the
  // real run delivers stasis. This is where `already current` and a persisting
  // override are proven.
  const settled = adapterSnapshot(root);
  const predicted2 = printedPlan(await forgeInit(root, ["--dry-run"]), known);
  await forgeInit(root);
  assertPlanPredictedDelta(predicted2, settled, adapterSnapshot(root), rendered);
  assert.ok(
    [...predicted2.values()].every((v) => !WOULD_CHANGE.includes(v)),
    "a converged project must predict no further writes",
  );
  assertHostIsolated();
});

test("FG-253 lifecycle: `forge upgrade --dry-run` writes nothing, and its printed plan is exactly what the real upgrade then does", async () => {
  const root = await mixedStateRoot("fg253-lifecycle-dry-upgrade-");
  const rendered = renderedBytes();
  const known = new Set(rendered.keys());

  const treeBefore = treeSnapshot(root);
  const before = adapterSnapshot(root);
  const dry = forgeUpgrade(root, { dryRun: true });
  // An override outranks the rest of the classification (classifyAdapterEntries):
  // it is the state an operator must SEE, so both the forecast and the real run
  // report it rather than the work they also did.
  assert.equal(dry.result.adapterSurfaces, "user-override");
  assert.equal(treeSnapshot(root), treeBefore, "a dry run must not write anything, anywhere under the project");

  const predicted = printedPlan(dry.out, known);
  const real = forgeUpgrade(root);
  assert.equal(real.result.adapterSurfaces, "user-override");
  assertPlanPredictedDelta(predicted, before, adapterSnapshot(root), rendered);

  // The override the dry run predicted is the override the real run reported —
  // same file, named the same way. A dry run can predict THIS exactly, because it
  // is decided by what is already on disk.
  const overridePath = relPathFor("codex-skill", "handoff");
  assert.equal(predicted.get(overridePath), "project override — LEFT ALONE");
  assert.deepEqual(dry.result.adapterOverrides, real.result.adapterOverrides);
  assert.ok(real.result.adapterOverrides.some((o) => o.includes(overridePath)));

  // Second cycle: converged apart from the override, which persists.
  const settled = adapterSnapshot(root);
  const dry2 = forgeUpgrade(root, { dryRun: true });
  const predicted2 = printedPlan(dry2.out, known);
  forgeUpgrade(root);
  assertPlanPredictedDelta(predicted2, settled, adapterSnapshot(root), rendered);
  assert.ok(
    [...predicted2.values()].every((v) => !WOULD_CHANGE.includes(v)),
    "a converged project must predict no further writes",
  );

  // Third cycle: hand the override back to forge. Now the outcome pair the
  // override was masking is reachable — would-install forecast, installed run —
  // and the delta still matches what was printed.
  rmSync(target(root, overridePath), { force: true });
  const handedBack = adapterSnapshot(root);
  const dry3 = forgeUpgrade(root, { dryRun: true });
  assert.equal(dry3.result.adapterSurfaces, "would-install");
  const predicted3 = printedPlan(dry3.out, known);
  assert.equal(forgeUpgrade(root).result.adapterSurfaces, "installed");
  assertPlanPredictedDelta(predicted3, handedBack, adapterSnapshot(root), rendered);
  assertHostIsolated();
});
