// FG-578 → FG-777: this file used to pin that `forge upgrade` must NEVER overwrite
// the operator's authored host RACI. FG-777 FLIPS that contract: agents,
// constraints and forge-raci.md are now forge-owned and ALWAYS upgraded — but the
// overwrite is GATED on FG-776's one-time host-edit backup, so a genuine edit is
// backed up before it is ever overwritten. This file now pins BOTH halves:
//
//   - the ALWAYS-UPGRADE (FG-777 tests): `forge upgrade` runs the FG-776 backup
//     first (writing the migration latch), then force-refreshes the authored RACI
//     and recompiles the policy from the SEED bytes. The operator's customization
//     is expected to have moved to a <project>/.forge override.
//   - the GATE-ABSENT retain (the surviving FG-578 direct-install tests): a bare
//     `FORCE=1 scripts/install-seeds.sh` on a host that never ran the migration
//     still RETAINS the authored files — the overwrite cannot fire without the
//     latch — so an operator who skips the migration is never silently clobbered.
//
// THE ORIGINAL DEFECT, for the record: upgrade.ts ran install-seeds.sh with
// FORCE=1 and the installer's generic predicate cp -f'd over EVERYTHING,
// forge-raci.md included, then recompiled routing-policy.yml FROM the clobbered
// source — with no backup. FG-578 stopped that by retaining; FG-777 re-enables the
// overwrite but only AFTER FG-776 has backed the edit up.
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
import { stageAgentProtocols } from "../../v2/seed-generation.testkit.js";

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
  writeFileSync(join(base, "seeds", "agents", "engineer", "CLAUDE.md"), "SEED agent prose\n");
  writeFileSync(join(base, "seeds", "constraints", "house-style.md"), "SEED constraint prose\n");
  writeFileSync(join(base, "seeds", "runtimes", "pi-apikey.yml"), "# SEED\nprovider: SEED\n");
  writeFileSync(join(base, "seeds", "orchestrator-template.md"), "SEED TEMPLATE\n");
  // FG-654: a release with no protocol for a covered role cannot publish a generation —
  // upgrade's publish step refuses it — so a release-shaped fixture carries the real set.
  stageAgentProtocols(join(base, "seeds"));
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
 *  is the one it states rather than whatever ran before it. FG-777: the
 *  `pre-upgrade-backup` dir is cleared too — it holds the FG-776 migration latch,
 *  and a latch leaked from a prior `upgradeAsRelease` test would flip a later
 *  DIRECT-install test's gate from retain to overwrite. Install STATE is what this
 *  resets, and the latch is install state. */
function freshHome(): string {
  const home = assertDisposableHome();
  for (const entry of ["forge-raci.md", "routing-policy.yml", "agents", "constraints", "runtimes", "workflows", "model-policy.example.yml", "pre-upgrade-backup"]) {
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

test("FG-777 (GATE, direct): FORCE=1 install-seeds.sh WITHOUT the migration latch does not overwrite a divergent operator RACI", () => {
  // THE GATE, exercised the way the docs tell operators to drive the writer. This
  // host never ran the FG-776 backup, so the latch is absent and the always-upgrade
  // is withheld: a bare `FORCE=1 scripts/install-seeds.sh` cannot fire the overwrite
  // without the latch. This is the assertion a runUpgrade-only test cannot make —
  // runUpgrade always writes the latch first — which is why the writer is driven
  // directly.
  assert.equal(executionModeFrom(join(release, "src", "v2")), "release", "the fixture really is a release, by the one mode oracle");
  const home = assertDisposableHome();

  installDirectly(); // first install: the operator's host now has the seed RACI
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE)); // `forge raci apply`

  installDirectly({ FORCE: "1" });

  assert.equal(
    readFileSync(join(home, "forge-raci.md"), "utf8"),
    raciDoc(OPERATOR_RESPONSIBLE),
    "no migration latch → the gate withholds the flip → the operator's audited routing change survives FORCE=1",
  );
});

