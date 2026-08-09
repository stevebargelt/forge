// FG-583 (FG-572 Child 5h) — THE SEED GENERATION: atomic publication of the
// forge-owned, dispatch-coupled host seed surface.
//
// THE DEFECT THIS CLOSES. Host seed installation used to be a sequential `cp` loop
// (scripts/install-seeds.sh) with no staging, no publication point, no lock, no
// rollback. A concurrent `forge next` consumes the shared workflow/runtime/policy
// surface directly. An interrupted or mid-flight upgrade could therefore expose a
// TORN yaml (fails dispatch) or — the sharp case — an old/new MIXTURE that still
// passes Zod, so dispatch runs under a workflow/policy set no release ever shipped.
// No attacker, no same-UID tampering: an ordinary interrupted upgrade is enough.
//
// THE FIX — reuse FG-571's settled atomic-publication vocabulary (promote.ts), do
// NOT invent a second mechanism. The forge-owned dispatch-coupled surfaces
// (workflows, runtimes, the derived compiled routing policy) are staged as ONE
// complete generation under a fresh directory, then committed with a SINGLE
// rename(2) over a DEDICATED seed pointer that resolves THROUGH a stable selection
// dir (seedCurrentLinkIn -> seed-selection/current). Generation dirs are retained,
// never recycled — a process resolves the pointer PHYSICALLY at dispatch entry and
// stays anchored to the generation it found, exactly as promote.ts anchors a
// release. So every consuming process observes ONE complete generation: the one
// current before the upgrade, or the complete one the upgrade publishes, never a
// torn or mixed surface.
//
// MEMBERSHIP is only the forge-owned overwrite-on-upgrade surfaces. agents,
// constraints and raci are AUTHORED_EXEMPT (seed-drift.ts SeedOwnership) — forge
// seeds them once and never writes over them — so they stay create-only OUTSIDE the
// generation, on the flat $FORGE_HOME layout the installer already writes.
//
// SOURCE TRUST — the generation is sourced through FG-577's assetRoot executing-
// release provenance (the caller passes assetRoot()); a caller-selected
// FORGE_REPO_DIR, the live dev checkout, or a bare releases/* path is never the
// source. DESTINATION TRUST — staging and publication destinations are realpath-
// contained inside the disposable $FORGE_HOME; a replaceable destination symlink
// that would redirect publication outside the home is refused BEFORE any byte is
// written, leaving the unrelated target byte-for-byte unchanged.

import { compilePolicyFile } from "../raci/host-policy.js";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  seedCurrentLinkIn,
  seedGenerationsDirIn,
  seedPreviousLinkIn,
  seedSelectionLinkIn,
  seedSelectionsDirIn,
} from "../util/paths.js";
import { atomicSymlinkSwap, realpathContains } from "./promote.js";
import { assetRoot as executingAssetRoot } from "./asset-root.js";
import { sha256OfBytes } from "../util/content-digest.js";
import { COVERED_ROLES } from "./review-contract.js";
import { OPERATOR_WORKFLOW_IDS, operatorSurface, operatorWorkflow } from "./operator-workflows.js";
import { CODEX_ACTIVATION_PHRASES, codexSkillName, codexSkillTargetPath } from "./render-codex-skills.js";

