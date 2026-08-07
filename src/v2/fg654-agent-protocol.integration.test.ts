// FG-654: the properties that decide whether the defect is actually closed, exercised
// through the REAL machinery — the real installer, a real published seed generation, real
// DB rows, real task dirs and real manifests on disk.
//
//   - The operator's ~/.forge/agents/<role>/CLAUDE.md is NEVER written. Not adopted, not
//     spliced, not backed up. That is the whole ownership claim, and it is asserted
//     against a CUSTOMIZED seed across the full asset path.
//   - A covered role whose protocol does not resolve out of the published generation does
//     not reach a container, and does not even mint a task dir.
//   - The recorded sha CANNOT diverge from the bytes that were composed.
//   - The removed machinery is genuinely gone from the tree.
//
// The container exec is stubbed — for a refused dispatch the point is that it is never
// called at all.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { invoke, dispatchInvokeTask, createInvokeRun } from "./invoke.js";
import { composeSystemPrompt } from "./compose.js";
import { publishFlatAsGeneration, publishTestGeneration } from "./seed-generation.testkit.js";
import { publishSeedGeneration, resolveSeedGeneration } from "./seed-generation.js";
import { readTaskManifest } from "./task-manifest.js";
import { getTask, insertTask } from "../store/tasks.js";
import { newTaskId } from "../util/ids.js";
import { resolveModel } from "./model-resolution.js";
import { taskDir } from "../util/paths.js";
import { assessLens, assessDiscoveryCompleteness, LENS_INCOMPLETE_REASONS } from "./review-discovery.js";
import { assessReviewDisposition } from "./review-gate.js";
import { COVERED_ROLES, STALE_PROTOCOL_FAILURE_KIND, protocolRelPath } from "./agent-protocol.js";
import type { DockerExecFn } from "./docker-exec.js";
import type { Task } from "../types/index.js";
import type { LensAcceptance } from "../store/reviews.js";
import type { Workflow } from "./schema.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const savedEnv = { ...process.env };
let tmpDirs: string[] = [];
let projectDir: string;
let execCalls = 0;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Counts its own invocations: a REFUSED dispatch must leave this at zero. */
function countingExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    execCalls += 1;
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

const RUNTIME_STUB = `name: claude
description: fg654 test stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`;

/** Write the flat runtime the suite's disposable home dispatches under, and publish it as
 *  a generation. `agentProtocols` steers ONLY the FG-654 category. */
function setupHome(agentProtocols?: false | Record<string, string>) {
  const fhome = process.env["FORGE_HOME"]!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, RUNTIME_STUB);
  return publishFlatAsGeneration(fhome, {
    ...(agentProtocols === undefined ? {} : { agentProtocols }),
  });
}

beforeEach(() => {
  projectDir = tmp("fg654-project-");
  execCalls = 0;
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
});

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

/** Built by concatenation so THIS file does not itself contain the literals it bans. */
const REMOVED_EXPORTS = [
  "publishAgentProtocol" + "Regions",
  "applyProtocol" + "Region",
  "renderProtocol" + "Publication",
  "fenced" + "Block",
  "readProtocol" + "Region",
  "PRE_ADOPTION_" + "BACKUP_SUFFIX",
  "PROTOCOL_START_" + "MARKER",
  "PROTOCOL_END_" + "MARKER",
];
const REMOVED_ARTEFACTS = [".forge-pre-" + "fg654.bak", ".forge-" + "publish-tmp"];

