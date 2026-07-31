// FG-654: the marker-fenced Forge-owned protocol region — the region reader, the
// adoption ladder, and the per-role coverage guard.
//
// The ladder is the dangerous half. It WRITES to $FORGE_HOME/agents/<role>/CLAUDE.md —
// files forge has promised since FG-578 never to write after creation — so a boundary bug
// (a duplicated heading, a `## ` inside a fenced code block, CRLF, an operator heading
// that collides with a Forge one) silently swallows or reorders content the operator
// wrote. Every rung has a named case, and the refuse rung asserts the file is UNTOUCHED.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COVERED_ROLES,
  NON_LENS_COVERED_ROLES,
  PROTOCOL_START_MARKER,
  PROTOCOL_END_MARKER,
  PRE_ADOPTION_BACKUP_SUFFIX,
  applyProtocolRegion,
  fencedBlock,
  isCoveredRole,
  protocolSha256,
  publishAgentProtocolRegions,
  readProtocolRegion,
  regionHeadings,
  resolveAgentProtocol,
  inspectAgentProtocols,
} from "./agent-protocol.js";
import { RISK_LENSES, lensRole } from "./review-contract.js";

const REGION = "## The protocol\n\nrule one\n\n## More protocol\n\nrule two";

// ─── P5: coverage is derived, not hand-copied ───────────────────────────────

test("FG-654: COVERED_ROLES is the five lens roles DERIVED from review-contract, plus the four named non-lens roles", () => {
  for (const lens of RISK_LENSES) {
    assert.ok(COVERED_ROLES.includes(lensRole(lens)), `${lens} lens role missing from COVERED_ROLES`);
  }
  for (const role of NON_LENS_COVERED_ROLES) assert.ok(COVERED_ROLES.includes(role));
  assert.equal(COVERED_ROLES.length, RISK_LENSES.length + NON_LENS_COVERED_ROLES.length);
  assert.equal(new Set(COVERED_ROLES).size, COVERED_ROLES.length, "no duplicates");
});

test("FG-654: roles outside the review lifecycle are NOT covered", () => {
  for (const role of ["synthesizer", "tech-lead", "architecture-advisor", "backend-specialist", "research-primary"]) {
    assert.equal(isCoveredRole(role), false, `${role} must not be gated`);
  }
});

// ─── P1: the region reader ──────────────────────────────────────────────────

test("FG-654: the region is the content between the markers, LF-normalized and trimmed", () => {
  const read = readProtocolRegion(`# role\n\nmine\n\n${PROTOCOL_START_MARKER}\r\n\r\n${REGION}\r\n\r\n${PROTOCOL_END_MARKER}\n`);
  assert.equal(read.kind, "fenced");
  if (read.kind === "fenced") assert.equal(read.region, REGION);
});

test("FG-654: identity is the REGION, so an operator edit outside the fence does not change the sha", () => {
  const a = `# role\n\n${fencedBlock(REGION)}\n`;
  const b = `# role\n\nMY OWN LONG SECTION\n\n${fencedBlock(REGION)}\n\n## Mine too\n\nmore\n`;
  const ra = readProtocolRegion(a);
  const rb = readProtocolRegion(b);
  assert.ok(ra.kind === "fenced" && rb.kind === "fenced");
  if (ra.kind === "fenced" && rb.kind === "fenced") {
    assert.equal(protocolSha256(ra.region), protocolSha256(rb.region));
  }
});

test("FG-654: a lone or duplicated marker is UNBALANCED, never a guessed boundary", () => {
  assert.equal(readProtocolRegion(`x\n${PROTOCOL_START_MARKER}\nbody\n`).kind, "unbalanced");
  assert.equal(readProtocolRegion(`x\n${PROTOCOL_END_MARKER}\nbody\n`).kind, "unbalanced");
  assert.equal(readProtocolRegion(`${PROTOCOL_END_MARKER}\nb\n${PROTOCOL_START_MARKER}\n`).kind, "unbalanced");
  assert.equal(
    readProtocolRegion(`${fencedBlock("a")}\n${fencedBlock("b")}`).kind,
    "unbalanced",
    "two pairs is ambiguous, not 'the first one'",
  );
  assert.equal(readProtocolRegion("no markers here").kind, "unfenced");
});