// Resolved LIVE from the environment, matching loader.ts's forgeHome() — the seed
// pointer resolvers and the loaders that consume them MUST agree on which home they
// read, or a process that swaps FORGE_HOME (every test uses a disposable home) would
// resolve the pointer from one home and the workflows from another. The paths.ts
// FORGE_HOME const captures the env at import time, so it is NOT usable as the default.
function liveForgeHome(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

/** The forge-owned, dispatch-coupled seed categories that ride inside the atomic
 *  generation. Each is a directory of files copied verbatim from the release's
 *  seeds/. The derived routing policy is committed alongside them (see
 *  publishSeedGeneration) so raw definitions and derived artifact land in ONE swap. */
export const SEED_GENERATION_DIRS = ["workflows", "runtimes", "agent-protocols"] as const;

/** The derived routing policy's filename inside a generation. Committed in the same
 *  rename(2) as the workflows it is compiled from (Risk#3 — no new-workflows/old-policy
 *  window). */
export const GENERATION_ROUTING_POLICY = "routing-policy.yml";

/** FG-576 (D8, AC8) — the Forge-owned Codex instruction carrier, RENDERED into the
 *  generation like the routing policy above rather than copied like a category dir.
 *
 *  WHY IT IS ITS OWN ARTIFACT AND NOT THE CLAUDE ONE. Claude's
 *  --append-system-prompt* ADDS to Claude Code's own base instructions, so the Claude
 *  adapter can hand over seeds/orchestrator-template.md verbatim. Codex's instructions
 *  file SUBSTITUTES the base instruction surface, so the same bytes would delete the
 *  agent scaffolding Codex normally supplies itself. seeds/codex/orchestrator-
 *  instructions.md is that scaffolding, and the canonical policy is spliced INTO it.
 *
 *  WHY IT RIDES THE GENERATION rather than a second installer. The carrier is a
 *  forge-owned surface an interactive orchestrator EXECUTES against. Publishing it
 *  separately would reintroduce exactly what FG-583 closed: an upgrade window in which
 *  a launch could bind a carrier from one release while dispatch ran the workflows of
 *  another, each internally valid, the SET one no release shipped. Rendered into
 *  staging, manifested, and committed in the SAME rename(2), it cannot be observed
 *  apart from the generation it belongs to.
 *
 *  PROVENANCE. The render is a pure function of two seed files, so the same release
 *  always produces identical bytes (AC8 determinism). WHICH release those bytes came
 *  from is not embedded in the carrier — it is the manifest's job: `sourceAssetRoot`
 *  names the executing release and `files[...]` pins the carrier's sha256, so
 *  resolveSeedGeneration reports the new provenance the moment a newer release
 *  publishes, and generationCodexCarrierState refuses bytes that are not the ones that
 *  release rendered. */
export const GENERATION_CODEX_CARRIER = "codex/orchestrator-instructions.md";

/** The carrier's scaffolding SOURCE, relative to a release's seeds/ dir. Same relative
 *  path as the published artifact deliberately: the flat $FORGE_HOME/codex copy the
 *  drift detector measures (seed-drift.ts SEED_SPECS) is the source, so `forge doctor`
 *  names the file an operator would actually edit. */
export const CODEX_CARRIER_SOURCE_REL = "codex/orchestrator-instructions.md";

/** The ONE point in the scaffolding where the canonical policy is spliced. */
export const CODEX_CARRIER_SPLICE_MARKER = "<!-- forge:codex-policy -->";

/** FG-253 — the SECOND splice point: where the carrier's statement about the
 *  orientation/handoff surface is rendered in.
 *
 *  WHY IT IS A SPLICE AND NOT PROSE. Until FG-253 this scaffolding carried a
 *  hand-written paragraph asserting "No Forge skills or slash commands", and it was
 *  true. Forge now renders repository-scoped Codex skills from the provider-neutral
 *  operator-workflow definition, which makes any hand-written statement here a second,
 *  independently-editable copy of a fact that lives elsewhere — the exact defect this
 *  ticket exists to remove. Rendering the region from the SAME definition and the SAME
 *  owned-skill set the installer writes means a carrier that advertises orientation
 *  skills and the skills Forge actually renders cannot come apart: add a workflow and
 *  this region names it on the next publish, with no edit here.
 *
 *  Same exactly-once refusal discipline as the policy marker, for the same reason. */
export const CODEX_CARRIER_ORIENTATION_MARKER = "<!-- forge:codex-orientation -->";

const ORCHESTRATOR_TEMPLATE_REL = "orchestrator-template.md";
const TEMPLATE_START_MARKER = "<!-- forge:orchestrator-start -->";
const TEMPLATE_END_MARKER = "<!-- forge:orchestrator-end -->";

/** Render the Codex carrier from the two canonical seeds. PURE — no I/O, no clock, no
 *  paths — so `same input → identical bytes` is a property of the function rather than
 *  of the caller's discipline (AC8).
 *
 *  Every gate below is publication-refusing on purpose, and the marker ones are not
 *  hypothetical: the policy gate fired during development on a header comment in the
 *  scaffolding that quoted the marker literally, which would have shipped a carrier
 *  split at the wrong point — scaffolding truncated mid-sentence, the policy spliced
 *  into a comment — while still being a perfectly valid-looking markdown file. "Exactly
 *  once" is what makes the splice point unambiguous; "at least once" would have shipped
 *  it. FG-253's orientation marker is held to the same standard, plus a placement check
 *  the count alone cannot make. */
export function renderCodexCarrier(scaffold: string, template: string): string {
  const occurrences = scaffold.split(CODEX_CARRIER_SPLICE_MARKER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `forge seed: the Codex carrier scaffolding must carry the policy splice marker EXACTLY once, found ${occurrences}.\n` +
        `  marker: ${CODEX_CARRIER_SPLICE_MARKER}\n` +
        `A scaffolding with no marker has nowhere to splice the canonical orchestrator policy; one with two ` +
        `splices at whichever comes first, silently truncating the rest of the scaffolding into the policy. ` +
        `Fix: leave the marker on the last line of seeds/${CODEX_CARRIER_SOURCE_REL} and nowhere else — not even ` +
        `quoted in a comment.`,
    );
  }

  // FG-253 — the orientation marker gets the SAME gate, and it is not ceremony: with
  // no marker the carrier ships silent about a surface Forge does install (the
  // capability matrix says `partial`, the carrier would say nothing), and with two the
  // region is rendered twice, so a session reads a duplicated claim.
  const orientationOccurrences = scaffold.split(CODEX_CARRIER_ORIENTATION_MARKER).length - 1;
  if (orientationOccurrences !== 1) {
    throw new Error(
      `forge seed: the Codex carrier scaffolding must carry the orientation splice marker EXACTLY once, found ` +
        `${orientationOccurrences}.\n` +
        `  marker: ${CODEX_CARRIER_ORIENTATION_MARKER}\n` +
        `The orientation region is RENDERED from the provider-neutral operator-workflow definition and the skill ` +
        `names Forge actually installs, so the carrier's claim about orientation cannot drift from the adapters. ` +
        `With no marker the carrier says nothing about a surface Forge does install; with two, a session reads the ` +
        `same claim twice. Fix: place the marker once in seeds/${CODEX_CARRIER_SOURCE_REL}, above the policy ` +
        `marker, and nowhere else — not even quoted in a comment.`,
    );
  }

  const startIdx = template.indexOf(TEMPLATE_START_MARKER);
  const endIdx = template.indexOf(TEMPLATE_END_MARKER);
  if (startIdx < 0 || endIdx <= startIdx) {
    throw new Error(
      `forge seed: the canonical orchestrator policy at seeds/${ORCHESTRATOR_TEMPLATE_REL} carries no ` +
        `${TEMPLATE_START_MARKER} … ${TEMPLATE_END_MARKER} region.\n` +
        `The Codex carrier is DERIVED from that region — the tail after the end marker is the project's own ` +
        `"Stack + project context", which is not Forge policy and must not reach the carrier. Fix: restore the ` +
        `markers in the template.`,
    );
  }
  const bodyStart = template.indexOf("\n", startIdx + TEMPLATE_START_MARKER.length);
  const policy = template.slice(bodyStart < 0 ? startIdx + TEMPLATE_START_MARKER.length : bodyStart + 1, endIdx).trim();

  const body = stripAuthoringHeader(scaffold.slice(0, scaffold.indexOf(CODEX_CARRIER_SPLICE_MARKER)));
  // The orientation marker survived the two edits above only if it sits inside the
  // scaffolding half AND outside the authoring header. Anywhere else it would be
  // dropped on the floor and the carrier would publish, silently, without the region —
  // the one failure the exactly-once count cannot see.
  if (!body.includes(CODEX_CARRIER_ORIENTATION_MARKER)) {
    throw new Error(
      `forge seed: the Codex carrier scaffolding's orientation splice marker is not in the scaffolding body.\n` +
        `  marker: ${CODEX_CARRIER_ORIENTATION_MARKER}\n` +
        `It sits below the policy splice marker, or inside the leading authoring comment — either way the rendered ` +
        `carrier would carry no orientation region at all, while publication reported success. Fix: put it in the ` +
        `instructions themselves in seeds/${CODEX_CARRIER_SOURCE_REL}, above ${CODEX_CARRIER_SPLICE_MARKER}.`,
    );
  }
  const withOrientation = body.replace(CODEX_CARRIER_ORIENTATION_MARKER, () => renderCodexOrientationRegion());
  return `${withOrientation.trimEnd()}\n\n${policy}\n`;
}

