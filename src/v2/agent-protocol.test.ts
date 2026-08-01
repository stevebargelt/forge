// FG-654 unit surface: the protocol resolver, the legacy detector, and the covered-role
// derivation. The end-to-end properties (byte-identical operator seeds across a real
// `forge upgrade`, refusal before container creation, the divergence probe) live in
// fg654-agent-protocol.integration.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COVERED_ROLES,
  LEGACY_PROTOCOL_MARKER_PREFIX,
  NON_LENS_COVERED_ROLES,
  STALE_PROTOCOL_FAILURE_KIND,
  assertAgentProtocolCurrent,
  detectEmbeddedLegacyProtocol,
  inspectAgentProtocols,
  isCoveredRole,
  protocolRelPath,
  resolveAgentProtocol,
} from "./agent-protocol.js";
import { REVIEW_DISPATCH_ROLES, RISK_LENSES, lensRole } from "./review-contract.js";
import { fixtureReleaseSeeds, publishTestGeneration } from "./seed-generation.testkit.js";
import type { SeedGeneration } from "./seed-generation.js";
import { assetRoot } from "./asset-root.js";

const PROTOCOL = "## The review protocol\n\nthe current generation\n";

function withGeneration<T>(
  fn: (ctx: { home: string; gen: SeedGeneration }) => T,
  agentProtocols?: false | Record<string, string>,
): T {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-unit-"));
  try {
    const gen = publishTestGeneration(home, {
      assetsParent: home,
      ...(agentProtocols === undefined ? {} : { agentProtocols }),
    });
    return fn({ home, gen });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ─── ACCEPTANCE 5: all nine roles, BY ITERATION ─────────────────────────────

test("FG-654: COVERED_ROLES is DERIVED from the lens map plus the dispatch registry", () => {
  assert.deepEqual(COVERED_ROLES, [...RISK_LENSES.map(lensRole), ...NON_LENS_COVERED_ROLES]);
  // The non-lens half is the dispatch registry's own values — not a list beside it.
  assert.deepEqual(NON_LENS_COVERED_ROLES, Object.values(REVIEW_DISPATCH_ROLES));
  assert.equal(COVERED_ROLES.length, 9, "five risk lenses plus four non-lens lifecycle roles");
  assert.equal(new Set(COVERED_ROLES).size, 9, "no duplicates");
  for (const role of COVERED_ROLES) assert.ok(isCoveredRole(role), `${role} must read as covered`);
  for (const role of ["synthesizer", "tech-lead", "architect", "engineer-x"]) {
    assert.ok(!isCoveredRole(role), `${role} must NOT be covered`);
  }
});

test("FG-654: every covered role ships a protocol, publishes into the generation, and resolves", () => {
  withGeneration(({ gen }) => {
    for (const role of COVERED_ROLES) {
      const rel = protocolRelPath(role);
      assert.equal(rel, `agent-protocols/${role}.md`);

      // Shipped by the release…
      const releaseBytes = readFileSync(join(assetRoot(), "seeds", rel));
      assert.ok(releaseBytes.length > 0, `${role}: the release protocol is empty`);

      // …published into the generation, with a manifest sha256…
      const manifested = gen.manifest.files[rel];
      assert.ok(manifested, `${role}: ${rel} is absent from the generation's provenance manifest`);
      assert.equal(
        manifested,
        createHash("sha256").update(releaseBytes).digest("hex"),
        `${role}: the manifest sha must digest the release bytes`,
      );

      // …and resolves for dispatch, returning those exact bytes.
      const resolved = resolveAgentProtocol(role, gen);
      assert.ok(resolved.ok, resolved.ok ? "" : `${role}: ${resolved.refusal}`);
      if (resolved.ok) {
        assert.equal(resolved.text, releaseBytes.toString("utf8"), `${role}: text must be the release bytes`);
        assert.equal(resolved.sha256, manifested);
        assert.equal(resolved.source, join(gen.root, rel));
      }
    }
  });
});

// ─── the three refusals, each naming the role and the remedy ────────────────

test("FG-654: a null generation refuses every covered role as no_generation", () => {
  for (const role of COVERED_ROLES) {
    const resolved = resolveAgentProtocol(role, null);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.equal(resolved.reason, "no_generation");
      assert.equal(resolved.role, role);
      assert.ok(resolved.refusal.includes(role), "names the role");
      assert.ok(resolved.refusal.includes("forge upgrade"), "names the remedy");
      // The loader's wording, so a pre-upgrade host reports ONE unmet precondition.
      assert.match(resolved.refusal, /no complete seed generation|refusing to dispatch/i);
    }
  }
});

test("FG-654: a generation with no agent-protocols refuses as protocol_missing", () => {
  withGeneration(({ gen }) => {
    const resolved = resolveAgentProtocol("red-wide", gen);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.equal(resolved.reason, "protocol_missing");
      assert.ok(resolved.refusal.includes("red-wide"));
      assert.ok(resolved.refusal.includes("agent-protocols/red-wide.md"));
      assert.ok(resolved.refusal.includes("forge upgrade"));
    }
  }, false);
});

