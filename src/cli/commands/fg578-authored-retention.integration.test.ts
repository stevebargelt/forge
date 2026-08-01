// FG-578: `forge upgrade` must not silently destroy the operator's authored host
// RACI — and the derived routing policy must be recompiled from what SURVIVED.
//
// THE DEFECT THIS FILE REPRODUCES: upgrade.ts runs install-seeds.sh with FORCE=1;
// the installer's generic predicate `[[ "${FORCE:-0}" == "1" || ! -e ... ]]` then
// cp -f'd over EVERYTHING, forge-raci.md included — the operator-authored routing
// source that `forge raci apply` audits every change to. upgrade then recompiled
// routing-policy.yml FROM the clobbered source, propagating the loss into the
// derivative. An operator applies an audited routing change through the gated,
// confirm-before-write channel that exists precisely so routing changes are
// reviewable, runs the ordinary supported `forge upgrade`, and their approved
// controls are silently reverted.
//
// WHY THIS FILE DRIVES THE INSTALLER DIRECTLY AND NOT ONLY runUpgrade: a
// runUpgrade-only test CANNOT distinguish a writer-side policy from a guard in
// the TypeScript caller — both go green. But FORCE is a published operator-facing
// contract: docs/how-to-upgrade.md, README.md, docs/how-to-new-workflow.md and
// seed-drift.ts's own remedy text all tell operators to run
// `FORCE=1 scripts/install-seeds.sh` themselves. A caller-side guard would ship
// this file passing while the clobber stayed live on three other documented entry
// points. So both paths are exercised, and the installer is exercised FIRST.
//
// SAFETY: every root here is disposable. The install prefix is the process-wide
// temp $FORGE_HOME from src/test-setup.ts (mkdtemp'd, removed on exit) — used
// directly, and NOT re-pointed, because util/paths.ts resolves RACI_PATH /
// ROUTING_POLICY_PATH at import time: overriding process.env.FORGE_HOME here
// would install into one home while upgrade compiled the policy against another,
// and the test would assert over two different hosts. `assertDisposableHome`
// below refuses to run against anything else. Nothing promotes this host, runs
// npm link, or mutates the forge checkout: the release fixture is a temp tree
// carrying a manifest, which is a release to the one mode oracle.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { runUpgrade } from "./upgrade.js";
import { compilePolicyFile } from "../../raci/host-policy.js";
import { assetRoot, executionModeFrom } from "../../v2/asset-root.js";

/** A route block the compiler accepts, with `responsible` as the ATTRIBUTABLE
 *  field: the whole point is telling apart a policy compiled from the operator's
 *  bytes and one compiled from the seed's. */
function raciDoc(responsible: string): string {
  return [
    "# forge RACI — host source",
    "",
    "### route: backend_work",
    "classification_hints: server, api",
    `responsible: ${responsible}`,
    "accountable: human",
    "path: invoke",
    "consulted: none",
    "required_followups: none",
    "informed: none",
    "force_rules: none",
    "",
  ].join("\n");
}

const SEED_RESPONSIBLE = "backend-specialist";
/** The audited change: what an operator's `forge raci apply` put on this host. */
const OPERATOR_RESPONSIBLE = "red-backend";

let release: string;

/** A tree shaped like a release: a manifest, the required asset dirs, and the
 *  REAL installer byte-for-byte (it resolves its own $HERE, so a release-bundled
 *  copy installs the release's seeds). Stubbing the installer would stub out the
 *  thing under test — scripts/install-seeds.sh IS the subject of this ticket. */
function releaseTree(): string {
  const base = mkdtempSync(join(tmpdir(), "fg578-release-"));
  mkdirSync(join(base, "seeds", "agents", "engineer"), { recursive: true });
  mkdirSync(join(base, "seeds", "constraints"), { recursive: true });
  mkdirSync(join(base, "seeds", "runtimes"), { recursive: true });
  mkdirSync(join(base, "scripts"), { recursive: true });
  writeFileSync(join(base, "seeds", "forge-raci.md"), raciDoc(SEED_RESPONSIBLE));
  // FG-654: a release carries a fenced protocol seed for every covered role (`engineer`
  // among them), and since RF-13 an upgrade that publishes nothing for one of them is
  // UNRESOLVED. Copying the real seeds keeps this fixture a COMPLETE release, so the
  // exit-code assertions below stay about retention — the variable this file isolates.
  cpSync(join(assetRoot(), "seeds", "agents"), join(base, "seeds", "agents"), { recursive: true });
  writeFileSync(join(base, "seeds", "constraints", "house-style.md"), "SEED constraint prose\n");
  writeFileSync(join(base, "seeds", "runtimes", "pi-apikey.yml"), "# SEED\nprovider: SEED\n");
  writeFileSync(join(base, "seeds", "orchestrator-template.md"), "SEED TEMPLATE\n");
  cpSync(join(assetRoot(), "scripts", "install-seeds.sh"), join(base, "scripts", "install-seeds.sh"));
  writeFileSync(join(base, "forge-release.json"), JSON.stringify({ schema: 1, abi: "137", id: "fg578-fixture" }));
  return base;
}

