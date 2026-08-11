// FG-576 step 7 — the CODEX ADAPTER, end to end, against a FAKE codex.
//
// Everything here runs against a FAKE `codex` on PATH and disposable FORGE_HOME /
// FORGE_DB_PATH / FORGE_ORCHESTRATORS_DIR / FORGE_CODEX_DIR roots. No billed
// interactive session is ever started, no real auth is read or mutated, CODEX_HOME is
// never set to anything (real or otherwise), and the operator's Codex config root is a
// mkdtemp fixture that every test proves is byte-identical afterwards (AC13, D8).
//
// The three properties that are worth an end-to-end test rather than a unit one:
//
//   AC8  a codex build WITHOUT the instructions-file capability never produces a
//        receipt claiming a fully initialized Forge orchestrator — it refuses before
//        spawn, or it records the degradation in its own fields.
//   AC9  the session identity is CORRELATED from what codex itself wrote after spawn,
//        and two sessions in one project inside the window record `ambiguous`.
//   AC10 a Claude-minted identifier is refused by RECEIPT LOOKUP. Both providers use
//        bare UUIDs, so nothing about the identifier itself can be what refuses it.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getDb } from "../store/db.js";
import {
  getOrchestratorReceipt,
  listOrchestratorReceiptsForProject,
  persistPendingOrchestratorReceipt,
  type OrchestratorReceipt,
} from "../store/orchestrator-receipts.js";
import { sha256OfBytes } from "../util/content-digest.js";
import {
  CODEX_CARRIER_ORIENTATION_MARKER,
  CODEX_CARRIER_SOURCE_REL,
  CODEX_CARRIER_SPLICE_MARKER,
  codexCarrierPath,
  publishSeedGeneration,
  resolveSeedGeneration,
  type SeedGeneration,
} from "../v2/seed-generation.js";
import { stageAgentProtocols } from "../v2/seed-generation.testkit.js";
import { CODEX_ALLOW_UNINITIALIZED_ENV, CODEX_INSTRUCTIONS_CONFIG_KEY } from "./codex-adapter.js";
import { runOrchestratorLaunch } from "./launch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "index.ts");
const LOADER = join(REPO_ROOT, "bin", "forge-loader.mjs");
const CLI_ARGV = ["--import", LOADER, CLI_ENTRY];
const FAKE_CODEX = join(HERE, "__fixtures__", "fake-codex.js");

const POLICY = `
model_profiles:
  codex-subscription:
    provider: openai
    auth: subscription
    map:
      default: { model: gpt-5.6-terra, cost_tier: standard }
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: codex-subscription
  activity: {}
`;

/** The operator's own Codex config root — an AGENTS.md they wrote, a config.toml, a
 *  credential. D8: a Forge launch must not read, splice, overwrite or add to any of it. */
const OPERATOR_AGENTS_MD = "# My own agent instructions\n\nAlways run `make check` before committing.\n";

type Roots = {
  base: string;
  home: string;
  db: string;
  orchestrators: string;
  project: string;
  bin: string;
  record: string;
  ready: string;
  /** Where FORGE reads Codex's session state, and where the fake writes it. */
  codexState: string;
  /** Stands in for the operator's ~/.codex. Nothing in Forge may touch it. */
  operatorCodex: string;
};

let roots: Roots;
let generation: SeedGeneration;
let envSnapshot: Record<string, string | undefined>;

const MANAGED_ENV = [
  "FORGE_HOME",
  "FORGE_DB_PATH",
  "FORGE_ORCHESTRATORS_DIR",
  "FORGE_CODEX_DIR",
  "FORGE_CODEX_CORRELATION_WINDOW_MS",
  "FORGE_CODEX_CORRELATION_POLL_MS",
  CODEX_ALLOW_UNINITIALIZED_ENV,
  "FAKE_CODEX_RECORD",
  "FAKE_CODEX_READY",
  "FAKE_CODEX_MODE",
  "FAKE_CODEX_VERSION",
  "FAKE_CODEX_SESSIONS",
  "FAKE_CODEX_EXTRA_SESSIONS",
  "PATH",
  "CODEX_HOME",
] as const;

