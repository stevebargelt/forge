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
//
// AND CURRENCY IS A SECOND, DIFFERENT QUESTION. The manifest only proves a generation is
// internally whole; it cannot say the generation is THIS release's. So resolution also
// measures the generation's protocol bytes against the executing release's seeds/ — the
// `stale` refusal — because a host that installed a newer forge without `forge upgrade`
// is precisely the silent old-contract dispatch FG-654 exists to prevent.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { COVERED_ROLES, REVIEW_DISPATCH_ROLES, isCoveredRole } from "./review-contract.js";
import { protocolRelPath, resolveSeedGeneration, type SeedGeneration } from "./seed-generation.js";
import { assetRoot } from "./asset-root.js";
import { noCompleteGenerationError } from "./loader.js";

/** The failure kind a refused dispatch carries, and the discovery vocabulary word for
 *  the same fact. One literal so the dispatch seam and the ledger cannot drift. */
export const STALE_PROTOCOL_FAILURE_KIND = "stale_protocol";

/** The non-lens half of the coverage, DERIVED from the dispatch registry the dispatch
 *  sites themselves read (review-contract's REVIEW_DISPATCH_ROLES) rather than restated
 *  here — a second list a future dispatch role could be added to without is the same
 *  defect class as a seed that drifts silently. */
export const NON_LENS_COVERED_ROLES: readonly string[] = Object.values(REVIEW_DISPATCH_ROLES);

// Coverage and the generation-relative protocol path are owned by the registry and the
// generation respectively; re-exported so this module stays the one import for the
// dispatch gate's callers.
export { COVERED_ROLES, isCoveredRole, protocolRelPath };

function forgeHomeDefault(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

/** READ-ONLY. The operator's own seed, which forge reads at compose time and never
 *  writes. Nothing in this module — or any other — writes through this path. */
export function installedSeedPath(role: string, forgeHome: string = forgeHomeDefault()): string {
  return join(forgeHome, "agents", role, "CLAUDE.md");
}

/** The EXECUTING release's protocol source — the baseline a published generation is
 *  measured STALE against. A parameter everywhere below so the measure is pure over its
 *  filesystem inputs (the same shape detectSeedDrift's baseline has), never an ambient
 *  read a test has to defeat. */
export function releaseSeedsDirDefault(): string {
  return join(assetRoot(), "seeds");
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
      reason: "no_generation" | "protocol_missing" | "protocol_tampered" | "stale";
      refusal: string;
    };

const REMEDY = "run `forge upgrade` to publish a complete seed generation, then retry";

/** Resolve a covered role's protocol out of ONE published generation. The file is read
 *  once; the bytes read are the bytes hashed and the bytes returned.
 *
 *  `releaseSeedsDir` is the EXECUTING release's `seeds/`. Manifest consistency alone only
 *  proves a generation is internally whole — it says nothing about WHICH release published
 *  it, so a host whose generation predates the running forge would compose an old review
 *  protocol silently (the flat-copy drift measure that covers workflows/runtimes has no
 *  agent-protocols entry to catch it). That is the `stale` arm. */
export function resolveAgentProtocol(
  role: string,
  gen: SeedGeneration | null,
  releaseSeedsDir: string = releaseSeedsDirDefault(),
): ProtocolResolution {
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

  // STALE: manifest-consistent, but not this release's protocol. Reached by installing a
  // newer forge (or re-running install-seeds.sh, which writes no protocol at all) without
  // `forge upgrade`: the seed pointer still names the older generation, every covered role
  // composes the older release's contract, and nothing else would say so.
  //
  // A release that carries no protocol for this role is NOT measured here — there is no
  // baseline to measure against, and that release is refused at PUBLICATION instead
  // (publishSeedGeneration), which is where a missing source belongs.
  const releaseFile = join(releaseSeedsDir, rel);
  if (existsSync(releaseFile)) {
    const releaseSha = createHash("sha256").update(readFileSync(releaseFile)).digest("hex");
    if (releaseSha !== sha256) {
      return {
        ok: false,
        role,
        reason: "stale",
        refusal:
          `agent role "${role}"'s protocol in the published seed generation (${gen.root}) is BEHIND the forge ` +
          `that is executing: the generation carries ${sha256.slice(0, 12)}, this release ships ` +
          `${releaseSha.slice(0, 12)} at ${releaseFile}. The generation was published by another release and ` +
          `nothing has republished it, so dispatching would judge this reviewer's output by a contract the ` +
          `running forge no longer states. Remedy: ${REMEDY}.`,
      };
    }
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
  releaseSeedsDir: string = releaseSeedsDirDefault(),
): ProtocolAssertion {
  if (!isCoveredRole(role)) return { ok: true };
  const resolved = resolveAgentProtocol(role, gen, releaseSeedsDir);
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
  /** the executing release's `seeds/` — the staleness baseline. */
  releaseSeedsDir?: string;
};

export type ProtocolInspection = { role: string; ok: boolean; detail: string };

/** Read-only, one entry per covered role. `forge doctor` consumes this rather than
 *  re-deriving the comparison. Generation-backed AND legacy-aware: an installed seed
 *  still carrying an embedded protocol is just as unable to dispatch as a missing one. */
export function inspectAgentProtocols(opts: ProtocolInspectOptions = {}): ProtocolInspection[] {
  const forgeHome = opts.forgeHome ?? forgeHomeDefault();
  const gen = opts.generation !== undefined ? opts.generation : resolveSeedGeneration(forgeHome);
  const releaseSeedsDir = opts.releaseSeedsDir ?? releaseSeedsDirDefault();
  return COVERED_ROLES.map((role) => {
    const resolved = resolveAgentProtocol(role, gen, releaseSeedsDir);
    if (!resolved.ok) return { role, ok: false, detail: resolved.refusal };
    const installed = installedSeedPath(role, forgeHome);
    if (existsSync(installed)) {
      const legacy = detectEmbeddedLegacyProtocol(readFileSync(installed, "utf8"), resolved.text);
      if (legacy) return { role, ok: false, detail: `${installed}: ${legacy.detail}` };
    }
    return { role, ok: true, detail: `current (${resolved.sha256.slice(0, 12)}) from ${resolved.source}` };
  });
}
