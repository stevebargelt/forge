// FG-253 step 8 — the host/project generation split, at the launch boundary.
//
// THE THING BEING PROVEN. Forge owns `$FORGE_HOME` and does not own a consumer repo,
// so the sha-pinned generation a launch resolves and the project's installed operator
// adapters can never be written atomically. This step does not try; it buys
// DETECTABILITY instead. Every test below is therefore of the same shape: put the
// project and the launch into a specific state of (dis)agreement, launch, and assert
// on WHAT WAS REPORTED — never on whether the launch was allowed. A session launches
// in all three states and the exit code is the child's in all three states.
//
// WHAT IS DELIBERATELY NOT ASSERTED ANYWHERE IN THIS FILE. That a written file was
// loaded by the provider. Forge can observe bytes on disk; it cannot observe a build
// reading them, and it runs no discovery probe on either adapter path — the capability
// matrix states that gap outright for Codex (skills/commands activation UNVERIFIED).
// An assertion of the form "the file is there, so /orient works" would make this suite
// testify to something forge has no evidence for, so the only claim made about
// installed bytes here is that they are installed.
//
// Everything runs against a FAKE `claude` on PATH and disposable FORGE_HOME /
// FORGE_DB_PATH / FORGE_ORCHESTRATORS_DIR / CLAUDE_CONFIG_DIR roots: no billed
// session, no real auth, no operator state read or written (AC13).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "../store/db.js";
import { listOrchestratorReceiptsForProject } from "../store/orchestrator-receipts.js";
import { currentAdapterStamp } from "../cli/commands/init.js";
import { projectAdapterBaseline } from "../v2/seed-drift.js";
import type { AdapterStamp } from "../v2/operator-workflows.js";
import { claudeProjectPreflight } from "./claude-adapter.js";
import { inspectLaunchAdapterGeneration, runOrchestratorLaunch } from "./launch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(HERE, "__fixtures__", "fake-claude.js");

/** A stamp that is valid, well-formed, and is NOT the one this checkout resolves —
 *  the "adapters from another release" fixture. */
const OTHER_GENERATION: AdapterStamp = "release-fg253-othergen-0001";

const POLICY = `
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity: {}
`;

type Roots = {
  base: string;
  home: string;
  db: string;
  orchestrators: string;
  project: string;
  bin: string;
  record: string;
  claudeConfig: string;
};

let roots: Roots;
let envSnapshot: Record<string, string | undefined>;

const MANAGED_ENV = [
  "FORGE_HOME",
  "FORGE_DB_PATH",
  "FORGE_ORCHESTRATORS_DIR",
  "CLAUDE_CONFIG_DIR",
  "FORGE_CLAUDE_STATE_DIR",
  "FAKE_CLAUDE_RECORD",
  "FAKE_CLAUDE_MODE",
  "PATH",
] as const;

function makeRoots(): Roots {
  // realpathSync, ALWAYS. On macOS os.tmpdir() is /var/folders/…, a symlink to
  // /private/var/folders/…, and this fixture's path is compared against a value that
  // has been through path resolution (resolveOrchestratorProjectRoot) and is handed to
  // a spawned child as its cwd. An un-canonicalized root passes on Linux and fails on
  // a darwin host — see doctor.test.ts, fg612-self-host-cli.integration.test.ts.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg253-launch-stamp-")));
  const home = join(base, "forge-home");
  const project = join(base, "project");
  const bin = join(base, "bin");
  const orchestrators = join(base, "orchestrators");
  const claudeConfig = join(base, "claude-config");
  for (const dir of [home, project, bin, orchestrators, claudeConfig]) mkdirSync(dir, { recursive: true });

  writeFileSync(join(home, "model-policy.yml"), POLICY, "utf8");
  writeFileSync(join(project, "CLAUDE.md"), `<!-- forge:orchestrator-start -->\nproject policy\n`, "utf8");

  const fake = join(bin, "claude");
  copyFileSync(FAKE_CLAUDE, fake);
  chmodSync(fake, 0o755);

  return {
    base,
    home,
    db: join(home, "forge.db"),
    orchestrators,
    project,
    bin,
    record: join(base, "record.json"),
    claudeConfig,
  };
}

function applyEnv(overrides: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    FORGE_HOME: roots.home,
    FORGE_DB_PATH: roots.db,
    FORGE_ORCHESTRATORS_DIR: roots.orchestrators,
    CLAUDE_CONFIG_DIR: roots.claudeConfig,
    FAKE_CLAUDE_RECORD: roots.record,
    PATH: `${roots.bin}:${process.env["PATH"] ?? ""}`,
    ...overrides,
  };
  for (const key of MANAGED_ENV) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
}