test("FG-654: regionHeadings ignores a `## ` inside a fenced code block", () => {
  const region = "## Real heading\n\n```md\n## Not a heading\n```\n\n## Also real";
  assert.deepEqual(regionHeadings(region), ["## Real heading", "## Also real"]);
});

// ─── P2: the four adoption rungs ────────────────────────────────────────────

test("FG-654 rung (a) SPLICE: balanced markers replace in place; everything outside survives verbatim", () => {
  const existing = `# red-wide\n\nMY PREAMBLE\n\n${fencedBlock("## The protocol\n\nOLD")}\n\n## My own section\n\nmine\n`;
  const out = applyProtocolRegion(existing, REGION);
  assert.equal(out.action, "replaced");
  assert.ok(out.content.includes("MY PREAMBLE"));
  assert.ok(out.content.includes("## My own section\n\nmine"));
  assert.ok(out.content.includes("rule two"));
  assert.ok(!out.content.includes("OLD"));
  // Re-running is a no-op.
  assert.equal(applyProtocolRegion(out.content, REGION).action, "unchanged");
});

test("FG-654 rung (b) ADOPT: an unmarked legacy file's matching sections are excised and fenced in place", () => {
  const existing = [
    "# red-wide",
    "",
    "## My own section",
    "",
    "operator prose that must survive byte-for-byte",
    "",
    "## The protocol",
    "",
    "an OLD copy of rule one",
    "",
    "## My trailing section",
    "",
    "also mine",
    "",
  ].join("\n");
  const out = applyProtocolRegion(existing, REGION);
  assert.equal(out.action, "adopted");
  assert.ok(out.excisedChanged, "the excised section differed → a .bak is warranted");
  assert.ok(out.content.includes("operator prose that must survive byte-for-byte"));
  assert.ok(out.content.includes("## My trailing section\n\nalso mine"));
  assert.ok(!out.content.includes("an OLD copy of rule one"), "the legacy Forge section is gone");
  // In POSITION: the fence lands where the excised section was — after the operator's
  // first section and before their trailing one.
  const iMine = out.content.indexOf("## My own section");
  const iFence = out.content.indexOf(PROTOCOL_START_MARKER);
  const iTrail = out.content.indexOf("## My trailing section");
  assert.ok(iMine < iFence && iFence < iTrail, "adoption preserved relative order");
  assert.equal(applyProtocolRegion(out.content, REGION).action, "unchanged");
});

test("FG-654 rung (c) APPEND: a legacy file with NO matching heading is appended to — nothing can be lost", () => {
  // The measured host's state: all five red seeds carried no FG-640 section at all.
  const existing = "# red-wide\n\n## Reading the project\n\nmine\n\n## Stance\n\nalso mine\n";
  const out = applyProtocolRegion(existing, REGION);
  assert.equal(out.action, "appended");
  assert.ok(!out.excisedChanged, "nothing was excised, so no .bak");
  assert.ok(out.content.startsWith(existing.trimEnd()), "every original byte survives, in order, at the front");
  assert.ok(out.content.includes("rule one"));
  assert.equal(applyProtocolRegion(out.content, REGION).action, "unchanged");
});

test("FG-654 rung (d) REFUSE: a lone marker leaves the file UNTOUCHED and names the exact repair", () => {
  const existing = `# red-wide\n\n${PROTOCOL_START_MARKER}\n\n${REGION}\n\n## My own tail\n\nmine\n`;
  const out = applyProtocolRegion(existing, REGION);
  assert.equal(out.action, "needs-markers");
  assert.equal(out.content, existing, "the file is byte-identical — nothing was guessed");
  if (out.action === "needs-markers") {
    assert.ok(out.message.includes(PROTOCOL_START_MARKER));
    assert.ok(out.message.includes(PROTOCOL_END_MARKER));
    assert.ok(out.message.includes("Nothing was written."));
  }
});

