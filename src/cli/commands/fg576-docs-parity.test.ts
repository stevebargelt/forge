// FG-576 step 12 (AC15/AC9) — the provider-neutral orchestrator launcher's operator
// surface is DOCUMENTED, and the documentation names only things that exist.
//
// ─── WHY THIS TEST HAS TO EXIST ──────────────────────────────────────────────
// `forge orchestrator` and `forge claude` share one resolver, one adapter contract
// and one capability/parity matrix (src/orchestrator/launch.ts, src/orchestrator/
// adapter.ts, src/v2/orchestrator-capabilities.ts). None of that guarantees an
// operator can find out what it does: a refusal code could be renamed, a capability
// row could gain a tenth member, or a flag could be dropped, and
// docs/how-to-orchestrator-launcher.md would keep describing the old surface with
// nothing noticing — which is worse than no docs, because a reader trusts them.
//
// ─── WHY IT IS NOT VACUOUS ───────────────────────────────────────────────────
// Every check below derives its EXPECTED side from the real shipped module: the
// registered `forge orchestrator` Commander options, `forge claude`'s own argument
// description (it is not Commander-option-based — it deliberately keeps
// `allowUnknownOption()`/`passThroughOptions()` so passthrough works without a `--`
// separator, so its owned-flag set is scraped from the string the command itself
// prints in `--help`), `LAUNCH_REFUSAL_CODES`, `ORCHESTRATOR_REFUSAL_CODES`, and
// `ORCHESTRATOR_CAPABILITIES`. A hardcoded list on either side would survive a
// rename; scraping both sides from the same sources the operator and the CLI both
// read is what makes a drift fail here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerOrchestrator } from "./orchestrator.js";
import { registerClaude } from "./claude.js";
import { LAUNCH_REFUSAL_CODES } from "../../orchestrator/adapter.js";
import { ORCHESTRATOR_REFUSAL_CODES } from "../../v2/orchestrator-resolve.js";
import { ORCHESTRATOR_CAPABILITIES, ORCHESTRATOR_CAPABILITY_IDS } from "../../v2/orchestrator-capabilities.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/** Where the launcher's operator surface is described. LAUNCHER carries the full
 *  contract (flags, refusals, capability matrix, resume semantics, the AC grid);
 *  the other three are the required cross-links (AC15) and are checked only for
 *  the specific claims the step requires of them. */
const LAUNCHER = "docs/how-to-orchestrator-launcher.md";
const MODEL_POLICY = "docs/how-to-model-policy.md";
const QUICK_START = "docs/quick-start.md";
const README = "README.md";

const launcherDoc = read(LAUNCHER);

// ─── the registered `forge orchestrator` / `forge claude` surface ────────────

function registeredOrchestratorFlags(): Set<string> {
  const program = new Command();
  program.enablePositionalOptions();
  registerOrchestrator(program);
  const orchestrator = program.commands.find((c) => c.name() === "orchestrator");
  assert.ok(orchestrator, "`forge orchestrator` is not registered — every flag check below derives from it");
  return new Set(orchestrator.options.map((o) => o.long).filter((l): l is string => typeof l === "string"));
}

/** `forge claude` is NOT Commander-option-based (it keeps `allowUnknownOption()` +
 *  `passThroughOptions()` so operator passthrough works without a `--` separator),
 *  so its Forge-owned flag set cannot be walked off `.options`. It IS declared,
 *  verbatim, in the `[args...]` argument description the command registers with
 *  Commander — the same string `forge claude --help` prints — so scraping that is
 *  reading the real registered surface rather than a second, driftable copy of it. */
function claudeShortcutOwnedFlags(): Set<string> {
  const program = new Command();
  program.enablePositionalOptions();
  registerClaude(program);
  const claude = program.commands.find((c) => c.name() === "claude");
  assert.ok(claude, "`forge claude` is not registered — every flag check below derives from it");
  const description = claude.registeredArguments[0]?.description ?? "";
  const flags = [...description.matchAll(/(--[a-z][a-z-]*|-[a-z])\b/g)].map((m) => m[1]!);
  assert.ok(flags.length >= 6, `only scraped ${flags.length} flag(s) out of forge claude's argument description — the scrape stopped matching`);
  return new Set(flags);
}

const orchestratorFlags = registeredOrchestratorFlags();
const claudeFlags = claudeShortcutOwnedFlags();

test("FG-576: every registered `forge orchestrator` flag has operator-facing text in the launcher doc", () => {
  assert.ok(orchestratorFlags.size >= 5, `only ${orchestratorFlags.size} flag(s) registered on \`forge orchestrator\``);
  const missing = [...orchestratorFlags].filter((f) => !launcherDoc.includes(`\`${f}`) && !launcherDoc.includes(f));
  assert.deepEqual(missing, [], `flag(s) registered on \`forge orchestrator\` but never mentioned in ${LAUNCHER}`);
});

test("FG-576: every Forge-owned \`forge claude\` flag has operator-facing text in the launcher doc", () => {
  const missing = [...claudeFlags].filter((f) => !launcherDoc.includes(f));
  assert.deepEqual(missing, [], `flag(s) forge claude owns but never mentioned in ${LAUNCHER}: ${missing.join(", ")}`);
});

