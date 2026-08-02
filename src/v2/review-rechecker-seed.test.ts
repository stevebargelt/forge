// FG-639: the review-rechecker role seed.
//
// The rechecker's seed is not decoration — it is where the host's mechanical rules are
// STATED to the model that has to satisfy them. Three of them, in particular, produce a
// refused result when the model gets them wrong, and a model that was never told is a model
// that will get them wrong: omission is a schema failure, a skipped test is never evidence,
// and a demonstrated finding cannot be closed by re-inspection.
//
// So this guard is about the CONTRACT staying stated, not about prose style. It also pins
// the two things the dispatch path needs — the seed dir exists with a read-only settings.json
// — because a role with no seed degrades to a stub prompt SILENTLY (see defaultAgentDir in
// src/v2/compose.ts), which is the failure mode a missing-file test is cheap insurance for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOLUTION_EVIDENCE_KINDS } from "./review-evidence.js";
import { RECHECK_RESULTS } from "./review-recheck.js";
import { resolveAgentProtocol } from "./agent-protocol.js";
import { publishTestGeneration } from "./seed-generation.testkit.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seedDir = join(repoRoot, "seeds", "agents", "review-rechecker");
// FG-654: the rubric this file guards is the FORGE-OWNED protocol, which now lives in its
// own generation-published file rather than inside the operator's seed. The content
// assertions below read it there; the operator seed is only checked for existence.
const seedPath = join(repoRoot, "seeds", "agent-protocols", "review-rechecker.md");
const operatorSeedPath = join(seedDir, "CLAUDE.md");

test("FG-639: the review-rechecker seed exists — a missing role degrades to a stub prompt silently", () => {
  assert.ok(existsSync(operatorSeedPath), `expected a role seed at ${operatorSeedPath}`);
  assert.ok(existsSync(seedPath), `expected a forge-owned protocol at ${seedPath}`);
  assert.ok(existsSync(join(seedDir, "settings.json")), "the role needs a settings.json like every other seed");
});

test("FG-639: the rechecker seed is declared read-only, matching the mount the host enforces", () => {
  const settings = JSON.parse(readFileSync(join(seedDir, "settings.json"), "utf8")) as { tools?: string[] };
  assert.deepEqual(settings.tools, ["read"], "Stage 8 reads the candidate; it never writes it");
});

test("FG-639: the seed states the omission rule — an absent finding id is never a resolution", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();
  assert.ok(md.includes("omission is a schema failure, never resolution"), "the omission rule must be stated verbatim");
  assert.ok(md.includes("refuses your entire result"), "and its mechanical consequence must be stated");
});

test("FG-639: the seed states the skip-evidence rule and the alternate-lane requirement", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();
  assert.ok(md.includes("a skipped test is never evidence"), "the operator's 2026-07-29 rule must be stated");
  assert.ok(md.includes("per test"), "and that execution is established per test, not per suite");
  for (const named of ["the lane", "the candidate sha", "the executed assertion"]) {
    assert.ok(md.includes(named), `an alternate-lane claim must be told to name ${named}`);
  }
  assert.ok(md.includes("covered elsewhere"), "and that unnamed coverage is refused");
});

// The seed states the rules AND lists the shapes, and the two drifted apart: the normative
// alternate-lane rule named the lane, the sha and the assertion while the shape list — and
// the host — also required that lane's runner output, and `supported` was stated as "a
// relevant verification step" when what the host enforces is an EXECUTED one. A rule that
// contradicts the shape beside it teaches the wrong thing twice, so both are pinned where
// they are STATED, not only where they are listed.

test("FG-639: the alternate-lane RULE names the lane's own runner output, not just the lane", () => {
  const md = readFileSync(seedPath, "utf8");
  const rule = md.split("\n").find((l) => l.includes("A skip is sound ONLY when")) ?? "";
  assert.ok(rule !== "", "the skip-soundness rule must be stated");
  assert.ok(
    rule.includes("runner_output"),
    "the rule must require the lane's own execution record — naming a lane resolves nothing",
  );
});

test("FG-639: the seed states that a check which RAN AND FAILED is not evidence either", () => {
  const md = readFileSync(seedPath, "utf8");
  assert.ok(md.includes("exit_status"), "the non-test step's execution record must be documented");
  assert.ok(
    md.toLowerCase().includes("ran and failed"),
    "a red check is the finding still being present, and the seed must say so",
  );
});

test("FG-639: the supported row requires an EXECUTED verification step, matching what the host enforces", () => {
  const md = readFileSync(seedPath, "utf8");
  const row = md.split("\n").find((l) => l.startsWith("| `supported`")) ?? "";
  assert.ok(row !== "", "the proportionality table must carry a supported row");
  assert.ok(row.includes("EXECUTED"), "an unexecuted step is refused, so 'relevant' understates the rule");
});