/** FG-253 — the carrier's orientation/handoff region, DERIVED. Pure and argument-free:
 *  everything it says comes from the provider-neutral definition
 *  (src/v2/operator-workflows.ts) and the Codex skill identity the installer and the
 *  drift detector use (src/v2/render-codex-skills.ts), so the same release always
 *  renders the same bytes and no fact here is maintained twice.
 *
 *  What it deliberately does NOT say: that the skills are active. Forge wrote files; a
 *  build without repository-scoped skill discovery ignores them silently, and there is
 *  no probe. The region states the fallback instead, which is the same CLI the skills
 *  drive. */
export function renderCodexOrientationRegion(): string {
  const lines: string[] = [
    "## Forge orientation and handoff",
    "",
    `Forge renders one repository-scoped Codex skill per operator workflow from its own provider-neutral ` +
      `definition — the same definition the Claude orchestrator's slash commands are rendered from — and ` +
      `\`forge init\` / \`forge upgrade\` install them into the project you are running in. ` +
      operatorSurface("codex").operatorAnswer,
    "",
    `A skill FILE existing is not evidence this build loaded it: repository-scoped skill discovery is ` +
      `version-coupled, and a build without it ignores the directory silently. If a skill is absent or does not ` +
      `activate, run the workflow yourself through the \`forge\` CLI — that is what the skill drives, and it is the ` +
      `interface either way.`,
  ];

  for (const id of OPERATOR_WORKFLOW_IDS) {
    const def = operatorWorkflow(id);
    const skill = codexSkillName(id);
    const phrases = CODEX_ACTIVATION_PHRASES[id].map((p) => `"${p}"`).join(", ");
    lines.push(
      "",
      `- **${skill}** — ${def.title}, installed at \`${codexSkillTargetPath(id)}\`.`,
      `  ${def.purpose}`,
      `  Invoke it explicitly by name as \`${skill}\`; it also activates from natural language such as ${phrases}.`,
      `  ${def.boundedCli.statement} The skill file carries the workflow in full — the probe set, the report order, ` +
        `and the prohibitions.`,
    );
  }

  return lines.join("\n");
}

/** Drop a LEADING html comment from the scaffolding. It is the authoring note — who
 *  owns this file, where to edit it, why the splice exists — addressed to whoever
 *  maintains the seed, and it is wrong in the artifact: a carrier that opens by telling
 *  the agent reading it "this file is not the artifact you read" is a false statement
 *  shipped inside an instruction surface. Leading only, so a comment the scaffolding
 *  deliberately puts in the instructions themselves still ships. */
