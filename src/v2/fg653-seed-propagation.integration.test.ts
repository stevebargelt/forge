// FG-653 AC-6: the amended red seeds reach a dispatched reviewer through the NORMAL authoritative
// mechanism, and through nothing else.
//
// A prose fix to a seed is only shipped when the prose reaches the container. FG-653 changed five
// `seeds/agents/red-*/CLAUDE.md` files and nothing else — so the claim to verify is not "the files
// changed" (git says that) but "the ONE documented install path carries them to the prompt, and no
// second path was invented to make that happen".
//
// This suite runs the REAL installer — `bash scripts/install-seeds.sh` against a throwaway
// $FORGE_HOME — and then composes the red system prompt out of what it installed, with
// `composeSystemPrompt`'s own default resolution. That is the whole chain, executed:
//
// FG-654 SPLIT THE ROLE'S PROSE IN TWO, and both halves reach the same prompt by their own
// documented path — so this suite executes BOTH chains rather than one:
//
//   seeds/agents/red-<lens>/CLAUDE.md            (the OPERATOR half)
//     → scripts/install-seeds.sh   (the only writer; `forge upgrade` step [3/4] runs this file)
//     → $FORGE_HOME/agents/red-<lens>/CLAUDE.md
//     → composeSystemPrompt        (default agentDir = $FORGE_HOME/agents/<role>)
//     → the reviewer's system prompt
//
//   seeds/agent-protocols/red-<lens>.md          (the FORGE-OWNED half — where AWN-5 lives)
//     → publishSeedGeneration      (`forge upgrade` step [3/4] publishes it atomically)
//     → the anchored seed generation
//     → composeSystemPrompt        (protocol section, composed AHEAD of the operator seed)
//     → the reviewer's system prompt
//
// It also pins the two negatives AC-6 asks for:
//   - NO NEW PATH. Agent SEEDS are still absent from the atomic seed generation — `agents` is not
//     in `SEED_GENERATION_DIRS`, so the operator half still has exactly one publisher — and
//     `upgradeAssetPaths` resolves exactly one seed installer.
//   - NO HAND-COPY. No file anywhere in the repo outside `seeds/agents/` and
//     `seeds/agent-protocols/` is a byte-copy of either half — a duplicated seed is how an edit
//     lands in one copy and rots in the other.
//
// And it pins the operator-visible consequence that is easy to assume away: `agents` is
// AUTHORED_EXEMPT (FG-578), so on a host that ALREADY has the seeds, the installer RETAINS the
// operator's copy and REPORTS it — FORCE=1 included. FG-653's prose does not silently overwrite an
// existing install, and an operator who never reads that report keeps running the old AWN-5 text.
//
// Integration tier: spawns a real bash installer and writes a real $FORGE_HOME. No git worktree.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { composeSystemPrompt } from "./compose.js";
import { SEED_GENERATION_DIRS } from "./seed-generation.js";
import { publishTestGeneration } from "./seed-generation.testkit.js";
import { upgradeAssetPaths, parseRetainedLine } from "../cli/commands/upgrade.js";
import { RISK_LENSES, lensRole } from "./review-contract.js";
import type { Workflow } from "./schema.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LENS_ROLES = RISK_LENSES.map(lensRole);

/** The FG-653 rule, as one unwrapped line of each seed. Line wrapping is prose style, so the
 *  needle is the shortest fragment the amendment guarantees on a single line. */
const RULE_NEEDLE = "UNKNOWN KEYS inside a";

/** The workflow/step a red lens is composed under. Only `steps[0]` matters here — the assertion is
 *  about the agent base section, which is the first thing composeSystemPrompt emits. */
const WORKFLOW: Workflow = {
  name: "feature",
  description: "",
  review_mode: "evidence_led",
  inputs: [],
  steps: [
    {
      id: "red",
      agent: "red-wide",
      activity: "spec-writer",
      runtime: "claude",
      depends_on: [],
      gate: "verdict",
      manual: false,
      reds: [],
    },
  ],
};