test("FG-639: the seed states proportional resolution evidence, including the demonstrated floor", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();
  assert.ok(md.includes("proportional"), "the proportionality rule must be named");
  assert.ok(
    md.includes("can never be closed by re-inspecting the code"),
    "and the demonstrated floor stated — that is the rule PRD #26 turns on",
  );
});

test("FG-639: every evidence kind and every recheck result the host accepts appears in the seed", () => {
  const md = readFileSync(seedPath, "utf8");
  for (const kind of RESOLUTION_EVIDENCE_KINDS) {
    assert.ok(md.includes(kind), `the seed must document the ${kind} evidence shape the host validates`);
  }
  for (const result of RECHECK_RESULTS) {
    assert.ok(md.includes(result), `the seed must document the ${result} result the host accepts`);
  }
});

test("FG-639: the seed states the two bounded jobs and refuses the third the model might invent", () => {
  // The role's SCOPE statement is operator-facing framing and stayed in the operator
  // seed; the resample/panel refusals are protocol. Both halves reach the agent, so
  // this reads both — which is also the guard that neither half loses its share.
  const md = (
    readFileSync(operatorSeedPath, "utf8") + readFileSync(seedPath, "utf8")
  ).toLowerCase();
  assert.ok(md.includes("exactly two bounded jobs") || md.includes("two bounded jobs"), "the scope must be bounded");
  assert.ok(md.includes("do not resample the repository"), "and the resample explicitly refused");
  assert.ok(md.includes("do not ask for another discovery panel"), "and so must launching another panel");
});

test("FG-639: the seed tells the rechecker it verifies evidence rather than repeating the fixer's claim", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();
  assert.ok(md.includes("you verify evidence") || md.includes("verify evidence; you never repeat"), "the stance must be stated");
  assert.ok(md.includes("restating the fixer's summary"), "and the specific failure it prevents named");
});

test("FG-639: the seed refuses new finding-/ticket-named test files as regression evidence", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();
  assert.ok(md.includes("names a behavior or invariant"), "a named regression test names a behavior");
  assert.ok(
    md.includes("does not mean a new file named after this finding or its ticket"),
    "and must not become one new file per finding or ticket (the debt FG-641 owns consolidating)",
  );
});

test("FG-639: the seed tells the rechecker its new findings land untriaged with no automatic fixer", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();
  assert.ok(md.includes("untriaged"), "new findings enter the ledger untriaged");
  assert.ok(md.includes("do not dispatch another fixer"), "and dispatch nothing");
  assert.ok(
    md.includes("does not acquire blocking force just because it arrived late"),
    "and lateness confers no blocking force (PRD #7)",
  );
});

// ─── FG-654: the rubric is published, and a tampered generation goes RED ─────
//
// Every assertion above reads the REPO's protocol file. That is now the right unit —
// since FG-654 the protocol is forge-owned and published atomically, so a host either
// has these exact bytes or is refused by name. What the repo assertions cannot say is
// that the refusal actually fires, so that is asserted here against a real generation.

test("FG-654: the rechecker's protocol publishes into a generation and resolves for dispatch", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-rechecker-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  const resolved = resolveAgentProtocol("review-rechecker", gen);
  assert.ok(resolved.ok, "after publish, dispatch must resolve the rechecker's protocol");
  if (resolved.ok) {
    assert.equal(resolved.text, readFileSync(seedPath, "utf8"), "the published bytes are the repo's bytes");
  }
  rmSync(home, { recursive: true, force: true });
});

test("FG-654: protocol bytes edited INSIDE the published generation refuse as tampered", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-rechecker-tamper-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  writeFileSync(
    join(gen.root, "agent-protocols", "review-rechecker.md"),
    `${readFileSync(seedPath, "utf8")}\n\nA LOCAL EDIT INSIDE THE FORGE-OWNED PROTOCOL\n`,
  );
  const resolved = resolveAgentProtocol("review-rechecker", gen);
  assert.equal(resolved.ok, false, "a hand-edited protocol inside the generation must be refused");
  if (!resolved.ok) assert.equal(resolved.reason, "protocol_tampered");
  rmSync(home, { recursive: true, force: true });
});

test("FG-654: a generation published WITHOUT protocols refuses the rechecker by name", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-rechecker-none-"));
  const gen = publishTestGeneration(home, { assetsParent: home, agentProtocols: false });
  const resolved = resolveAgentProtocol("review-rechecker", gen);
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.reason, "protocol_missing");
    assert.ok(resolved.refusal.includes("review-rechecker"));
    assert.ok(resolved.refusal.includes("forge upgrade"));
  }
  rmSync(home, { recursive: true, force: true });
});