function makeRoots(): Roots {
  // realpath, because the child reports its cwd resolved and a /tmp symlink would turn
  // "did the child start in the project root?" into a path-shape accident.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg576-codex-")));
  const home = join(base, "forge-home");
  const project = join(base, "project");
  const bin = join(base, "bin");
  const orchestrators = join(base, "orchestrators");
  const codexState = join(base, "codex-state");
  const operatorCodex = join(base, "operator-codex");
  for (const dir of [home, project, bin, orchestrators, codexState, operatorCodex]) mkdirSync(dir, { recursive: true });

  writeFileSync(join(home, "model-policy.yml"), POLICY, "utf8");
  writeFileSync(join(project, "CLAUDE.md"), `<!-- forge:orchestrator-start -->\nproject policy\n`, "utf8");
  writeFileSync(join(project, "AGENTS.md"), OPERATOR_AGENTS_MD, "utf8");
  writeFileSync(join(operatorCodex, "AGENTS.md"), OPERATOR_AGENTS_MD, "utf8");
  writeFileSync(join(operatorCodex, "config.toml"), `model = "gpt-operator-choice"\n`, "utf8");
  writeFileSync(join(operatorCodex, "auth.json"), `{"tokens":{"access_token":"fixture"}}\n`, "utf8");
  // The DISPOSABLE Codex state root Forge reads through FORGE_CODEX_DIR: the openai/
  // subscription probe looks for auth.json here, so a fixture credential lives here and
  // the operator's real ~/.codex is never read (AC13).
  writeFileSync(join(codexState, "auth.json"), `{"tokens":{"access_token":"disposable-fixture"}}\n`, "utf8");

  // The fake goes on PATH under the real name, so `spawn("codex", ...)` resolves to it
  // exactly the way it would resolve the operator's binary.
  const fake = join(bin, "codex");
  copyFileSync(FAKE_CODEX, fake);
  chmodSync(fake, 0o755);

  return {
    base,
    home,
    db: join(home, "forge.db"),
    orchestrators,
    project,
    bin,
    record: join(base, "record.json"),
    ready: join(base, "ready"),
    codexState,
    operatorCodex,
  };
}

/** Publish the Forge-owned Codex carrier into the disposable home through the REAL
 *  publisher, so the file a launch binds is the one a release renders and the
 *  generation manifest pins. */
function publishCarrierGeneration(): SeedGeneration {
  const release = join(roots.base, "release");
  const seeds = join(release, "seeds");
  mkdirSync(join(seeds, "workflows"), { recursive: true });
  mkdirSync(join(seeds, "runtimes"), { recursive: true });
  writeFileSync(join(seeds, "workflows", "feature.yml"), `name: feature\nsteps: []\n`);
  writeFileSync(join(seeds, "runtimes", "claude.yml"), `kind: claude\n`);
  stageAgentProtocols(seeds);
  writeFileSync(
    join(seeds, "orchestrator-template.md"),
    [
      "<!-- forge:orchestrator-start -->",
      "",
      "# forge orchestrator",
      "",
      "Route work through the RACI.",
      "",
      "<!-- forge:orchestrator-end -->",
      "",
      "PROJECT TAIL — never Forge policy.",
      "",
    ].join("\n"),
  );
  mkdirSync(join(seeds, "codex"), { recursive: true });
  writeFileSync(
    join(seeds, CODEX_CARRIER_SOURCE_REL),
    ["# Forge orchestrator — Codex CLI", "", "SCAFFOLDING: shell, edits, when to ask.", "", CODEX_CARRIER_ORIENTATION_MARKER, "", CODEX_CARRIER_SPLICE_MARKER, ""].join("\n"),
  );
  publishSeedGeneration({ home: roots.home, assetsDir: release, trustedAssetRoot: () => release });
  const gen = resolveSeedGeneration(roots.home);
  assert.ok(gen, "a seed generation must resolve after publishing");
  return gen;
}

function launchEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FORGE_HOME: roots.home,
    FORGE_DB_PATH: roots.db,
    FORGE_ORCHESTRATORS_DIR: roots.orchestrators,
    // Where FORGE reads Codex session state. Deliberately NOT CODEX_HOME: Forge
    // redirects only where it reads, never where the child writes (D8).
    FORGE_CODEX_DIR: roots.codexState,
    // The fake writes its post-spawn session 150ms later. 400ms leaves only
    // child-spawn contention as its budget under the full integration tier;
    // this remains test-only while AC9's ordering and ambiguity assertions
    // below continue to prove the correlation policy.
    FORGE_CODEX_CORRELATION_WINDOW_MS: "5000",
    FORGE_CODEX_CORRELATION_POLL_MS: "50",
    FAKE_CODEX_RECORD: roots.record,
    FAKE_CODEX_SESSIONS: roots.codexState,
    PATH: `${roots.bin}:${process.env["PATH"] ?? ""}`,
    ...overrides,
  };
  delete env["CODEX_HOME"];
  delete env[CODEX_ALLOW_UNINITIALIZED_ENV];
  for (const [key, value] of Object.entries(overrides)) env[key] = value;
  return env;
}

function applyEnv(overrides: Record<string, string> = {}): void {
  const env = launchEnv(overrides);
  for (const key of MANAGED_ENV) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
}