function sourceFiles(at: string, out: string[] = []): string[] {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(at, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// ─── ACCEPTANCE 1: the operator's seeds are BYTE-IDENTICAL across the asset path ─────

test("integ FG-654: a CUSTOMIZED operator seed survives the full asset path byte-for-byte, with no new entry", () => {
  const home = tmp("fg654-assetpath-home-");
  const skills = tmp("fg654-assetpath-skills-");

  // Seed the host the way a first install does — the real installer, unmodified.
  const first = spawnSync("bash", [join(repoRoot, "scripts", "install-seeds.sh")], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, FORGE_HOME: home, CLAUDE_SKILLS_DEST: skills },
  });
  assert.equal(first.status, 0, `install-seeds.sh failed: ${first.stderr}`);

  // Now CUSTOMIZE every covered role — operator prose ADDED, so this is not a pristine
  // copy that a byte-copy comparison would pass vacuously.
  const snapshot = new Map<string, Buffer>();
  for (const role of COVERED_ROLES) {
    const path = join(home, "agents", role, "CLAUDE.md");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n\n## My house rule for ${role}\n\nAlways read the ledger first.\n`,
    );
    snapshot.set(role, readFileSync(path));
  }
  const entriesBefore = new Map(
    COVERED_ROLES.map((role) => [role, readdirSync(join(home, "agents", role)).sort()]),
  );

  // THE FULL ASSET PATH: FORCE=1 install-seeds.sh (upgrade step [3/4]) plus the atomic
  // seed-generation publish it ends with.
  const forced = spawnSync("bash", [join(repoRoot, "scripts", "install-seeds.sh")], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, FORGE_HOME: home, CLAUDE_SKILLS_DEST: skills, FORCE: "1" },
  });
  assert.equal(forced.status, 0, `forced install-seeds.sh failed: ${forced.stderr}`);
  const gen = publishTestGeneration(home, { assetsParent: home });

  for (const role of COVERED_ROLES) {
    const path = join(home, "agents", role, "CLAUDE.md");
    assert.ok(
      readFileSync(path).equals(snapshot.get(role)!),
      `${role}: the operator's seed was REWRITTEN — forge does not write this file`,
    );
    // Nothing new appeared beside it, under any name.
    assert.deepEqual(
      readdirSync(join(home, "agents", role)).sort(),
      entriesBefore.get(role),
      `${role}: a new entry appeared under ~/.forge/agents/${role}/`,
    );
  }

  // And no removed-machinery artefact anywhere under the agents tree.
  const stray: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (REMOVED_ARTEFACTS.some((a) => entry.name.endsWith(a))) stray.push(full);
    }
  };
  walk(join(home, "agents"));
  assert.deepEqual(stray, [], "no .bak and no staging file may ever be written under ~/.forge/agents");

  // The protocol went where it belongs instead: inside the generation.
  for (const role of COVERED_ROLES) {
    assert.ok(gen.manifest.files[protocolRelPath(role)], `${role}: not published into the generation`);
  }
});

// ─── ACCEPTANCE 3: refused before dispatch, by name, non-overrideable ────────

test("integ FG-654: NO published generation refuses every covered role — no task dir, no container", async () => {
  // The runtime is published, the protocols are not: the ONLY unmet precondition is the
  // protocol, so the refusal cannot be attributed to anything else.
  setupHome(false);
  for (const role of COVERED_ROLES) {
    execCalls = 0;
    const res = await invoke({
      agentRole: role,
      task: "review the change",
      projectDir,
      readOnlyProject: role.startsWith("red-"),
      dockerExec: countingExec(),
    });

    assert.equal(res.status, "failed", `${role} dispatched with no protocol published`);
    assert.equal(res.failureKind, STALE_PROTOCOL_FAILURE_KIND, `${role}`);
    assert.equal(execCalls, 0, `${role}: a refused dispatch must never reach a container`);
    const error = res.error ?? "";
    assert.ok(error.includes(role), `${role}: the refusal must name the role`);
    assert.ok(error.includes("forge upgrade"), `${role}: the refusal must name the remedy`);
    assert.ok(!/\.bak|marker|fence/i.test(error), `${role}: the refusal must not mention removed machinery`);

    // Durable and addressable: the row exists and failed, and NO task dir was minted.
    assert.equal(getTask(res.taskId)?.status, "failed", `${role}: the refusal must be durable`);
    assert.ok(!existsSync(taskDir(res.runId, res.taskId)), `${role}: a refused dispatch mints no task dir`);
    assert.equal(readTaskManifest(taskDir(res.runId, res.taskId)), undefined, `${role}: no dispatch, no manifest`);
  }
});