test("FG-654: a protocol present on disk but ABSENT from the manifest refuses — closed set", () => {
  withGeneration(({ gen }) => {
    // An unmanifested EXTRA file, exactly the state the workflow/runtime checks refuse.
    writeFileSync(join(gen.root, "agent-protocols", "red-wide.md"), PROTOCOL);
    const resolved = resolveAgentProtocol("red-wide", gen);
    assert.equal(resolved.ok, false, "a file the manifest never published must not dispatch");
    if (!resolved.ok) assert.equal(resolved.reason, "protocol_missing");
  }, { engineer: PROTOCOL });
});

test("FG-654: bytes that do not match the manifest refuse as protocol_tampered, naming both digests", () => {
  withGeneration(({ gen }) => {
    writeFileSync(join(gen.root, protocolRelPath("engineer")), "## Something else\n");
    const resolved = resolveAgentProtocol("engineer", gen);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.equal(resolved.reason, "protocol_tampered");
      assert.ok(resolved.refusal.includes("engineer"));
      assert.ok(resolved.refusal.includes("provenance manifest"));
      assert.ok(resolved.refusal.includes("forge upgrade"));
      const digests = resolved.refusal.match(/[0-9a-f]{64}/g) ?? [];
      assert.equal(digests.length, 2, "the refusal names the read digest AND the manifest's");
    }
  }, { engineer: PROTOCOL });
});

// ─── the STALE arm: the generation is whole, but it is not THIS release's ───

test("FG-654: a manifest-consistent generation BEHIND the executing release refuses as stale", () => {
  withGeneration(({ gen }) => {
    // The generation is internally perfect — its bytes match its own manifest — and it
    // is exactly what a host that installed a newer forge without `forge upgrade` holds.
    const newerRelease = mkdtempSync(join(tmpdir(), "forge-fg654-newer-"));
    try {
      mkdirSync(join(newerRelease, "agent-protocols"), { recursive: true });
      writeFileSync(join(newerRelease, protocolRelPath("engineer")), "## The review protocol\n\nTHE NEW CONTRACT\n");
      const resolved = resolveAgentProtocol("engineer", gen, newerRelease);
      assert.equal(resolved.ok, false, "an old generation must not dispatch under the new release");
      if (!resolved.ok) {
        assert.equal(resolved.reason, "stale");
        assert.ok(resolved.refusal.includes("engineer"), "names the role");
        assert.ok(resolved.refusal.includes("forge upgrade"), "names the remedy");
        assert.ok(resolved.refusal.includes(gen.root), "names the generation it read");
      }
      // …and the same generation against the release it WAS published from is current.
      const current = resolveAgentProtocol("engineer", gen, fixtureReleaseSeeds(gen));
      assert.ok(current.ok, current.ok ? "" : current.refusal);
    } finally {
      rmSync(newerRelease, { recursive: true, force: true });
    }
  }, { engineer: PROTOCOL });
});

