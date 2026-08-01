// FG-654: the Forge-owned agent protocol — a FORGE-OWNED SEED GENERATION CATEGORY.
//
// FG-578 made ~/.forge/agents/<role>/CLAUDE.md operator-authored: forge creates it once
// and never writes over it, FORCE=1 included. That is right for the operator's own
// customization and wrong for the REVIEW PROTOCOL, which is Forge's — the two shared one
// overwrite-or-retain unit, so protecting the second silently froze the first. Measured
// 2026-07-31: every discovery lens on the reporting host was running a pre-evidence-led
// contract, which surfaced downstream as a malformed_output storm rather than as a seed
// problem, and nothing in the run record said which protocol generation had actually run.
//
// THE FIX IS OWNERSHIP, NOT SURGERY. The protocol no longer lives inside the operator's
// file at all: it is `seeds/agent-protocols/<role>.md`, a category of the SAME atomic seed
// generation that already publishes workflows and runtimes (seed-generation.ts). It is
// staged, digested into the provenance manifest, and committed by the one rename(2) with
// everything else. There is no second publication mechanism and nothing here writes to
// $FORGE_HOME — the operator's seed is READ, never touched, and compose puts the protocol
// AHEAD of it.
//
// IDENTITY IS THE WHOLE PROTOCOL FILE, checked against the generation's own manifest —
// the same closed-set + digest discipline assertGenerationWorkflowConsistent applies. A
// whole-operator-file hash would make every customizing host permanently stale; a
// composed-prompt hash varies with step id / workflow / runTags / the constraint filter,
// so it is unique per task and answers nothing.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { RISK_LENSES, lensRole } from "./review-contract.js";
import { resolveSeedGeneration, type SeedGeneration } from "./seed-generation.js";
import { noCompleteGenerationError } from "./loader.js";

/** The failure kind a refused dispatch carries, and the discovery vocabulary word for
 *  the same fact. One literal so the dispatch seam and the ledger cannot drift. */
export const STALE_PROTOCOL_FAILURE_KIND = "stale_protocol";

/** The four review-lifecycle dispatch roles that are NOT one of the five risk lenses.
 *  They cannot be derived from a type, so `fg578-ownership-agreement.test.ts` parses the
 *  real dispatch sites (review-wiring.ts's `agentRole:` literals, runNext.ts's
 *  shipping-reviewer literal) and fails naming any role missing from here. */
export const NON_LENS_COVERED_ROLES = [
  "engineer",
  "documentation-maintainer",
  "review-rechecker",
  "shipping-reviewer",
] as const;

/** Every role the review lifecycle dispatches. The lens half is DERIVED from
 *  review-contract's own map — a hand-copied lens list is the same defect class as a
 *  seed that drifts silently. */
export const COVERED_ROLES: readonly string[] = [
  ...RISK_LENSES.map((l) => lensRole(l)),
  ...NON_LENS_COVERED_ROLES,
];

export function isCoveredRole(role: string): boolean {
  return COVERED_ROLES.includes(role);
}

function forgeHomeDefault(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

/** READ-ONLY. The operator's own seed, which forge reads at compose time and never
 *  writes. Nothing in this module — or any other — writes through this path. */
export function installedSeedPath(role: string, forgeHome: string = forgeHomeDefault()): string {
  return join(forgeHome, "agents", role, "CLAUDE.md");
}

/** The one place the generation-relative protocol path is spelled. */
export function protocolRelPath(role: string): string {
  return `agent-protocols/${role}.md`;
}

// ─── resolution against the published generation ────────────────────────────

/** The RECORDED dispatch-time protocol fact. Written into the task manifest and
 *  indexed by the review ledger. */
export type AgentProtocolStamp = {
  role: string;
  sha256: string;
  /** the protocol file's absolute path inside the resolved generation */
  source: string;
};

export type ProtocolResolution =
  | { ok: true; role: string; text: string; sha256: string; source: string }
  | {
      ok: false;
      role: string;
      reason: "no_generation" | "protocol_missing" | "protocol_tampered";
      refusal: string;
    };

const REMEDY = "run `forge upgrade` to publish a complete seed generation, then retry";

/** Resolve a covered role's protocol out of ONE published generation. The file is read
 *  once; the bytes read are the bytes hashed and the bytes returned. */
export function resolveAgentProtocol(role: string, gen: SeedGeneration | null): ProtocolResolution {
  // Deferring to the loader's wording on purpose: a host that has never upgraded is
  // missing ONE precondition, and it should read one refusal naming it, not two.
  if (!gen) {
    return {
      ok: false,
      role,
      reason: "no_generation",
      refusal: `agent role "${role}" is covered by the Forge-owned review protocol. ${noCompleteGenerationError("agent-protocols").message}`,
    };
  }

  const rel = protocolRelPath(role);
  const source = join(gen.root, rel);
  const expected = gen.manifest.files[rel];
  if (!existsSync(source) || expected === undefined) {
    return {
      ok: false,
      role,
      reason: "protocol_missing",
      refusal:
        `agent role "${role}" is covered by the Forge-owned review protocol, but the published seed generation ` +
        `at ${gen.root} carries no manifest-consistent ${rel}. Dispatching it would run a reviewer that was never ` +
        `told the contract its output is judged by. Remedy: ${REMEDY}.`,
    };
  }

  const bytes = readFileSync(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected) {
    return {
      ok: false,
      role,
      reason: "protocol_tampered",
      refusal:
        `agent role "${role}"'s protocol at ${source} does not match the seed generation's provenance manifest ` +
        `(${gen.root}): read ${sha256}, manifest ${expected}. The generation is torn or was tampered with — a ` +
        `state no release shipped — so the dispatch is refused rather than run against unknown bytes. ` +
        `Remedy: ${REMEDY}.`,
    };
  }
  return { ok: true, role, text: bytes.toString("utf8"), sha256, source };
}

// ─── embedded legacy protocols: DETECT AND REFUSE, never migrate ────────────

/** DETECTION-ONLY. A leftover of the removed in-place writer: nothing parses a fence and
 *  nothing writes a marker any more, and this must never grow a matching writer. */
export const LEGACY_PROTOCOL_MARKER_PREFIX = "<!-- forge:agent-protocol-";

export type EmbeddedLegacyProtocol = { kind: "marker" | "heading"; detail: string };

/** `## ` headings at markdown-code-fence depth 0. A `## ` inside a fenced code block is
 *  content, not a heading — reading one as a heading is how a detector cries wolf. */
function headings(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^## /.test(line)) out.push(line.trimEnd());
  }
  return out;
}

