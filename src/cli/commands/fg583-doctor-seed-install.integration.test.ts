// FG-583 (FG-572 Child 5h) — `forge doctor` CONSUMER surface for the named,
// repairable seed-install state.
//
// The brief requires the failed/interrupted-install state to propagate to
// `doctor`. The library return (inspectSeedInstall) and the promoted-install
// surface are covered elsewhere; what had NO direct coverage is the doctor
// COMMAND ACTION wiring (doctor.ts:298-312): that an `incomplete` seed
// generation makes `forge doctor`
//   1. print the NAMED, repairable human line + `forge upgrade` retry advice,
//   2. surface `seedInstall.kind === "incomplete"` in --json, and
//   3. drive a non-zero exit,
// while a `no-generation` home (fresh / flat layout — HEALTHY, not partial)
// does NONE of that.
//
// Driven through the REAL registered command (registerDoctor + commander
// parseAsync → the same .action() the CLI runs). Docker probes fail gracefully
// (no mounts, no agent), so no docker is required; the seed assertions are
// independent of the image/policy checks. Operates ONLY on the disposable
// $FORGE_HOME from src/test-setup.ts — the real ~/.forge is NEVER touched.
//
// Mutation-sensitive: the incomplete-state human line, the --json field, and the
// no-generation negative control each go red if doctor.ts stops consulting
// inspectSeedInstall or misclassifies no-generation as a readiness problem.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { FORGE_HOME, seedCurrentLinkIn, seedGenerationsDirIn } from "../../util/paths.js";
import { registerDoctor } from "./doctor.js";

// The doctor action reads inspectSeedInstall() against the FORGE_HOME constant
// (fixed at import from the test-setup temp home), so we plant / clear the seed
// pointer state THERE.
const seedCurrent = seedCurrentLinkIn(FORGE_HOME);
const gensDir = seedGenerationsDirIn(FORGE_HOME);

function clearSeedState(): void {
  rmSync(seedCurrent, { force: true });
  rmSync(gensDir, { recursive: true, force: true });
}

/** Plant a torn generation: a generation dir the pointer resolves to that never
 *  got its provenance manifest — the mid-publish/incomplete state doctor must
 *  name as repairable rather than report healthy. */
function plantTornGeneration(): void {
  const torn = join(gensDir, "gen-torn");
  mkdirSync(join(torn, "workflows"), { recursive: true });
  writeFileSync(join(torn, "workflows", "alpha.yml"), "name: alpha\n");
  symlinkSync(torn, seedCurrent);
}

/** Drive the real `forge doctor` action, capturing stdout and the exit code the
 *  action sets, and always restoring both. */
async function runDoctor(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const program = new Command();
  program.exitOverride(); // never let commander call process.exit in-process
  registerDoctor(program);

  const lines: string[] = [];
  const realLog = console.log;
  const savedExit = process.exitCode;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  process.exitCode = undefined;
  try {
    await program.parseAsync(["node", "forge", "doctor", ...args]);
    return { out: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = realLog;
    process.exitCode = savedExit;
  }
}

beforeEach(() => clearSeedState());
afterEach(() => clearSeedState());

test("FG-583 doctor (human): an incomplete seed generation is NAMED repairable with forge-upgrade retry advice, and exits non-zero", async () => {
  plantTornGeneration();
  const { out, exitCode } = await runDoctor([]);

  assert.match(out, /Seed install: INCOMPLETE \(repairable\)/, "doctor must name the incomplete/repairable seed-install state");
  assert.match(out, /no valid provenance manifest|mid-publish|torn/, "and explain the reason (torn / mid-publish)");
  assert.match(out, /forge upgrade/, "and give the republish retry advice");
  assert.equal(exitCode, 1, "an incomplete seed install fails the readiness check");
});

test("FG-583 doctor (--json): an incomplete seed generation surfaces seedInstall.kind === 'incomplete'", async () => {
  plantTornGeneration();
  const { out, exitCode } = await runDoctor(["--json"]);

  const parsed = JSON.parse(out) as { seedInstall?: { kind?: string; reason?: string } };
  assert.ok(parsed.seedInstall, "--json must carry a seedInstall block");
  assert.equal(parsed.seedInstall!.kind, "incomplete", "the named state rides in --json");
  assert.ok((parsed.seedInstall!.reason ?? "").length > 0, "with a human-readable reason");
  assert.equal(exitCode, 1, "the named partial state drives a non-zero exit in --json too");
});

test("FG-583 doctor: a no-generation home (fresh / flat layout) is HEALTHY, not a partial-install problem", async () => {
  // No seed pointer at all → the ordinary pre-migration flat-layout host. It must
  // NOT be reported as incomplete, and must NOT emit the repairable line — that
  // guards against over-broad refusal (only `incomplete`, never `no-generation`).
  const human = await runDoctor([]);
  assert.doesNotMatch(human.out, /Seed install: INCOMPLETE/, "a fresh/flat host is not a partial install");

  const jsonRun = await runDoctor(["--json"]);
  const parsed = JSON.parse(jsonRun.out) as { seedInstall?: { kind?: string } };
  assert.equal(parsed.seedInstall!.kind, "no-generation", "no pointer → no-generation (healthy), not incomplete");
});