test("FG-576: every \`forge orchestrator --xxx\` flag the launcher doc names is a REAL registered flag", () => {
  // The reverse direction: a doc naming a flag that no longer exists is exactly the
  // drift this test exists to catch, and it fails silently in the forward direction
  // above (a dropped flag leaves nothing to be "missing" from).
  const bogus = new Set<string>();
  for (const rawLine of launcherDoc.split("\n")) {
    // A passthrough example ("forge orchestrator -- --add-dir ...") deliberately
    // shows a flag Forge does NOT own — that is the whole point of passthrough — so
    // anything after a bare `--` separator on the line is out of scope here.
    const line = rawLine.split(/\s--(?:\s|$)/)[0]!;
    if (!line.includes("forge orchestrator")) continue;
    for (const m of line.matchAll(/(--[a-z][a-z-]*)/g)) {
      const flag = m[1]!;
      if (!orchestratorFlags.has(flag)) bogus.add(flag);
    }
  }
  assert.deepEqual([...bogus], [], `${LAUNCHER} names a \`forge orchestrator\` flag that is not registered: ${[...bogus].join(", ")}`);
});

// ─── every pre-spawn refusal reason is named, operator-facing, in the doc ────

const ALL_REFUSAL_CODES = [...ORCHESTRATOR_REFUSAL_CODES, ...LAUNCH_REFUSAL_CODES];

test("FG-576: the refusal-code scrape actually found both vocabularies (guards a silently-empty check)", () => {
  assert.ok(ORCHESTRATOR_REFUSAL_CODES.length >= 9, `only ${ORCHESTRATOR_REFUSAL_CODES.length} resolution refusal code(s)`);
  assert.ok(LAUNCH_REFUSAL_CODES.length >= 9, `only ${LAUNCH_REFUSAL_CODES.length} launch-boundary refusal code(s)`);
  assert.equal(new Set(ALL_REFUSAL_CODES).size, ALL_REFUSAL_CODES.length, "a code appears in both vocabularies — the two closed sets are supposed to be disjoint");
});

test("FG-576 AC5/AC15: every pre-spawn refusal reason has operator-facing text in the launcher doc", () => {
  const missing = ALL_REFUSAL_CODES.filter((code) => !launcherDoc.includes(`\`${code}\``));
  assert.deepEqual(
    missing,
    [],
    `refusal code(s) with no operator-facing text in ${LAUNCHER}: ${missing.join(", ")} — an operator hitting ` +
      `one of these has nothing in the docs to explain it`,
  );
});

// ─── every capability-matrix row is named, and Codex's gaps are not smoothed over ──

test("FG-576 AC9: the matrix scrape actually found all nine capabilities (guards a silently-empty check)", () => {
  assert.equal(ORCHESTRATOR_CAPABILITY_IDS.length, 9, "the capability matrix grew or shrank — update this test's expectations deliberately");
});

test("FG-576 AC9: every capability-matrix row has operator-facing text in the launcher doc, by its own title", () => {
  const missing = ORCHESTRATOR_CAPABILITIES.filter((row) => !launcherDoc.includes(row.title));
  assert.deepEqual(
    missing.map((r) => r.capability),
    [],
    `capability row(s) with no operator-facing text (by title) in ${LAUNCHER}`,
  );
});

test("FG-576 AC9: Codex's named gaps are NOT smoothed over — every one of its non-supported capabilities is called out", () => {
  // Structural rather than string-matching each limitation verbatim: every capability
  // where Codex's cell is not "supported" must have SOME mention of Codex near an
  // unsupported/partial/gated word in the doc, so a future edit cannot quietly drop
  // one adapter's gap while leaving the row's title in place.
  const codexGaps = ORCHESTRATOR_CAPABILITIES.filter((r) => r.adapters.codex.support !== "supported");
  assert.ok(codexGaps.length >= 5, `expected several named Codex gaps, found ${codexGaps.length}`);
  for (const row of codexGaps) {
    const at = launcherDoc.indexOf(row.title);
    assert.ok(at >= 0, `${row.capability}: title not found`);
    const windowText = launcherDoc.slice(at, at + 1200);
    assert.match(
      windowText,
      /unsupported|partial|evidence-gated/i,
      `${LAUNCHER} names '${row.title}' but does not say Codex's support for it is anything other than full parity`,
    );
  }
});

test("FG-576: skills/commands, hooks, usage evidence and remote control are each named as Codex gaps, not smoothed over", () => {
  // The step's own required-coverage list, checked by literal phrase rather than by
  // capability id, because these are the specific promises AC15 makes to the reader.
  //
  // FG-253 moved the skills-commands cell off `unsupported` onto `partial` — Codex now
  // gets rendered repository-scoped skills — so the doc's gap-statement changed from "no
  // equivalent surface" to "installed is not active": activation is unverified, never
  // claimed, because repository-scoped skill discovery is version-coupled and an older
  // Codex build ignores the directory silently.
  assert.match(launcherDoc, /activation is[^.]*unverified/i, "no statement that Codex skill/command activation is unverified");
  assert.match(launcherDoc, /no hook/i, "no statement that Codex supplies no heartbeat/interaction hook");
  assert.match(launcherDoc, /no equivalent authoritative usage evidence/i, "no statement that Codex exposes no usage evidence");
  assert.match(launcherDoc, /no remote-control link is captured/i, "no statement that Codex gets no remote-control link");
});