/** Does the operator's installed seed still carry a protocol inside it? Two shapes: the
 *  marker-fenced region the removed implementation wrote, and the pre-FG-654 unfenced
 *  shape — a `## ` heading this generation's protocol also owns. Both are refused by
 *  name; neither is migrated, because rewriting an operator-authored file is exactly the
 *  thing FG-578 settled that forge does not do. */
export function detectEmbeddedLegacyProtocol(
  installedSeedText: string,
  protocolText: string,
): EmbeddedLegacyProtocol | null {
  if (installedSeedText.includes(LEGACY_PROTOCOL_MARKER_PREFIX)) {
    return {
      kind: "marker",
      detail: `it still contains a '${LEGACY_PROTOCOL_MARKER_PREFIX}…' marker-fenced region`,
    };
  }
  const owned = new Set(headings(protocolText));
  const collision = headings(installedSeedText).find((h) => owned.has(h));
  if (collision !== undefined) {
    return {
      kind: "heading",
      detail: `it still contains the section '${collision}', which this release's protocol owns`,
    };
  }
  return null;
}

// ─── the dispatch-time gate ─────────────────────────────────────────────────

export type ProtocolAssertion =
  | { ok: true; text?: string; stamp?: AgentProtocolStamp }
  | { ok: false; role: string; refusal: string };

/** ROLE-KEYED, so it gates every lifecycle that dispatches a covered role off the same
 *  generation — including the legacy review-loop's red-wide — and is not forgeable by
 *  dispatching through the other mode. Uncovered roles (synthesizer, tech-lead, the
 *  specialists) are untouched. */
export function assertAgentProtocolCurrent(
  role: string,
  gen: SeedGeneration | null,
  // Path AND text together, because a refusal that cannot name the file the operator has
  // to edit is not actionable — and re-deriving the path from $FORGE_HOME would name a
  // different file than the one compose actually read.
  installedSeed: { path: string; text: string } | null,
): ProtocolAssertion {
  if (!isCoveredRole(role)) return { ok: true };
  const resolved = resolveAgentProtocol(role, gen);
  if (!resolved.ok) return { ok: false, role, refusal: resolved.refusal };

  if (installedSeed !== null) {
    const legacy = detectEmbeddedLegacyProtocol(installedSeed.text, resolved.text);
    if (legacy) {
      return {
        ok: false,
        role,
        refusal:
          `agent role "${role}"'s installed seed at ${installedSeed.path} carries an embedded copy of the ` +
          `Forge-owned review protocol: ${legacy.detail}. Since FG-654 the protocol is composed from the ` +
          `published seed generation (${resolved.source}), so the embedded copy would be delivered a second ` +
          `time — an older contract contradicting the current one in the same prompt. Forge does not rewrite ` +
          `your file: delete the embedded protocol section (or the marker-fenced region) from that file by ` +
          `hand, then retry. Nothing was written and no backup was made.`,
      };
    }
  }

  return {
    ok: true,
    text: resolved.text,
    stamp: { role, sha256: resolved.sha256, source: resolved.source },
  };
}

// There is deliberately NO `agentProtocolStamp(role)` helper here. The stamp a manifest
// records must be the one the COMPOSE that produced the prompt resolved — it rides
// TaskPackage.agentProtocol from there to writeTaskManifest. A function that re-derives it
// from a role is a second read of the generation minutes later: it can name a generation
// the container was never given, or return undefined for a covered role that did dispatch,
// and either way the receipt asserts something untrue about the run.

// ─── reporting ──────────────────────────────────────────────────────────────

export type ProtocolInspectOptions = {
  /** `undefined` resolves the live seed pointer; `null` means none anchored. */
  generation?: SeedGeneration | null;
  forgeHome?: string;
};

export type ProtocolInspection = { role: string; ok: boolean; detail: string };

/** Read-only, one entry per covered role. `forge doctor` consumes this rather than
 *  re-deriving the comparison. Generation-backed AND legacy-aware: an installed seed
 *  still carrying an embedded protocol is just as unable to dispatch as a missing one. */
export function inspectAgentProtocols(opts: ProtocolInspectOptions = {}): ProtocolInspection[] {
  const forgeHome = opts.forgeHome ?? forgeHomeDefault();
  const gen = opts.generation !== undefined ? opts.generation : resolveSeedGeneration(forgeHome);
  return COVERED_ROLES.map((role) => {
    const resolved = resolveAgentProtocol(role, gen);
    if (!resolved.ok) return { role, ok: false, detail: resolved.refusal };
    const installed = installedSeedPath(role, forgeHome);
    if (existsSync(installed)) {
      const legacy = detectEmbeddedLegacyProtocol(readFileSync(installed, "utf8"), resolved.text);
      if (legacy) return { role, ok: false, detail: `${installed}: ${legacy.detail}` };
    }
    return { role, ok: true, detail: `current (${resolved.sha256.slice(0, 12)}) from ${resolved.source}` };
  });
}