/** Write the adapter files this release renders for `stamp` into the project — the
 *  same bytes `forge init` materializes, from the same producer, so a fixture cannot
 *  drift from the installer. */
function installAdapters(stamp: AdapterStamp): string[] {
  const written: string[] = [];
  for (const base of projectAdapterBaseline(stamp)) {
    const target = join(roots.project, ...base.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, base.bytes, "utf8");
    written.push(base.path);
  }
  return written;
}

type Launched = { exitCode: number; spawned: boolean; reported: string };

async function launch(overrides: Record<string, string> = {}): Promise<Launched> {
  applyEnv(overrides);
  const lines: string[] = [];
  const outcome = await runOrchestratorLaunch({
    commandName: "forge orchestrator",
    cwd: roots.project,
    heartbeatsDir: roots.orchestrators,
    stdio: "ignore",
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  return { exitCode: outcome.exitCode, spawned: outcome.spawned, reported: lines.join("\n") };
}

function receiptLimitation(capability: string): { capability: string; note: string } | undefined {
  return listOrchestratorReceiptsForProject(roots.project)[0]?.limitations.find((l) => l.capability === capability);
}

/** The advisory lines that are about the operator adapters, and nothing else — the
 *  half-configured project also warns about settings.local.json, which is a different
 *  finding with a different remedy and must not be read as this one. */
function adapterAdvisories(reported: string): string[] {
  return reported.split("\n").filter((l) => /orient|handoff|generation/i.test(l));
}

beforeEach(() => {
  roots = makeRoots();
  envSnapshot = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  closeDb();
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  rmSync(roots.base, { recursive: true, force: true });
});

// ─── agreement: nothing to report ───────────────────────────────────────────

test("integ FG-253: adapters carrying the resolved generation's stamp launch with NO adapter warning", async () => {
  installAdapters(currentAdapterStamp());

  const launched = await launch();

  assert.equal(launched.spawned, true);
  assert.equal(launched.exitCode, 0);
  assert.ok(existsSync(roots.record), "the provider binary was never launched");
  assert.deepEqual(adapterAdvisories(launched.reported), [], launched.reported);
  assert.equal(
    receiptLimitation("operator-adapters"),
    undefined,
    "an agreeing project must record no split — a limitation here is a false report",
  );
});

// ─── a different release: NAME BOTH, launch anyway ──────────────────────────

test("integ FG-253: adapters from ANOTHER generation are reported naming BOTH stamps, and the session still launches", async () => {
  installAdapters(OTHER_GENERATION);
  const resolved = currentAdapterStamp();
  assert.notEqual(resolved, OTHER_GENERATION, "the fixture stamp must differ from the resolved one");

  const launched = await launch();

  // Reported, not refused.
  assert.equal(launched.spawned, true);
  assert.equal(launched.exitCode, 0);
  assert.ok(existsSync(roots.record), "a reported split must never stop the session");

  const advisories = adapterAdvisories(launched.reported).join("\n");
  assert.match(advisories, new RegExp(escapeRe(OTHER_GENERATION)), "the installed generation was not named");
  assert.match(advisories, new RegExp(escapeRe(resolved)), "the resolved generation was not named");
  assert.match(advisories, /\.claude\/commands\/orient\.md/);
  assert.match(advisories, /\.claude\/commands\/handoff\.md/);

  // The durable half: `forge show` can still answer this after the session is gone.
  const recorded = receiptLimitation("operator-adapters");
  assert.ok(recorded, "the split was printed but not recorded on the session record");
  assert.match(recorded.note, new RegExp(escapeRe(OTHER_GENERATION)));
  assert.match(recorded.note, new RegExp(escapeRe(resolved)));
});

test("integ FG-253: a reported split does not move the exit code — the child's is the session's", async () => {
  installAdapters(OTHER_GENERATION);

  const launched = await launch({ FAKE_CLAUDE_MODE: "exit:7" });

  assert.equal(launched.spawned, true);
  assert.equal(launched.exitCode, 7, "the adapter split rewrote the child's exit code");
  assert.ok(receiptLimitation("operator-adapters"), "the split was silently dropped");
});

// ─── absence: named, not silent ─────────────────────────────────────────────

test("integ FG-253: adapters absent while the surface advertises them are named, and the session still launches", async () => {
  const launched = await launch();

  assert.equal(launched.spawned, true);
  assert.equal(launched.exitCode, 0);

  const advisories = adapterAdvisories(launched.reported).join("\n");
  assert.match(advisories, /\.claude\/commands\/orient\.md/);
  assert.match(advisories, /\.claude\/commands\/handoff\.md/);
  assert.match(advisories, /\/orient/);
  assert.match(advisories, /forge init/);

  const recorded = receiptLimitation("operator-adapters");
  assert.ok(recorded, "absent adapters were not recorded on the session record");
  assert.match(recorded.note, /absent/);
});

// ─── present, but no generation resolves ────────────────────────────────────

test("integ FG-253: an unmarked file at an adapter path is reported as ungeneratable, never claimed or overwritten", async () => {
  const mine = join(roots.project, ".claude", "commands", "orient.md");
  mkdirSync(dirname(mine), { recursive: true });
  writeFileSync(mine, "# my own orientation command\n", "utf8");

  const launched = await launch();

  assert.equal(launched.spawned, true);
  const advisories = adapterAdvisories(launched.reported).join("\n");
  assert.match(advisories, /no forge ownership marker/);
  assert.match(recordedNote(), /no forge ownership marker/);

  // Reported is not repaired: the operator's bytes are exactly as they were.
  assert.equal(readFileSync(mine, "utf8"), "# my own orientation command\n", "the launch rewrote a file forge does not own");
});

// ─── the dead check is gone ─────────────────────────────────────────────────

test("integ FG-253: the pre-step-4 dangling-symlink warning no longer appears for a bytes install", async () => {
  // Step 4 installs materialized bytes, so the symlink the old preflight looked for
  // cannot exist on a forge install. Its warning is therefore a check that can only
  // ever pass — which reads as evidence while establishing nothing.
  installAdapters(currentAdapterStamp());

  const launched = await launch();

  assert.doesNotMatch(launched.reported, /repoint/i);
  assert.doesNotMatch(launched.reported, /target missing/i);
  assert.doesNotMatch(launched.reported, /→ \//, "a symlink-shaped warning survived the bytes install");
});

// ─── installation is not activation ─────────────────────────────────────────

test("integ FG-253: the report claims installation only — never that the provider loaded the adapter", async () => {
  installAdapters(OTHER_GENERATION);

  const launched = await launch();

  // The one claim forge is entitled to make about bytes it wrote, stated outright in
  // both halves of the report. Activation is UNVERIFIED in the capability matrix, and
  // nothing on this path observes a provider reading anything.
  assert.match(launched.reported, /bytes on disk are not evidence this session loaded them/);
  assert.match(recordedNote(), /Installation is not activation/);
});

// ─── the pure surface, without a spawn ──────────────────────────────────────

test("integ FG-253: the split is computed from the stamp it is HANDED, so a launch judges its own generation", () => {
  installAdapters(OTHER_GENERATION);

  const agreeing = inspectLaunchAdapterGeneration(roots.project, "claude-code", OTHER_GENERATION);
  assert.deepEqual(agreeing.fromAnotherGeneration, []);
  assert.deepEqual(agreeing.missing, []);
  assert.deepEqual(agreeing.unresolvable, []);

  const split = inspectLaunchAdapterGeneration(roots.project, "claude-code", "release-fg253-thirdgen-01");
  assert.equal(split.fromAnotherGeneration.length, 2);
  assert.ok(split.fromAnotherGeneration.every((e) => e.stamp === OTHER_GENERATION));

  // The Codex surface is a different set of paths in the same project, and this
  // project has them: a Claude launch reports on the surface it resolved, not on both.
  assert.ok(split.fromAnotherGeneration.every((e) => e.surface === "claude-code"));
  assert.ok(
    existsSync(join(roots.project, ".agents", "skills", "forge-orient", "SKILL.md")),
    "the fixture did not install the Codex surface, so this assertion proves nothing",
  );
});

test("integ FG-253: the Claude preflight is advisory and creates nothing it warns about", () => {
  const warnings = claudeProjectPreflight(roots.project, currentAdapterStamp());

  assert.ok(warnings.some((w) => w.includes(".claude/commands/orient.md")));
  assert.equal(existsSync(join(roots.project, ".claude")), false, "the preflight created what it warned about");
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recordedNote(): string {
  return String(receiptLimitation("operator-adapters")?.note);
}