// RF-15: THE STALE MEASURE MUST NOT FAIL OPEN WHEN THERE IS NO BASELINE.
//
// The reachable state: a host publishes under release A (protocol present), then installs
// release B whose `seeds/agent-protocols/<role>.md` is absent. Publication refuses B, so
// nothing republishes and A's generation stays selected and manifest-consistent — exactly
// the silent old-contract dispatch this ticket exists to prevent. Delegating the case to
// publication covers only the generation B would have CREATED, never the one already there.
test("FG-654 RF-15: a release carrying no protocol for the role REFUSES — the currency measure is closed", () => {
  withGeneration(({ home, gen }) => {
    const damagedRelease = mkdtempSync(join(tmpdir(), "forge-fg654-empty-"));
    try {
      const resolved = resolveAgentProtocol("engineer", gen, damagedRelease);
      assert.equal(resolved.ok, false, "with no baseline the generation's currency is unknowable, not fine");
      if (!resolved.ok) {
        assert.equal(resolved.reason, "release_protocol_missing");
        assert.ok(resolved.refusal.includes("engineer"), "names the role");
        assert.ok(resolved.refusal.includes(join(damagedRelease, protocolRelPath("engineer"))), "names the file it looked for");
        assert.ok(/reinstall the release/i.test(resolved.refusal), "names the remedy that actually repairs it");
      }

      // The dispatch seam refuses on the same state — before any container exists…
      const dispatch = assertAgentProtocolCurrent("engineer", gen, null, damagedRelease);
      assert.equal(dispatch.ok, false, "the gate must refuse, not compose an unmeasurable contract");

      // …and doctor cannot report the host healthy while every covered role would refuse.
      const inspected = inspectAgentProtocols({ generation: gen, forgeHome: home, releaseSeedsDir: damagedRelease });
      assert.equal(inspected.filter((e) => e.ok).length, 0, "doctor must not read a damaged release as current");
    } finally {
      rmSync(damagedRelease, { recursive: true, force: true });
    }
  }, { engineer: PROTOCOL });
});

test("FG-654: doctor's inspection carries the same stale arm, by role", () => {
  withGeneration(({ home, gen }) => {
    const newerRelease = mkdtempSync(join(tmpdir(), "forge-fg654-newer-inspect-"));
    try {
      mkdirSync(join(newerRelease, "agent-protocols"), { recursive: true });
      for (const role of COVERED_ROLES) {
        writeFileSync(join(newerRelease, protocolRelPath(role)), `## ${role}\n\nTHE NEW CONTRACT\n`);
      }
      const stale = inspectAgentProtocols({ generation: gen, forgeHome: home, releaseSeedsDir: newerRelease });
      assert.equal(stale.filter((e) => e.ok).length, 0, "every covered role reads stale, not just the first");
      assert.ok(stale[0]?.detail.includes("BEHIND the forge"));
    } finally {
      rmSync(newerRelease, { recursive: true, force: true });
    }
  });
});

// ─── ACCEPTANCE 6 (unit half): detect and refuse, never migrate ─────────────

test("FG-654: the marker detector fires on the leftover fence, in either half", () => {
  for (const seed of [
    `# r\n\n${LEGACY_PROTOCOL_MARKER_PREFIX}start -->\n\nold\n\n${LEGACY_PROTOCOL_MARKER_PREFIX}end -->\n`,
    `# r\n\n${LEGACY_PROTOCOL_MARKER_PREFIX}start -->\n`,
    `# r\n\n${LEGACY_PROTOCOL_MARKER_PREFIX}end -->\n`,
  ]) {
    const hit = detectEmbeddedLegacyProtocol(seed, PROTOCOL);
    assert.equal(hit?.kind, "marker", "a lone marker is still a leftover region");
  }
});