test("integ FG-654: a generation whose protocol bytes were TAMPERED refuses the same way", async () => {
  const gen = setupHome();
  const role = "red-security";
  writeFileSync(join(gen.root, protocolRelPath(role)), "## Not what the manifest published\n");

  const res = await invoke({
    agentRole: role,
    task: "audit",
    projectDir,
    readOnlyProject: true,
    dockerExec: countingExec(),
  });
  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, STALE_PROTOCOL_FAILURE_KIND);
  assert.equal(execCalls, 0);
  assert.ok((res.error ?? "").includes("provenance manifest"));
  assert.ok(!existsSync(taskDir(res.runId, res.taskId)), "a refused dispatch mints no task dir");
});

test("integ FG-654: a generation BEHIND the executing release refuses at dispatch, before any container", async () => {
  // The generation is published, complete and manifest-consistent — its engineer protocol
  // is simply an OLDER release's bytes, which is exactly the state of a host that took a
  // new forge (or re-ran install-seeds.sh) without `forge upgrade`. Nothing else measures
  // it: there is no flat ~/.forge/agent-protocols for the drift detector to compare.
  setupHome({ engineer: "## The review protocol\n\nAN OLDER RELEASE'S CONTRACT\n" });
  const res = await invoke({
    agentRole: "engineer",
    task: "fix the batch",
    projectDir,
    dockerExec: countingExec(),
  });
  assert.equal(res.status, "failed", "an old protocol must not dispatch under the running forge");
  assert.equal(res.failureKind, STALE_PROTOCOL_FAILURE_KIND);
  assert.equal(execCalls, 0, "a refused dispatch never reaches a container");
  assert.ok((res.error ?? "").includes("BEHIND the forge"), "the refusal names WHY, not just that");
  assert.ok((res.error ?? "").includes("forge upgrade"), "and names the remedy");
  assert.ok(!existsSync(taskDir(res.runId, res.taskId)), "a refused dispatch mints no task dir");
});

test("integ FG-654: a release with no protocol for a covered role CANNOT publish a generation", async () => {
  // RF-13's mechanism: the staging loop manifests only what it finds, so without this gate
  // such a release publishes a generation that is COMPLETE by construction — upgrade reports
  // it published and exits 0 — while that role refuses at every dispatch.
  const home = tmp("fg654-pubgate-home-");
  const release = tmp("fg654-pubgate-release-");
  const seeds = join(release, "seeds");
  mkdirSync(join(seeds, "workflows"), { recursive: true });
  mkdirSync(join(seeds, "runtimes"), { recursive: true });
  writeFileSync(join(seeds, "runtimes", "claude.yml"), RUNTIME_STUB);
  mkdirSync(join(seeds, "agent-protocols"), { recursive: true });
  const dropped = "review-rechecker";
  for (const role of COVERED_ROLES) {
    if (role === dropped) continue;
    writeFileSync(join(seeds, protocolRelPath(role)), `## ${role}\n\ncontract\n`);
  }

  assert.throws(
    () => publishSeedGeneration({ home, assetsDir: release, trustedAssetRoot: () => release }),
    (e: Error) => {
      assert.ok(e.message.includes(dropped), "the refusal names the role the release cannot dispatch");
      assert.ok(e.message.includes(`seeds/${protocolRelPath(dropped)}`), "and the file it expected");
      assert.ok(/refusing to publish/.test(e.message));
      return true;
    },
  );
  assert.equal(resolveSeedGeneration(home), null, "nothing was published — no generation to dispatch under");
});

test("integ FG-654: an UNCOVERED role dispatches exactly as before, and carries no stamp", async () => {
  setupHome(false);
  for (const role of ["synthesizer", "tech-lead"]) {
    execCalls = 0;
    const res = await invoke({ agentRole: role, task: "think", projectDir, dockerExec: countingExec() });
    assert.equal(res.status, "complete", `${role} must not be gated`);
    assert.equal(execCalls, 1, `${role} must still reach its container`);
    assert.equal(readTaskManifest(taskDir(res.runId, res.taskId))?.agentProtocol, undefined);
  }
});