let tmpDirs: string[] = [];
let home: string;
let skills: string;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Run the ONE authoritative installer, exactly as `forge upgrade` step [3/4] does. */
function installSeeds(opts: { force?: boolean } = {}): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync("bash", [join(repoRoot, "scripts", "install-seeds.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      FORGE_HOME: home,
      CLAUDE_SKILLS_DEST: skills,
      ...(opts.force === true ? { FORCE: "1" } : {}),
    },
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

const seedPath = (role: string): string => join(repoRoot, "seeds", "agents", role, "CLAUDE.md");
/** FG-654: the forge-owned half, where the FG-653 AWN-5 rule now lives. */
const protocolPath = (role: string): string => join(repoRoot, "seeds", "agent-protocols", `${role}.md`);
const installedPath = (role: string): string => join(home, "agents", role, "CLAUDE.md");

/** Every regular file under `dir`, as paths relative to it. */
function treeOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

beforeEach(() => {
  home = tmp("fg653-forge-home-");
  skills = tmp("fg653-skills-");
});

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

// ─── the chain, executed ────────────────────────────────────────────────────

test("integ FG-653: the authoritative installer propagates all five amended red seeds to a fresh host, byte-identical", () => {
  const run = installSeeds();
  assert.equal(run.status, 0, `install-seeds.sh failed: ${run.stderr}`);

  for (const role of LENS_ROLES) {
    const shipped = readFileSync(seedPath(role));
    const landed = readFileSync(installedPath(role));
    assert.ok(shipped.equals(landed), `${role}: the installed seed is not the bytes this release ships`);
    // FG-654: the AWN-5 rule lives in the forge-owned half now, which the installer does
    // NOT write — it rides the seed generation. Asserted here so the split itself is
    // pinned: the rule is in exactly one of the two halves, not silently in both.
    assert.ok(
      !landed.toString("utf8").includes(RULE_NEEDLE),
      `${role}: the FG-653 rule must NOT be in the operator half — it is forge-owned`,
    );
    assert.ok(
      readFileSync(protocolPath(role), "utf8").includes(RULE_NEEDLE),
      `${role}: the FG-653 discovery rule is missing from the forge-owned protocol`,
    );
  }

  // Nothing extra installed and nothing dropped: the installed agents tree IS the repo's. A
  // propagation path that quietly adds or omits a file is exactly what AC-6 rules out.
  assert.deepEqual(
    treeOf(join(home, "agents")),
    treeOf(join(repoRoot, "seeds", "agents")),
    "the installed agents tree must be the shipped seeds/agents tree, file for file",
  );
});

test("integ FG-653: the rule reaches the reviewer's COMPOSED system prompt, resolved the way dispatch resolves it", () => {
  assert.equal(installSeeds().status, 0);

  // FG-654: the forge-owned half reaches compose through the published generation, which
  // is the same `forge upgrade` that ran install-seeds.sh above. Publishing it here is
  // the second half of the chain, not a test shortcut.
  const gen = publishTestGeneration(home, { assetsParent: home });

  const prevForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    for (const role of LENS_ROLES) {
      // No agentDir override: composeSystemPrompt resolves $FORGE_HOME/agents/<role> itself, which
      // is the same directory install-seeds.sh just wrote. That identity is the propagation claim.
      const composed = composeSystemPrompt({
        role,
        workflow: WORKFLOW,
        step: { ...WORKFLOW.steps[0]!, agent: role },
        seedGeneration: gen,
      });
      assert.ok(composed.ok, composed.ok ? "" : `${role}: ${composed.refusal}`);
      const prompt = composed.ok ? composed.prompt : "";
      assert.ok(
        !prompt.includes("Agent base CLAUDE.md not found"),
        `${role}: compose fell back to its placeholder — the seed is not where dispatch looks for it`,
      );
      assert.ok(prompt.includes(RULE_NEEDLE), `${role}: the composed prompt does not carry the FG-653 discovery rule`);
      assert.ok(
        prompt.includes("`# Risk-targeted discovery — <lens> lens`"),
        `${role}: the composed prompt must name the dispatch that triggers the rule`,
      );
      assert.ok(
        prompt.includes("`finding_type` is the ONE field below that a discovery finding also accepts"),
        `${role}: the composed prompt must keep finding_type legal`,
      );
      for (const key of ["confidence", "affected_files", "recommended_fix", "disposition"]) {
        assert.ok(prompt.includes(key), `${role}: the composed prompt must still name ${key}`);
      }
    }
  } finally {
    if (prevForgeHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevForgeHome;
  }
});

// ─── no second path ─────────────────────────────────────────────────────────

test("integ FG-653: agent SEEDS are NOT part of the atomic seed generation — the installer is their only publisher", () => {
  // If `agents` were ever added to the generation, the OPERATOR half would have TWO publishers
  // with different ownership rules (forge-owned overwrite vs operator-authored retain) and a
  // seed edit's fate would depend on which one ran last. FG-654 added `agent-protocols` — a
  // separate, wholly forge-owned category — precisely so that `agents` did not have to move.
  assert.deepEqual([...SEED_GENERATION_DIRS], ["workflows", "runtimes", "agent-protocols"]);
  assert.ok(
    !(SEED_GENERATION_DIRS as readonly string[]).includes("agents"),
    "agent seeds must stay out of the generation — their propagation path is install-seeds.sh alone",
  );
});

test("integ FG-653: the release resolves exactly ONE seed installer, and it is scripts/install-seeds.sh", () => {
  const { installScript } = upgradeAssetPaths(repoRoot);
  assert.equal(installScript, join(repoRoot, "scripts", "install-seeds.sh"));
  assert.ok(statSync(installScript).isFile(), "the resolved installer exists in the shipped tree");
});

test("integ FG-653: no file outside seeds/agents is a byte-copy of a red lens seed — nothing was hand-copied", () => {
  const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".next", ".forge", "designs"]);
  const digest = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

  const seeds = new Map<string, string>(); // sha256 → the seed's repo-relative path
  const sizes = new Set<number>();
  // FG-654: BOTH halves. A hand-copied protocol rots exactly the way a hand-copied seed does.
  for (const role of LENS_ROLES) {
    for (const path of [seedPath(role), protocolPath(role)]) {
      const buf = readFileSync(path);
      seeds.set(digest(buf), relative(repoRoot, path));
      sizes.add(buf.byteLength);
    }
  }

  const copies: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Only files that COULD be a copy are hashed — a size match first keeps this a cheap walk.
      if (!sizes.has(statSync(full).size)) continue;
      const rel = relative(repoRoot, full);
      const owner = seeds.get(digest(readFileSync(full)));
      if (owner !== undefined && rel !== owner) copies.push(`${rel} duplicates ${owner}`);
    }
  };
  walk(repoRoot);

  assert.deepEqual(copies, [], `a red lens seed or protocol is duplicated in the tree: ${copies.join("; ")}`);
});