/** The install prefix, with the safety property stated as an assertion rather
 *  than a comment: if FORGE_HOME is ever not the suite's disposable temp home,
 *  this file must not run at all. The real ~/.forge is an operator's live control
 *  plane; a test that clobbers a RACI to prove forge doesn't would be the joke
 *  writing itself. */
function assertDisposableHome(): string {
  const home = process.env.FORGE_HOME;
  assert.ok(home, "FORGE_HOME must be set by src/test-setup.ts");
  assert.ok(home!.startsWith(tmpdir()) && /forge-test-/.test(home!), `refusing to run against a non-disposable FORGE_HOME: ${home}`);
  return home!;
}

/** A home wiped back to "never installed" between tests, so each test's premise
 *  is the one it states rather than whatever ran before it. */
function freshHome(): string {
  const home = assertDisposableHome();
  for (const entry of ["forge-raci.md", "routing-policy.yml", "agents", "constraints", "runtimes", "workflows", "model-policy.example.yml"]) {
    rmSync(join(home, entry), { recursive: true, force: true });
  }
  return home;
}

/** Run the REAL installer the way the docs tell operators to. */
function installDirectly(env: Record<string, string> = {}): string {
  return execFileSync("bash", [join(release, "scripts", "install-seeds.sh")], {
    env: { ...process.env, FORGE_HOME: assertDisposableHome(), CLAUDE_SKILLS_DEST: join(release, "skills-sink"), ...env },
    encoding: "utf8",
  });
}

/** runUpgrade reports failure through process.exitCode; a leaked 1 would fail
 *  this whole file with every test passing. */
function captureExit(fn: () => void): number | undefined {
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    fn();
    return process.exitCode as number | undefined;
  } finally {
    process.exitCode = before;
  }
}

/** Drive the real `forge upgrade` action as a release, capturing BOTH operator
 *  streams — the false-refresh claim this ticket forbids would be a line on one
 *  of them, so neither may be discarded.
 *
 *  --skip-git/--skip-npm are passed to ISOLATE THE VARIABLE, not for speed. A
 *  release refuses dev-advancement, and FG-577 classifies that refusal
 *  `unresolved` — correctly: the operator asked for advancement and did not get
 *  it. Leaving it in would make the exit code 1 for a reason that has nothing to
 *  do with this ticket, and the assertion "retention does not cost exit 0" could
 *  never fail. Skipped, the ONLY thing left that could raise the exit code is the
 *  retention state under test. */
function upgradeAsRelease(opts: { json?: boolean } = {}): { out: string; exitCode: number | undefined } {
  const lines: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  const skills = process.env.CLAUDE_SKILLS_DEST;
  process.env.CLAUDE_SKILLS_DEST = join(release, "skills-sink");
  try {
    const exitCode = captureExit(() => runUpgrade(
      { skipProject: true, skipGit: true, skipNpm: true, json: opts.json },
      { mode: "release", assetsDir: release, devDir: join(tmpdir(), "fg578-no-such-checkout") },
    ));
    return { out: lines.join("\n"), exitCode };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    if (skills === undefined) delete process.env.CLAUDE_SKILLS_DEST;
    else process.env.CLAUDE_SKILLS_DEST = skills;
  }
}

function responsibleInCompiledPolicy(home: string): string {
  const policy = yamlParse(readFileSync(join(home, "routing-policy.yml"), "utf8"));
  return policy.routes.backend_work.responsible;
}

beforeEach(() => {
  release = releaseTree();
  freshHome();
});

afterEach(() => {
  rmSync(release, { recursive: true, force: true });
  freshHome();
});

// ─────────────────────────── 1. THE CORE PROPERTY ───────────────────────────