// ─── ACCEPTANCE 3 (second half): an acceptance cannot clear it ───────────────

test("integ FG-654: a refused lens surfaces as `stale_protocol`, never as no_outcome/never-dispatched", () => {
  assert.ok((LENS_INCOMPLETE_REASONS as readonly string[]).includes("stale_protocol"));

  const outcome = assessLens({
    lens: "wide",
    role: "red-wide",
    dispatched: false,
    failureKind: STALE_PROTOCOL_FAILURE_KIND,
    detail: "no manifest-consistent agent-protocols/red-wide.md; run `forge upgrade`",
  });
  assert.equal(outcome.complete, false);
  if (!outcome.complete) {
    assert.equal(outcome.reason, "stale_protocol");
    assert.ok(!outcome.detail.includes("never dispatched"), "it was refused, not never-dispatched");
    assert.ok(outcome.detail.includes("forge upgrade"));
  }
});

test("integ FG-654: a bound, current-candidate operator acceptance does NOT clear a stale-protocol lens", () => {
  const refused = assessLens({
    lens: "security",
    role: "red-security",
    dispatched: false,
    failureKind: STALE_PROTOCOL_FAILURE_KIND,
  });
  const acceptance: LensAcceptance = {
    kind: "lens_acceptance",
    lens: "security",
    missingEvidence: "no security lens ran",
    rationale: "shipping anyway",
    candidateSha: "cafe1234",
    acceptedBy: "operator",
    acceptedAt: new Date(0).toISOString(),
  };

  // The control: this exact acceptance DOES clear an ordinary missing lens, so the
  // assertion below is about the REASON and not about the acceptance being malformed.
  const ordinary = assessDiscoveryCompleteness(
    ["security"],
    [assessLens({ lens: "security", role: "red-security", dispatched: false, failureKind: "container_crash" })],
    { acceptances: [acceptance], candidateSha: "cafe1234" },
  );
  assert.equal(ordinary.complete, true, "control: a crashed lens IS clearable by a bound acceptance");
  assert.equal(ordinary.accepted.length, 1);

  const staleProtocol = assessDiscoveryCompleteness(["security"], [refused], {
    acceptances: [acceptance],
    candidateSha: "cafe1234",
  });
  assert.equal(staleProtocol.complete, false, "a stale-protocol lens must NOT be acceptable-away");
  assert.equal(staleProtocol.accepted.length, 0, "and the acceptance must not be reported as having cleared it");
  assert.equal(staleProtocol.missing[0]?.reason, "stale_protocol");

});

test("integ FG-654: the disposition gate still names the remedy, and says an acceptance cannot clear it", () => {
  const acceptance: LensAcceptance = {
    kind: "lens_acceptance",
    lens: "security",
    missingEvidence: "no security lens ran",
    rationale: "shipping anyway",
    candidateSha: "cafe1234",
    acceptedBy: "operator",
    acceptedAt: new Date(0).toISOString(),
  };
  const review = {
    id: "review-fg654-gate",
    contract: {
      threat_model: "a reviewer that was never told the contract",
      protected_invariants: ["one review_mode per run"],
      acceptance_refs: ["FG-654 AC 3"],
      risk_lenses: ["security"],
      non_goals: [],
      lens_scopes: { security: ["src/v2/agent-protocol.ts"] },
    },
    contractConfirmedSha: "cafe1234",
    candidateSha: "cafe1234",
    lensOutcomes: [
      acceptance,
      {
        lens: "security",
        role: "red-security",
        complete: false,
        reason: "stale_protocol",
        detail: "no manifest-consistent agent-protocols/red-security.md; run `forge upgrade`",
      },
    ],
  } as unknown as Parameters<typeof assessReviewDisposition>[0]["review"];

  const assessment = assessReviewDisposition({ review, findings: [] });
  const condition = assessment.conditions.find((c) => c.id === "lens_outcome_missing");
  assert.ok(condition, "the gate must still hold on the missing lens outcome");
  assert.match(condition!.detail, /forge upgrade/, "the remedy is named");
  assert.match(condition!.detail, /acceptance cannot clear/i, "and so is the non-overrideability");
});