function stripAuthoringHeader(scaffold: string): string {
  const text = scaffold.trimStart();
  if (!text.startsWith("<!--")) return scaffold;
  // A splice marker IS an html comment. A scaffolding that opens on one is opening on
  // content, not on an authoring note, and eating it would drop the region silently.
  if (text.startsWith(CODEX_CARRIER_ORIENTATION_MARKER)) return scaffold;
  const end = text.indexOf("-->");
  return end < 0 ? scaffold : text.slice(end + "-->".length).trimStart();
}

/** The one place the generation-relative protocol path is spelled (FG-654). It lives
 *  here, beside the category list it names, so publication and resolution cannot drift
 *  about where a role's protocol is. */
export function protocolRelPath(role: string): string {
  return `agent-protocols/${role}.md`;
}

/** The provenance manifest forge writes LAST into a staged generation, so a
 *  generation dir carrying a valid manifest is by construction COMPLETE. `files`
 *  records every published file's sha256, which lets the drift measure (FG-579)
 *  check a consumed file against the generation's OWN provenance rather than against
 *  the executing-release assetRoot baseline — a generation is internally consistent
 *  by construction, so the two-pointer window (Risk#2) cannot produce a spurious
 *  hard refusal. */
export const GENERATION_MANIFEST_NAME = ".seed-generation.json";

export type SeedGenerationManifest = {
  schema: 1;
  /** the assetRoot the generation was sourced from — FG-577 executing-release provenance. */
  sourceAssetRoot: string;
  /** sha256 by generation-relative path, e.g. "workflows/feature.yml". */
  files: Record<string, string>;
};

/** A resolved, held generation: an ABSOLUTE physical root captured once (realpath),
 *  plus its provenance. Anchoring a run to this at dispatch entry and threading it to
 *  every lazy load is what keeps a single invocation on ONE generation even if the
 *  pointer swaps mid-run. */
export type SeedGeneration = {
  root: string;
  manifest: SeedGenerationManifest;
};

/** A NAMED, repairable install state — not a byte diff. Propagated to doctor and the
 *  upgrade result. `incomplete` names a mixed/torn generation the pointer resolves to;
 *  `no-generation` is a host with nothing published yet (fresh / pre-migration). Since
 *  FG-583 both are NOT-ready for dispatch — the loader refuses either, and doctor
 *  reports both as readiness findings with the `forge upgrade` remedy; only `healthy`
 *  (a complete generation is published) dispatches. */
export type SeedInstallState =
  | { kind: "healthy"; generation: string }
  | { kind: "no-generation" }
  | { kind: "incomplete"; reason: string; generation: string | null };

function manifestPath(genRoot: string): string {
  return join(genRoot, GENERATION_MANIFEST_NAME);
}

function readGenerationManifest(genRoot: string): SeedGenerationManifest | null {
  const p = manifestPath(genRoot);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as SeedGenerationManifest;
    if (m?.schema !== 1 || typeof m.sourceAssetRoot !== "string" || typeof m.files !== "object" || m.files === null) {
      return null;
    }
    return m;
  } catch {
    return null;
  }
}

/** Resolve the seed `current` pointer PHYSICALLY, ONCE. Returns the held generation,
 *  or null when nothing is published (fresh host / pre-migration flat layout). Since
 *  FG-583 the loaders do NOT fall back to the flat layout on null — they refuse
 *  dispatch (there is no flat dispatch source), so a null here means dispatch is
 *  refused until `forge upgrade` publishes a generation. A pointer resolving to a
 *  directory with no valid manifest reads as null here too: inspectSeedInstall names
 *  it `incomplete`, and doctor / callers that must not run under a partial install
 *  consult that. */
export function resolveSeedGeneration(home: string = liveForgeHome()): SeedGeneration | null {
  const link = seedCurrentLinkIn(home);
  if (!existsSync(link)) return null;
  let root: string;
  try {
    root = realpathSync(link);
  } catch {
    return null;
  }
  const manifest = readGenerationManifest(root);
  if (!manifest) return null;
  return { root, manifest };
}

/** The NAMED install state for doctor / preflight. Distinguishes:
 *   - no pointer at all            → no-generation (healthy; flat layout / fresh host)
 *   - pointer → dir, valid manifest → healthy
 *   - pointer → nothing / dir with no|invalid manifest → incomplete (torn/mid-publish),
 *     repairable by re-running `forge upgrade`. */
export function inspectSeedInstall(home: string = liveForgeHome()): SeedInstallState {
  const link = seedCurrentLinkIn(home);
  if (!existsSync(link)) return { kind: "no-generation" };
  let root: string;
  try {
    root = realpathSync(link);
  } catch {
    return {
      kind: "incomplete",
      generation: null,
      reason: `the seed generation pointer ${link} does not resolve — a publish was interrupted before it committed`,
    };
  }
  const manifest = readGenerationManifest(root);
  if (!manifest) {
    return {
      kind: "incomplete",
      generation: root,
      reason: `the seed generation at ${root} carries no valid provenance manifest — it is mid-publish or torn`,
    };
  }
  return { kind: "healthy", generation: root };
}