test("FG-578 (CORE): FORCE=1 install-seeds.sh does not overwrite a divergent operator RACI", () => {
  // The writer, driven the way the docs tell operators to drive it. This is the
  // assertion a runUpgrade-only test cannot make: it fails on a caller-side guard,
  // which is what makes it evidence that the policy lives in the writer.
  assert.equal(executionModeFrom(join(release, "src", "v2")), "release", "the fixture really is a release, by the one mode oracle");
  const home = assertDisposableHome();

  installDirectly(); // first install: the operator's host now has the seed RACI
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE)); // `forge raci apply`

  installDirectly({ FORCE: "1" });

  assert.equal(
    readFileSync(join(home, "forge-raci.md"), "utf8"),
    raciDoc(OPERATOR_RESPONSIBLE),
    "PRE-FIX THIS CLOBBERS: FORCE=1 cp -f'd the seed over the operator's audited routing change",
  );
});

test("FG-578 (CORE): forge upgrade retains the operator RACI AND recompiles routing-policy.yml from the RETAINED bytes", () => {
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE));

  const { out } = upgradeAsRelease();

  // Half one: the source survived.
  assert.equal(readFileSync(join(home, "forge-raci.md"), "utf8"), raciDoc(OPERATOR_RESPONSIBLE), "the authored source survives the upgrade");

  // Half two — the one that actually matters, and the one "forge-raci.md still
  // exists" cannot prove. upgrade recompiles the DERIVED policy right after the
  // install; if the derivative inherited the seed's bytes, the operator's routing
  // is reverted in the artifact the orchestrator actually consumes and the
  // surviving source is a decoy. Retention that stops at the source is not
  // retention.
  assert.equal(
    responsibleInCompiledPolicy(home),
    OPERATOR_RESPONSIBLE,
    "routing-policy.yml must be compiled from the RETAINED operator RACI — the derivative does not inherit the exemption, it inherits the retained SOURCE",
  );
  assert.notEqual(responsibleInCompiledPolicy(home), SEED_RESPONSIBLE, "compiling the seed's routing into the live policy IS the defect");
  // FG-583: the flat routing-policy.yml is recompiled but marked non-authoritative
  // (drift/doctor only); the effective policy is published in the seed generation.
  assert.match(out, /routing-policy\.yml.*recompiled/, "the derived artifact is still kept in lockstep — the exemption is scoped to the SOURCE, not to $FORGE_HOME");
});

test("FG-578 (direct-path): recreating forge-raci.md via the installer does NOT recompile routing-policy.yml — it stays stale until `forge route compile`", () => {
  // The gap docs/how-to-upgrade.md warns about, pinned. The documented recipe for
  // re-testing an edit to an authored seed is "remove its ~/.forge/ copy so the
  // installer recreates it". For forge-raci.md that recreates the SOURCE but the
  // DERIVED routing-policy.yml is install-seeds.sh's explicit non-responsibility
  // (see AUTHORED_EXEMPT's comment) — so the live routing rules keep reflecting the
  // RACI that was just replaced. Compiling the policy is init/upgrade's job, or the
  // operator's via `forge route compile`; the installer never does it.
  const home = assertDisposableHome();

  // A host as `forge upgrade` leaves it: an authored RACI and a policy COMPILED
  // FROM IT (both responsible=OPERATOR).
  installDirectly();
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE));
  compilePolicyFile(join(home, "forge-raci.md"), join(home, "routing-policy.yml"));
  assert.equal(responsibleInCompiledPolicy(home), OPERATOR_RESPONSIBLE, "premise: the policy is derived from the operator RACI");

  // The recipe: drop the host RACI so the installer recreates it from the seed.
  rmSync(join(home, "forge-raci.md"));
  installDirectly({ FORCE: "1" });

  // The source is recreated from the seed...
  assert.equal(readFileSync(join(home, "forge-raci.md"), "utf8"), raciDoc(SEED_RESPONSIBLE), "the RACI is recreated from the seed");
  // ...but the installer left routing-policy.yml untouched, so it still routes by
  // the RACI that no longer exists. This is the trap the doc note now forbids.
  assert.equal(responsibleInCompiledPolicy(home), OPERATOR_RESPONSIBLE, "the derived policy is STALE — the installer does not recompile it");

  // The documented remedy closes the gap: compile brings the policy back in
  // lockstep with the recreated RACI.
  compilePolicyFile(join(home, "forge-raci.md"), join(home, "routing-policy.yml"));
  assert.equal(responsibleInCompiledPolicy(home), SEED_RESPONSIBLE, "`forge route compile` recompiles the policy from the recreated RACI");
});