test("FG-654: the heading detector is DERIVED from the protocol bytes, not a list", () => {
  const protocol = "## Alpha\n\na\n\n## Beta\n\nb\n";
  assert.equal(detectEmbeddedLegacyProtocol("# r\n\n## Alpha\n\nstale\n", protocol)?.kind, "heading");
  assert.equal(detectEmbeddedLegacyProtocol("# r\n\n## Beta\n\nstale\n", protocol)?.kind, "heading");
  // A heading the protocol does NOT own is the operator's own section.
  assert.equal(detectEmbeddedLegacyProtocol("# r\n\n## Gamma\n\nmine\n", protocol), null);
  // Depth matters: `### Alpha` is not the `## Alpha` the protocol owns.
  assert.equal(detectEmbeddedLegacyProtocol("# r\n\n### Alpha\n\nmine\n", protocol), null);
});

test("FG-654: a `## ` heading inside a fenced code block is content, not an embedded protocol", () => {
  const seed = "# r\n\nDo not write:\n\n```md\n## The review protocol\n```\n\n## My own section\n";
  assert.equal(detectEmbeddedLegacyProtocol(seed, PROTOCOL), null);
  // …and the same heading OUTSIDE a fence still fires, so the fence logic is not
  // suppressing the detector wholesale.
  assert.equal(detectEmbeddedLegacyProtocol(`${seed}\n## The review protocol\n`, PROTOCOL)?.kind, "heading");
});

test("FG-654: NO shipped operator seed collides with its own role's protocol", () => {
  // A collision would make a PRISTINE host refuse at every dispatch of the role, which
  // is the one way this detector could be worse than the defect it closes.
  for (const role of COVERED_ROLES) {
    const seed = readFileSync(join(assetRoot(), "seeds", "agents", role, "CLAUDE.md"), "utf8");
    const protocol = readFileSync(join(assetRoot(), "seeds", protocolRelPath(role)), "utf8");
    assert.equal(detectEmbeddedLegacyProtocol(seed, protocol), null, `${role}: heading collision`);
    assert.ok(!seed.includes(LEGACY_PROTOCOL_MARKER_PREFIX), `${role}: a marker survives in the seed`);
  }
});

// ─── the assertion seam ─────────────────────────────────────────────────────

test("FG-654: assertAgentProtocolCurrent returns ok with NO text and NO stamp for an uncovered role", () => {
  withGeneration(({ gen }) => {
    for (const role of ["synthesizer", "tech-lead", "architect"]) {
      const out = assertAgentProtocolCurrent(role, gen, {
        path: "/x/CLAUDE.md",
        text: "## The review protocol\n",
      });
      assert.ok(out.ok, `${role} must not be gated`);
      if (out.ok) {
        assert.equal(out.text, undefined);
        assert.equal(out.stamp, undefined);
      }
    }
  });
});

test("FG-654: an embedded legacy protocol refuses by name with MANUAL remediation, no rewrite", () => {
  withGeneration(({ gen }) => {
    const path = "/home/op/.forge/agents/engineer/CLAUDE.md";
    const out = assertAgentProtocolCurrent(
      "engineer",
      gen,
      {
        path,
        text: `# engineer\n\n${LEGACY_PROTOCOL_MARKER_PREFIX}start -->\n\nold\n\n${LEGACY_PROTOCOL_MARKER_PREFIX}end -->\n`,
      },
      fixtureReleaseSeeds(gen),
    );
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.role, "engineer");
      assert.ok(out.refusal.includes("engineer"), "names the role");
      assert.ok(out.refusal.includes(path), "names the installed path it was GIVEN");
      assert.ok(/by hand/i.test(out.refusal), "MANUAL remediation");
      assert.ok(/does not rewrite|Nothing was written/i.test(out.refusal), "says nothing was written");
      assert.ok(!/\.bak/.test(out.refusal), "and offers no backup, because none is made");
    }
  }, { engineer: PROTOCOL });
});