// ─── what the install path actually does on an ALREADY-INSTALLED host ───────

test("integ FG-653: an operator's existing red seed is RETAINED and REPORTED, FORCE=1 included — the amendment never silently overwrites", () => {
  // FG-578: `agents` is AUTHORED_EXEMPT. This is the honest propagation truth for FG-653 and the
  // reason a host can keep running the OLD AWN-5 prose after the amendment ships: the installer
  // creates the seed once, then declines to write it again and NAMES what it declined.
  assert.equal(installSeeds().status, 0, "first install seeds the host");

  const operatorCopy = "# red-wide\n\nthe operator's own edits\n";
  writeFileSync(installedPath("red-wide"), operatorCopy);

  const forced = installSeeds({ force: true });
  assert.equal(forced.status, 0, `forced re-install failed: ${forced.stderr}`);
  assert.equal(
    readFileSync(installedPath("red-wide"), "utf8"),
    operatorCopy,
    "FORCE=1 must not overwrite an operator-authored agent seed",
  );

  // Retained, and machine-readably so — parsed by the parser `forge upgrade` itself uses, not by a
  // regex this test invented.
  const retained = forced.stdout.split("\n").map(parseRetainedLine).filter((p): p is string => p !== null);
  assert.ok(
    retained.includes(join("agents", "red-wide", "CLAUDE.md")),
    `the divergence must be reported, or the operator cannot tell they are on the old prose — got: ${retained.join(", ")}`,
  );

  // The four untouched seeds are NOT reported: a report that names everything names nothing.
  for (const role of LENS_ROLES) {
    if (role === "red-wide") continue;
    assert.ok(!retained.includes(join("agents", role, "CLAUDE.md")), `${role} was current and must not be reported`);
    assert.ok(
      readFileSync(seedPath(role)).equals(readFileSync(installedPath(role))),
      `${role} still carries this release's bytes`,
    );
  }
});