function runCli(args: string[], overrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [...CLI_ARGV, ...args], {
    cwd: roots.project,
    encoding: "utf8",
    env: launchEnv(overrides),
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function readRecord(): { argv: string[]; cwd: string; env: Record<string, string> } {
  assert.ok(existsSync(roots.record), "the fake codex recorded nothing — it was never launched");
  return JSON.parse(readFileSync(roots.record, "utf8"));
}

function countFlag(argv: string[], flag: string): number {
  return argv.filter((token) => token === flag || token.startsWith(`${flag}=`)).length;
}

/** Every file under `dir`, with its digest — the D8 evidence that a Forge launch left
 *  the operator's Codex install exactly as it found it. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? dir, entry.name);
    out[path] = sha256OfBytes(path);
  }
  return out;
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  roots = makeRoots();
  envSnapshot = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
  generation = publishCarrierGeneration();
  closeDb();
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

// ─── AC1 / AC2 / AC6 / AC8 / D8: what actually reaches the child ────────────

test("integ FG-576 AC1/AC2/AC6: a codex-resolving policy launches codex with an explicit model, the project root and the Forge carrier", () => {
  const operatorBefore = snapshotTree(roots.operatorCodex);
  const projectAgentsBefore = readFileSync(join(roots.project, "AGENTS.md"), "utf8");

  const res = runCli(["orchestrator"]);
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();

  // Every Forge-owned flag EXACTLY once: a duplicate would mean the effective model,
  // project root or instruction surface is decided by argv ordering rather than by the
  // recorded decision.
  for (const flag of ["--model", "--cd", "-c"]) {
    assert.equal(countFlag(record.argv, flag), 1, `${flag} appears ${countFlag(record.argv, flag)}× in ${record.argv.join(" ")}`);
  }
  assert.equal(record.argv[record.argv.indexOf("--model") + 1], "gpt-5.6-terra");
  assert.equal(record.argv[record.argv.indexOf("--cd") + 1], roots.project);
  assert.equal(record.cwd, roots.project, "the child did not start in the resolved project root");

  // AC8: the carrier is bound PER LAUNCH by a config override pointing INSIDE the
  // Forge generation root. Nothing was installed anywhere.
  const carrierArg = record.argv[record.argv.indexOf("-c") + 1]!;
  assert.equal(carrierArg, `${CODEX_INSTRUCTIONS_CONFIG_KEY}=${codexCarrierPath(generation)}`);
  assert.ok(codexCarrierPath(generation).startsWith(generation.root));

  // AC2: not one Claude flag, and not one Claude-owned variable in the child env.
  for (const claudeFlag of ["--session-id", "--append-system-prompt", "--append-system-prompt-file", "-n", "-p", "--profile"]) {
    assert.equal(record.argv.includes(claudeFlag), false, `${claudeFlag} reached the Codex argv: ${record.argv.join(" ")}`);
  }
  assert.equal(record.env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"], undefined);
  assert.equal(record.env["CLAUDE_CODE_USE_BEDROCK"], undefined);
  // D8: CODEX_HOME is never redirected — the child resolves its own Codex home exactly
  // as it would have without Forge.
  assert.equal(record.env["CODEX_HOME"], undefined);

  applyEnv();
  const receipts = listOrchestratorReceiptsForProject(roots.project);
  assert.equal(receipts.length, 1);
  const receipt = receipts[0]!;
  assert.equal(receipt.adapter, "codex");
  assert.equal(receipt.provider, "openai");
  assert.equal(receipt.runtime, "codex-subscription");
  assert.equal(receipt.model, "gpt-5.6-terra");
  assert.equal(receipt.resolvedProfile, "codex-subscription");
  assert.equal(receipt.carrier.acceptance, "accepted");
  assert.equal(receipt.carrier.generation, generation.root);
  assert.match(String(receipt.carrier.evidence), new RegExp(`${CODEX_INSTRUCTIONS_CONFIG_KEY}=`));
  assert.match(String(receipt.carrier.evidence), /codex --version reports/);
  assert.equal(receipt.state, "exited");
  assert.equal(receipt.exitCode, 0);

  // AC12: the usage gap is a RECORDED VALUE, and no usage row was invented for it.
  const usage = receipt.limitations.find((l) => l.capability === "usage-capture");
  assert.ok(usage, `the receipt records no usage-capture limitation: ${JSON.stringify(receipt.limitations)}`);
  assert.match(usage.note, /no token counts or costs are fabricated/);
  const rows = getDb().prepare("SELECT COUNT(*) AS n FROM model_calls").get() as { n: number };
  assert.equal(rows.n, 0, "usage rows were invented for a Codex session");

  // D8: the operator's Codex config root and their AGENTS.md are exactly as they were.
  assert.deepEqual(snapshotTree(roots.operatorCodex), operatorBefore, "the operator's Codex config root was modified");
  assert.equal(readFileSync(join(roots.project, "AGENTS.md"), "utf8"), projectAgentsBefore);
  // And the generation's own carrier survived the session: it is a published artifact,
  // not something this launch wrote and must therefore clean up.
  assert.equal(existsSync(codexCarrierPath(generation)), true, "the launch deleted the published carrier at close-out");
});

// ─── AC8 REGRESSION: bare Codex is never registered as initialized ──────────

test("integ FG-576 AC8 REGRESSION: a codex build without the instructions-file capability refuses before spawn and records nothing", () => {
  const res = runCli(["orchestrator"], { FAKE_CODEX_VERSION: "codex-cli 0.101.0" });

  assert.equal(res.status, 1, `expected a refusal, got:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /upgrade the codex CLI/);
  assert.match(res.stderr, new RegExp(CODEX_ALLOW_UNINITIALIZED_ENV));
  assert.match(res.stderr, /nothing was spawned/i);

  // Nothing ran and nothing was recorded: a receipt here would itself be the false
  // registration this regression exists to prevent.
  assert.equal(existsSync(roots.record), false, "a build with no carrier capability was spawned anyway");
  applyEnv();
  assert.equal(listOrchestratorReceiptsForProject(roots.project).length, 0);
});

test("integ FG-576 AC8 REGRESSION: the degrade path launches, and its receipt says NOT fully initialized", () => {
  const res = runCli(["orchestrator"], {
    FAKE_CODEX_VERSION: "codex-cli 0.101.0",
    [CODEX_ALLOW_UNINITIALIZED_ENV]: "1",
  });
  assert.equal(res.status, 0, res.stderr);

  const record = readRecord();
  // No carrier was bound at all — constructing a flag this build would ignore is not
  // evidence, and Forge does not construct evidence it did not observe.
  assert.equal(countFlag(record.argv, "-c"), 0, `a degraded launch bound a carrier: ${record.argv.join(" ")}`);

  applyEnv();
  const receipt = listOrchestratorReceiptsForProject(roots.project)[0]!;
  assert.equal(receipt.adapter, "codex");
  assert.notEqual(receipt.carrier.acceptance, "accepted");
  assert.equal(receipt.carrier.acceptance, "unproven");
  assert.equal(receipt.carrier.path, null);
  const instruction = receipt.limitations.filter((l) => l.capability === "instruction-source");
  assert.match(
    instruction.map((l) => l.note).join("\n"),
    /NOT a fully initialized Forge orchestrator/,
    `the receipt does not say the session is uninitialized: ${JSON.stringify(receipt.limitations)}`,
  );
});

// ─── AC10 / D9: resume is provider-bound, by receipt lookup ─────────────────

test("integ FG-576 AC10/D9: resuming a Claude-minted identifier in Codex is refused by the receipt that minted it", () => {
  const claudeId = "11111111-2222-4333-8444-555555555555";
  applyEnv();
  persistPendingOrchestratorReceipt({
    sessionKey: claudeId,
    projectDir: roots.project,
    runtime: "claude-oauth",
    provider: "anthropic",
    adapter: "claude-code",
    sessionOperation: "new",
    providerSessionId: claudeId,
  });
  closeDb();

  const res = runCli(["orchestrator", "--resume", claudeId]);
  assert.equal(res.status, 1, `expected a cross-provider refusal, got:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /claude-code/);
  assert.match(res.stderr, /looked up in the Forge receipt that minted it, not guessed from its format/);
  assert.equal(existsSync(roots.record), false, "a cross-provider resume reached the spawn path");

  applyEnv();
  // The refused launch recorded no second receipt: it was refused at the gate, before
  // anything durable was written.
  assert.equal(listOrchestratorReceiptsForProject(roots.project).length, 1);
});

// ─── AC9: identity is CORRELATED after spawn, and ambiguous when it must be ──

/** One in-process launch against the fake, held open until `settle` has run. In-process
 *  rather than through the CLI because the correlation is recorded WHILE the session is
 *  running — a closed receipt takes no identity — so the test has to observe the
 *  receipt mid-session and end the session itself. */
async function launchAndObserve(
  overrides: Record<string, string>,
  settle: (receiptId: string) => Promise<void>,
): Promise<void> {
  applyEnv({ FAKE_CODEX_MODE: "hold", FAKE_CODEX_READY: roots.ready, ...overrides });

  let child: ChildProcess | undefined;
  const spawnFn: typeof spawn = ((cmd: string, args: string[], opts: object) => {
    child = spawn(cmd, args, opts as never);
    return child;
  }) as unknown as typeof spawn;

  let receiptId = "";
  const launch = runOrchestratorLaunch({
    commandName: "forge orchestrator",
    cwd: roots.project,
    heartbeatsDir: roots.orchestrators,
    spawnFn,
    stdio: "ignore",
    out: () => {},
    err: () => {},
    onBeforeSpawn: (state) => {
      receiptId = state.receiptId;
    },
  });

  try {
    await waitFor(() => existsSync(roots.ready));
    await settle(receiptId);
  } finally {
    child?.kill("SIGKILL");
    await launch;
  }
}

test("integ FG-576 AC9: the session codex itself recorded is CORRELATED onto the receipt after spawn", async () => {
  let observed: OrchestratorReceipt | undefined;
  await launchAndObserve({}, async (receiptId) => {
    await waitFor(() => getOrchestratorReceipt(receiptId)?.identityStrength === "correlated", 30_000);
    observed = getOrchestratorReceipt(receiptId);
  });

  assert.ok(observed);
  assert.equal(observed.identityStrength, "correlated");
  assert.match(String(observed.identityBasis), /CORRELATED, not asserted/);

  // The bound id is the one codex wrote into its own session state — read, never
  // guessed, and never the newest neighbour.
  const day = join(roots.codexState, "sessions", "2026", "08", "07");
  const written = readdirSync(day).filter((n) => n.startsWith("rollout-"));
  assert.equal(written.length, 1);
  assert.ok(written[0]!.includes(String(observed.providerSessionId)), `${written[0]} does not name ${observed.providerSessionId}`);
});

test("integ FG-576 AC9: two overlapping sessions in one project record AMBIGUOUS, not a guessed binding", async () => {
  let observed: OrchestratorReceipt | undefined;
  await launchAndObserve({ FAKE_CODEX_EXTRA_SESSIONS: "1" }, async (receiptId) => {
    await waitFor(() => {
      const strength = getOrchestratorReceipt(receiptId)?.identityStrength;
      return strength === "ambiguous" || strength === "correlated";
    }, 30_000);
    observed = getOrchestratorReceipt(receiptId);
  });

  assert.ok(observed);
  assert.equal(observed.identityStrength, "ambiguous", "two overlapping sessions produced a guessed binding");
  assert.equal(observed.providerSessionId, null, "an ambiguous correlation must bind NO provider session id");
  assert.match(String(observed.identityBasis), /2 new Codex sessions appeared/);
});