/** DESTINATION TRUST — FOLLOW-SAFE. Before any byte is staged, prove that the two
 *  directories a publish will write — the generations store and the selection store
 *  — resolve PHYSICALLY inside the disposable home. realpathContains (reused from
 *  promote.ts, FG-571's containment vocabulary — NOT a second machinery) follows
 *  every symlink, so a `seed-generations`/`seed-selection` an attacker replaced with
 *  a symlink, or one reached through a symlinked path component, that points outside
 *  the home is caught here — before writing — leaving the unrelated target
 *  byte-for-byte unchanged. The irreducible sub-microsecond same-UID swap of a
 *  component AFTER this check and BEFORE the write (the FG-604 class) is out of
 *  scope; the realistic pre-existing-symlink case is what this closes. */
function assertDestinationsContained(home: string): void {
  const realHome = existsSync(home) ? realpathSync(home) : resolve(home);
  for (const dir of [seedGenerationsDirIn(home), seedSelectionsDirIn(home), seedSelectionLinkIn(home)]) {
    // Only an EXISTING path can be a redirect; a not-yet-created dir is made below
    // and lands inside the home by construction.
    if (!existsSync(dir) && !isSymlink(dir)) continue;
    if (!realpathContains(realHome, dir)) {
      throw new Error(
        `forge seed: refusing to publish — a publication destination escapes the forge home.\n` +
          `  forge home:  ${realHome}\n` +
          `  destination: ${dir}\n` +
          `  resolves to: ${safeRealpath(dir)}\n` +
          `A destination that resolves outside the home is a replaceable symlink that would carry this ` +
          `publish onto an unrelated host path. Forge refuses before writing any byte, so that path is ` +
          `left byte-for-byte unchanged.\n` +
          `Fix: remove the redirecting link at ${dir} and re-run \`forge upgrade\`.`,
      );
    }
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return "(does not resolve)";
  }
}

/** Where `seed-current` and `seed-previous` point once a home is linked through
 *  `seed-selection` — relative, so the chain resolves from the home itself and a
 *  moved/bind-mounted home still resolves. Mirrors promote.ts CURRENT_VIA_SELECTION. */
const SEED_CURRENT_VIA_SELECTION = join("seed-selection", "current");
const SEED_PREVIOUS_VIA_SELECTION = join("seed-selection", "previous");

/** Publish a (current, previous) PAIR for the seed pointer with ONE swap: build a
 *  fresh selection dir holding both links and rename(2) `seed-selection` over it. */