// ─── ACCEPTANCE 4b: THE DIVERGENCE PROBE ────────────────────────────────────
//
// The manifest is written well after the prompt is composed — after model resolution,
// mount preflight and docker-arg construction. If the stamp were re-derived there, a
// `forge upgrade` landing in that window would make the receipt name a generation the
// container was never given. A stamp that disagrees with what is on disk is the only way
// to tell an echo from a second read.

test("integ FG-654: the manifest records the COMPOSED bytes' sha, not a fresh read of the generation", async () => {
  const gen = setupHome();
  const role = "red-wide";

  const protocolText = readFileSync(join(gen.root, protocolRelPath(role)), "utf8");
  const composed = composeSystemPrompt({
    role,
    workflow: INVOKE_SHAPE,
    step: INVOKE_SHAPE.steps[0]!,
    seedGeneration: gen,
  });
  assert.ok(composed.ok, composed.ok ? "" : composed.refusal);
  if (!composed.ok) return;
  const composedSha = composed.protocol!.sha256;
  // 4(a) restated at the dispatch seam: the stamp digests the bytes that are IN the prompt.
  assert.ok(composed.prompt.includes(protocolText), "the exact protocol bytes are in the prompt");
  assert.equal(composedSha, createHash("sha256").update(Buffer.from(protocolText, "utf8")).digest("hex"));

  // The prompt is built. NOW the file underneath changes — the upgrade-in-the-window.
  const path = join(gen.root, protocolRelPath(role));
  writeFileSync(path, "## A DIFFERENT GENERATION ENTIRELY\n");
  const onDiskNow = createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.notEqual(composedSha, onDiskNow, "fixture: the bytes really did change");

  // Complete the dispatch with the package that compose produced.
  const runId = createInvokeRun(role, projectDir, undefined, "fg654 divergence", undefined);
  const taskId = newTaskId(role);
  const task: Task = {
    id: taskId,
    runId,
    phase: "task",
    agentRole: role,
    status: "pending",
    taskPackage: {
      taskId,
      runId,
      phase: "task",
      role,
      inputs: { task: "review" },
      composedSystemPrompt: composed.prompt,
      dispatchSource: "invoke",
      agentProtocol: composed.protocol!,
    },
    createdAt: new Date().toISOString(),
  };
  insertTask(task);

  const res = await dispatchInvokeTask({
    task,
    resolution: resolveModel({ agentRole: role, runtimeName: "claude", ctx: { projectDir } }),
    projectDir,
    taskText: "review",
    ownsRun: true,
    readOnlyProject: true,
    dockerExec: countingExec(),
  });
  assert.equal(res.status, "complete");

  // Read from the FILE — the claim is about durable state.
  const raw = JSON.parse(readFileSync(join(taskDir(res.runId, res.taskId), "manifest.json"), "utf8")) as {
    agentProtocol?: { role: string; sha256: string; source: string };
  };
  assert.equal(raw.agentProtocol?.role, role);
  assert.equal(raw.agentProtocol?.sha256, composedSha, "the manifest ECHOES the compose");
  assert.notEqual(
    raw.agentProtocol?.sha256,
    onDiskNow,
    "a re-derived stamp would carry the generation this prompt was NOT built from",
  );
});

const INVOKE_SHAPE: Workflow = {
  name: "invoke",
  description: "",
  review_mode: "evidence_led",
  inputs: [],
  steps: [
    {
      id: "task",
      agent: "red-wide",
      activity: "spec-writer",
      runtime: "claude",
      depends_on: [],
      gate: "auto",
      manual: false,
      reds: [],
    },
  ],
};

// ─── ACCEPTANCE 7: the machinery is genuinely gone ──────────────────────────