test("FG-654 rung (d) REFUSE: a DUPLICATED region heading is ambiguous, so it is refused too", () => {
  const existing = "# red-wide\n\n## The protocol\n\nfirst\n\n## Mine\n\nx\n\n## The protocol\n\nsecond\n";
  const out = applyProtocolRegion(existing, REGION);
  assert.equal(out.action, "needs-markers");
  assert.equal(out.content, existing);
  if (out.action === "needs-markers") assert.ok(out.message.includes("## The protocol"));
});

test("FG-654: a `## ` inside an operator's fenced code block is never mistaken for a section boundary", () => {
  const existing = [
    "# red-wide",
    "",
    "## The protocol",
    "",
    "old",
    "",
    "## My own section",
    "",
    "```md",
    "## The protocol",
    "",
    "this is an EXAMPLE in my docs, not a section",
    "```",
    "",
    "trailing operator prose",
    "",
  ].join("\n");
  const out = applyProtocolRegion(existing, REGION);
  assert.equal(out.action, "adopted");
  assert.ok(out.content.includes("this is an EXAMPLE in my docs, not a section"));
  assert.ok(out.content.includes("trailing operator prose"));
});

test("FG-654: adoption of a byte-identical legacy section needs no backup", () => {
  const existing = `# red-wide\n\n## Mine\n\nx\n\n${REGION}\n`;
  const out = applyProtocolRegion(existing, REGION);
  assert.equal(out.action, "adopted");
  assert.ok(!out.excisedChanged);
});

test("FG-654: CRLF input is handled without corrupting the operator's content", () => {
  const existing = "# red-wide\r\n\r\n## Mine\r\n\r\noperator line\r\n";
  const out = applyProtocolRegion(existing, REGION);
  assert.equal(out.action, "appended");
  assert.ok(out.content.includes("operator line"));
  assert.ok(out.content.includes(PROTOCOL_START_MARKER));
});

// ─── the publisher, against a real fixture tree ─────────────────────────────

function hostFixture(): { root: string; home: string; seeds: string } {
  const root = mkdtempSync(join(tmpdir(), "forge-fg654-"));
  const home = join(root, "home");
  const seeds = join(root, "release", "seeds");
  for (const role of COVERED_ROLES) {
    mkdirSync(join(seeds, "agents", role), { recursive: true });
    writeFileSync(join(seeds, "agents", role, "CLAUDE.md"), `# ${role}\n\n${fencedBlock(REGION)}\n`);
  }
  mkdirSync(join(home, "agents"), { recursive: true });
  return { root, home, seeds };
}