function writeSeedSelection(home: string, current: string | null, previous: string | null): void {
  const dir = join(seedSelectionsDirIn(home), `sel-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(dir, { recursive: true });
  if (current) symlinkSync(current, join(dir, "current"));
  if (previous) symlinkSync(previous, join(dir, "previous"));
  atomicSymlinkSwap(dir, seedSelectionLinkIn(home));
}

/** Bring a home onto the seed-selection layout WITHOUT changing what it selects.
 *  Every swap replaces a pointer with one resolving to the SAME generation (or to
 *  nothing), so an interrupt anywhere inside leaves the home selecting exactly what
 *  it selected before. */
function ensureSeedSelectionLayout(home: string): void {
  const readsThrough = (link: string, expected: string): boolean => {
    try {
      return lstatSync(link).isSymbolicLink() && readlinkSync(link) === expected;
    } catch {
      return false;
    }
  };
  if (readsThrough(seedCurrentLinkIn(home), SEED_CURRENT_VIA_SELECTION) && readsThrough(seedPreviousLinkIn(home), SEED_PREVIOUS_VIA_SELECTION)) {
    return;
  }
  const current = resolveSeedGeneration(home)?.root ?? currentPointerTarget(home);
  const previous = previousPointerTarget(home);
  writeSeedSelection(home, current, previous);
  atomicSymlinkSwap(SEED_CURRENT_VIA_SELECTION, seedCurrentLinkIn(home));
  atomicSymlinkSwap(SEED_PREVIOUS_VIA_SELECTION, seedPreviousLinkIn(home));
}

/** What `seed-current` physically resolves to, without requiring a valid manifest —
 *  used to preserve the incumbent target while migrating the pointer layout. */
function currentPointerTarget(home: string): string | null {
  const link = seedCurrentLinkIn(home);
  try {
    return existsSync(link) ? realpathSync(link) : null;
  } catch {
    return null;
  }
}

function previousPointerTarget(home: string): string | null {
  const link = seedPreviousLinkIn(home);
  try {
    return existsSync(link) ? realpathSync(link) : null;
  } catch {
    return null;
  }
}

export type PublishSeedGenerationOptions = {
  home?: string;
  /** FG-577 executing-release provenance: the assetRoot the seeds are sourced from.
   *  The caller passes assetRoot(); its seeds/ subtree is the ONLY source. This is
   *  VALIDATED against the executing-release provenance below, not trusted — a
   *  caller-selected FORGE_REPO_DIR / dev checkout / bare releases path that does not
   *  match the executing release is REFUSED, so those bytes can never become the
   *  promoted seed source. */
  assetsDir: string;
  /** Test seam ONLY: the executing-release provenance resolver, defaulting to
   *  FG-577's assetRoot() (the tree THIS process runs from). publishSeedGeneration
   *  DERIVES the seed source from this — not from the caller-supplied `assetsDir` —
   *  and refuses if `assetsDir` does not resolve to the same physical tree. A test
   *  injects a disposable release root here; production passes nothing and the real
   *  executing-release root is enforced. */
  trustedAssetRoot?: () => string;
  /** The installed host RACI source to compile the derived routing policy from. When
   *  absent (no host RACI), the generation ships no routing policy — routing falls
   *  back fail-closed, unchanged. */
  raciPath?: string;
  /** Test seam: fires after the generation is fully staged (manifest written) but
   *  BEFORE the atomic swap — the interruption window. Never set in production. */
  onBeforeSwap?: () => void;
};

export type PublishSeedGenerationResult = {
  generation: string;
  previous: string | null;
  files: number;
  routingPolicyCompiled: boolean;
  /** FG-576: whether this generation carries the Forge-owned Codex instruction
   *  carrier. False only for a release that ships no seeds/codex scaffolding at all —
   *  a release that ships a MALFORMED one refuses to publish rather than reporting
   *  false here. */
  codexCarrierPublished: boolean;
};

/** PUBLISH the complete forge-owned seed surface as ONE atomic generation.
 *
 *  Order IS the safety property:
 *    validate destinations contained -> stage a fresh generation dir from
 *    assetsDir/seeds -> compile the derived routing policy INTO the staging dir ->
 *    write the provenance manifest LAST -> ONE rename(2) over the seed pointer.
 *
 *  An interrupt before the swap leaves only a `.staging-*` dir the pointer never
 *  names, so the prior generation stays fully intact and selectable and NOTHING
 *  partial is ever observable — the torn/mixed surface is structurally impossible.
 *  The staged generation is retained-never-recycled once published, so a process
 *  anchored to a prior generation keeps reading it. */
export function publishSeedGeneration(opts: PublishSeedGenerationOptions): PublishSeedGenerationResult {
  const home = opts.home ?? liveForgeHome();

  // SOURCE TRUST (FG-577). DERIVE the seed source from the executing-release
  // provenance itself — never trust the caller-supplied assetsDir. `trustedRoot` is
  // assetRoot() (the tree this process runs from) in production; a test injects a
  // disposable release. The caller-supplied assetsDir must resolve to the SAME
  // physical tree, or a dev/FORGE_REPO_DIR/bare-releases path could make arbitrary
  // bytes the promoted seed source — the exact thing this refuses.
  const trustedRoot = (opts.trustedAssetRoot ?? executingAssetRoot)();
  const realTrusted = safeRealpath(trustedRoot);
  const realAssets = safeRealpath(opts.assetsDir);
  if (realAssets !== realTrusted) {
    throw new Error(
      `forge seed: refusing to publish — the seed source is not the executing release.\n` +
        `  supplied assetsDir:   ${opts.assetsDir} (resolves to ${realAssets})\n` +
        `  executing release:    ${trustedRoot} (resolves to ${realTrusted})\n` +
        `Seeds are sourced ONLY from the release this forge is executing from (FG-577). A dev checkout, a ` +
        `caller-selected FORGE_REPO_DIR, or a bare releases/* path can never become the promoted seed source. ` +
        `Fix: publish from the executing release (forge upgrade), not a hand-picked directory.`,
    );
  }
  // Read from the TRUSTED root, not the caller's string — provenance is derived,
  // not merely asserted (the two are equal here, so behavior is unchanged).
  const seedsSrc = join(trustedRoot, "seeds");
  if (!existsSync(seedsSrc)) {
    throw new Error(
      `forge seed: refusing to publish — the release's seeds/ tree is missing.\n` +
        `  assetRoot: ${trustedRoot}\n` +
        `  expected:  ${seedsSrc}\n` +
        `Seeds are sourced only from the executing release (FG-577). Fix: reinstall the release.`,
    );
  }

  mkdirSync(home, { recursive: true });
  // DESTINATION TRUST first — before any byte is written.
  assertDestinationsContained(home);

  const generationsDir = seedGenerationsDirIn(home);
  mkdirSync(generationsDir, { recursive: true });
  const staging = join(generationsDir, `.staging-${Math.random().toString(36).slice(2, 10)}`);
  try {
    mkdirSync(staging, { recursive: true });

    const files: Record<string, string> = {};
    for (const category of SEED_GENERATION_DIRS) {
      const srcDir = join(seedsSrc, category);
      const dstDir = join(staging, category);
      mkdirSync(dstDir, { recursive: true });
      if (!existsSync(srcDir)) continue;
      for (const rel of walkRelFiles(srcDir)) {
        const src = join(srcDir, rel);
        const dst = join(dstDir, rel);
        mkdirSync(join(dst, ".."), { recursive: true });
        cpSync(src, dst);
        files[`${category}/${rel}`] = sha256OfBytes(dst);
      }
    }

    // FG-654 / RF-13: COVERAGE IS A PUBLICATION PRECONDITION, not a later discovery.
    // The staging loop above skips a category the release does not carry and manifests
    // only what it found, so a release shipping no protocol for a covered role would
    // otherwise publish a generation that is COMPLETE by construction — `forge upgrade`
    // reports it published and exits 0 — while every dispatch of that role is refused.
    // A generation that cannot dispatch the review lifecycle is not publishable: refuse
    // here, where nothing has been committed and the prior generation stays selectable.
    const uncovered = COVERED_ROLES.filter((role) => files[protocolRelPath(role)] === undefined);
    if (uncovered.length > 0) {
      throw new Error(
        `forge seed: refusing to publish — this release carries no Forge-owned protocol for ` +
          `${uncovered.length} role(s) the review lifecycle dispatches.\n` +
          `  assetRoot: ${trustedRoot}\n` +
          `  missing:   ${uncovered.map((r) => `seeds/${protocolRelPath(r)}`).join(", ")}\n` +
          `Publishing would report a complete generation while every dispatch of those roles refused, ` +
          `so the generation is not published and the current one is left selectable. Fix: reinstall the release.`,
      );
    }

    // Compile the derived routing policy INTO the staging generation so the raw
    // workflow definitions and the derived artifact commit together in ONE rename
    // (Risk#3 — no new-workflows/old-policy window).
    let routingPolicyCompiled = false;
    if (opts.raciPath && existsSync(opts.raciPath)) {
      const policyDst = join(staging, GENERATION_ROUTING_POLICY);
      const res = compilePolicyFile(opts.raciPath, policyDst, { write: true });
      if (!res.ok) {
        throw new Error(
          `forge seed: refusing to publish — the host RACI does not compile under this release.\n` +
            `  raci:   ${opts.raciPath}\n` +
            `  reason: ${res.error}\n` +
            `Publishing a generation whose derived routing policy is stale or missing would let dispatch ` +
            `run under a policy no release shipped. Fix: correct ${opts.raciPath} and re-run \`forge upgrade\`.`,
        );
      }
      files[GENERATION_ROUTING_POLICY] = sha256OfBytes(policyDst);
      routingPolicyCompiled = true;
    }

    // FG-576 (D8, AC8) — RENDER the Forge-owned Codex instruction carrier into the
    // same staging dir, so it commits in the SAME rename(2) as workflows/runtimes/
    // protocols/policy. It is written under Forge's own root and nowhere else: no byte
    // reaches the operator's Codex config root, CODEX_HOME is never redirected, and
    // AGENTS.md / CLAUDE.md / config.toml / plugins are never read or spliced.
    //
    // A release that ships no scaffolding publishes no carrier (`absent` — the same
    // shape as a generation published with no host RACI). A release that ships a
    // MALFORMED one is a different case entirely and REFUSES here, where nothing has
    // been committed and the prior generation stays selectable: silently publishing a
    // carrier split at the wrong point would bind a plausible-looking instruction
    // surface no release meant to ship.
    let codexCarrierPublished = false;
    const carrierSrc = join(seedsSrc, CODEX_CARRIER_SOURCE_REL);
    if (existsSync(carrierSrc)) {
      const templateSrc = join(seedsSrc, ORCHESTRATOR_TEMPLATE_REL);
      if (!existsSync(templateSrc)) {
        throw new Error(
          `forge seed: refusing to publish — this release carries the Codex carrier scaffolding but not the ` +
            `canonical orchestrator policy it is rendered from.\n` +
            `  scaffolding: ${carrierSrc}\n` +
            `  expected:    ${templateSrc}\n` +
            `Publishing scaffolding with no policy spliced into it would bind a Codex orchestrator that had been ` +
            `told how to act and nothing about what Forge expects of it. Fix: reinstall the release.`,
        );
      }
      const rendered = renderCodexCarrier(readFileSync(carrierSrc, "utf8"), readFileSync(templateSrc, "utf8"));
      const carrierDst = join(staging, GENERATION_CODEX_CARRIER);
      mkdirSync(join(carrierDst, ".."), { recursive: true });
      writeFileSync(carrierDst, rendered);
      files[GENERATION_CODEX_CARRIER] = sha256OfBytes(carrierDst);
      codexCarrierPublished = true;
    }

    const manifest: SeedGenerationManifest = {
      schema: 1,
      sourceAssetRoot: realTrusted,
      files,
    };
    // Written LAST: a generation dir with a valid manifest is COMPLETE by construction.
    writeFileSync(manifestPath(staging), `${JSON.stringify(manifest, null, 2)}\n`);

    // COMMIT: rename the staging dir to an immutable, retained generation name, then
    // one swap over the pointer. The rename off `.staging-*` makes it addressable;
    // the pointer swap selects it.
    const generation = join(generationsDir, `gen-${Math.random().toString(36).slice(2, 12)}`);
    renameSync(staging, generation);

    const before = resolveSeedGeneration(home)?.root ?? currentPointerTarget(home);
    ensureSeedSelectionLayout(home);
    opts.onBeforeSwap?.();
    writeSeedSelection(home, generation, before);

    return {
      generation,
      previous: before,
      files: Object.keys(files).length,
      routingPolicyCompiled,
      codexCarrierPublished,
    };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** Relative paths of every regular file under `base` (recursive). */
function walkRelFiles(base: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(base, { withFileTypes: true })) {
    const rel = prefix === "" ? ent.name : `${prefix}/${ent.name}`;
    const p = join(base, ent.name);
    if (ent.isDirectory()) out.push(...walkRelFiles(p, rel));
    else if (ent.isFile() && statSync(p).isFile()) out.push(rel);
  }
  return out;
}

/** Resolve a category directory (workflows/runtimes) for a resolved generation, or
 *  null when the generation does not carry that category. Consumed by the loader's
 *  generation-anchored resolution. */
export function generationCategoryDir(gen: SeedGeneration, category: (typeof SEED_GENERATION_DIRS)[number]): string {
  return join(gen.root, category);
}

/** FG-583 (finding 2): the integrity state of a generation's compiled routing
 *  policy, measured against the generation's OWN provenance manifest — the SAME
 *  closed-set / digest check assertGenerationWorkflowConsistent / assertGeneration-
 *  RuntimeConsistent give workflows/runtimes. Without it a torn/tampered generation
 *  could carry a schema-valid but REPLACED routing-policy.yml while workflows/runtimes
 *  stay intact, so route preflight / receipts / dispatch would consume mis-routing
 *  bytes no release shipped.
 *
 *  - `absent`   → the generation ships NO policy (published with no host RACI): not
 *                 in the manifest AND not on disk. Fail-closed fallback, unchanged.
 *  - `present`  → policy present and its bytes match the manifest. Authoritative.
 *  - `tampered` → an unmanifested EXTRA file, a manifested-but-missing file, or a
 *                 byte mismatch — a torn/tampered generation. Consumers refuse
 *                 (dispatch) or report the named state (operator). */
export type GenerationPolicyState =
  | { kind: "absent" }
  | { kind: "present"; path: string }
  | { kind: "tampered"; path: string; reason: string };

/** FG-576: where the Forge-owned Codex instruction carrier lives inside a resolved
 *  generation. The ONE place the generation-relative path is turned into an absolute
 *  one, so the launch binding (step 7) and publication cannot drift about it. */
export function codexCarrierPath(gen: SeedGeneration): string {
  return join(gen.root, GENERATION_CODEX_CARRIER);
}

/** FG-576 — the integrity state of a generation's Codex instruction carrier, measured
 *  against the generation's OWN provenance manifest. The same three-state shape as
 *  generationPolicyState above, and for the same reason: a torn or tampered generation
 *  could otherwise carry a perfectly readable markdown file that no release rendered,
 *  and a Codex orchestrator would be bound to it as if it were Forge policy.
 *
 *  - `absent`   → not in the manifest AND not on disk: a release that ships no
 *                 scaffolding. The launcher names the gap; it does not fake a carrier.
 *  - `present`  → on disk and byte-identical to what the manifest pins. Bindable.
 *  - `tampered` → unmanifested extra file, manifested-but-missing, or byte mismatch. */
export type GenerationCarrierState =
  | { kind: "absent" }
  | { kind: "present"; path: string }
  | { kind: "tampered"; path: string; reason: string };

export function generationCodexCarrierState(gen: SeedGeneration): GenerationCarrierState {
  const rel = GENERATION_CODEX_CARRIER;
  const expected = gen.manifest.files[rel];
  const path = join(gen.root, rel);
  const onDisk = existsSync(path);
  if (!expected && !onDisk) return { kind: "absent" };
  if (!expected) {
    return {
      kind: "tampered",
      path,
      reason:
        `the Codex instruction carrier at ${path} resolves inside the published seed generation but is not in its ` +
        `provenance manifest (${gen.root}) — an instruction surface present under the generation but absent from ` +
        `its manifest is one no release rendered`,
    };
  }
  if (!onDisk) {
    return {
      kind: "tampered",
      path,
      reason: `the Codex instruction carrier manifested in the seed generation is missing from ${path} — the generation is torn or mid-publish`,
    };
  }
  if (sha256OfBytes(path) !== expected) {
    return {
      kind: "tampered",
      path,
      reason:
        `the Codex instruction carrier at ${path} does not match the seed generation's provenance manifest ` +
        `(${gen.root}) — these are not the bytes this release rendered`,
    };
  }
  return { kind: "present", path };
}

export function generationPolicyState(gen: SeedGeneration): GenerationPolicyState {
  const rel = GENERATION_ROUTING_POLICY;
  const expected = gen.manifest.files[rel];
  const path = join(gen.root, rel);
  const onDisk = existsSync(path);
  // A generation with no policy in EITHER the manifest or on disk is the legitimate
  // no-host-RACI case — routing falls back fail-closed, unchanged.
  if (!expected && !onDisk) return { kind: "absent" };
  // Present under the generation dir but absent from its provenance manifest — an
  // unmanifested EXTRA file (the closed-set violation), exactly as the workflow /
  // runtime checks refuse.
  if (!expected) {
    return {
      kind: "tampered",
      path,
      reason:
        `the routing policy at ${path} resolves inside the published seed generation but is not in its provenance manifest ` +
        `(${gen.root}) — a file present under the generation but absent from its manifest means this generation is torn or was tampered with, a state no release shipped`,
    };
  }
  // Manifested but missing on disk — a torn/mid-publish generation.
  if (!onDisk) {
    return {
      kind: "tampered",
      path,
      reason: `the routing policy manifested in the seed generation is missing from ${path} — the generation is torn or mid-publish`,
    };
  }
  if (sha256OfBytes(path) !== expected) {
    return {
      kind: "tampered",
      path,
      reason:
        `the routing policy at ${path} does not match the seed generation's provenance manifest (${gen.root}) — ` +
        `the generation is torn or was tampered with, a state no release shipped`,
    };
  }
  return { kind: "present", path };
}