test("integ FG-654: agent-protocol.ts exports NONE of the removed machinery", () => {
  const source = readFileSync(join(repoRoot, "src", "v2", "agent-protocol.ts"), "utf8");
  for (const name of REMOVED_EXPORTS) {
    assert.ok(
      !new RegExp(`export\\s+(const|function|type)\\s+${name}\\b`).test(source),
      `agent-protocol.ts still exports ${name} — removal means DELETION, not deprecation`,
    );
  }
  // Nothing in the module writes to $FORGE_HOME/agents, either.
  for (const writer of ["writeFileSync", "renameSync", "rmSync", "mkdirSync", "symlinkSync"]) {
    assert.ok(!source.includes(writer), `agent-protocol.ts must not call ${writer} — it is READ-ONLY now`);
  }
});

test("integ FG-654: no module IMPORTS a removed name from agent-protocol.js", () => {
  const files = sourceFiles(join(repoRoot, "src"));
  assert.ok(files.length > 100, "sanity: the walk found the source tree");
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"[^"]*agent-protocol\.js"/g)) {
      const names = (m[1] ?? "").split(",").map((n) => n.replace(/^\s*type\s+/, "").trim());
      for (const name of names) {
        if (REMOVED_EXPORTS.includes(name)) hits.push(`${relative(repoRoot, file)}: ${name}`);
      }
    }
  }
  assert.deepEqual(hits, [], `removed machinery still imported:\n${hits.join("\n")}`);
});

test("integ FG-654: the backup and staging-file artefacts appear nowhere under src/", () => {
  const hits: string[] = [];
  for (const file of sourceFiles(join(repoRoot, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const artefact of REMOVED_ARTEFACTS) {
      if (text.includes(artefact)) hits.push(`${relative(repoRoot, file)}: ${artefact}`);
    }
  }
  assert.deepEqual(hits, [], `a removed artefact literal survives:\n${hits.join("\n")}`);
});

test("integ FG-654: the only `forge:agent-protocol` string left in src/ is the detection constant", () => {
  const walk = (at: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  const carriers = walk(join(repoRoot, "src"))
    .filter((f) => readFileSync(f, "utf8").includes("forge:agent-protocol"))
    .map((f) => relative(repoRoot, f))
    .sort();

  // agent-protocol.ts DEFINES the detection-only constant; everything else is a test
  // exercising the detector. No production module may parse a fence or write a marker.
  assert.ok(carriers.includes(join("src", "v2", "agent-protocol.ts")), "the constant must live in agent-protocol.ts");
  for (const file of carriers) {
    assert.ok(
      file.endsWith(".test.ts") || file === join("src", "v2", "agent-protocol.ts"),
      `${file} still references the legacy marker outside the detector and its tests`,
    );
  }
});

test("integ FG-654: no marker survives in seeds/agents, and upgrade prints only four steps", () => {
  for (const role of COVERED_ROLES) {
    const seed = readFileSync(join(repoRoot, "seeds", "agents", role, "CLAUDE.md"), "utf8");
    assert.ok(!seed.includes("forge:agent-protocol"), `${role}: a marker survives in the shipped seed`);
    // And the protocol it lost is a real file.
    assert.ok(statSync(join(repoRoot, "seeds", protocolRelPath(role))).isFile(), `${role}: no protocol file`);
  }

  const upgrade = readFileSync(join(repoRoot, "src", "cli", "commands", "upgrade.ts"), "utf8");
  assert.ok(!/agentProtocol/.test(upgrade), "UpgradeResult must carry no agentProtocol* field");
  const denominators = [...new Set([...upgrade.matchAll(/\[(\d+)\/(\d+)\]/g)].map((m) => m[2]))];
  assert.deepEqual(denominators, ["4"], "upgrade prints only [n/4]");
});

test("integ FG-654: scripts/install-seeds.sh is textually untouched by this ticket", () => {
  const script = readFileSync(join(repoRoot, "scripts", "install-seeds.sh"), "utf8");
  assert.ok(!script.includes("FG-654"), "the installer must carry no FG-654 framing");
  assert.ok(!script.includes("agent-protocol"), "the installer must not know about the protocol at all");
  assert.match(
    script,
    /AUTHORED_EXEMPT=\(agents constraints raci\)/,
    "agents is once again wholly operator-authored, whole-file",
  );
});