// ──────────────────── 2. THE EXEMPTION LIMITS, NOT DISABLES ────────────────────

test("FG-578: first install still CREATES forge-raci.md from the seed", () => {
  // The seed's authority is CREATION. An exemption that also disabled that would
  // leave a fresh host with no RACI at all — fixing the clobber by breaking the
  // install.
  const home = freshHome();
  assert.ok(!existsSync(join(home, "forge-raci.md")), "premise: a host that has never been installed");

  const out = installDirectly();

  assert.equal(readFileSync(join(home, "forge-raci.md"), "utf8"), raciDoc(SEED_RESPONSIBLE), "an absent authored file is CREATED from the seed");
  assert.match(out, /Installing forge-raci\.md into/, "a real creation IS announced as an install — it happened");
  assert.ok(!/^Retained:/m.test(out), "nothing was retained on a first install: there was nothing there to retain");
});

test("FG-578: FORCE=1 still refreshes forge-OWNED seeds — the fix must not become a blanket no-op", () => {
  // The over-fix guard. runtimes are forge-owned execution artifacts and a stale
  // pi-apikey.yml silently rebinds the provider (#265) — the failure the drift
  // detector exists for. Exempting everything would fix FG-578 by breaking FG-335.
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "runtimes", "pi-apikey.yml"), "# STALE\nprovider: stale-and-wrong\n");

  installDirectly({ FORCE: "1" });

  assert.equal(readFileSync(join(home, "runtimes", "pi-apikey.yml"), "utf8"), "# SEED\nprovider: SEED\n", "FORCE=1 must still overwrite a drifted runtime seed");
});

test("FG-578: a BARE (non-FORCE) reinstall leaves every existing file byte-identical", () => {
  const home = assertDisposableHome();
  installDirectly();
  const edits: Record<string, string> = {
    "forge-raci.md": raciDoc(OPERATOR_RESPONSIBLE),
    "agents/engineer/CLAUDE.md": "LOCALLY EDITED agent\n",
    "constraints/house-style.md": "LOCALLY EDITED constraint\n",
    "runtimes/pi-apikey.yml": "# LOCALLY EDITED\nprovider: mine\n",
  };
  for (const [rel, body] of Object.entries(edits)) writeFileSync(join(home, rel), body);

  installDirectly(); // bare — no FORCE

  for (const [rel, body] of Object.entries(edits)) {
    assert.equal(readFileSync(join(home, rel), "utf8"), body, `bare reinstall must leave ${rel} untouched`);
  }
});

// ─────────── 3. AUDIT HIGH-2: agents/ and constraints/, DECIDED AND TESTED ───────────

test("FG-578 (audit HIGH-2): divergent agents/ and constraints/ files survive FORCE=1", () => {
  // Decided, not defaulted. seed-drift.ts has classified these two
  // operator-authored + prose — "may carry local edits → warn, never
  // auto-overwrite" — since FG-335, which shipped only the detector and named the
  // deferred half in as many words. util/paths.ts gives neither a project-level
  // override, so ~/.forge IS the only place an operator can edit them: authored
  // surfaces by construction. Leaving them to the generic FORCE branch by
  // omission would be a decision too — the silent one.
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "OPERATOR agent prose\n");
  writeFileSync(join(home, "constraints", "house-style.md"), "OPERATOR constraint prose\n");

  const out = installDirectly({ FORCE: "1" });

  assert.equal(readFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "utf8"), "OPERATOR agent prose\n");
  assert.equal(readFileSync(join(home, "constraints", "house-style.md"), "utf8"), "OPERATOR constraint prose\n");
  assert.match(out, /^Retained: agents\/engineer\/CLAUDE\.md /m, "and the operator is TOLD, per file");
  assert.match(out, /^Retained: constraints\/house-style\.md /m);
});

test("FG-578: a NEW seed file inside an exempt category is still installed alongside the operator's edits", () => {
  // The exemption is per FILE, not per directory: forge may not overwrite the
  // agent prose you edited, but a newly-shipped agent you have never seen must
  // still arrive — otherwise one local edit freezes the whole category forever.
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "OPERATOR agent prose\n");
  mkdirSync(join(release, "seeds", "agents", "brand-new"), { recursive: true });
  writeFileSync(join(release, "seeds", "agents", "brand-new", "CLAUDE.md"), "NEW seed agent\n");

  installDirectly({ FORCE: "1" });

  assert.equal(readFileSync(join(home, "agents", "brand-new", "CLAUDE.md"), "utf8"), "NEW seed agent\n", "a never-seen seed file is created");
  assert.equal(readFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "utf8"), "OPERATOR agent prose\n", "…without disturbing the edited one beside it");
});