test("FG-654: an ABSENT operator seed is not a refusal — the contract comes from the generation", () => {
  withGeneration(({ gen }) => {
    const out = assertAgentProtocolCurrent("engineer", gen, null, fixtureReleaseSeeds(gen));
    assert.ok(out.ok, out.ok ? "" : out.refusal);
    if (out.ok) {
      assert.equal(out.text, PROTOCOL);
      assert.equal(out.stamp?.role, "engineer");
      assert.equal(
        out.stamp?.sha256,
        createHash("sha256").update(Buffer.from(PROTOCOL, "utf8")).digest("hex"),
      );
    }
  }, { engineer: PROTOCOL });
});

// ─── doctor's read-only view ────────────────────────────────────────────────

test("FG-654: inspectAgentProtocols reports one entry per covered role, and names the bad one", () => {
  withGeneration(({ home, gen }) => {
    const ok = inspectAgentProtocols({ generation: gen, forgeHome: home });
    assert.equal(ok.length, 9);
    assert.deepEqual(ok.map((e) => e.role), [...COVERED_ROLES]);
    assert.ok(ok.every((e) => e.ok), JSON.stringify(ok.filter((e) => !e.ok)));

    // A legacy-carrying installed seed flips exactly one role, by name.
    const agentDir = join(home, "agents", "red-security");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "CLAUDE.md"), `# red-security\n\n${LEGACY_PROTOCOL_MARKER_PREFIX}start -->\n`);
    const mixed = inspectAgentProtocols({ generation: gen, forgeHome: home });
    assert.deepEqual(mixed.filter((e) => !e.ok).map((e) => e.role), ["red-security"]);
    assert.ok(mixed.find((e) => e.role === "red-security")?.detail.includes(agentDir));
  });
});

test("FG-654: the failure-kind literal is the one word the dispatch seam and the ledger share", () => {
  assert.equal(STALE_PROTOCOL_FAILURE_KIND, "stale_protocol");
});

// ─── the durable docs describe what SHIPPED ─────────────────────────────────
//
// Nothing generates these documents from the code, and they are what a maintainer
// consults to interpret a refusal or a recorded receipt. A doc still describing the
// DELETED in-place writer — or a refusal set the code no longer has — is read as current
// behavior, so the agreement is asserted rather than left to review.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const invariantsDoc = (): string => readFileSync(join(repoRoot, "docs", "invariants.md"), "utf8");
const upgradeDoc = (): string => readFileSync(join(repoRoot, "docs", "how-to-upgrade.md"), "utf8");