// ─── AC3: the Codex-by-policy recipe, stated exactly as an operator would type it ──

test("FG-576 AC3: the Codex-by-policy recipe is stated VERBATIM, copy-pasteable", () => {
  assert.match(
    launcherDoc,
    /overrides:\n {2}agents:\n {4}orchestrator: codex-subscription/,
    `${LAUNCHER} does not state the \`overrides.agents.orchestrator: codex-subscription\` recipe as a literal, ` +
      "indented YAML block an operator could paste",
  );
  assert.match(launcherDoc, /No Forge source edit, no shell alias, no per-project repetition/i);
});

// ─── the AC1–AC15 evidence grid ───────────────────────────────────────────────

type GridRow = { ac: number; paths: string[] };

function evidenceGrid(): GridRow[] {
  const at = launcherDoc.indexOf("## Acceptance evidence");
  assert.ok(at > 0, `${LAUNCHER} has no "## Acceptance evidence" section`);
  const section = launcherDoc.slice(at);
  const rows: GridRow[] = [];
  for (const line of section.split("\n")) {
    const m = /^\| AC(\d+) \|.*\|\s*(.+?)\s*\|$/.exec(line.trim());
    if (!m) continue;
    const paths = [...m[2]!.matchAll(/`([^`]+)`/g)].map((p) => p[1]!);
    rows.push({ ac: Number(m[1]), paths });
  }
  return rows;
}

const grid = evidenceGrid();

test("FG-576 AC15: the evidence grid cites AC1 through AC15, each exactly once", () => {
  assert.ok(grid.length >= 15, `only scraped ${grid.length} row(s) out of the AC1–AC15 grid — the scrape stopped matching`);
  const numbers = grid.map((r) => r.ac).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 15 }, (_, i) => i + 1), "the grid does not cite exactly AC1–AC15 once each");
});

test("FG-576 AC15: every path the evidence grid cites is a real file in this repo", () => {
  const missing: string[] = [];
  for (const row of grid) {
    assert.ok(row.paths.length > 0, `AC${row.ac} cites no test file`);
    for (const p of row.paths) {
      if (!existsSync(join(repoRoot, p))) missing.push(`AC${row.ac}: ${p}`);
    }
  }
  assert.deepEqual(missing, [], "the evidence grid cites a path that does not exist");
});

test("FG-576 AC5/AC8/AC13: their dedicated regressions are cited by name, not just any covering test", () => {
  const byAc = new Map(grid.map((r) => [r.ac, r.paths]));
  assert.ok(
    byAc.get(5)?.includes("src/v2/fg576-orchestrator-resolve.test.ts"),
    "AC5's grid row does not cite its dedicated regression (src/v2/fg576-orchestrator-resolve.test.ts)",
  );
  assert.ok(
    byAc.get(8)?.includes("src/orchestrator/fg576-codex-carrier-evidence.test.ts"),
    "AC8's grid row does not cite its dedicated regression (src/orchestrator/fg576-codex-carrier-evidence.test.ts)",
  );
  assert.ok(
    byAc.get(13)?.includes("src/orchestrator/fg576-launch-lifecycle.integration.test.ts"),
    "AC13's grid row does not cite its dedicated regression (src/orchestrator/fg576-launch-lifecycle.integration.test.ts)",
  );
});

// ─── AC13: the manual live smoke is optional operator evidence, not a CI gate ────

test("FG-576 AC13: the doc states the manual live smoke is OPTIONAL and gates nothing", () => {
  const at = launcherDoc.indexOf("## Manual live smoke");
  assert.ok(at > 0, `${LAUNCHER} has no manual-live-smoke section`);
  const section = launcherDoc.slice(at, launcherDoc.indexOf("\n## ", at + 1));
  assert.match(section, /optional/i);
  assert.match(section, /gates nothing|not a CI gate|no CI check depends on it/i);
  assert.match(section, /no criterion below cites it as its proof|no test in CI ever starts a billed/i);
});

// ─── cross-links (AC15) ───────────────────────────────────────────────────────

test("FG-576 AC15: docs/how-to-model-policy.md links to the launcher doc and names the orchestrator role", () => {
  const text = read(MODEL_POLICY);
  assert.match(text, /overrides\.agents\.orchestrator/);
  assert.match(text, /how-to-orchestrator-launcher\.md/);
});

test("FG-576 AC15: docs/quick-start.md documents the D16 forge-claude refusal and links to the launcher doc", () => {
  const text = read(QUICK_START);
  assert.match(text, /forge claude` refuses before launching anything/);
  assert.match(text, /how-to-orchestrator-launcher\.md/);
});

test("FG-576 AC15: README.md links to the launcher doc", () => {
  const text = read(README);
  assert.match(text, /how-to-orchestrator-launcher\.md/);
});