test("FG-654: publish creates every covered role's seed on a host that has never run forge", () => {
  const fx = hostFixture();
  const out = publishAgentProtocolRegions({ forgeHome: fx.home, seedsDir: fx.seeds });
  assert.equal(out.length, COVERED_ROLES.length);
  for (const o of out) assert.equal(o.action, "created", `${o.role}`);
  for (const r of inspectAgentProtocols({ forgeHome: fx.home, seedsDir: fx.seeds })) {
    assert.ok(r.ok, r.ok ? "" : r.refusal);
  }
  // Idempotent.
  const again = publishAgentProtocolRegions({ forgeHome: fx.home, seedsDir: fx.seeds });
  for (const o of again) assert.equal(o.action, "unchanged");
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: publish preserves operator customization BYTE-FOR-BYTE while updating the Forge region, and writes the .bak", () => {
  const fx = hostFixture();
  const role = "red-wide";
  const operatorProse = "## My house rule\n\nAlways check the ledger first. Never skip this.";
  mkdirSync(join(fx.home, "agents", role), { recursive: true });
  writeFileSync(
    join(fx.home, "agents", role, "CLAUDE.md"),
    `# ${role}\n\n${operatorProse}\n\n## The protocol\n\nan OLD generation\n`,
  );

  const out = publishAgentProtocolRegions({ forgeHome: fx.home, seedsDir: fx.seeds });
  const mine = out.find((o) => o.role === role);
  assert.equal(mine?.action, "adopted");
  assert.equal(mine?.backupPath, join(fx.home, "agents", role, "CLAUDE.md") + PRE_ADOPTION_BACKUP_SUFFIX);
  assert.ok(existsSync(mine!.backupPath!), "the pre-adoption copy is on disk, not just named");

  const after = readFileSync(join(fx.home, "agents", role, "CLAUDE.md"), "utf8");
  assert.ok(after.includes(operatorProse), "the operator's section survives byte-for-byte");
  assert.ok(after.indexOf(operatorProse) < after.indexOf(PROTOCOL_START_MARKER), "and in its original position");
  const read = readProtocolRegion(after);
  assert.ok(read.kind === "fenced");
  if (read.kind === "fenced") assert.equal(read.region, REGION, "the region byte-equals the release's");
  assert.ok(resolveAgentProtocol(role, { forgeHome: fx.home, seedsDir: fx.seeds }).ok);
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: publish REFUSES a seed with an ambiguous fence and leaves it untouched", () => {
  const fx = hostFixture();
  const role = "engineer";
  const broken = `# ${role}\n\n${PROTOCOL_START_MARKER}\n\n## The protocol\n\nhalf-edited\n`;
  mkdirSync(join(fx.home, "agents", role), { recursive: true });
  writeFileSync(join(fx.home, "agents", role, "CLAUDE.md"), broken);
  const out = publishAgentProtocolRegions({ forgeHome: fx.home, seedsDir: fx.seeds });
  const mine = out.find((o) => o.role === role);
  assert.equal(mine?.action, "needs-markers");
  assert.equal(readFileSync(join(fx.home, "agents", role, "CLAUDE.md"), "utf8"), broken);
  // The other eight are still published — one bad seed does not block the rest.
  assert.equal(out.filter((o) => o.action === "created").length, COVERED_ROLES.length - 1);
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: dryRun writes nothing", () => {
  const fx = hostFixture();
  const out = publishAgentProtocolRegions({ forgeHome: fx.home, seedsDir: fx.seeds, dryRun: true });
  assert.equal(out.length, COVERED_ROLES.length);
  for (const role of COVERED_ROLES) {
    assert.equal(existsSync(join(fx.home, "agents", role, "CLAUDE.md")), false, `${role} was written on a dry run`);
  }
  rmSync(fx.root, { recursive: true, force: true });
});

test("FG-654: resolveAgentProtocol names BOTH shas and the remedy on a stale region", () => {
  const fx = hostFixture();
  publishAgentProtocolRegions({ forgeHome: fx.home, seedsDir: fx.seeds });
  const role = "review-rechecker";
  mkdirSync(join(fx.home, "agents", role), { recursive: true });
  writeFileSync(join(fx.home, "agents", role, "CLAUDE.md"), `# ${role}\n\n${fencedBlock("## The protocol\n\nMUTATED")}\n`);
  const r = resolveAgentProtocol(role, { forgeHome: fx.home, seedsDir: fx.seeds });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "stale");
    assert.equal(r.sha256, protocolSha256("## The protocol\n\nMUTATED"));
    assert.equal(r.requiredSha256, protocolSha256(REGION));
    assert.ok(r.refusal.includes(r.sha256!) && r.refusal.includes(r.requiredSha256!));
    assert.ok(r.refusal.includes("forge upgrade"));
    assert.ok(r.refusal.includes(role));
  }
  rmSync(fx.root, { recursive: true, force: true });
});