test("FG-654 RF-5: invariant 4 states generation ownership, with no trace of the deleted in-place writer", () => {
  const doc = invariantsDoc();
  for (const gone of [
    /\.forge-pre-fg654/,
    /publishes it deterministically into the operator's file/,
    /one marker-fenced region per seed/,
    /adoption/i,
  ]) {
    assert.doesNotMatch(doc, gone, `invariants.md still describes the deleted in-place writer: ${gone}`);
  }
  assert.match(doc, /it does not live in the operator's file at all/, "…and states where the protocol DOES live");
  assert.match(doc, /seeds\/agent-protocols\/<role>\.md/, "…naming the forge-owned seed category");
  assert.match(doc, /STALE \(manifest-consistent, but not the executing release's bytes/, "…and the stale refusal");
  // Forge writing an operator-owned file is the invariant itself, so it is stated whole.
  assert.match(doc, /Forge NEVER writes an operator-owned `~\/\.forge\/agents\/<role>\/CLAUDE\.md`/);
});

test("FG-654 RF-8: invariant 6 describes the receipt the manifest actually carries", () => {
  const doc = invariantsDoc();
  assert.doesNotMatch(
    doc,
    /content hash of the Forge-owned region in the seed/,
    "invariant 6 still describes the region hash of an operator-owned file",
  );
  assert.match(doc, /sha256 of the WHOLE Forge-owned protocol file/, "the identity the stamp actually digests");
  assert.match(doc, /path inside the resolved seed generation/, "…and the source it actually names");
  // The manifest's own doc comment is the other half of this agreement.
  const manifest = readFileSync(join(repoRoot, "src", "v2", "task-manifest.ts"), "utf8");
  assert.match(manifest, /whole protocol file's bytes/);
  assert.match(manifest, /path inside the resolved seed generation/);
});

test("FG-654 RF-7: the upgrade doc documents the embedded-legacy refusal most hosts will hit", () => {
  const doc = upgradeDoc();
  assert.match(doc, /### The embedded-legacy-protocol refusal/, "the state gets its own operator-facing section");
  assert.match(doc, /`forge upgrade` will not fix this for you/, "…and says plainly that upgrade does not repair it");
  assert.match(doc, /delete the marker-fenced region \(markers included\)/, "…with the manual repair spelled out");
  // The doctor paragraph must not enumerate generation states alone: protocol state exits
  // non-zero too, and a reader who stops at "only a complete generation is healthy" is
  // told the opposite of what a legacy-carrying host will see.
  const doctorPara = doc.split("\n").find((l) => l.includes("Only a **complete published generation** is healthy"));
  assert.ok(doctorPara, "the doctor paragraph must still exist");
  assert.match(doctorPara!, /Forge-owned agent protocol/, "…and must say protocol state is part of the verdict");
  assert.match(doctorPara!, /still embedded in your own agent seed/, "…naming the state upgrade does not repair");
});

test("FG-654 RF-14: the documented refusal-state count matches the table, which matches the code", () => {
  const doc = upgradeDoc();
  const lines = doc.split("\n");
  const introIdx = lines.findIndex((l) => l.includes("REFUSED at dispatch"));
  assert.ok(introIdx > 0, "the dispatch-refusal table intro must still exist");
  const claimed = /in (four|five|six|seven|eight) states/.exec(lines[introIdx]!);
  assert.ok(claimed, `the intro must still state a count: ${lines[introIdx]}`);
  const words: Record<string, number> = { four: 4, five: 5, six: 6, seven: 7, eight: 8 };

  let rows = 0;
  for (let i = introIdx + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    if (!line.startsWith("|")) break;
    if (/^\|\s*State\s*\|/.test(line) || /^\|\s*-+/.test(line.replace(/\s/g, " "))) continue;
    rows++;
  }
  assert.equal(words[claimed[1]!], rows, "the prose count and the table's rows must agree");

  // …and the table is the code's refusal set: every resolution reason plus the embedded
  // legacy arm, which lives in assertAgentProtocolCurrent rather than the union.
  const source = readFileSync(join(repoRoot, "src", "v2", "agent-protocol.ts"), "utf8");
  const union = /reason:\s*("[a-z_]+"(?:\s*\|\s*"[a-z_]+")+)/.exec(source);
  assert.ok(union, "the refusal union must still be a literal union — update this guard if it moved");
  const reasons = union[1]!.match(/"[a-z_]+"/g) ?? [];
  assert.equal(rows, reasons.length + 1, "one table row per refusal reason, plus the embedded-legacy arm");

  // The publishing-side paragraph makes no ordinal claim of its own — the drift RF-14
  // reported was exactly an ordinal that stopped matching the table above it.
  const publishing = lines.find((l) => l.includes("on the publishing side rather than the dispatching one"));
  assert.ok(publishing, "the publishing-side refusal must still be documented");
  assert.doesNotMatch(publishing!, /A (fourth|fifth|sixth|seventh) state/, "no ordinal to drift out of date");
});