// ─────────── 4. NO FALSE REFRESH — the summary-count trap ───────────

test("FG-578: a retained file is NOT echoed as 'Installing …' and NOT counted as refreshed", () => {
  // THE TRAP, pinned at its exact seam. upgrade derives "[3/5] N component(s)
  // refreshed" by counting installer stdout lines starting with "Installing". Had
  // install-seeds kept echoing "Installing forge-raci.md into $DEST/" while
  // skipping the copy, upgrade would report a refresh that DID NOT HAPPEN — the
  // false claim this ticket forbids, produced by a string-matching seam rather
  // than by anyone's decision.
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE));

  const out = installDirectly({ FORCE: "1" });

  assert.ok(!/Installing forge-raci\.md/.test(out), "the retained file must not be announced as an install");
  assert.match(out, /^Retained: forge-raci\.md /m, "it is announced as what it is");
  for (const line of out.split("\n").filter((l) => l.startsWith("Installing"))) {
    assert.ok(!/forge-raci\.md|agents/.test(line), `a retained/untouched category must not appear in the refreshed count: ${line}`);
  }
});

test("FG-578: upgrade's human output names WHAT was skipped and WHY, and claims no refresh that did not happen", () => {
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE));

  const { out } = upgradeAsRelease();

  assert.match(out, /NOT refreshed/, "says plainly that a refresh did NOT happen");
  assert.match(out, /operator-authored/, "names WHY — ownership, not an error");
  assert.match(out, /out of forge's control path/, "…and that this is a standing property, not this run's accident");
  assert.match(out, /forge-raci\.md/, "names WHICH file");
  // The new failure this fix introduces, named rather than buried: an operator
  // whose RACI is never refreshed runs old prose against new forge code. The
  // exemption is still right — losing an audited routing change is worse — but
  // silence about the trade would be the same dishonesty in the other direction.
  assert.match(out, /newer forge code/, "names the failure the exemption INTRODUCES");
  assert.ok(!/Installing forge-raci\.md/.test(out), "and never claims it installed it");
});

test("FG-578: --json exposes the retained set machine-readably, and the run is RESOLVED (exit 0)", () => {
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE));

  const { out, exitCode } = upgradeAsRelease({ json: true });
  const result = JSON.parse(out);

  assert.equal(result.authoredRetention, "retained", "the typed outcome variant is on the machine surface");
  assert.deepEqual(result.authoredRetentions, ["forge-raci.md"], "…with the named set, exactly as slashCommandOverrides is");

  // Classified RESOLVED, and the exit code is the assertion — not the table.
  // `retained` fires on EVERY host whose operator has ever run `forge raci apply`,
  // so classifying it unresolved would make exit 1 permanent for the supported,
  // audited workflow: forge declining to clobber a file it does not own is the
  // command working, not a failed request. (SLASH_COMMANDS' user-override is the
  // settled precedent for exactly this shape.)
  assert.equal(exitCode, undefined, "retention must not set a non-zero exit code");
  assert.equal(result.ok, true);
  assert.deepEqual(result.unresolved, [], "retention contributes no unresolved reason");
});

test("FG-578: a clean host reports retention as 'none' — the signal fires on the state, not on every run", () => {
  // The guard on every assertion above: if `retained` fired unconditionally, the
  // tests would pass while meaning nothing. An unedited host retained nothing.
  installDirectly();

  const { out, exitCode } = upgradeAsRelease({ json: true });
  const result = JSON.parse(out);

  assert.equal(result.authoredRetention, "none");
  assert.deepEqual(result.authoredRetentions, []);
  assert.equal(exitCode, undefined);
});

test("FG-578: when install-seeds never runs, retention is 'not-run' — not a clean ownership report", () => {
  // "Nothing was retained" and "nobody looked" are different facts. Collapsing
  // them would report a clean ownership picture for a host this upgrade never
  // touched — the same shape of lie as the false refresh, told by omission.
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE));
  rmSync(join(release, "scripts", "install-seeds.sh"));

  const { out } = upgradeAsRelease({ json: true });
  const result = JSON.parse(out);

  assert.equal(result.assetInstall, "not-found");
  assert.equal(result.authoredRetention, "not-run", "the installer never ran, so forge knows nothing about what it would have retained");
  assert.notEqual(result.authoredRetention, "none");
});