test("FG-777 (CORE): forge upgrade ALWAYS-UPGRADES the host RACI — it backs the operator's edit up (FG-776) then overwrites it, and recompiles routing-policy.yml from the SEED bytes", () => {
  // The FG-777 inversion of the old FG-578 retain contract. forge upgrade now runs
  // the FG-776 host-edit backup FIRST (writing the migration latch), then
  // install-seeds sees the latch and force-refreshes the authored RACI. The
  // operator's routing customization is expected to have moved to a
  // <project>/.forge/forge-raci.md full-replacement override — the host RACI is
  // forge's again.
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE));

  const { out } = upgradeAsRelease({ json: true });
  const result = JSON.parse(out);

  // The host RACI is refreshed to this release's seed — the always-upgrade.
  assert.equal(readFileSync(join(home, "forge-raci.md"), "utf8"), raciDoc(SEED_RESPONSIBLE), "the host RACI is force-refreshed to the seed");
  // …and the derived policy follows it, compiled from the seed bytes now.
  assert.equal(responsibleInCompiledPolicy(home), SEED_RESPONSIBLE, "routing-policy.yml is recompiled from the refreshed seed RACI");
  assert.notEqual(responsibleInCompiledPolicy(home), OPERATOR_RESPONSIBLE, "the operator's host-RACI routing no longer stands — it moved to the project override");

  // The safety half, and the reason the overwrite is allowed at all: FG-776 backed
  // the operator's edit up BEFORE the overwrite, so a genuine edit is never
  // destroyed. The backup is on the machine surface.
  assert.equal(result.hostEditMigration, "backed-up", "the FG-776 backup ran before the overwrite");
  assert.ok(result.hostEditBackedUp.includes("forge-raci.md"), "the operator's RACI was backed up");
  const backedUp = readFileSync(join(result.hostEditBackupDir, "forge-raci.md"), "utf8");
  assert.equal(backedUp, raciDoc(OPERATOR_RESPONSIBLE), "the backup holds the operator's exact pre-upgrade bytes");
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

// ──────────── 2. THE GATE LIMITS, NOT DISABLES (create + forge-owned) ────────────

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

// ─────────── 3. THE GATE, ABSENT: agents/ and constraints/ retained + operator told ───────────

test("FG-777 (GATE): without the migration latch, divergent agents/ and constraints/ survive FORCE=1, and the operator is told the migration must run first", () => {
  // FG-777 flipped agents/constraints to forge-owned (always-upgraded), but the
  // flip is GATED on FG-776's host-edit backup. This host never ran it — no latch —
  // so the overwrite is withheld and the divergent files survive, exactly as they
  // did under the old FG-578 exemption. The operator is told WHY (the migration
  // must run first), which is what turns a silent no-op into an actionable state.
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "OPERATOR agent prose\n");
  writeFileSync(join(home, "constraints", "house-style.md"), "OPERATOR constraint prose\n");

  const out = installDirectly({ FORCE: "1" });

  assert.equal(readFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "utf8"), "OPERATOR agent prose\n");
  assert.equal(readFileSync(join(home, "constraints", "house-style.md"), "utf8"), "OPERATOR constraint prose\n");
  assert.match(out, /^Retained: agents\/engineer\/CLAUDE\.md /m, "and the operator is TOLD, per file");
  assert.match(out, /^Retained: constraints\/house-style\.md /m);
  assert.match(out, /GATED|migration|pre-upgrade backup/i, "the operator is told the flip is gated and the migration must run first");
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
  // THE TRAP, pinned at its exact seam. upgrade derives "[3/4] N component(s)
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

test("FG-777: upgrade's human output announces the host-edit backup and REFRESHES the authored RACI — no false 'retained' claim", () => {
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE));

  const { out } = upgradeAsRelease();

  // The FG-776 backup is announced BEFORE the refresh, naming the file it backed up.
  assert.match(out, /pre-upgrade host-edit backup/, "the backup step is announced");
  assert.match(out, /backed up/, "…and says it backed the edit up");
  assert.match(out, /forge-raci\.md/, "names WHICH file");
  // And the always-upgrade actually refreshes it: forge-raci.md IS installed now.
  assert.match(out, /Installing forge-raci\.md into|forge-raci\.md into/, "the authored RACI is refreshed, not retained");
  // The old FG-578 'NOT refreshed / these are yours' claim must be GONE — on the
  // upgrade path the latch is present, so nothing is retained.
  assert.ok(!/NOT refreshed/.test(out), "the flip means the authored seeds ARE refreshed — no stale 'not refreshed' claim");
});

test("FG-777: --json shows the authored RACI was refreshed (authoredRetention none), with the FG-776 backup recorded", () => {
  const home = assertDisposableHome();
  installDirectly();
  writeFileSync(join(home, "forge-raci.md"), raciDoc(OPERATOR_RESPONSIBLE));

  const { out } = upgradeAsRelease({ json: true });
  const result = JSON.parse(out);

  // Nothing is retained on the upgrade path: the migration latch is present, so the
  // authored RACI is force-refreshed like any forge-owned seed.
  assert.equal(result.authoredRetention, "none", "on the flipped upgrade path the authored seed is refreshed, not retained");
  assert.deepEqual(result.authoredRetentions, [], "…so there is no retained set");
  // The safety trail is what carries the operator's edit now: FG-776 backed it up.
  assert.equal(result.hostEditMigration, "backed-up");
  assert.deepEqual(result.hostEditBackedUp, ["forge-raci.md"], "the operator's edit is recorded as backed up before the overwrite");
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
